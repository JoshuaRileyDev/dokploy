import { db } from "@dokploy/server/db";
import { workflowRuns } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { connectToBoatSandbox, findBoatSettings } from "../../services/boat";
import { findServerById } from "../../services/server";
import {
	BOAT_PREPARE_DOCKER_SCRIPT,
	BOAT_RUN_LABEL,
	BOAT_RUN_TTL_SECONDS,
	BOAT_RUNS_DIR,
	ensureBoatSnapshot,
	releaseBoatRunSandbox,
} from "../../services/workflow-boat";
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

type Machine = {
	session: SshSession;
	description: string;
	baseDir?: string;
	prepareScript?: string;
	release: () => Promise<void>;
};

type StartedRun = NonNullable<
	Awaited<ReturnType<typeof RunRecorder.start>>
>["run"];

const elapsedSince = (start: number) =>
	`${((Date.now() - start) / 1000).toFixed(1)}s`;

const workflowServerMachine = async (
	serverId: string,
	workflowRunId: string,
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

const boatMachine = async (
	run: StartedRun,
	log: (line: string) => void,
	signal: AbortSignal,
): Promise<Machine> => {
	const start = Date.now();
	const settings = await findBoatSettings(run.repository.organizationId);
	if (!settings) {
		throw new Error("Boat was disconnected from this organization.");
	}
	const client = new BoatClient(settings.apiKey);
	signal.throwIfAborted();
	// The snapshot build is shared with other runs, so a cancel stops waiting rather than the build.
	const snapshot = await Promise.race([
		ensureBoatSnapshot(run.repository.organizationId, {
			log: (line) => log(`[boat snapshot] ${line}`),
		}),
		new Promise<never>((_, reject) =>
			signal.addEventListener(
				"abort",
				() => reject(new Error("Cancelled while preparing Boat")),
				{ once: true },
			),
		),
	]);

	const sandbox = await client.createSandbox(
		{
			type: settings.workflowMachineType,
			from: snapshot,
			name: `${run.repository.repository} ${run.workflowName} #${run.runNumber}`.slice(
				0,
				120,
			),
			ttlSeconds: BOAT_RUN_TTL_SECONDS,
			labels: { [BOAT_RUN_LABEL]: run.workflowRunId },
			snapshots: false,
		},
		run.workflowRunId,
		signal,
	);
	await db
		.update(workflowRuns)
		.set({ boatSandboxId: sandbox.id })
		.where(eq(workflowRuns.workflowRunId, run.workflowRunId));
	const release = () =>
		releaseBoatRunSandbox(client, run.workflowRunId, sandbox.id);

	try {
		log(
			`Starting Boat sandbox ${sandbox.id} (${settings.workflowMachineType})`,
		);
		const { target } = await connectToBoatSandbox(client, sandbox.id, signal);
		log(`Boat sandbox ready after ${elapsedSince(start)}`);
		const session = await openSshSession(target, {
			retryForMs: 30_000,
			signal,
		});
		log(`Connected over SSH after ${elapsedSince(start)}`);
		return {
			session,
			description: `Boat sandbox ${sandbox.id}`,
			baseDir: BOAT_RUNS_DIR,
			prepareScript: BOAT_PREPARE_DOCKER_SCRIPT,
			release: async () => {
				session.close();
				await release();
			},
		};
	} catch (error) {
		await release().catch(() => {});
		throw error;
	}
};

/** Runs one workflow run to completion over SSH, on its workflow server or a fresh Boat sandbox. */
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

	let exitCode = 1;
	let errorMessage: string | null = null;
	let machine: Machine | null = null;
	// Inputs (tokens, secrets, the workflow file) and the machine are independent, so the machine
	// boots while the inputs are fetched. Failing inputs stop the boot.
	const preparing = new AbortController();
	const machineSignal = AbortSignal.any([combined, preparing.signal]);
	try {
		const [inputs, acquired] = await Promise.allSettled([
			prepareRunInputs(run, { seedActions: true }).catch((error) => {
				preparing.abort(error);
				throw error;
			}),
			run.runsOnBoat
				? boatMachine(run, (line) => recorder.log(line), machineSignal)
				: workflowServerMachine(run.serverId!, workflowRunId, machineSignal),
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
			script: buildActRunScript({
				...scriptInput,
				baseDir: machine!.baseDir,
				prepareScript: machine!.prepareScript,
				managedCache: true,
			}),
			signal: combined,
			onAbortScript: buildActCancelScript(workflowRunId, machine!.baseDir),
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

	if (timeout.aborted) {
		errorMessage = "The run exceeded the 6 hour limit and was stopped.";
	}
	await recorder.finish({
		exitCode,
		cancelled: signal.aborted,
		errorMessage,
	});
};
