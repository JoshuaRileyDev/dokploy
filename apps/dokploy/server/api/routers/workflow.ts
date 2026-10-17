import {
	assertGitProviderAccess,
	cancelWorkflowRun,
	createWorkflowNotificationRule,
	dispatchWorkflowRun,
	findGithubById,
	findNotificationChannels,
	findWorkflowDefinitionById,
	findWorkflowEnv,
	findWorkflowNotificationRules,
	findWorkflowRepositoriesByOrganization,
	findWorkflowRepositoryById,
	findWorkflowRunById,
	findWorkflowRuns,
	getWorkflowRepositoryOctokit,
	IS_CLOUD,
	importWorkflowRepository,
	removeWorkflowEnv,
	removeWorkflowNotificationRule,
	removeWorkflowRepository,
	rerunWorkflowRun,
	setWorkflowDefinitionEnabled,
	setWorkflowEnv,
	syncWorkflowRepository,
	syncWorkflowSchedules,
	updateWorkflowRepository,
} from "@dokploy/server";
import type { statements } from "@dokploy/server/lib/access-control";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateWorkflowNotification,
	apiDispatchWorkflow,
	apiFindOneWorkflowRepository,
	apiFindOneWorkflowRun,
	apiFindWorkflowEnv,
	apiFindWorkflowRuns,
	apiImportWorkflowRepository,
	apiRemoveWorkflowEnv,
	apiRemoveWorkflowNotification,
	apiSetWorkflowDefinitionEnabled,
	apiSetWorkflowEnv,
	apiUpdateWorkflowRepository,
} from "@/server/db/schema";

// Workflows run arbitrary repository code on the user's servers, so they are self-hosted only.
const workflowProcedure = (action: (typeof statements)["workflow"][number]) =>
	withPermission("workflow", action).use(({ next }) => {
		if (IS_CLOUD) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Workflows are not available on Dokploy Cloud",
			});
		}
		return next();
	});

const findOwnedRepository = async (
	workflowRepositoryId: string,
	organizationId: string,
) => {
	const repository = await findWorkflowRepositoryById(workflowRepositoryId);
	if (repository.organizationId !== organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Workflow repository not found",
		});
	}
	return repository;
};

const findOwnedRun = async (workflowRunId: string, organizationId: string) => {
	const run = await findWorkflowRunById(workflowRunId);
	if (run.repository.organizationId !== organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
	}
	return run;
};

