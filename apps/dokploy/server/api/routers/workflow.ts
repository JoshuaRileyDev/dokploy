import {
	assertGitProviderAccess,
	findGithubById,
	findWorkflowDefinitionById,
	findWorkflowRepositoriesByOrganization,
	findWorkflowRepositoryById,
	IS_CLOUD,
	importWorkflowRepository,
	removeWorkflowRepository,
	setWorkflowDefinitionEnabled,
	syncWorkflowRepository,
	updateWorkflowRepository,
} from "@dokploy/server";
import type { statements } from "@dokploy/server/lib/access-control";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindOneWorkflowRepository,
	apiImportWorkflowRepository,
	apiSetWorkflowDefinitionEnabled,
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
		}),
});
