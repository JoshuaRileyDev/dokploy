import { db } from "@dokploy/server/db";
import { workflowRuns } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { getDokployUrl } from "../../services/admin";
import { findBoatSettings } from "../../services/boat";
import { findServerById } from "../../services/server";
import {
	BOAT_PREPARE_DOCKER_SCRIPT,
	BOAT_RUN_LABEL,
	BOAT_RUN_TTL_SECONDS,
	BOAT_RUNS_DIR,
	boatPlatformImages,
	boatRunRunnerSetup,
	ensureBoatSnapshot,
} from "../../services/workflow-boat";
import {
	createEphemeralRunner,
	finishEphemeralRun,
	type PreparedRunnerScript,
	registerEphemeralRun,
	releaseEphemeralRunner,
	unregisterEphemeralRun,
} from "../../services/workflow-runner";
import { BoatClient } from "../boat/client";
import {
	buildActCancelScript,
	buildActCleanupScript,
	buildActRunScript,
} from "./act";
import { prepareRunInputs, RunRecorder } from "./run-recorder";
import {
	openSshSession,
	runRemoteScript,
	type SshSession,
	type SshTarget,
} from "./ssh";

const MAX_RUN_DURATION_MS = 6 * 60 * 60 * 1000;
const RUN_LIMIT_MESSAGE = "The run exceeded the 6 hour limit and was stopped.";
const RUNNER_START_TIMEOUT_MS = 2 * 60 * 1000;
const FINISH_POLL_MS = 2000;
// The runner hears about a cancel within seconds and gives act 20s to stop.
const CANCEL_GRACE_MS = 60_000;

type Machine = {
	session: SshSession;
	description: string;
	release: () => Promise<void>;
};

type StartedRun = NonNullable<
	Awaited<ReturnType<typeof RunRecorder.start>>
>["run"];

const workflowServerMachine = async (
	serverId: string,
	workflowRunId: string,
	recorder: RunRecorder,
	signal: AbortSignal,
): Promise<Machine> => {
	const server = await findServerById(serverId);
	if (!server.sshKey?.privateKey) {
		throw new Error(`Server ${server.name} has no SSH key`);
	}
	const target: SshTarget = {
		ipAddress: server.ipAddress,
		port: server.port,
		username: server.username,
		privateKey: server.sshKey.privateKey,
	};
	const session = await openSshSession(target, { signal });
	await recorder.mark("connected");
	return {
		session,
		description: server.name,
		release: async () => {
			session.close();
			await runRemoteScript({
				target,
				script: buildActCleanupScript(workflowRunId),
			});
		},
	};
};

const untilAborted = (signal: AbortSignal, message: string) =>
	new Promise<never>((_, reject) => {
		if (signal.aborted) reject(new Error(message));
		signal.addEventListener("abort", () => reject(new Error(message)), {
			once: true,
		});
	});

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});

/** Creates the run's sandbox with a one-run runner in it; resolves once Boat reports the sandbox ready. */
const startBoatRunSandbox = async (
	run: StartedRun,
	recorder: RunRecorder,
	signal: AbortSignal,
) => {
	const { organizationId } = run.repository;
	const settings = await findBoatSettings(organizationId);
	if (!settings) {
		throw new Error("Boat was disconnected from this organization.");
	}
	const client = new BoatClient(settings.apiKey);
	// The snapshot build is shared with other runs, so a cancel stops waiting rather than the build.
	const snapshot = await Promise.race([
		ensureBoatSnapshot(organizationId, {
			log: (line) => recorder.log(`[boat snapshot] ${line}`),
		}),
		untilAborted(signal, "Cancelled while preparing Boat"),
	]);
	const name =
		`${run.repository.repository} ${run.workflowName} #${run.runNumber}`.slice(
			0,
			120,
		);
	const [{ runner, token }, url] = await Promise.all([
		createEphemeralRunner({
			organizationId,
			workflowRunId: run.workflowRunId,
			name: `Boat: ${name}`,
			labels: run.runsOn,
		}),
		getDokployUrl(),
	]);
	const sandbox = await client.createSandbox(
		{
			type: settings.workflowMachineType,
			from: snapshot,
			name,
			ttlSeconds: BOAT_RUN_TTL_SECONDS,
			labels: { [BOAT_RUN_LABEL]: run.workflowRunId },
			snapshots: false,
			...boatRunRunnerSetup({
				url,
				workflowRunnerId: runner.workflowRunnerId,
				name: runner.name,
				labels: runner.labels,
				token,
			}),
		},
		run.workflowRunId,
		signal,
	);
	await db
		.update(workflowRuns)
		.set({ boatSandboxId: sandbox.id })
		.where(eq(workflowRuns.workflowRunId, run.workflowRunId));
	recorder.log(
		`Starting Boat sandbox ${sandbox.id} (${settings.workflowMachineType})`,
	);
	return {
		url,
		ready: client
			.waitForSandbox(sandbox.id, signal)
			.then(() => recorder.mark("sandbox_ready")),
	};
};

