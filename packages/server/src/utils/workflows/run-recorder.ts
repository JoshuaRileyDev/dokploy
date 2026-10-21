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
import { resolveWorkflowEnv } from "../../services/workflow";
import {
	authGithub,
	getGithubToken,
	normalizeGithubUrl,
} from "../providers/github";
import type { ActRunScriptInput } from "./act";
import { ActLogProcessor, jobDisplayName, LineBuffer } from "./act-log";
import { syncWorkflowCheckRun } from "./check-runs";
import { sendWorkflowRunNotifications } from "./notifications";

export const workflowLogsDirectory = (workflowRunId: string) =>
	path.join(paths().LOGS_PATH, "workflows", workflowRunId);

export const createSecretMasker = (secrets: string[]) => {
	const values = secrets
		.filter((secret) => secret.length >= 4)
		.sort((a, b) => b.length - a.length);
	return (line: string) =>
		values.reduce((masked, secret) => masked.split(secret).join("***"), line);
};

const loadRun = (workflowRunId: string) =>
	db.query.workflowRuns.findFirst({
		where: eq(workflowRuns.workflowRunId, workflowRunId),
		with: { repository: { with: { github: true } } },
	});

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

/** Everything a machine needs to run this workflow with act, plus the values to mask in its output. */
export const prepareRunInputs = async (run: LoadedRun) => {
	const github = run.repository.github;
	if (!github) throw new Error("The repository's GitHub provider was removed");

	const token = await getGithubToken(authGithub(github));
	const base = new URL(normalizeGithubUrl(github.githubUrl));
	const configured = run.trusted
		? await resolveWorkflowEnv(run.workflowRepositoryId)
		: { secrets: {}, variables: {} };
	const secrets: Record<string, string> = run.trusted
		? { ...configured.secrets, GITHUB_TOKEN: token }
		: {};
	const { owner, repository } = run.repository;

	const scriptInput: Omit<ActRunScriptInput, "baseDir" | "platformImages"> = {
		runId: run.workflowRunId,
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
		variables: configured.variables,
		inputs: run.inputs ?? {},
		trusted: run.trusted,
	};
	return { scriptInput, maskValues: [token, ...Object.values(secrets)] };
};

