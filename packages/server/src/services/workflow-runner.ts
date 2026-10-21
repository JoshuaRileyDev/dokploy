import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	type apiCreateWorkflowRunner,
	type apiUpdateWorkflowRunner,
	workflowRepositories,
	workflowRunners,
	workflowRuns,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	buildActRunScript,
	DEFAULT_PLATFORM_IMAGES,
} from "../utils/workflows/act";
import { syncWorkflowCheckRun } from "../utils/workflows/check-runs";
import {
	prepareRunInputs,
	RunRecorder,
	workflowLogsDirectory,
} from "../utils/workflows/run-recorder";
import { resolveWorkflowEnv } from "./workflow";

export type WorkflowRunner = typeof workflowRunners.$inferSelect;

const REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000;
/** A runner that hasn't polled for this long is shown as offline. */
export const RUNNER_ONLINE_WINDOW_MS = 60 * 1000;
/** In-progress runs on a runner that has been silent this long are failed. */
const RUNNER_STALE_MS = 3 * 60 * 1000;

const generateToken = (prefix: string) =>
	`${prefix}_${randomBytes(32).toString("base64url")}`;

export const hashRunnerToken = (token: string) =>
	createHash("sha256").update(token).digest("hex");

export const isRunnerOnline = (runner: Pick<WorkflowRunner, "lastSeenAt">) =>
	!!runner.lastSeenAt &&
	Date.now() - Date.parse(runner.lastSeenAt) < RUNNER_ONLINE_WINDOW_MS;

const newRegistrationToken = () => {
	const token = generateToken("dkr_reg");
	return {
		token,
		registrationTokenHash: hashRunnerToken(token),
		registrationExpiresAt: new Date(
			Date.now() + REGISTRATION_TOKEN_TTL_MS,
		).toISOString(),
	};
};

const normalizeLabels = (labels: string[]) => [
	...new Set(labels.map((label) => label.trim()).filter(Boolean)),
];

export const findWorkflowRunners = async (organizationId: string) => {
	const runners = await db.query.workflowRunners.findMany({
		where: eq(workflowRunners.organizationId, organizationId),
		orderBy: desc(workflowRunners.createdAt),
	});
	const active = runners.length
		? await db.query.workflowRuns.findMany({
				where: and(
					eq(workflowRuns.status, "in_progress"),
					inArray(
						workflowRuns.workflowRunnerId,
						runners.map((runner) => runner.workflowRunnerId),
					),
				),
				columns: {
					workflowRunId: true,
					workflowRunnerId: true,
					workflowName: true,
					runNumber: true,
				},
			})
		: [];
	return runners.map(({ tokenHash, registrationTokenHash, ...runner }) => ({
		...runner,
		registered: !!tokenHash,
		online: isRunnerOnline(runner),
		currentRun:
			active.find((run) => run.workflowRunnerId === runner.workflowRunnerId) ??
			null,
	}));
};

const findOwnedRunner = async (
	workflowRunnerId: string,
	organizationId: string,
) => {
	const runner = await db.query.workflowRunners.findFirst({
		where: and(
			eq(workflowRunners.workflowRunnerId, workflowRunnerId),
			eq(workflowRunners.organizationId, organizationId),
		),
	});
	if (!runner) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Runner not found" });
	}
	return runner;
};

const assertRepositoriesInOrganization = async (
	repositoryIds: string[],
	organizationId: string,
) => {
	if (repositoryIds.length === 0) return;
	const found = await db.query.workflowRepositories.findMany({
		where: and(
			eq(workflowRepositories.organizationId, organizationId),
			inArray(workflowRepositories.workflowRepositoryId, repositoryIds),
		),
		columns: { workflowRepositoryId: true },
	});
	if (found.length !== new Set(repositoryIds).size) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown repository" });
	}
};

