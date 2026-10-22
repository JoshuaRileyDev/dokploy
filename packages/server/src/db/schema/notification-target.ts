import { relations, sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";
import { compose } from "./compose";
import { notifications } from "./notification";

// A notification with no rows here applies to every app; with rows, its
// appDeploy/appBuildError events only fire for the listed services. A separate
// table keeps upstream's `notification` schema untouched.
export const notificationTargets = pgTable(
	"fork_notification_target",
	{
		targetId: text("targetId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		notificationId: text("notificationId")
			.notNull()
			.references(() => notifications.notificationId, { onDelete: "cascade" }),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{ onDelete: "cascade" },
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
	},
	(table) => [
		index("fork_notification_target_notification_idx").on(table.notificationId),
		uniqueIndex("fork_notification_target_application_idx").on(
			table.notificationId,
			table.applicationId,
		),
		uniqueIndex("fork_notification_target_compose_idx").on(
			table.notificationId,
			table.composeId,
		),
		check(
			"fork_notification_target_one_service",
			sql`num_nonnulls(${table.applicationId}, ${table.composeId}) = 1`,
		),
	],
);

export const notificationTargetRelations = relations(
	notificationTargets,
	({ one }) => ({
		notification: one(notifications, {
			fields: [notificationTargets.notificationId],
			references: [notifications.notificationId],
		}),
		application: one(applications, {
			fields: [notificationTargets.applicationId],
			references: [applications.applicationId],
		}),
		compose: one(compose, {
			fields: [notificationTargets.composeId],
			references: [compose.composeId],
		}),
	}),
);

export const notificationTargetSchema = z.object({
	type: z.enum(["application", "compose"]),
	id: z.string().min(1),
});

export type NotificationTarget = z.infer<typeof notificationTargetSchema>;

export const apiFindNotificationTargets = z.object({
	notificationId: z.string().min(1),
});

export const apiSetNotificationTargets = z
	.object({
		notificationId: z.string().min(1),
		appScope: z.enum(["all", "selected"]),
		targets: z.array(notificationTargetSchema).max(500),
	})
	.refine((input) => input.appScope === "all" || input.targets.length > 0, {
		message: "Select at least one application",
		path: ["targets"],
	});

export const apiModifyNotificationTargets = z.object({
	notificationId: z.string().min(1),
	targets: z.array(notificationTargetSchema).min(1).max(500),
});

export const apiFindNotificationsForService = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
	})
	.refine((input) => !!input.applicationId !== !!input.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	});
