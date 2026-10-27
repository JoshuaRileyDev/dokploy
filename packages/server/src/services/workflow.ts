import { db } from "@dokploy/server/db";
import {
	type apiCreateWorkflowNotification,
	type apiImportWorkflowRepository,
	type apiSetWorkflowEnv,
	type apiUpdateWorkflowRepository,
	notifications,
	server,
	workflowDefinitions,
	workflowEnv,
	workflowNotifications,
	workflowRepositories,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, arrayContains, desc, eq, notInArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { authGithub } from "../utils/providers/github";
import {
	fetchWorkflowFiles,
	loadWorkflow,
	type WorkflowSourceType,
} from "../utils/workflows/github";
import { findGithubById } from "./github";

export type WorkflowRepository = typeof workflowRepositories.$inferSelect;
export type WorkflowDefinition = typeof workflowDefinitions.$inferSelect;

const ALL_SOURCES: WorkflowSourceType[] = ["github", "dokploy"];

export const findWorkflowRepositoryById = async (
	workflowRepositoryId: string,
) => {
	const repository = await db.query.workflowRepositories.findFirst({
		where: eq(workflowRepositories.workflowRepositoryId, workflowRepositoryId),
		with: {
			github: { with: { gitProvider: true } },
			defaultServer: {
				columns: { serverId: true, name: true, serverRoles: true },
			},
			definitions: {
				orderBy: (definitions, { asc }) => [asc(definitions.path)],
			},
		},
	});
	if (!repository) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workflow repository not found",
		});
	}
	return repository;
};

export const findWorkflowRepositoriesByOrganization = async (
	organizationId: string,
) =>
	db.query.workflowRepositories.findMany({
		where: eq(workflowRepositories.organizationId, organizationId),
		orderBy: desc(workflowRepositories.createdAt),
		with: {
			defaultServer: { columns: { serverId: true, name: true } },
			definitions: {
				columns: {
					workflowDefinitionId: true,
					source: true,
					enabled: true,
					parseError: true,
				},
			},
		},
	});

export const assertWorkflowServer = async (
	serverId: string,
	organizationId: string,
) => {
	const workflowServer = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, organizationId),
			arrayContains(server.serverRoles, ["workflow"]),
		),
	});
	if (!workflowServer) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The selected server doesn't have the workflow role",
		});
	}
	return workflowServer;
};

export const importWorkflowRepository = async (
	input: z.infer<typeof apiImportWorkflowRepository>,
	organizationId: string,
) => {
	if (input.defaultServerId) {
		await assertWorkflowServer(input.defaultServerId, organizationId);
	}

	const githubProvider = await findGithubById(input.githubId);
	const octokit = authGithub(githubProvider);
	const { data: repo } = await octokit.rest.repos
		.get({ owner: input.owner, repo: input.repository })
		.catch(() => {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `The GitHub App can't access ${input.owner}/${input.repository}`,
			});
		});

	const existing = await db.query.workflowRepositories.findFirst({
		where: and(
			eq(workflowRepositories.organizationId, organizationId),
			eq(workflowRepositories.githubId, input.githubId),
			eq(workflowRepositories.owner, repo.owner.login),
			eq(workflowRepositories.repository, repo.name),
		),
	});
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `${repo.full_name} is already imported`,
		});
	}

	const [created] = await db
		.insert(workflowRepositories)
		.values({
			organizationId,
			githubId: input.githubId,
			owner: repo.owner.login,
			repository: repo.name,
			defaultBranch: repo.default_branch,
			defaultServerId: input.defaultServerId ?? null,
		})
		.returning();
	if (!created) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error importing the repository",
		});
	}

	await syncWorkflowRepository(created.workflowRepositoryId);
	return created;
};

export const updateWorkflowRepository = async (
	input: z.infer<typeof apiUpdateWorkflowRepository>,
	organizationId: string,
) => {
	if (input.defaultServerId) {
		await assertWorkflowServer(input.defaultServerId, organizationId);
	}
	const { workflowRepositoryId, ...values } = input;
	const [updated] = await db
		.update(workflowRepositories)
		.set(values)
		.where(eq(workflowRepositories.workflowRepositoryId, workflowRepositoryId))
		.returning();
	return updated;
};