/** Creates a runner and returns its one-time registration token, which is never stored in plain text. */
export const createWorkflowRunner = async (
	input: z.infer<typeof apiCreateWorkflowRunner>,
	organizationId: string,
) => {
	await assertRepositoriesInOrganization(
		input.allowedRepositoryIds,
		organizationId,
	);
	const { token, ...registration } = newRegistrationToken();
	const [runner] = await db
		.insert(workflowRunners)
		.values({
			organizationId,
			name: input.name,
			labels: normalizeLabels(input.labels),
			allowedRepositoryIds: input.allowedRepositoryIds,
			...registration,
		})
		.returning();
	return {
		workflowRunnerId: runner!.workflowRunnerId,
		registrationToken: token,
	};
};

export const updateWorkflowRunner = async (
	input: z.infer<typeof apiUpdateWorkflowRunner>,
	organizationId: string,
) => {
	await findOwnedRunner(input.workflowRunnerId, organizationId);
	await assertRepositoriesInOrganization(
		input.allowedRepositoryIds,
		organizationId,
	);
	await db
		.update(workflowRunners)
		.set({
			name: input.name,
			labels: normalizeLabels(input.labels),
			allowedRepositoryIds: input.allowedRepositoryIds,
		})
		.where(eq(workflowRunners.workflowRunnerId, input.workflowRunnerId));
};

/** Issues a fresh registration token; registering with it replaces the runner's current credential. */
export const regenerateRunnerRegistration = async (
	workflowRunnerId: string,
	organizationId: string,
) => {
	await findOwnedRunner(workflowRunnerId, organizationId);
	const { token, ...registration } = newRegistrationToken();
	await db
		.update(workflowRunners)
		.set(registration)
		.where(eq(workflowRunners.workflowRunnerId, workflowRunnerId));
	return { registrationToken: token };
};

export const removeWorkflowRunner = async (
	workflowRunnerId: string,
	organizationId: string,
) => {
	await findOwnedRunner(workflowRunnerId, organizationId);
	await db
		.delete(workflowRunners)
		.where(eq(workflowRunners.workflowRunnerId, workflowRunnerId));
};

/** Swaps a one-time registration token for the runner's long-lived credential. */
export const registerWorkflowRunner = async ({
	registrationToken,
	os,
	arch,
	version,
}: {
	registrationToken: string;
	os?: string;
	arch?: string;
	version?: string;
}) => {
	const runner = await db.query.workflowRunners.findFirst({
		where: eq(
			workflowRunners.registrationTokenHash,
			hashRunnerToken(registrationToken),
		),
	});
	if (
		!runner?.registrationExpiresAt ||
		Date.parse(runner.registrationExpiresAt) < Date.now()
	) {
		return null;
	}
	const token = generateToken("dkr");
	await db
		.update(workflowRunners)
		.set({
			tokenHash: hashRunnerToken(token),
			registrationTokenHash: null,
			registrationExpiresAt: null,
			lastSeenAt: new Date().toISOString(),
			os: os ?? null,
			arch: arch ?? null,
			version: version ?? null,
		})
		.where(eq(workflowRunners.workflowRunnerId, runner.workflowRunnerId));
	return {
		workflowRunnerId: runner.workflowRunnerId,
		name: runner.name,
		labels: runner.labels,
		token,
	};
};

export const authenticateWorkflowRunner = async (token: string) => {
	const runner = await db.query.workflowRunners.findFirst({
		where: eq(workflowRunners.tokenHash, hashRunnerToken(token)),
	});
	if (!runner) return null;
	await db
		.update(workflowRunners)
		.set({ lastSeenAt: new Date().toISOString() })
		.where(eq(workflowRunners.workflowRunnerId, runner.workflowRunnerId));
	return runner;
};

/** Labels a runner serves that aren't Linux runner images run directly on the runner's machine. */
export const runnerPlatformImages = (labels: string[]) =>
	Object.fromEntries(
		labels
			.filter(
				(label) =>
					label === "self-hosted" || !(label in DEFAULT_PLATFORM_IMAGES),
			)
			.map((label) => [label, "-self-hosted"]),
	);

