import {
	assertGitProviderAccess,
	cancelWorkflowRun,
	createWorkflowNotificationRule,
	createWorkflowRunner,
	dispatchWorkflowRun,
	findGithubById,
	findNotificationChannels,
	findServicesLinkedToRepository,
	findWorkflowDefinitionById,
	findWorkflowEnv,
	findWorkflowNotificationRules,
	findWorkflowRepositoriesByOrganization,
	findWorkflowRepositoryById,
	findWorkflowRepositoryForService,
	findWorkflowRunById,
	findWorkflowRunFilterOptions,
	findWorkflowRunners,
	findWorkflowRuns,
	getWorkflowRepositoryOctokit,
	IS_CLOUD,
	importLinkedServiceEnv,
	importWorkflowRepository,
	importWorkflowRepositoryForService,
	readLinkedServiceEnv,
	regenerateRunnerRegistration,
	removeWorkflowEnv,
	removeWorkflowNotificationRule,
	removeWorkflowRepository,
	removeWorkflowRunner,
	removeWorkflowRuns,
	rerunWorkflowRun,
	searchWorkflowRuns,
	setWorkflowDefinitionEnabled,
	setWorkflowEnv,
	setWorkflowJobEnabled,
	setWorkflowRunsArchived,
	syncWorkflowRepository,
	syncWorkflowSchedules,
	updateWorkflowRepository,
	updateWorkflowRunner,
	workflowEnvNameProblem,
} from "@dokploy/server";
import type { statements } from "@dokploy/server/lib/access-control";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
} from "@dokploy/server/services/permission";
import { readLogTail } from "@dokploy/server/utils/workflows/logs";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateWorkflowNotification,
	apiCreateWorkflowRunner,
	apiDispatchWorkflow,
	apiFindOneWorkflowRepository,
	apiFindOneWorkflowRun,
	apiFindOneWorkflowRunner,
	apiFindWorkflowEnv,
	apiFindWorkflowRuns,
	apiImportLinkedServiceEnv,
	apiImportWorkflowRepository,
	apiLinkedServiceEnv,
	apiReadWorkflowRunLogs,
	apiRemoveWorkflowEnv,
	apiRemoveWorkflowNotification,
	apiSearchWorkflowRuns,
	apiSetWorkflowDefinitionEnabled,
	apiSetWorkflowEnv,
	apiSetWorkflowJobEnabled,
	apiSetWorkflowRunsArchived,
	apiUpdateWorkflowRepository,
	apiUpdateWorkflowRunner,
	apiWorkflowRunFilterOptions,
	apiWorkflowRunIds,
	apiWorkflowService,
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
	setJobEnabled: workflowProcedure("create")
		.input(apiSetWorkflowJobEnabled)
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
			await setWorkflowJobEnabled(
				input.workflowDefinitionId,
				input.jobId,
				input.enabled,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: definition.workflowDefinitionId,
				resourceName: `${definition.path} job ${input.jobId} ${input.enabled ? "enabled" : "disabled"}`,
			});
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
	searchRuns: workflowProcedure("read")
		.input(apiSearchWorkflowRuns)
		.query(({ input, ctx }) =>
			searchWorkflowRuns({
				organizationId: ctx.session.activeOrganizationId,
				...input,
			}),
		),
	runFilterOptions: workflowProcedure("read")
		.input(apiWorkflowRunFilterOptions)
		.query(({ input, ctx }) =>
			findWorkflowRunFilterOptions({
				organizationId: ctx.session.activeOrganizationId,
				...input,
			}),
		),
	setRunsArchived: workflowProcedure("run")
		.input(apiSetWorkflowRunsArchived)
		.mutation(async ({ input, ctx }) => {
			const updated = await setWorkflowRunsArchived(
				input.workflowRunIds,
				input.archived,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceName: `${input.archived ? "Archived" : "Unarchived"} ${updated} ${updated === 1 ? "run" : "runs"}`,
				metadata: { workflowRunIds: input.workflowRunIds },
			});
			return { updated };
		}),
	removeRuns: workflowProcedure("delete")
		.input(apiWorkflowRunIds)
		.mutation(async ({ input, ctx }) => {
			const removed = await removeWorkflowRuns(
				input.workflowRunIds,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "workflow",
				resourceName: `Deleted ${removed} ${removed === 1 ? "run" : "runs"}`,
				metadata: { workflowRunIds: input.workflowRunIds },
			});
			return { removed };
		}),
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
	// The live log viewer streams over a websocket, so this is how API clients (CLIs, agents fixing a failed run) read
	// the logs. Logs are written with secrets already masked.
	readLogs: workflowProcedure("read")
		.input(apiReadWorkflowRunLogs)
		.query(async ({ input, ctx }) => {
			const run = await findOwnedRun(
				input.workflowRunId,
				ctx.session.activeOrganizationId,
			);
			const jobs = input.workflowJobId
				? run.jobs.filter((job) => job.workflowJobId === input.workflowJobId)
				: run.jobs;
			if (input.workflowJobId && jobs.length === 0) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
			}
			return {
				workflowRunId: run.workflowRunId,
				status: run.status,
				errorMessage: run.errorMessage,
				// Setup output and anything act printed outside a job, such as a clone or parse failure.
				runLog:
					input.workflowJobId || !run.logPath
						? null
						: await readLogTail(run.logPath, input.tail),
				jobs: await Promise.all(
					jobs.map(async (job) => ({
						workflowJobId: job.workflowJobId,
						jobId: job.jobId,
						name: job.name,
						matrix: job.matrix,
						status: job.status,
						failedSteps: job.steps
							.filter((step) => step.status === "failure")
							.map((step) => step.name),
						log: await readLogTail(job.logPath, input.tail),
					})),
				),
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
				resourceName: `${definition.repository.owner}/${definition.repository.repository} ${definition.path}${input.jobId ? ` job ${input.jobId}` : ""}`,
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
	linkedServices: workflowProcedure("create")
		.input(apiFindOneWorkflowRepository)
		.query(async ({ input, ctx }) => {
			const repository = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			const services = await findServicesLinkedToRepository(repository);
			const accessible = await Promise.all(
				services.map((service) =>
					checkServiceAccess(ctx, service.serviceId, "read")
						.then(() => true)
						.catch(() => false),
				),
			);
			return services.filter((_, index) => accessible[index]);
		}),
	linkedServiceEnvNames: workflowProcedure("create")
		.input(apiLinkedServiceEnv)
		.query(async ({ input, ctx }) => {
			const repository = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			// Importing exposes the values to workflows, so it needs the same access as reading them.
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				envVars: ["read"],
			});
			const entries = await readLinkedServiceEnv(
				repository,
				input.serviceType,
				input.serviceId,
			);
			return entries.map(({ name, source }) => ({
				name,
				source,
				problem: workflowEnvNameProblem(name),
			}));
		}),
	importLinkedServiceEnv: workflowProcedure("create")
		.input(apiImportLinkedServiceEnv)
		.mutation(async ({ input, ctx }) => {
			const repository = await findOwnedRepository(
				input.workflowRepositoryId,
				ctx.session.activeOrganizationId,
			);
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				envVars: ["read"],
			});
			const result = await importLinkedServiceEnv({
				repository,
				serviceType: input.serviceType,
				serviceId: input.serviceId,
				names: input.names,
				kind: input.kind,
				overwrite: input.overwrite,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: repository.workflowRepositoryId,
				resourceName: `Imported ${result.imported.length} ${input.kind}s into ${repository.owner}/${repository.repository}`,
				metadata: { serviceId: input.serviceId, names: result.imported },
			});
			return result;
		}),
	repositoryForService: workflowProcedure("read")
		.input(apiWorkflowService)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.serviceId, "read");
			const found = await findWorkflowRepositoryForService(
				input.serviceType,
				input.serviceId,
			);
			if (!found.eligible) return { eligible: false as const };
			if (found.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Service not found",
				});
			}
			return {
				eligible: true as const,
				owner: found.owner,
				repository: found.repository,
				workflowRepositoryId: found.workflowRepositoryId,
			};
		}),
	importRepositoryForService: workflowProcedure("create")
		.input(apiWorkflowService)
		.mutation(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.serviceId, "read");
			const found = await findWorkflowRepositoryForService(
				input.serviceType,
				input.serviceId,
			);
			if (
				found.eligible &&
				found.organizationId !== ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Service not found",
				});
			}
			const workflowRepositoryId = await importWorkflowRepositoryForService(
				input.serviceType,
				input.serviceId,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "workflow",
				resourceId: workflowRepositoryId,
				resourceName: found.eligible
					? `${found.owner}/${found.repository}`
					: undefined,
			});
			return { workflowRepositoryId };
		}),
	runners: workflowProcedure("read").query(({ ctx }) =>
		findWorkflowRunners(ctx.session.activeOrganizationId),
	),
	createRunner: workflowProcedure("create")
		.input(apiCreateWorkflowRunner)
		.mutation(async ({ input, ctx }) => {
			const created = await createWorkflowRunner(
				input,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "workflow",
				resourceId: created.workflowRunnerId,
				resourceName: `Runner ${input.name}`,
			});
			return created;
		}),
	updateRunner: workflowProcedure("create")
		.input(apiUpdateWorkflowRunner)
		.mutation(async ({ input, ctx }) => {
			await updateWorkflowRunner(input, ctx.session.activeOrganizationId);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: input.workflowRunnerId,
				resourceName: `Runner ${input.name}`,
			});
		}),
	regenerateRunnerToken: workflowProcedure("create")
		.input(apiFindOneWorkflowRunner)
		.mutation(async ({ input, ctx }) => {
			const result = await regenerateRunnerRegistration(
				input.workflowRunnerId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: input.workflowRunnerId,
				resourceName: "Runner registration token",
			});
			return result;
		}),
	removeRunner: workflowProcedure("delete")
		.input(apiFindOneWorkflowRunner)
		.mutation(async ({ input, ctx }) => {
			await removeWorkflowRunner(
				input.workflowRunnerId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "workflow",
				resourceId: input.workflowRunnerId,
				resourceName: "Runner",
			});
		}),
});
