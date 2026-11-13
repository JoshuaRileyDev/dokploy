import {
	boatSnapshotName,
	findBoatSettings,
	getBoatSummary,
	IS_CLOUD,
	isBoatSnapshotBuilding,
	removeBoatConnection,
	requireBoatSettings,
	saveBoatConnection,
	saveBoatWorkflowSettings,
	startBoatSnapshotBuild,
} from "@dokploy/server";
import { resolvePermissions } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiSaveBoatConnection,
	apiSaveBoatWorkflowSettings,
} from "@/server/db/schema";

// Boat machines run repository code with the organization's credentials, so like workflows this is self-hosted only.
const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Boat is not available on Dokploy Cloud",
		});
	}
};

export const boatRouter = createTRPCRouter({
	get: protectedProcedure.query(async ({ ctx }) => {
		assertSelfHosted();
		const permissions = await resolvePermissions(ctx);
		if (!permissions.workflow?.read && !permissions.server?.read) {
			throw new TRPCError({ code: "FORBIDDEN" });
		}
		const organizationId = ctx.session.activeOrganizationId;
		const summary = await getBoatSummary(organizationId);
		if (!summary) return null;
		return {
			...summary,
			workflowSnapshotCurrent:
				summary.workflowSnapshotName === boatSnapshotName(),
			workflowSnapshotBuilding: isBoatSnapshotBuilding(organizationId),
		};
	}),
	saveConnection: withPermission("organization", "update")
		.input(apiSaveBoatConnection)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			const organizationId = ctx.session.activeOrganizationId;
			await saveBoatConnection(input.apiKey, organizationId);
			const settings = await findBoatSettings(organizationId);
			if (settings?.workflowsEnabled) startBoatSnapshotBuild(organizationId);
			await audit(ctx, {
				action: "update",
				resourceType: "organization",
				resourceId: organizationId,
				resourceName: "Boat connection",
			});
		}),
	removeConnection: withPermission("organization", "update").mutation(
		async ({ ctx }) => {
			assertSelfHosted();
			await removeBoatConnection(ctx.session.activeOrganizationId);
			await audit(ctx, {
				action: "delete",
				resourceType: "organization",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: "Boat connection",
			});
		},
	),
	saveWorkflowSettings: withPermission("workflow", "create")
		.input(apiSaveBoatWorkflowSettings)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			await saveBoatWorkflowSettings(input, ctx.session.activeOrganizationId);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: "Boat workflow settings",
			});
		}),
	rebuildWorkflowSnapshot: withPermission("workflow", "create").mutation(
		async ({ ctx }) => {
			assertSelfHosted();
			await requireBoatSettings(ctx.session.activeOrganizationId);
			startBoatSnapshotBuild(ctx.session.activeOrganizationId, true);
			await audit(ctx, {
				action: "update",
				resourceType: "workflow",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: "Boat workflow snapshot",
			});
		},
	),
});
