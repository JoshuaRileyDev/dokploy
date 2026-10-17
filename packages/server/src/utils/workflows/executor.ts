import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type WorkflowJobStatus,
	type WorkflowRunStatus,
	type WorkflowStepState,
	workflowJobs,
	workflowRuns,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { findServerById } from "../../services/server";
import {
	authGithub,
	getGithubToken,
	normalizeGithubUrl,
} from "../providers/github";
import {
	buildActCancelScript,
	buildActCleanupScript,
	buildActRunScript,
} from "./act";
import { ActLogProcessor, jobDisplayName, LineBuffer } from "./act-log";
import { runRemoteScript, type SshTarget } from "./ssh";

const MAX_RUN_DURATION_MS = 6 * 60 * 60 * 1000;

export const workflowLogsDirectory = (workflowRunId: string) =>
	path.join(paths().LOGS_PATH, "workflows", workflowRunId);

type JobState = {
	workflowJobId: string;
	jobId: string;
	status: WorkflowJobStatus;
	steps: WorkflowStepState[];
	log: WriteStream;
};

const loadRun = (workflowRunId: string) =>
	db.query.workflowRuns.findFirst({
		where: eq(workflowRuns.workflowRunId, workflowRunId),
		with: { repository: { with: { github: true } } },
	});

export const createSecretMasker = (secrets: string[]) => {
	const values = secrets
		.filter((secret) => secret.length >= 4)
		.sort((a, b) => b.length - a.length);
	return (line: string) =>
		values.reduce((masked, secret) => masked.split(secret).join("***"), line);
};

const finalRunStatus = (
	exitCode: number,
	jobs: JobState[],
	cancelled: boolean,
): WorkflowRunStatus => {
	if (cancelled) return "cancelled";
	if (jobs.some((job) => job.status === "failure")) return "failure";
	return exitCode === 0 ? "success" : "failure";
};

