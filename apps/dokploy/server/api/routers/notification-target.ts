import {
	addNotificationTargets,
	findNotificationById,
	findNotificationsForService,
	findNotificationTargets,
	removeNotificationTargets,
	setNotificationTargets,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindNotificationsForService,
	apiFindNotificationTargets,
	apiModifyNotificationTargets,
	apiSetNotificationTargets,
} from "@/server/db/schema";
import { createTRPCRouter, withAnyPermission, withPermission } from "../trpc";

const findNotificationInOrg = async (
	notificationId: string,
	organizationId: string,
) => {
	const notification = await findNotificationById(notificationId);
	if (notification.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this notification",
		});
	}
	return notification;
};

const SCOPE_NOTE =
	'Targets only affect the App Deploy and App Build Error events. A notification with no targets (appScope "all") fires for every application and compose service in the organization.';

export const notificationTargetRouter = createTRPCRouter({
	get: withPermission("notification", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/notificationTarget.get",
				tags: ["notificationTarget"],
				summary: "Get the applications a notification is scoped to",
				description: `Returns the notification's appScope ("all" or "selected") and its targets. ${SCOPE_NOTE}`,
			},
		})
		.input(apiFindNotificationTargets)
		.query(async ({ input, ctx }) => {
			await findNotificationInOrg(
				input.notificationId,
				ctx.session.activeOrganizationId,
			);
			return await findNotificationTargets(input.notificationId);
		}),

	// The create dialog sets targets straight after creating the notification,
	// so users who can only create notifications need this too.
	set: withAnyPermission("notification", ["create", "update"])
		.meta({
			openapi: {
				method: "POST",
				path: "/notificationTarget.set",
				tags: ["notificationTarget"],
				summary: "Replace the applications a notification is scoped to",
				description: `Replaces all targets. Use appScope "all" (targets are ignored) to make the notification fire for every application, or "selected" with at least one target. ${SCOPE_NOTE}`,
			},
		})
		.input(apiSetNotificationTargets)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationInOrg(
				input.notificationId,
				ctx.session.activeOrganizationId,
			);
			await setNotificationTargets(input, ctx.session.activeOrganizationId);
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return await findNotificationTargets(input.notificationId);
		}),

	add: withPermission("notification", "update")
		.meta({
			openapi: {
				method: "POST",
				path: "/notificationTarget.add",
				tags: ["notificationTarget"],
				summary: "Add applications to a notification's scope",
				description: `Adds targets, keeping existing ones. Adding a target to a notification scoped to all applications narrows it to just the added targets. ${SCOPE_NOTE}`,
			},
		})
		.input(apiModifyNotificationTargets)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationInOrg(
				input.notificationId,
				ctx.session.activeOrganizationId,
			);
			const result = await addNotificationTargets(
				input.notificationId,
				input.targets,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),

	remove: withPermission("notification", "update")
		.meta({
			openapi: {
				method: "POST",
				path: "/notificationTarget.remove",
				tags: ["notificationTarget"],
				summary: "Remove applications from a notification's scope",
				description: `Removes targets. Fails if it would remove the last target, since that would widen the notification to all applications; use notificationTarget.set with appScope "all" for that. ${SCOPE_NOTE}`,
			},
		})
		.input(apiModifyNotificationTargets)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationInOrg(
				input.notificationId,
				ctx.session.activeOrganizationId,
			);
			const result = await removeNotificationTargets(
				input.notificationId,
				input.targets,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),

	forService: withPermission("notification", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/notificationTarget.forService",
				tags: ["notificationTarget"],
				summary: "List notifications that fire for an application",
				description: `Pass exactly one of applicationId or composeId. Returns every notification with App Deploy or App Build Error enabled that covers the service, either because it targets it or because it applies to all applications. ${SCOPE_NOTE}`,
			},
		})
		.input(apiFindNotificationsForService)
		.query(async ({ input, ctx }) => {
			const service = input.applicationId
				? { applicationId: input.applicationId }
				: { composeId: input.composeId as string };
			return await findNotificationsForService(
				service,
				ctx.session.activeOrganizationId,
			);
		}),
});
