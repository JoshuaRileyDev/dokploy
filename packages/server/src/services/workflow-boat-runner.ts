import { db } from "@dokploy/server/db";
import { workflowRunners } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { BoatApiError, BoatClient, STOPPED_STATES } from "../utils/boat/client";
import { ACT_VERSION } from "../utils/workflows/act";
import {
	BOAT_RUNNER_CLI,
	installRunnerBundleScript,
} from "../utils/workflows/runner-bundle";
import { runRemoteScript } from "../utils/workflows/ssh";
import { getDokployUrl } from "./admin";
import {
	type BoatSettings,
	connectToBoatSandbox,
	findBoatSettings,
	requireBoatSettings,
} from "./boat";
import {
	findOwnedRunner,
	isRunnerOnline,
	regenerateRunnerRegistration,
	type WorkflowRunner,
} from "./workflow-runner";

const IDLE_STOP_MS = 10 * 60 * 1000;
// Boat stops the machine on its own after this long in case Dokploy never does; outlives the 6 hour run limit.
const MACHINE_TTL_SECONDS = 7 * 60 * 60;

// Dev can evaluate this module more than once, so in-flight work lives on globalThis.
const globalForRunners = globalThis as unknown as {
	__dokployBoatRunnersBusy?: Set<string>;
};
globalForRunners.__dokployBoatRunnersBusy ??= new Set();
const busy = globalForRunners.__dokployBoatRunnersBusy;

const isGone = (error: unknown) =>
	error instanceof BoatApiError &&
	(error.status === 404 || error.code === "snapshot_data_expired");

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const boatRunnerSetupScript = (
	dokployUrl: string,
	registrationToken: string,
) => {
	const cli = BOAT_RUNNER_CLI;
	return [
		"set -euo pipefail",
		`echo "Installing act ${ACT_VERSION}"`,
		`curl -fsSL "https://raw.githubusercontent.com/nektos/act/v${ACT_VERSION}/install.sh" | sudo bash -s -- -b /usr/local/bin "v${ACT_VERSION}"`,
		"act --version",
		'echo "Installing the Dokploy runner"',
		installRunnerBundleScript(),
		`${cli} register --url '${dokployUrl}' --token '${registrationToken}'`,
		// The runner is a systemd user service; lingering starts it at boot, with nobody logged in.
		'sudo loginctl enable-linger "$(id -un)"',
		'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
		'for _ in $(seq 30); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 1; done',
		`${cli} install-service`,
		"sync",
	].join("\n");
};

const updateRunner = (
	workflowRunnerId: string,
	values: Partial<typeof workflowRunners.$inferInsert>,
) =>
	db
		.update(workflowRunners)
		.set(values)
		.where(eq(workflowRunners.workflowRunnerId, workflowRunnerId));

/** Creates a fresh Boat machine for the runner, installs and registers the runner on it, then stops it unless a run is waiting. */
const provision = async (
	runner: WorkflowRunner,
	settings: BoatSettings,
	{ keepRunning }: { keepRunning: boolean },
) => {
	const client = new BoatClient(settings.apiKey);
	if (runner.boatSandboxId) {
		await client.deleteSandbox(runner.boatSandboxId).catch(() => {});
	}
	let sandboxId: string | undefined;
	try {
		const sandbox = await client.createSandbox({
			type: settings.workflowMachineType,
			name: `Dokploy runner ${runner.name}`,
			ttlSeconds: MACHINE_TTL_SECONDS,
			labels: { dokploy: "runner" },
		});
		sandboxId = sandbox.id;
		await updateRunner(runner.workflowRunnerId, {
			boatSandboxId: sandbox.id,
			boatStatus: "provisioning",
			boatError: null,
			boatLastActiveAt: new Date().toISOString(),
		});
		const { target } = await connectToBoatSandbox(client, sandbox.id);
		const { registrationToken } = await regenerateRunnerRegistration(
			runner.workflowRunnerId,
			runner.organizationId,
		);
		const tail: string[] = [];
		const collect = (chunk: string) => {
			tail.push(...chunk.split("\n").filter(Boolean));
			tail.splice(0, Math.max(0, tail.length - 20));
		};
		const exitCode = await runRemoteScript({
			target,
			script: boatRunnerSetupScript(await getDokployUrl(), registrationToken),
			onStdout: collect,
			onStderr: collect,
		});
		if (exitCode !== 0) {
			throw new Error(
				`Setting up the runner failed with exit code ${exitCode}:\n${tail.join("\n")}`,
			);
		}
		await updateRunner(runner.workflowRunnerId, { boatStatus: "ready" });
		if (!keepRunning) await client.stopSandbox(sandbox.id);
	} catch (error) {
		await updateRunner(runner.workflowRunnerId, {
			boatStatus: "failed",
			boatError: errorText(error),
		});
		if (sandboxId) await client.stopSandbox(sandboxId).catch(() => {});
	}
};

const exclusively = async (
	workflowRunnerId: string,
	work: () => Promise<void>,
) => {
	if (busy.has(workflowRunnerId)) return;
	busy.add(workflowRunnerId);
	try {
		await work();
	} finally {
		busy.delete(workflowRunnerId);
	}
};

const findRunner = (workflowRunnerId: string) =>
	db.query.workflowRunners.findFirst({
		where: eq(workflowRunners.workflowRunnerId, workflowRunnerId),
	});