type JobState = {
	workflowJobId: string;
	jobId: string;
	status: WorkflowJobStatus;
	steps: WorkflowStepState[];
	log: WriteStream;
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

/**
 * Turns act's output for one run into job rows, step states and log files, then records the
 * outcome. Shared by the SSH executor and remote runners.
 */
export class RunRecorder {
	private readonly jobs = new Map<string, JobState>();
	private readonly stdout = new LineBuffer();
	private readonly stderr = new LineBuffer();
	private readonly stderrTail: string[] = [];
	private pending = Promise.resolve();
	private mask = (line: string) => line;
	private aborting = false;

	private constructor(
		readonly run: LoadedRun,
		private readonly logsDir: string,
		private readonly runLog: WriteStream,
		private readonly processor: ActLogProcessor,
	) {}

	/** Marks a queued run as started; returns null if it isn't queued any more. */
	static async start(
		workflowRunId: string,
		assignment: { serverId?: string; workflowRunnerId?: string } = {},
	) {
		const run = await loadRun(workflowRunId);
		if (run?.status !== "queued") return null;

		const logsDir = workflowLogsDirectory(workflowRunId);
		mkdirSync(logsDir, { recursive: true });
		const runLogPath = path.join(logsDir, "run.log");
		const [updated] = await db
			.update(workflowRuns)
			.set({
				status: "in_progress",
				startedAt: new Date().toISOString(),
				logPath: runLogPath,
				errorMessage: null,
				...assignment,
			})
			.where(eq(workflowRuns.workflowRunId, workflowRunId))
			.returning();
		syncWorkflowCheckRun(workflowRunId);

		return new RunRecorder(
			{ ...run, ...updated! },
			logsDir,
			createWriteStream(runLogPath, { flags: "a" }),
			new ActLogProcessor(),
		);
	}

	/** Picks an in-progress run back up from the database, e.g. after Dokploy restarted while a runner was working on it. */
	static async resume(workflowRunId: string) {
		const run = await loadRun(workflowRunId);
		if (run?.status !== "in_progress") return null;
		const logsDir = workflowLogsDirectory(workflowRunId);
		mkdirSync(logsDir, { recursive: true });
		const existing = await db.query.workflowJobs.findMany({
			where: eq(workflowJobs.workflowRunId, workflowRunId),
		});
		const recorder = new RunRecorder(
			run,
			logsDir,
			createWriteStream(path.join(logsDir, "run.log"), { flags: "a" }),
			new ActLogProcessor(existing.map((job) => job.actKey)),
		);
		for (const job of existing) {
			recorder.jobs.set(job.actKey, {
				workflowJobId: job.workflowJobId,
				jobId: job.jobId,
				status: job.status,
				steps: job.steps,
				log: createWriteStream(job.logPath, { flags: "a" }),
			});
		}
		return recorder;
	}

	setMaskValues(values: string[]) {
		this.mask = createSecretMasker(values);
	}

	/** From now on, failures act reports are recorded as cancellations, since act was told to stop. */
	markAborting() {
		this.aborting = true;
	}

	log(line: string) {
		this.write(this.runLog, line);
	}

	/** Accepts raw output chunks, which may split lines. */
	pushChunk(stream: "stdout" | "stderr", chunk: string) {
		this.pushLines(
			stream,
			(stream === "stdout" ? this.stdout : this.stderr).push(chunk),
		);
	}

	pushLines(stream: "stdout" | "stderr", lines: string[]) {
		if (stream === "stderr") {
			this.stderrTail.push(...lines);
			this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - 20));
		}
		// Lines are handled strictly in order so job rows exist before their step updates arrive.
		for (const line of lines) {
			this.pending = this.pending
				.then(() => this.handleLine(line))
				.catch((error) => {
					console.error("Failed to record workflow output", error);
				});
		}
	}

	async flush() {
		this.pushLines("stdout", this.stdout.flush());
		this.pushLines("stderr", this.stderr.flush());
		await this.pending;
	}

	private write(stream: WriteStream, line: string) {
		stream.write(`${new Date().toISOString()} ${this.mask(line)}\n`);
	}

	private resultAfterAbort<T extends WorkflowJobStatus>(result: T) {
		return this.aborting && result === "failure" ? "cancelled" : result;
	}

	private persistJob(
		job: JobState,
		values: Partial<typeof workflowJobs.$inferInsert> = {},
	) {
		return db
			.update(workflowJobs)
			.set({ status: job.status, steps: job.steps, ...values })
			.where(eq(workflowJobs.workflowJobId, job.workflowJobId));
	}

	private async handleLine(line: string) {
		for (const event of this.processor.process(line)) {
			if (event.type === "log") {
				const job = event.key ? this.jobs.get(event.key) : undefined;
				this.write(job?.log ?? this.runLog, event.line);
				continue;
			}
			if (event.type === "job_started") {
				const position = this.jobs.size;
				const jobLogPath = path.join(this.logsDir, `job-${position}.log`);
				const [row] = await db
					.insert(workflowJobs)
					.values({
						workflowRunId: this.run.workflowRunId,
						actKey: event.key,
						jobId: event.jobId,
						name: this.mask(
							jobDisplayName(
								this.run.jobNames[event.jobId] ?? event.jobId,
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
				this.jobs.set(event.key, {
					workflowJobId: row!.workflowJobId,
					jobId: event.jobId,
					status: "in_progress",
					steps: [],
					log: createWriteStream(jobLogPath, { flags: "a" }),
				});
				continue;
			}
			const job = this.jobs.get(event.key);
			if (!job) continue;
			if (event.type === "step_started") {
				job.steps.push({
					key: event.stepKey,
					// act evaluates expressions in step names, so they can contain secrets.
					name: this.mask(event.name),
					status: "in_progress",
					startedAt: new Date().toISOString(),
				});
				await this.persistJob(job);
			} else if (event.type === "step_finished") {
				const step = [...job.steps]
					.reverse()
					.find((s) => s.key === event.stepKey);
				if (step) {
					step.status = this.resultAfterAbort(event.result);
					step.durationMs = event.durationMs;
				}
				await this.persistJob(job);
			} else if (event.type === "job_finished") {
				job.status = this.resultAfterAbort(event.result);
				await this.persistJob(job, { finishedAt: new Date().toISOString() });
			}
		}
	}

	/** Records the outcome, closes the logs, and reports it to GitHub and notification channels. */
	async finish({
		exitCode,
		cancelled,
		errorMessage: providedError = null,
	}: {
		exitCode: number;
		cancelled: boolean;
		errorMessage?: string | null;
	}) {
		await this.flush();
		const stopped = cancelled || this.aborting;
		let errorMessage = providedError ? this.mask(providedError) : null;
		if (!errorMessage && exitCode !== 0 && this.jobs.size === 0 && !stopped) {
			errorMessage =
				this.mask(this.stderrTail.join("\n").trim()) ||
				`act exited with code ${exitCode}`;
		}
		if (errorMessage) this.log(errorMessage);

		const leftoverStatus: WorkflowJobStatus = stopped ? "cancelled" : "failure";
		const finishedAt = new Date().toISOString();
		for (const job of this.jobs.values()) {
			if (job.status === "in_progress") {
				job.status = leftoverStatus;
				for (const step of job.steps) {
					if (step.status === "in_progress") step.status = leftoverStatus;
				}
				await this.persistJob(job, { finishedAt });
			}
			job.log.end();
		}

		// act doesn't report jobs it never started (failed dependencies or false `if:`), so record them as skipped.
		const startedJobIds = new Set(
			[...this.jobs.values()].map((job) => job.jobId),
		);
		if (this.jobs.size > 0) {
			let position = this.jobs.size;
			for (const [jobId, name] of Object.entries(this.run.jobNames)) {
				if (startedJobIds.has(jobId)) continue;
				await db.insert(workflowJobs).values({
					workflowRunId: this.run.workflowRunId,
					actKey: jobId,
					jobId,
					name,
					status: stopped ? "cancelled" : "skipped",
					logPath: path.join(this.logsDir, `job-${position}.log`),
					position: position++,
				});
			}
		}

		const status =
			errorMessage && !cancelled
				? "failure"
				: finalRunStatus(exitCode, [...this.jobs.values()], cancelled);
		this.log(`Run finished: ${status}`);
		this.runLog.end();

		await db
			.update(workflowRuns)
			// A cancellation reason (e.g. from a concurrency group) was already stored on the run.
			.set({
				status,
				finishedAt,
				...(cancelled && !errorMessage ? {} : { errorMessage }),
			})
			.where(eq(workflowRuns.workflowRunId, this.run.workflowRunId));

		await syncWorkflowCheckRun(this.run.workflowRunId);
		await sendWorkflowRunNotifications(this.run.workflowRunId).catch((error) =>
			console.error("Failed to send workflow notifications", error),
		);
		return status;
	}
}