/** Whether some runner in the organization could take a run with these runs-on labels. */
export const hasMatchingRunner = async ({
	organizationId,
	workflowRepositoryId,
	runsOn,
}: {
	organizationId: string;
	workflowRepositoryId: string;
	runsOn: string[];
}) => {
	if (runsOn.length === 0) return false;
	const [match] = await db
		.select({ workflowRunnerId: workflowRunners.workflowRunnerId })
		.from(workflowRunners)
		.where(
			and(
				eq(workflowRunners.organizationId, organizationId),
				sql`${workflowRunners.labels} && ${sql.param(runsOn)}::text[]`,
				sql`(cardinality(${workflowRunners.allowedRepositoryIds}) = 0 OR ${workflowRepositoryId} = ANY(${workflowRunners.allowedRepositoryIds}))`,
			),
		)
		.limit(1);
	return !!match;
};

type ActiveRecording = { recorder: RunRecorder };

// Recorders hold parsing state between a runner's event batches, so they live for the whole run.
const globalForRecorders = globalThis as unknown as {
	__dokployRunnerRecorders?: Map<string, Promise<ActiveRecording | null>>;
};
globalForRecorders.__dokployRunnerRecorders ??= new Map();
const recorders = globalForRecorders.__dokployRunnerRecorders;

const recordingFor = (workflowRunId: string) => {
	let entry = recorders.get(workflowRunId);
	if (!entry) {
		entry = (async () => {
			const recorder = await RunRecorder.resume(workflowRunId);
			if (!recorder) return null;
			// After a Dokploy restart the original installation token is unknown, but configured secrets can still be masked.
			const { secrets } = await resolveWorkflowEnv(
				recorder.run.workflowRepositoryId,
			);
			recorder.setMaskValues(Object.values(secrets));
			return { recorder };
		})();
		recorders.set(workflowRunId, entry);
	}
	return entry;
};