/** Waits for the sandbox's runner to finish the run, asking it to stop when the run is cancelled or times out. */
const waitForBoatRunner = async (
	workflowRunId: string,
	signal: AbortSignal,
	timeout: AbortSignal,
) => {
	const stop = AbortSignal.any([signal, timeout]);
	let giveUpAt: number | null = null;
	for (;;) {
		const current = await db.query.workflowRuns.findFirst({
			where: eq(workflowRuns.workflowRunId, workflowRunId),
			columns: { status: true, cancelRequested: true },
		});
		if (current?.status !== "in_progress") return;
		// A cancel from the UI is stored on the run for the runner, without aborting this executor.
		if (current.cancelRequested && giveUpAt === null && !stop.aborted) {
			giveUpAt = Date.now() + CANCEL_GRACE_MS;
		}
		if (stop.aborted && giveUpAt === null) {
			await db
				.update(workflowRuns)
				.set({
					cancelRequested: true,
					...(timeout.aborted ? { errorMessage: RUN_LIMIT_MESSAGE } : {}),
				})
				.where(eq(workflowRuns.workflowRunId, workflowRunId));
			giveUpAt = Date.now() + CANCEL_GRACE_MS;
		}
		if (giveUpAt !== null && Date.now() > giveUpAt) {
			await finishEphemeralRun(workflowRunId, {
				exitCode: 1,
				cancelled: !timeout.aborted,
				errorMessage: timeout.aborted
					? RUN_LIMIT_MESSAGE
					: "The Boat sandbox's runner didn't stop after the run was cancelled.",
			});
			return;
		}
		await sleep(FINISH_POLL_MS, giveUpAt === null ? stop : undefined);
	}
};

/**
 * Runs a Boat run through a runner inside its sandbox. The runner claims the run over HTTP like any
 * runner, so the run keeps going if Dokploy restarts, and the sandbox is deleted when it finishes.
 */