/** Runs one workflow run to completion on its server with act and records jobs, steps and logs as it goes. */
export const executeWorkflowRun = async (
	workflowRunId: string,
	signal: AbortSignal,
) => {
	const run = await loadRun(workflowRunId);
	if (!run || run.status !== "queued" || !run.serverId) return;

	const logsDir = workflowLogsDirectory(workflowRunId);
	mkdirSync(logsDir, { recursive: true });
	const runLogPath = path.join(logsDir, "run.log");
	const runLog = createWriteStream(runLogPath, { flags: "a" });
	const jobs = new Map<string, JobState>();
	let mask = (line: string) => line;
	const stderrTail: string[] = [];

	const write = (stream: WriteStream, line: string) =>
		stream.write(`${new Date().toISOString()} ${mask(line)}\n`);

	await db
		.update(workflowRuns)
		.set({
			status: "in_progress",
			startedAt: new Date().toISOString(),
			logPath: runLogPath,
			errorMessage: null,
		})
		.where(eq(workflowRuns.workflowRunId, workflowRunId));

	let exitCode = 1;
	let errorMessage: string | null = null;
	const timeout = AbortSignal.timeout(MAX_RUN_DURATION_MS);
	const combined = AbortSignal.any([signal, timeout]);

	try {
		const server = await findServerById(run.serverId);
		if (!server.sshKey?.privateKey) {
			throw new Error(`Server ${server.name} has no SSH key`);
		}
		const github = run.repository.github;
		if (!github)
			throw new Error("The repository's GitHub provider was removed");

		const token = await getGithubToken(authGithub(github));
		const base = new URL(normalizeGithubUrl(github.githubUrl));
		const secrets: Record<string, string> = run.trusted
			? { GITHUB_TOKEN: token }
			: {};
		mask = createSecretMasker([token, ...Object.values(secrets)]);

		const { owner, repository } = run.repository;
		const script = buildActRunScript({
			runId: workflowRunId,
			cloneUrl: `${base.protocol}//x-access-token:${token}@${base.host}/${owner}/${repository}.git`,
			remoteUrl: `${base.origin}/${owner}/${repository}.git`,
			githubInstance: base.host === "github.com" ? undefined : base.host,
			sha: run.sha,
			event: run.event,
			workflowPath: run.workflowPath,
			defaultBranch: run.repository.defaultBranch,
			actor: run.actor ?? "dokploy",
			eventPayload: run.payload,
			secrets,
			variables: {},
			inputs: run.inputs ?? {},
			trusted: run.trusted,
		});

		const target: SshTarget = {
			ipAddress: server.ipAddress,
			port: server.port,
			username: server.username,
			privateKey: server.sshKey.privateKey,
		};

		write(
			runLog,
			`Running ${run.workflowPath} at ${run.sha.slice(0, 7)} on ${server.name}`,
		);

		const processor = new ActLogProcessor();
		const stdout = new LineBuffer();
		const stderr = new LineBuffer();
		let pending = Promise.resolve();

		// act reports jobs it was told to stop as failed; show them as cancelled instead.
		const resultAfterAbort = <T extends WorkflowJobStatus>(result: T) =>
			combined.aborted && result === "failure" ? "cancelled" : result;

		const persistJob = (
			job: JobState,
			values: Partial<typeof workflowJobs.$inferInsert> = {},
		) =>
			db
				.update(workflowJobs)
				.set({ status: job.status, steps: job.steps, ...values })
				.where(eq(workflowJobs.workflowJobId, job.workflowJobId));

		const handleLine = async (line: string) => {
			for (const event of processor.process(line)) {
				if (event.type === "log") {
					const job = event.key ? jobs.get(event.key) : undefined;
					write(job?.log ?? runLog, event.line);
					continue;
				}
				if (event.type === "job_started") {
					const position = jobs.size;
					const jobLogPath = path.join(logsDir, `job-${position}.log`);
					const [row] = await db
						.insert(workflowJobs)
						.values({
							workflowRunId,
							actKey: event.key,
							jobId: event.jobId,
							name: mask(
								jobDisplayName(
									run.jobNames[event.jobId] ?? event.jobId,
									event.matrix,
								),
							),
							matrix: event.matrix,
							status: "in_progress",
							logPath: jobLogPath,
							position,
							startedAt: new Date().toISOString(),
						})
						.returning();
					jobs.set(event.key, {
						workflowJobId: row!.workflowJobId,
						jobId: event.jobId,
						status: "in_progress",
						steps: [],
						log: createWriteStream(jobLogPath, { flags: "a" }),
					});
					continue;
				}
				const job = jobs.get(event.key);
				if (!job) continue;
				if (event.type === "step_started") {
					job.steps.push({
						key: event.stepKey,
						name: mask(event.name),
						status: "in_progress",
						startedAt: new Date().toISOString(),
					});
					await persistJob(job);
				} else if (event.type === "step_finished") {
					const step = [...job.steps]
						.reverse()
						.find((s) => s.key === event.stepKey);
					if (step) {
						step.status = resultAfterAbort(event.result);
						step.durationMs = event.durationMs;
					}
					await persistJob(job);
				} else if (event.type === "job_finished") {
					job.status = resultAfterAbort(event.result);
					await persistJob(job, { finishedAt: new Date().toISOString() });
				}
			}
		};

		// Lines are handled strictly in order so job rows exist before their step updates arrive.
		const enqueueLines = (lines: string[]) => {
			for (const line of lines) {
				pending = pending
					.then(() => handleLine(line))
					.catch((error) => {
						console.error("Failed to record workflow output", error);
					});
			}
		};

		exitCode = await runRemoteScript({
			target,
			script,
			signal: combined,
			onAbortScript: buildActCancelScript(workflowRunId),
			onStdout: (chunk) => enqueueLines(stdout.push(chunk)),
			onStderr: (chunk) => {
				const lines = stderr.push(chunk);
				stderrTail.push(...lines);
				stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
				enqueueLines(lines);
			},
		});
		enqueueLines([...stdout.flush(), ...stderr.flush()]);
		await pending;

		await runRemoteScript({
			target,
			script: buildActCleanupScript(workflowRunId),
		}).catch((error) => write(runLog, `Cleanup failed: ${error.message}`));

		if (exitCode !== 0 && jobs.size === 0 && !combined.aborted) {
			errorMessage =
				mask(stderrTail.join("\n").trim()) ||
				`act exited with code ${exitCode}`;
		}
	} catch (error) {
		errorMessage = mask(error instanceof Error ? error.message : String(error));
		write(runLog, errorMessage);
	}

	if (timeout.aborted) {
		errorMessage = "The run exceeded the 6 hour limit and was stopped.";
	}

	const cancelled = signal.aborted;
	const leftoverStatus: WorkflowJobStatus = combined.aborted
		? "cancelled"
		: "failure";
	const finishedAt = new Date().toISOString();
	for (const job of jobs.values()) {
		if (job.status === "in_progress") {
			job.status = leftoverStatus;
			for (const step of job.steps) {
				if (step.status === "in_progress") step.status = leftoverStatus;
			}
			await db
				.update(workflowJobs)
				.set({ status: job.status, steps: job.steps, finishedAt })
				.where(eq(workflowJobs.workflowJobId, job.workflowJobId));
		}
		job.log.end();
	}

	// act doesn't report jobs it never started (failed dependencies or false `if:`), so record them as skipped.
	const startedJobIds = new Set([...jobs.values()].map((job) => job.jobId));
	if (jobs.size > 0) {
		let position = jobs.size;
		for (const [jobId, name] of Object.entries(run.jobNames)) {
			if (startedJobIds.has(jobId)) continue;
			await db.insert(workflowJobs).values({
				workflowRunId,
				actKey: jobId,
				jobId,
				name,
				status: combined.aborted ? "cancelled" : "skipped",
				logPath: path.join(logsDir, `job-${position}.log`),
				position: position++,
			});
		}
	}

	const status =
		errorMessage && !cancelled
			? "failure"
			: finalRunStatus(exitCode, [...jobs.values()], cancelled);
	write(runLog, `Run finished: ${status}`);
	runLog.end();

	await db
		.update(workflowRuns)
		.set({ status, errorMessage, finishedAt })
		.where(eq(workflowRuns.workflowRunId, workflowRunId));
};