export const removeWorkflowRepository = async (workflowRepositoryId: string) =>
	db
		.delete(workflowRepositories)
		.where(eq(workflowRepositories.workflowRepositoryId, workflowRepositoryId));

export const getWorkflowRepositoryOctokit = async (
	repository: Pick<WorkflowRepository, "githubId">,
): Promise<ReturnType<typeof authGithub>> => {
	if (!repository.githubId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Repository has no GitHub provider",
		});
	}
	return authGithub(await findGithubById(repository.githubId));
};

/** Refreshes the cached workflow definitions from the repository's default branch. */
export const syncWorkflowRepository = async (workflowRepositoryId: string) => {
	const repository = await findWorkflowRepositoryById(workflowRepositoryId);
	try {
		const octokit = await getWorkflowRepositoryOctokit(repository);
		const files = await fetchWorkflowFiles({
			octokit,
			owner: repository.owner,
			repo: repository.repository,
			ref: repository.defaultBranch,
			sources: ALL_SOURCES,
		});
		const now = new Date().toISOString();

		await db.transaction(async (tx) => {
			for (const workflow of files.map(loadWorkflow)) {
				const values = {
					source: workflow.source,
					name: workflow.parsed?.name ?? workflow.path.split("/").pop()!,
					triggers: workflow.parsed?.triggers ?? [],
					jobs: workflow.parsed?.jobs ?? [],
					sha: workflow.sha,
					parseError: workflow.parseError,
					updatedAt: now,
				};
				await tx
					.insert(workflowDefinitions)
					.values({ workflowRepositoryId, path: workflow.path, ...values })
					.onConflictDoUpdate({
						target: [
							workflowDefinitions.workflowRepositoryId,
							workflowDefinitions.path,
						],
						set: values,
					});
			}

			const paths = files.map((file) => file.path);
			await tx
				.delete(workflowDefinitions)
				.where(
					and(
						eq(workflowDefinitions.workflowRepositoryId, workflowRepositoryId),
						paths.length > 0
							? notInArray(workflowDefinitions.path, paths)
							: undefined,
					),
				);

			await tx
				.update(workflowRepositories)
				.set({ lastSyncedAt: now, syncError: null })
				.where(
					eq(workflowRepositories.workflowRepositoryId, workflowRepositoryId),
				);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(workflowRepositories)
			.set({ syncError: message })
			.where(
				eq(workflowRepositories.workflowRepositoryId, workflowRepositoryId),
			);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Failed to sync workflows: ${message}`,
			cause: error,
		});
	}
	return findWorkflowRepositoryById(workflowRepositoryId);
};

export const findWorkflowDefinitionById = async (
	workflowDefinitionId: string,
) => {
	const definition = await db.query.workflowDefinitions.findFirst({
		where: eq(workflowDefinitions.workflowDefinitionId, workflowDefinitionId),
		with: { repository: true },
	});
	if (!definition) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workflow not found",
		});
	}
	return definition;
};

export const setWorkflowDefinitionEnabled = async (
	workflowDefinitionId: string,
	enabled: boolean,
) =>
	db
		.update(workflowDefinitions)
		.set({ enabled })
		.where(eq(workflowDefinitions.workflowDefinitionId, workflowDefinitionId));

export const setWorkflowJobEnabled = async (
	workflowDefinitionId: string,
	jobId: string,
	enabled: boolean,
) =>
	db
		.update(workflowDefinitions)
		.set({
			disabledJobs: enabled
				? sql`array_remove(${workflowDefinitions.disabledJobs}, ${jobId})`
				: sql`array_append(array_remove(${workflowDefinitions.disabledJobs}, ${jobId}), ${jobId})`,
		})
		.where(eq(workflowDefinitions.workflowDefinitionId, workflowDefinitionId));

export const findWorkflowRepositoriesByGithubRepo = async ({
	githubId,
	owner,
	repository,
}: {
	githubId: string;
	owner: string;
	repository: string;
}) =>
	db.query.workflowRepositories.findMany({
		where: and(
			eq(workflowRepositories.githubId, githubId),
			eq(workflowRepositories.owner, owner),
			eq(workflowRepositories.repository, repository),
		),
	});

export const findWorkflowNotificationRules = async (organizationId: string) =>
	db.query.workflowNotifications.findMany({
		where: eq(workflowNotifications.organizationId, organizationId),
		orderBy: desc(workflowNotifications.createdAt),
		with: {
			notification: {
				columns: { notificationId: true, name: true, notificationType: true },
			},
			repository: { columns: { owner: true, repository: true } },
		},
	});

export const createWorkflowNotificationRule = async (
	input: z.infer<typeof apiCreateWorkflowNotification>,
	organizationId: string,
) => {
	const notification = await db.query.notifications.findFirst({
		where: and(
			eq(notifications.notificationId, input.notificationId),
			eq(notifications.organizationId, organizationId),
		),
	});
	if (!notification) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Notification not found",
		});
	}
	if (input.workflowRepositoryId) {
		const repository = await findWorkflowRepositoryById(
			input.workflowRepositoryId,
		);
		if (repository.organizationId !== organizationId) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Repository not found",
			});
		}
	}
	if (!input.onFailure && !input.onSuccess) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Choose at least one of failures or successes",
		});
	}
	const [rule] = await db
		.insert(workflowNotifications)
		.values({ ...input, organizationId })
		.returning();
	return rule;
};

export const removeWorkflowNotificationRule = async (
	workflowNotificationId: string,
	organizationId: string,
) =>
	db
		.delete(workflowNotifications)
		.where(
			and(
				eq(
					workflowNotifications.workflowNotificationId,
					workflowNotificationId,
				),
				eq(workflowNotifications.organizationId, organizationId),
			),
		);

export const findNotificationChannels = async (organizationId: string) =>
	db.query.notifications.findMany({
		where: eq(notifications.organizationId, organizationId),
		columns: { notificationId: true, name: true, notificationType: true },
		orderBy: desc(notifications.createdAt),
	});

/** Lists a repository's secrets and variables; secret values are never returned. */
export const findWorkflowEnv = async (
	organizationId: string,
	workflowRepositoryId: string,
) => {
	const rows = await db.query.workflowEnv.findMany({
		where: and(
			eq(workflowEnv.organizationId, organizationId),
			eq(workflowEnv.workflowRepositoryId, workflowRepositoryId),
		),
		orderBy: (env, { asc }) => [asc(env.kind), asc(env.name)],
	});
	return rows.map(({ value, ...row }) => ({
		...row,
		value: row.kind === "variable" ? value : null,
	}));
};

const assertRepositoryInOrganization = async (
	workflowRepositoryId: string,
	organizationId: string,
) => {
	const repository = await findWorkflowRepositoryById(workflowRepositoryId);
	if (repository.organizationId !== organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Repository not found" });
	}
};

export const setWorkflowEnv = async (
	input: z.infer<typeof apiSetWorkflowEnv>,
	organizationId: string,
) => {
	await assertRepositoryInOrganization(
		input.workflowRepositoryId,
		organizationId,
	);
	const existing = await db.query.workflowEnv.findFirst({
		where: and(
			eq(workflowEnv.organizationId, organizationId),
			eq(workflowEnv.workflowRepositoryId, input.workflowRepositoryId),
			eq(workflowEnv.kind, input.kind),
			eq(workflowEnv.name, input.name),
		),
		columns: { workflowEnvId: true },
	});
	const updatedAt = new Date().toISOString();
	if (existing) {
		await db
			.update(workflowEnv)
			.set({ value: input.value, updatedAt })
			.where(eq(workflowEnv.workflowEnvId, existing.workflowEnvId));
		return existing.workflowEnvId;
	}
	const [created] = await db
		.insert(workflowEnv)
		.values({ ...input, organizationId, updatedAt })
		.returning({ workflowEnvId: workflowEnv.workflowEnvId });
	return created?.workflowEnvId;
};

export const removeWorkflowEnv = async (
	workflowEnvId: string,
	organizationId: string,
) =>
	db
		.delete(workflowEnv)
		.where(
			and(
				eq(workflowEnv.workflowEnvId, workflowEnvId),
				eq(workflowEnv.organizationId, organizationId),
			),
		);

export const resolveWorkflowEnv = async (workflowRepositoryId: string) => {
	const rows = await db.query.workflowEnv.findMany({
		where: eq(workflowEnv.workflowRepositoryId, workflowRepositoryId),
	});
	const secrets: Record<string, string> = {};
	const variables: Record<string, string> = {};
	for (const row of rows) {
		(row.kind === "secret" ? secrets : variables)[row.name] = row.value;
	}
	return { secrets, variables };
};