export const workflowRouter = createTRPCRouter({
	allRepositories: workflowProcedure("read").query(({ ctx }) =>
		findWorkflowRepositoriesByOrganization(ctx.session.activeOrganizationId),
	),
	oneRepository: workflowProcedure("read")
		.input(apiFindOneWorkflowRepository)
		.query(async ({ input, ctx }) => {
			const { github, ...repository } = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			return {
				...repository,
				github: github
					? {
							githubId: github.githubId,
							githubUrl: github.githubUrl,
							name: github.gitProvider.name,
						}
					: null,
			};
		}),
	importRepository: workflowProcedure("create")
		.input(apiImportWorkflowRepository)
		.mutation(async ({ input, ctx }) => {
			const githubProvider = await findGithubById(input.githubId);
			await assertGitProviderAccess(ctx.session, githubProvider.gitProvider);
			const repository = await importWorkflowRepository(
				input,
				ctx.session.activeOrganizationId,
			);
			await syncWorkflowSchedules();
			await audit(ctx, {
				action: "create",
				resourceType: "workflow",
				resourceId: repository.workflowRepositoryId,
				resourceName: `${repository.owner}/${repository.repository}`,
			});
			return repository;
		}),
	updateRepository: workflowProcedure("create")
		.input(apiUpdateWorkflowRepository)
		.mutation(async ({ input, ctx }) => {
			const repository = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			const updated = await updateWorkflowRepository(
				input,
				ctx.session.activeOrganizationId,
			);
			await syncWorkflowSchedules();
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: repository.workflowRepositoryId,
				resourceName: `${repository.owner}/${repository.repository}`,
			});
			return updated;
		}),
	removeRepository: workflowProcedure("delete")
		.input(apiFindOneWorkflowRepository)
		.mutation(async ({ input, ctx }) => {
			const repository = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			await removeWorkflowRepository(repository.workflowRepositoryId);
			await syncWorkflowSchedules();
			await audit(ctx, {
				action: "delete",
				resourceType: "workflow",
				resourceId: repository.workflowRepositoryId,
				resourceName: `${repository.owner}/${repository.repository}`,
			});
		}),
	syncRepository: workflowProcedure("create")
		.input(apiFindOneWorkflowRepository)
		.mutation(async ({ input, ctx }) => {
			await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			await syncWorkflowRepository(input.workflowRepositoryId);
			await syncWorkflowSchedules();
		}),
	setDefinitionEnabled: workflowProcedure("create")
		.input(apiSetWorkflowDefinitionEnabled)
		.mutation(async ({ input, ctx }) => {
			const definition = await findWorkflowDefinitionById(
				input.workflowDefinitionId,
			);
			if (
				definition.repository.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workflow not found",
				});
			}
			await setWorkflowDefinitionEnabled(
				input.workflowDefinitionId,
				input.enabled,
			);
			await syncWorkflowSchedules();
		}),
	branches: workflowProcedure("read")
		.input(apiFindOneWorkflowRepository)
		.query(async ({ input, ctx }) => {
			const repository = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			const octokit = await getWorkflowRepositoryOctokit(repository);
			const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
				owner: repository.owner,
				repo: repository.repository,
				per_page: 100,
			});
			return branches.map((branch) => branch.name);
		}),
	runs: workflowProcedure("read")
		.input(apiFindWorkflowRuns)
		.query(({ input, ctx }) =>
			findWorkflowRuns({
				organizationId: ctx.session.activeOrganizationId,
				...input,
			}),
		),
	oneRun: workflowProcedure("read")
		.input(apiFindOneWorkflowRun)
		.query(async ({ input, ctx }) => {
			const { repository, ...run } = await findOwnedRun(
				input.workflowRunId,
				ctx.session.activeOrganizationId,
			);
			const { github, ...repositoryFields } = repository;
			return {
				...run,
				repository: {
					...repositoryFields,
					githubUrl: github?.githubUrl ?? null,
				},
			};
		}),
	dispatch: workflowProcedure("run")
		.input(apiDispatchWorkflow)
		.mutation(async ({ input, ctx }) => {
			const definition = await findWorkflowDefinitionById(
				input.workflowDefinitionId,
			);
			if (
				definition.repository.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workflow not found",
				});
			}
			const run = await dispatchWorkflowRun({
				...input,
				actor: ctx.user.email,
			});
			await audit(ctx, {
				action: "run",
				resourceType: "workflow",
				resourceId: run.workflowRunId,
				resourceName: `${definition.repository.owner}/${definition.repository.repository} ${definition.path}`,
			});
			return run;
		}),
	rerun: workflowProcedure("run")
		.input(apiFindOneWorkflowRun)
		.mutation(async ({ input, ctx }) => {
			const previous = await findOwnedRun(
				input.workflowRunId,
				ctx.session.activeOrganizationId,
			);
			const run = await rerunWorkflowRun(previous.workflowRunId);
			await audit(ctx, {
				action: "run",
				resourceType: "workflow",
				resourceId: run.workflowRunId,
				resourceName: `${previous.workflowName} #${previous.runNumber}`,
			});
			return run;
		}),
	cancelRun: workflowProcedure("run")
		.input(apiFindOneWorkflowRun)
		.mutation(async ({ input, ctx }) => {
			const run = await findOwnedRun(
				input.workflowRunId,
				ctx.session.activeOrganizationId,
			);
			await cancelWorkflowRun(run.workflowRunId);
			await audit(ctx, {
				action: "cancel",
				resourceType: "workflow",
				resourceId: run.workflowRunId,
				resourceName: `${run.workflowName} #${run.runNumber}`,
			});
		}),
	notificationRules: workflowProcedure("read").query(({ ctx }) =>
		findWorkflowNotificationRules(ctx.session.activeOrganizationId),
	),
	notificationChannels: workflowProcedure("create").query(({ ctx }) =>
		findNotificationChannels(ctx.session.activeOrganizationId),
	),
	createNotificationRule: workflowProcedure("create")
		.input(apiCreateWorkflowNotification)
		.mutation(async ({ input, ctx }) => {
			const rule = await createWorkflowNotificationRule(
				input,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "workflow",
				resourceId: rule?.workflowNotificationId,
				resourceName: "Workflow notification",
			});
			return rule;
		}),
	removeNotificationRule: workflowProcedure("create")
		.input(apiRemoveWorkflowNotification)
		.mutation(async ({ input, ctx }) => {
			await removeWorkflowNotificationRule(
				input.workflowNotificationId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "workflow",
				resourceId: input.workflowNotificationId,
				resourceName: "Workflow notification",
			});
		}),
	env: workflowProcedure("read")
		.input(apiFindWorkflowEnv)
		.query(({ input, ctx }) =>
			findWorkflowEnv(
				ctx.session.activeOrganizationId,
				input.workflowRepositoryId,
			),
		),
	setEnv: workflowProcedure("create")
		.input(apiSetWorkflowEnv)
		.mutation(async ({ input, ctx }) => {
			const workflowEnvId = await setWorkflowEnv(
				input,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: workflowEnvId,
				resourceName: `${input.kind} ${input.name}`,
			});
		}),
	removeEnv: workflowProcedure("create")
		.input(apiRemoveWorkflowEnv)
		.mutation(async ({ input, ctx }) => {
			await removeWorkflowEnv(
				input.workflowEnvId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "workflow",
				resourceId: input.workflowEnvId,
				resourceName: "Workflow secret or variable",
			});
		}),
});