/** Sets up (or rebuilds) the runner's Boat machine in the background. */
export const startBoatRunnerProvisioning = async (
	workflowRunnerId: string,
	organizationId: string,
) => {
	await findOwnedRunner(workflowRunnerId, organizationId);
	const settings = await requireBoatSettings(organizationId);
	if (busy.has(workflowRunnerId)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "The runner's Boat machine is busy starting or being set up.",
		});
	}
	await updateRunner(workflowRunnerId, {
		boatStatus: "provisioning",
		boatError: null,
	});
	exclusively(workflowRunnerId, async () => {
		const runner = await findRunner(workflowRunnerId);
		if (runner) await provision(runner, settings, { keepRunning: false });
	}).catch((error) =>
		console.error(`Failed to set up Boat runner ${workflowRunnerId}`, error),
	);
};

const wake = (runner: WorkflowRunner, settings: BoatSettings) =>
	exclusively(runner.workflowRunnerId, async () => {
		await updateRunner(runner.workflowRunnerId, {
			boatLastActiveAt: new Date().toISOString(),
		});
		const client = new BoatClient(settings.apiKey);
		try {
			const sandbox = await client.getSandbox(runner.boatSandboxId!);
			if (STOPPED_STATES.has(sandbox.state)) {
				await client.resumeSandbox(
					runner.boatSandboxId!,
					settings.workflowMachineType,
				);
			}
		} catch (error) {
			// Boat deletes the disk of a machine stopped for over 14 days, so build a new one.
			if (!isGone(error)) throw error;
			await provision(runner, settings, { keepRunning: true });
		}
	});

const stop = (runner: WorkflowRunner, settings: BoatSettings) =>
	exclusively(runner.workflowRunnerId, async () => {
		await new BoatClient(settings.apiKey)
			.stopSandbox(runner.boatSandboxId!)
			.catch((error) => {
				if (!isGone(error)) throw error;
			});
	});

/** Whether the runner has a run in progress or a queued run it could claim. */
const hasWork = async (runner: WorkflowRunner) => {
	const result = await db.execute<{ found: boolean }>(sql`
		SELECT EXISTS (
			SELECT 1 FROM workflow_run r
			JOIN workflow_repository repo ON repo."workflowRepositoryId" = r."workflowRepositoryId"
			WHERE (r."status" = 'in_progress' AND r."workflowRunnerId" = ${runner.workflowRunnerId})
				OR (r."status" = 'queued'
					AND r."requiresRunner"
					AND repo."organizationId" = ${runner.organizationId}
					AND r."runsOn" && ${sql.param(runner.labels)}::text[]
					AND (cardinality(${sql.param(runner.allowedRepositoryIds)}::text[]) = 0
						OR r."workflowRepositoryId" = ANY(${sql.param(runner.allowedRepositoryIds)}::text[])))
		) AS found
	`);
	return !!result[0]?.found;
};

const boatRunners = () =>
	db.query.workflowRunners.findMany({
		where: and(
			isNotNull(workflowRunners.boatSandboxId),
			eq(workflowRunners.boatStatus, "ready"),
		),
	});

/** Runs every minute: wakes Boat runners that have work and stops the ones idle for 10 minutes. */
export const syncBoatRunners = async () => {
	const idleBefore = Date.now() - IDLE_STOP_MS;
	for (const runner of await boatRunners()) {
		const settings = await findBoatSettings(runner.organizationId);
		if (!settings) continue;
		try {
			if (await hasWork(runner)) {
				if (!isRunnerOnline(runner)) await wake(runner, settings);
				else
					await updateRunner(runner.workflowRunnerId, {
						boatLastActiveAt: new Date().toISOString(),
					});
			} else if (
				isRunnerOnline(runner) &&
				Date.parse(runner.boatLastActiveAt ?? "") < idleBefore
			) {
				await stop(runner, settings);
			}
		} catch (error) {
			console.error(`Failed to sync Boat runner ${runner.name}`, error);
		}
	}
};

/** Wakes a Boat runner for a newly queued run, unless a matching runner is already online. */
export const wakeBoatRunnerForRun = async (run: {
	organizationId: string;
	workflowRepositoryId: string;
	runsOn: string[];
}) => {
	const candidates = await db.query.workflowRunners.findMany({
		where: and(
			eq(workflowRunners.organizationId, run.organizationId),
			isNull(workflowRunners.ephemeralRunId),
			sql`${workflowRunners.labels} && ${sql.param(run.runsOn)}::text[]`,
			sql`(cardinality(${workflowRunners.allowedRepositoryIds}) = 0 OR ${run.workflowRepositoryId} = ANY(${workflowRunners.allowedRepositoryIds}))`,
		),
	});
	if (candidates.some(isRunnerOnline)) return;
	const runner = candidates.find(
		(candidate) => candidate.boatSandboxId && candidate.boatStatus === "ready",
	);
	if (!runner) return;
	const settings = await findBoatSettings(runner.organizationId);
	if (settings) await wake(runner, settings);
};

/** Deletes the runner's Boat machine, if it has one. */
export const deleteBoatRunnerMachine = async (runner: WorkflowRunner) => {
	if (!runner.boatSandboxId) return;
	const settings = await findBoatSettings(runner.organizationId);
	if (!settings) return;
	await new BoatClient(settings.apiKey)
		.deleteSandbox(runner.boatSandboxId)
		.catch((error) =>
			console.error(
				`Failed to delete Boat sandbox ${runner.boatSandboxId}`,
				error,
			),
		);
};

/** At startup no setup is running, so a runner still marked as provisioning was interrupted. */
export const initBoatRunners = async () => {
	await db
		.update(workflowRunners)
		.set({
			boatStatus: "failed",
			boatError: "Dokploy restarted while setting up this runner. Retry it.",
		})
		.where(eq(workflowRunners.boatStatus, "provisioning"));
};