const executeBoatRun = async (
	recorder: RunRecorder,
	signal: AbortSignal,
	timeout: AbortSignal,
) => {
	const { run } = recorder;
	const stop = AbortSignal.any([signal, timeout]);
	let claimed = false;
	let onClaim!: () => void;
	const claim = new Promise<void>((resolve) => {
		onClaim = () => {
			claimed = true;
			resolve();
		};
	});
	const prepared: Promise<PreparedRunnerScript> = prepareRunInputs(run, {
		seedActions: true,
	}).then(async ({ scriptInput, maskValues, usesServices }) => {
		recorder.setMaskValues(maskValues);
		await recorder.mark("inputs_ready");
		recorder.log(
			`Running ${run.workflowPath} at ${run.sha.slice(0, 7)} on a Boat sandbox`,
		);
		return {
			script: buildActRunScript({
				...scriptInput,
				baseDir: BOAT_RUNS_DIR,
				prepareScript: BOAT_PREPARE_DOCKER_SCRIPT,
				platformImages: boatPlatformImages(run.trusted && !usesServices),
				managedCache: true,
			}),
			maskValues,
		};
	});
	prepared.catch(() => {});
	registerEphemeralRun(run.workflowRunId, { recorder, prepared, onClaim });

	try {
		try {
			const { url, ready } = await startBoatRunSandbox(run, recorder, stop);
			let sandboxReady = false;
			await Promise.race([
				claim,
				prepared.then(() => claim),
				ready.then(() => {
					sandboxReady = true;
					return claim;
				}),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									sandboxReady
										? `The runner in the Boat sandbox didn't reach Dokploy at ${url} within 2 minutes. Boat sandboxes must be able to reach Dokploy at that address (Settings → Web Server).`
										: "The Boat sandbox wasn't ready within 2 minutes.",
								),
							),
						RUNNER_START_TIMEOUT_MS,
					).unref(),
				),
				untilAborted(stop, "Cancelled while starting the Boat sandbox"),
			]);
		} catch (error) {
			if (!claimed) {
				await recorder.finish({
					exitCode: 1,
					cancelled: signal.aborted,
					errorMessage: timeout.aborted
						? RUN_LIMIT_MESSAGE
						: signal.aborted
							? null
							: error instanceof Error
								? error.message
								: String(error),
				});
				return;
			}
		}
		await waitForBoatRunner(run.workflowRunId, signal, timeout);
	} finally {
		unregisterEphemeralRun(run.workflowRunId);
		await releaseEphemeralRunner(run.workflowRunId).catch((error) =>
			console.error(
				`Failed to release the Boat sandbox of run ${run.workflowRunId}`,
				error,
			),
		);
	}
};

/** Runs one workflow run to completion: over SSH on its workflow server, or through a runner in a fresh Boat sandbox. */
export const executeWorkflowRun = async (
	workflowRunId: string,
	signal: AbortSignal,
) => {
	const recorder = await RunRecorder.start(workflowRunId);
	if (!recorder) return;
	const { run } = recorder;
	if (!run.serverId && !run.runsOnBoat) return;

	const timeout = AbortSignal.timeout(MAX_RUN_DURATION_MS);
	const combined = AbortSignal.any([signal, timeout]);
	combined.addEventListener("abort", () => recorder.markAborting(), {
		once: true,
	});
	if (run.runsOnBoat) {
		await executeBoatRun(recorder, signal, timeout);
		return;
	}

	let exitCode = 1;
	let errorMessage: string | null = null;
	let machine: Machine | null = null;
	// Inputs (tokens, secrets, the workflow file) and the connection are independent, so they're
	// fetched together. Failing inputs stop the connection attempt.
	const preparing = new AbortController();
	const machineSignal = AbortSignal.any([combined, preparing.signal]);
	try {
		const [inputs, acquired] = await Promise.allSettled([
			prepareRunInputs(run, { seedActions: true }).then(
				async (inputs) => {
					await recorder.mark("inputs_ready");
					return inputs;
				},
				(error) => {
					preparing.abort(error);
					throw error;
				},
			),
			workflowServerMachine(
				run.serverId!,
				workflowRunId,
				recorder,
				machineSignal,
			),
		]);
		if (acquired.status === "fulfilled") machine = acquired.value;
		if (inputs.status === "rejected") throw inputs.reason;
		if (acquired.status === "rejected") throw acquired.reason;
		const { scriptInput, maskValues } = inputs.value;
		recorder.setMaskValues(maskValues);
		recorder.log(
			`Running ${run.workflowPath} at ${run.sha.slice(0, 7)} on ${machine!.description}`,
		);

		exitCode = await machine!.session.run({
			script: buildActRunScript({ ...scriptInput, managedCache: true }),
			signal: combined,
			onAbortScript: buildActCancelScript(workflowRunId),
			onStdout: (chunk) => recorder.pushChunk("stdout", chunk),
			onStderr: (chunk) => recorder.pushChunk("stderr", chunk),
		});
		await recorder.flush();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error);
	}
	await machine
		?.release()
		.catch((error) => recorder.log(`Cleanup failed: ${error.message}`));

	if (timeout.aborted) errorMessage = RUN_LIMIT_MESSAGE;
	await recorder.finish({
		exitCode,
		cancelled: signal.aborted,
		errorMessage,
	});
};
