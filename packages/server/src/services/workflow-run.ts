import { db } from "@dokploy/server/db";
import {
	server,
	type WorkflowRunStatus,
	workflowDefinitions,
	workflowRepositories,
	workflowRuns,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, arrayContains, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Octokit } from "octokit";
import { authGithub } from "../utils/providers/github";
import {
	type NormalizedGithubEvent,
	normalizeGithubEvent,
} from "../utils/workflows/events";
import {
	fetchWorkflowFiles,
	loadWorkflow,
	WORKFLOW_DIRECTORIES,
	type WorkflowSourceType,
} from "../utils/workflows/github";
import type { ParsedWorkflow } from "../utils/workflows/parser";
import {
	activeWorkflowRunCounts,
	cancelQueuedOrActiveRun,
	enqueueWorkflowRun,
} from "../utils/workflows/queue";
import { findMatchingTrigger } from "../utils/workflows/triggers";
import { findGithubById } from "./github";
import {
	findWorkflowRepositoriesByGithubRepo,
	syncWorkflowRepository,
	type WorkflowRepository,
} from "./workflow";

export type WorkflowRun = typeof workflowRuns.$inferSelect;

const FINISHED_STATUSES: WorkflowRunStatus[] = [
	"success",
	"failure",
	"cancelled",
	"skipped",
];

export const isFinishedRunStatus = (status: WorkflowRunStatus) =>
	FINISHED_STATUSES.includes(status);

export const findWorkflowRuns = async ({
	organizationId,
	workflowRepositoryId,
	status,
	limit,
}: {
	organizationId: string;
	workflowRepositoryId?: string;
	status?: WorkflowRunStatus;
	limit: number;
}) =>
	db
		.select({
			workflowRunId: workflowRuns.workflowRunId,
			workflowRepositoryId: workflowRuns.workflowRepositoryId,
			workflowName: workflowRuns.workflowName,
			workflowPath: workflowRuns.workflowPath,
			runNumber: workflowRuns.runNumber,
			attempt: workflowRuns.attempt,
			event: workflowRuns.event,
			eventAction: workflowRuns.eventAction,
			branch: workflowRuns.branch,
			ref: workflowRuns.ref,
			sha: workflowRuns.sha,
			title: workflowRuns.title,
			actor: workflowRuns.actor,
			status: workflowRuns.status,
			createdAt: workflowRuns.createdAt,
			startedAt: workflowRuns.startedAt,
			finishedAt: workflowRuns.finishedAt,
			owner: workflowRepositories.owner,
			repository: workflowRepositories.repository,
		})
		.from(workflowRuns)
		.innerJoin(
			workflowRepositories,
			eq(
				workflowRuns.workflowRepositoryId,
				workflowRepositories.workflowRepositoryId,
			),
		)
		.where(
			and(
				eq(workflowRepositories.organizationId, organizationId),
				workflowRepositoryId
					? eq(workflowRuns.workflowRepositoryId, workflowRepositoryId)
					: undefined,
				status ? eq(workflowRuns.status, status) : undefined,
			),
		)
		.orderBy(desc(workflowRuns.createdAt))
		.limit(limit);

export const findWorkflowRunById = async (workflowRunId: string) => {
	const run = await db.query.workflowRuns.findFirst({
		where: eq(workflowRuns.workflowRunId, workflowRunId),
		with: {
			repository: { with: { github: true } },
			server: { columns: { serverId: true, name: true } },
			jobs: { orderBy: (jobs, { asc }) => [asc(jobs.position)] },
		},
	});
	if (!run) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
	}
	return run;
};

/** Picks the repository's server, or the least busy workflow server in the organization. */
export const pickWorkflowServer = async (
	repository: Pick<WorkflowRepository, "organizationId" | "defaultServerId">,
) => {
	const candidates = await db.query.server.findMany({
		where: and(
			eq(server.organizationId, repository.organizationId),
			arrayContains(server.serverRoles, ["workflow"]),
			isNotNull(server.sshKeyId),
			eq(server.serverStatus, "active"),
			repository.defaultServerId
				? eq(server.serverId, repository.defaultServerId)
				: undefined,
		),
		columns: { serverId: true },
	});
	if (candidates.length === 0) return null;
	const load = activeWorkflowRunCounts();
	return candidates.reduce((best, candidate) =>
		(load.get(candidate.serverId) ?? 0) < (load.get(best.serverId) ?? 0)
			? candidate
			: best,
	).serverId;
};

type NewRun = Omit<
	typeof workflowRuns.$inferInsert,
	"workflowRunId" | "runNumber" | "serverId" | "status"