/** Atomically assigns the oldest queued run this runner can take, and returns the script to run it. */
export const claimRunForRunner = async (
	runner: WorkflowRunner,
	workDir: string,
) => {
	const logPath = (runId: string) =>
		path.join(workflowLogsDirectory(runId), "run.log");
	const claimed = await db.execute<{ workflowRunId: string }>(sql`
		UPDATE ${workflowRuns}
		SET "status" = 'in_progress',
			"workflowRunnerId" = ${runner.workflowRunnerId},
			"startedAt" = ${new Date().toISOString()},
			"errorMessage" = NULL
		WHERE "workflowRunId" = (
			SELECT r."workflowRunId"
			FROM ${workflowRuns} r
			JOIN ${workflowRepositories} repo ON repo."workflowRepositoryId" = r."workflowRepositoryId"
			WHERE r."status" = 'queued'
				AND r."requiresRunner"
				AND repo."organizationId" = ${runner.organizationId}
				AND r."runsOn" && ${sql.param(runner.labels)}::text[]
				AND (cardinality(${sql.param(runner.allowedRepositoryIds)}::text[]) = 0
					OR r."workflowRepositoryId" = ANY(${sql.param(runner.allowedRepositoryIds)}::text[]))
				AND NOT EXISTS (
					SELECT 1 FROM ${workflowRuns} other
					WHERE other."status" = 'in_progress'
						AND other."concurrencyGroup" IS NOT NULL
						AND other."concurrencyGroup" = r."concurrencyGroup"
						AND other."workflowRepositoryId" = r."workflowRepositoryId"
				)
			ORDER BY r."createdAt"
			LIMIT 1
			FOR UPDATE OF r SKIP LOCKED
		)
		RETURNING "workflowRunId"
	`);
	const workflowRunId = claimed[0]?.workflowRunId;
	if (!workflowRunId) return null;

	await db
		.update(workflowRuns)
		.set({ logPath: logPath(workflowRunId) })
		.where(eq(workflowRuns.workflowRunId, workflowRunId));
	syncWorkflowCheckRun(workflowRunId);

	recorders.delete(workflowRunId);
	const recording = await recordingFor(workflowRunId);
	if (!recording) return null;
	const { recorder } = recording;
	try {
		const { scriptInput, maskValues } = await prepareRunInputs(recorder.run);
		recorder.setMaskValues(maskValues);
		recorder.log(
			`Running ${recorder.run.workflowPath} at ${recorder.run.sha.slice(0, 7)} on runner ${runner.name}`,
		);
		const script = buildActRunScript({
			...scriptInput,
			baseDir: workDir,
			platformImages: runnerPlatformImages(runner.labels),
		});
		return {
			workflowRunId,
			workflowName: recorder.run.workflowName,
			runNumber: recorder.run.runNumber,
			repository: `${recorder.run.repository.owner}/${recorder.run.repository.repository}`,
			script,
			maskValues,
		};
	} catch (error) {
		await completeRunnerRun(runner, workflowRunId, {
			exitCode: 1,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
};

const findRunnerRun = async (runner: WorkflowRunner, workflowRunId: string) => {
	const run = await db.query.workflowRuns.findFirst({
		where: and(
			eq(workflowRuns.workflowRunId, workflowRunId),
			eq(workflowRuns.workflowRunnerId, runner.workflowRunnerId),
		),
		columns: { status: true, cancelRequested: true },
	});
	if (!run) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
	}
	return run;
};

export type RunnerOutputLine = { stream: "stdout" | "stderr"; line: string };

/** Records a batch of output from a runner and tells it whether the run was cancelled. */
export const recordRunnerEvents = async (
	runner: WorkflowRunner,
	workflowRunId: string,
	lines: RunnerOutputLine[],
) => {
	const run = await findRunnerRun(runner, workflowRunId);
	if (run.status !== "in_progress") return { cancel: true };
	const recording = await recordingFor(workflowRunId);
	if (!recording) return { cancel: true };
	if (run.cancelRequested) recording.recorder.markAborting();
	for (const { stream, line } of lines) {
		recording.recorder.pushLines(stream, [line]);
	}
	await recording.recorder.flush();
	return { cancel: run.cancelRequested };
};

export const completeRunnerRun = async (
	runner: WorkflowRunner,
	workflowRunId: string,
	{
		exitCode,
		errorMessage = null,
	}: { exitCode: number; errorMessage?: string | null },
) => {
	const run = await findRunnerRun(runner, workflowRunId);
	if (run.status !== "in_progress") return;
	const recording = await recordingFor(workflowRunId);
	recorders.delete(workflowRunId);
	if (!recording) return;
	await recording.recorder.finish({
		exitCode,
		cancelled: run.cancelRequested,
		errorMessage,
	});
};

/** Fails in-progress runs whose runner stopped polling, e.g. because the machine went to sleep or lost its connection. */
export const failStaleRunnerRuns = async () => {
	const cutoff = new Date(Date.now() - RUNNER_STALE_MS).toISOString();
	const stale = await db
		.select({
			workflowRunId: workflowRuns.workflowRunId,
			runnerName: workflowRunners.name,
		})
		.from(workflowRuns)
		.innerJoin(
			workflowRunners,
			eq(workflowRuns.workflowRunnerId, workflowRunners.workflowRunnerId),
		)
		.where(
			and(
				eq(workflowRuns.status, "in_progress"),
				isNotNull(workflowRuns.workflowRunnerId),
				lt(workflowRunners.lastSeenAt, cutoff),
			),
		);
	for (const { workflowRunId, runnerName } of stale) {
		const recording = await recordingFor(workflowRunId);
		recorders.delete(workflowRunId);
		await recording?.recorder.finish({
			exitCode: 1,
			cancelled: false,
			errorMessage: `Runner ${runnerName} stopped responding.`,
		});
	}
};