> & { runNumber?: number };

export const createWorkflowRun = async (
	values: NewRun,
	repository: Pick<WorkflowRepository, "organizationId" | "defaultServerId">,
	options: { skipReason?: string } = {},
) => {
	const serverId = options.skipReason
		? null
		: await pickWorkflowServer(repository);

	const run = await db.transaction(async (tx) => {
		// Serializes run numbering per workflow so concurrent deliveries can't share a number.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`${values.workflowRepositoryId}:${values.workflowPath}`}))`,
		);
		let runNumber = values.runNumber;
		if (runNumber === undefined) {
			const [row] = await tx
				.select({
					max: sql<number>`coalesce(max(${workflowRuns.runNumber}), 0)`,
				})
				.from(workflowRuns)
				.where(
					and(
						eq(workflowRuns.workflowRepositoryId, values.workflowRepositoryId),
						eq(workflowRuns.workflowPath, values.workflowPath),
					),
				);
			runNumber = Number(row?.max ?? 0) + 1;
		}
		const now = new Date().toISOString();
		const [created] = await tx
			.insert(workflowRuns)
			.values({
				...values,
				runNumber,
				serverId,
				status: options.skipReason || !serverId ? "skipped" : "queued",
				errorMessage:
					options.skipReason ??
					(serverId
						? null
						: "No workflow server is available. Add a server with the Workflows role, or check the repository's workflow server setting."),
				finishedAt: options.skipReason || !serverId ? now : null,
			})
			.returning();
		return created!;
	});

	if (run.status === "queued" && run.serverId) {
		enqueueWorkflowRun(run.workflowRunId, run.serverId);
	}
	return run;
};

const jobNamesOf = (workflow: ParsedWorkflow) =>
	Object.fromEntries(workflow.jobs.map((job) => [job.id, job.name]));

const enabledSources = (
	repository: WorkflowRepository,
): WorkflowSourceType[] => [
	...(repository.runDokployWorkflows ? (["dokploy"] as const) : []),
	...(repository.runGithubWorkflows ? (["github"] as const) : []),
];

const resolveSha = async (
	octokit: Octokit,
	event: NormalizedGithubEvent,
): Promise<string> => {
	if (event.sha) return event.sha;
	const { data } = await octokit.rest.repos.getCommit({
		owner: event.owner,
		repo: event.repository,
		ref: event.resolveRef ?? event.ref,
	});
	return data.sha;
};

const changedFilesLoader = (
	octokit: Octokit,
	event: NormalizedGithubEvent,
	defaultBranch: string,
) => {
	let cached: Promise<string[]> | undefined;
	return () => {
		cached ??= (async () => {
			if (event.name === "pull_request" && event.pullRequestNumber) {
				const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
					owner: event.owner,
					repo: event.repository,
					pull_number: event.pullRequestNumber,
					per_page: 100,
				});
				return files.map((file) => file.filename);
			}
			// A new branch has no "before" commit, so GitHub diffs it against the default branch.
			const base =
				event.beforeSha && !/^0+$/.test(event.beforeSha)
					? event.beforeSha
					: defaultBranch;
			const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
				owner: event.owner,
				repo: event.repository,
				basehead: `${base}...${event.sha}`,
			});
			return (data.files ?? []).map((file) => file.filename);
		})();
		return cached;
	};
};

/** Fork pull requests only run when the author can push to the repository, since workflow servers are long-lived machines. */
const forkSkipReason = async (
	octokit: Octokit,
	event: NormalizedGithubEvent,
) => {
	if (!event.isFork) return undefined;
	if (event.actor) {
		const permission = await octokit.rest.repos
			.getCollaboratorPermissionLevel({
				owner: event.owner,
				repo: event.repository,
				username: event.actor,
			})
			.then(({ data }) => data.permission)
			.catch(() => null);
		if (permission && ["admin", "maintain", "write"].includes(permission)) {
			return undefined;
		}
	}
	return `Skipped: pull request from a fork by ${event.actor ?? "an unknown user"}, who doesn't have write access to the repository.`;
};

const touchesWorkflowFiles = async (changedFiles: () => Promise<string[]>) => {
	const files = await changedFiles().catch(() => []);
	return files.some((file) =>
		Object.values(WORKFLOW_DIRECTORIES).some((dir) =>
			file.startsWith(`${dir}/`),
		),
	);
};

const queueRunsForRepository = async (
	repository: WorkflowRepository,
	octokit: Octokit,
	event: NormalizedGithubEvent,
	payload: Record<string, unknown>,
) => {
	const sha = await resolveSha(octokit, event);
	const changedFiles = changedFilesLoader(
		octokit,
		{ ...event, sha },
		repository.defaultBranch,
	);

	if (
		event.name === "push" &&
		event.branch === repository.defaultBranch &&
		(await touchesWorkflowFiles(changedFiles))
	) {
		syncWorkflowRepository(repository.workflowRepositoryId).catch((error) =>
			console.error("Failed to sync workflows after push", error),
		);
	}

	const sources = enabledSources(repository);
	if (sources.length === 0 || event.skipCi) return [];

	const files = await fetchWorkflowFiles({
		octokit,
		owner: event.owner,
		repo: event.repository,
		ref: sha,
		sources,
	});
	const definitions = new Map(
		(
			await db.query.workflowDefinitions.findMany({
				where: eq(
					workflowDefinitions.workflowRepositoryId,
					repository.workflowRepositoryId,
				),
				columns: { workflowDefinitionId: true, path: true, enabled: true },
			})
		).map((definition) => [definition.path, definition]),
	);

	const workflowEvent = {
		name: event.name,
		action: event.action,
		ref: event.ref,
		baseBranch: event.baseBranch,
		changedFiles,
	};

	let skipReason: string | undefined;
	let skipReasonChecked = false;
	const runs = [];

	for (const file of files.map(loadWorkflow)) {
		const definition = definitions.get(file.path);
		if (!file.parsed || definition?.enabled === false) continue;
		if (!(await findMatchingTrigger(file.parsed.triggers, workflowEvent)))
			continue;

		if (!skipReasonChecked) {
			skipReason = await forkSkipReason(octokit, event);
			skipReasonChecked = true;
		}

		runs.push(
			await createWorkflowRun(
				{
					workflowRepositoryId: repository.workflowRepositoryId,
					workflowDefinitionId: definition?.workflowDefinitionId ?? null,
					workflowPath: file.path,
					workflowName: file.parsed.name,
					source: file.source,
					event: event.name,
					eventAction: event.action ?? null,
					payload,
					jobNames: jobNamesOf(file.parsed),
					ref: event.ref,
					sha,
					branch: event.branch,
					title: event.title,
					actor: event.actor,
					pullRequestNumber: event.pullRequestNumber ?? null,
					trusted: !event.isFork,
				},
				repository,
				{ skipReason },
			),
		);
	}
	return runs;
};

/** Creates and queues runs for every imported repository whose workflows match a GitHub webhook delivery. */
export const queueWorkflowRunsForGithubEvent = async ({
	githubId,
	eventName,
	payload,
}: {
	githubId: string;
	eventName: string;
	payload: Record<string, unknown>;
}) => {
	const event = normalizeGithubEvent(eventName, payload);
	if (!event) return [];

	const repositories = await findWorkflowRepositoriesByGithubRepo({
		githubId,
		owner: event.owner,
		repository: event.repository,
	});
	if (repositories.length === 0) return [];

	const octokit = authGithub(await findGithubById(githubId));
	const runs = [];
	for (const repository of repositories) {
		try {
			runs.push(
				...(await queueRunsForRepository(repository, octokit, event, payload)),
			);
		} catch (error) {
			console.error(
				`Failed to queue workflow runs for ${event.owner}/${event.repository}`,
				error,
			);
		}
	}
	return runs;
};

export const dispatchWorkflowRun = async ({
	workflowDefinitionId,
	branch,
	inputs,
	actor,
}: {
	workflowDefinitionId: string;
	branch: string;
	inputs: Record<string, string>;
	actor: string;
}) => {
	const definition = await db.query.workflowDefinitions.findFirst({
		where: eq(workflowDefinitions.workflowDefinitionId, workflowDefinitionId),
		with: { repository: true },
	});
	if (!definition) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found" });
	}
	const { repository } = definition;
	if (!repository.githubId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Repository has no GitHub provider",
		});
	}
	const octokit = authGithub(await findGithubById(repository.githubId));
	const { data: commit } = await octokit.rest.repos
		.getCommit({
			owner: repository.owner,
			repo: repository.repository,
			ref: `heads/${branch}`,
		})
		.catch(() => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Branch ${branch} not found`,
			});
		});

	const [file] = (
		await fetchWorkflowFiles({
			octokit,
			owner: repository.owner,
			repo: repository.repository,
			ref: commit.sha,
			sources: [definition.source],
		})
	)
		.filter((f) => f.path === definition.path)
		.map(loadWorkflow);
	if (!file?.parsed) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: file
				? `The workflow on ${branch} is invalid: ${file.parseError}`
				: `${definition.path} doesn't exist on ${branch}`,
		});
	}
	const dispatchTrigger = file.parsed.triggers.find(
		(trigger) => trigger.event === "workflow_dispatch",
	);
	if (!dispatchTrigger) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `The workflow on ${branch} has no workflow_dispatch trigger`,
		});
	}

	const resolvedInputs: Record<string, string> = {};
	for (const [name, spec] of Object.entries(dispatchTrigger.inputs ?? {})) {
		const value =
			inputs[name] ?? (spec.default !== undefined ? String(spec.default) : "");
		if (spec.required && value === "") {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Input "${name}" is required`,
			});
		}
		if (spec.type === "choice" && value && !spec.options?.includes(value)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Input "${name}" must be one of ${spec.options?.join(", ")}`,
			});
		}
		resolvedInputs[name] = value;
	}

	const ref = `refs/heads/${branch}`;
	return createWorkflowRun(
		{
			workflowRepositoryId: repository.workflowRepositoryId,
			workflowDefinitionId: definition.workflowDefinitionId,
			workflowPath: definition.path,
			workflowName: file.parsed.name,
			source: definition.source,
			event: "workflow_dispatch",
			payload: {
				ref,
				inputs: resolvedInputs,
				repository: {
					name: repository.repository,
					full_name: `${repository.owner}/${repository.repository}`,
					owner: { login: repository.owner },
					default_branch: repository.defaultBranch,
				},
				sender: { login: actor },
			},
			inputs: resolvedInputs,
			jobNames: jobNamesOf(file.parsed),
			ref,
			sha: commit.sha,
			branch,
			title: `Manually run by ${actor}`,
			actor,
			trusted: true,
		},
		repository,
	);
};

export const rerunWorkflowRun = async (workflowRunId: string) => {
	const previous = await findWorkflowRunById(workflowRunId);
	if (!isFinishedRunStatus(previous.status)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Wait for the run to finish before re-running it",
		});
	}
	const latestAttempt = await db
		.select({ attempt: sql<number>`max(${workflowRuns.attempt})` })
		.from(workflowRuns)
		.where(
			and(
				eq(workflowRuns.workflowRepositoryId, previous.workflowRepositoryId),
				eq(workflowRuns.workflowPath, previous.workflowPath),
				eq(workflowRuns.runNumber, previous.runNumber),
			),
		)
		.then(([row]) => Number(row?.attempt ?? previous.attempt));

	return createWorkflowRun(
		{
			workflowRepositoryId: previous.workflowRepositoryId,
			workflowDefinitionId: previous.workflowDefinitionId,
			workflowPath: previous.workflowPath,
			workflowName: previous.workflowName,
			source: previous.source,
			runNumber: previous.runNumber,
			attempt: latestAttempt + 1,
			event: previous.event,
			eventAction: previous.eventAction,
			payload: previous.payload,
			inputs: previous.inputs,
			jobNames: previous.jobNames,
			ref: previous.ref,
			sha: previous.sha,
			branch: previous.branch,
			title: previous.title,
			actor: previous.actor,
			pullRequestNumber: previous.pullRequestNumber,
			trusted: previous.trusted,
		},
		previous.repository,
	);
};

export const cancelWorkflowRun = async (workflowRunId: string) => {
	const run = await findWorkflowRunById(workflowRunId);
	if (isFinishedRunStatus(run.status)) return run;
	const wasActive = cancelQueuedOrActiveRun(workflowRunId);
	if (!wasActive) {
		await db
			.update(workflowRuns)
			.set({ status: "cancelled", finishedAt: new Date().toISOString() })
			.where(eq(workflowRuns.workflowRunId, workflowRunId));
	}
	return run;
};

/** Called once at startup: in-memory queue state is gone, so requeue waiting runs and fail interrupted ones. */
export const initWorkflowRuns = async () => {
	await db
		.update(workflowRuns)
		.set({
			status: "failure",
			errorMessage: "Dokploy restarted while this run was in progress.",
			finishedAt: new Date().toISOString(),
		})
		.where(eq(workflowRuns.status, "in_progress"));

	const queued = await db.query.workflowRuns.findMany({
		where: eq(workflowRuns.status, "queued"),
		columns: { workflowRunId: true, serverId: true },
		orderBy: (runs, { asc }) => [asc(runs.createdAt)],
	});
	for (const run of queued) {
		if (run.serverId) enqueueWorkflowRun(run.workflowRunId, run.serverId);
	}
};
