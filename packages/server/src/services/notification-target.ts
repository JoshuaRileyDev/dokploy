import { db } from "@dokploy/server/db";
import {
	type apiSetNotificationTargets,
	applications,
	compose,
	environments,
	type NotificationTarget,
	notifications,
	notificationTargets,
	projects,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, getTableName, inArray, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";

const targetKey = (target: NotificationTarget) => `${target.type}:${target.id}`;

const toRows = (notificationId: string, targets: NotificationTarget[]) =>
	[...new Map(targets.map((t) => [targetKey(t), t])).values()].map((t) => ({
		notificationId,
		applicationId: t.type === "application" ? t.id : null,
		composeId: t.type === "compose" ? t.id : null,
	}));

export type NotificationService =
	| { applicationId: string; composeId?: never }
	| { composeId: string; applicationId?: never };

export const findNotificationTargets = async (notificationId: string) => {
	const rows = await db.query.notificationTargets.findMany({
		where: eq(notificationTargets.notificationId, notificationId),
	});
	const targets: NotificationTarget[] = rows.map((row) =>
		row.applicationId
			? { type: "application", id: row.applicationId }
			: { type: "compose", id: row.composeId as string },
	);
	return {
		appScope: targets.length > 0 ? ("selected" as const) : ("all" as const),
		targets,
	};
};

const assertTargetsInOrganization = async (
	targets: NotificationTarget[],
	organizationId: string,
) => {
	const applicationIds = targets
		.filter((t) => t.type === "application")
		.map((t) => t.id);
	const composeIds = targets
		.filter((t) => t.type === "compose")
		.map((t) => t.id);

	const [foundApplications, foundCompose] = await Promise.all([
		applicationIds.length === 0
			? []
			: db
					.select({ id: applications.applicationId })
					.from(applications)
					.innerJoin(
						environments,
						eq(environments.environmentId, applications.environmentId),
					)
					.innerJoin(projects, eq(projects.projectId, environments.projectId))
					.where(
						and(
							inArray(applications.applicationId, applicationIds),
							eq(projects.organizationId, organizationId),
						),
					),
		composeIds.length === 0
			? []
			: db
					.select({ id: compose.composeId })
					.from(compose)
					.innerJoin(
						environments,
						eq(environments.environmentId, compose.environmentId),
					)
					.innerJoin(projects, eq(projects.projectId, environments.projectId))
					.where(
						and(
							inArray(compose.composeId, composeIds),
							eq(projects.organizationId, organizationId),
						),
					),
	]);

	if (
		new Set(foundApplications.map((a) => a.id)).size !==
			new Set(applicationIds).size ||
		new Set(foundCompose.map((c) => c.id)).size !== new Set(composeIds).size
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "One or more selected applications were not found",
		});
	}
};

export const setNotificationTargets = async (
	input: z.infer<typeof apiSetNotificationTargets>,
	organizationId: string,
) => {
	const targets = input.appScope === "all" ? [] : input.targets;
	await assertTargetsInOrganization(targets, organizationId);

	await db.transaction(async (tx) => {
		await tx
			.delete(notificationTargets)
			.where(eq(notificationTargets.notificationId, input.notificationId));
		if (targets.length === 0) return;
		await tx
			.insert(notificationTargets)
			.values(toRows(input.notificationId, targets));
	});
};

export const addNotificationTargets = async (
	notificationId: string,
	targets: NotificationTarget[],
	organizationId: string,
) => {
	await assertTargetsInOrganization(targets, organizationId);
	await db
		.insert(notificationTargets)
		.values(toRows(notificationId, targets))
		.onConflictDoNothing();
	return await findNotificationTargets(notificationId);
};

export const removeNotificationTargets = async (
	notificationId: string,
	targets: NotificationTarget[],
) => {
	const current = await findNotificationTargets(notificationId);
	const removing = new Set(targets.map(targetKey));
	const remaining = current.targets.filter((t) => !removing.has(targetKey(t)));

	// An empty target list means "all applications", so silently emptying it
	// would widen the notification instead of narrowing it.
	if (current.targets.length > 0 && remaining.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				'Removing every target would make this notification fire for all applications. Use notificationTarget.set with appScope "all" if that is intended.',
		});
	}

	const applicationIds = targets
		.filter((t) => t.type === "application")
		.map((t) => t.id);
	const composeIds = targets
		.filter((t) => t.type === "compose")
		.map((t) => t.id);
	const serviceMatches = [
		applicationIds.length > 0 &&
			inArray(notificationTargets.applicationId, applicationIds),
		composeIds.length > 0 && inArray(notificationTargets.composeId, composeIds),
	].filter((condition): condition is SQL => !!condition);

	await db
		.delete(notificationTargets)
		.where(
			and(
				eq(notificationTargets.notificationId, notificationId),
				or(...serviceMatches),
			),
		);
	return await findNotificationTargets(notificationId);
};

export const findNotificationsForService = async (
	service: NotificationService,
	organizationId: string,
) => {
	await assertTargetsInOrganization(
		[
			service.applicationId
				? { type: "application", id: service.applicationId }
				: { type: "compose", id: service.composeId as string },
		],
		organizationId,
	);

	const matching = await db.query.notifications.findMany({
		where: and(
			eq(notifications.organizationId, organizationId),
			or(
				eq(notifications.appDeploy, true),
				eq(notifications.appBuildError, true),
			),
			matchesNotificationTarget(service),
		),
		columns: {
			notificationId: true,
			name: true,
			notificationType: true,
			appDeploy: true,
			appBuildError: true,
		},
	});
	if (matching.length === 0) return [];

	const scoped = new Set(
		(
			await db
				.selectDistinct({ notificationId: notificationTargets.notificationId })
				.from(notificationTargets)
				.where(
					inArray(
						notificationTargets.notificationId,
						matching.map((n) => n.notificationId),
					),
				)
		).map((row) => row.notificationId),
	);

	return matching.map((notification) => ({
		...notification,
		appScope: scoped.has(notification.notificationId)
			? ("selected" as const)
			: ("all" as const),
	}));
};

// Matches notifications with no targets (all apps) or one targeting `service`.
// The subquery uses raw identifiers because relational queries (db.query.*)
// rewrite every Column in `where` to the root table's alias, which would
// point the target table's columns at "notifications".
export const matchesNotificationTarget = (
	service: NotificationService | undefined,
): SQL => {
	const targets = sql`${sql.identifier(getTableName(notificationTargets))} t`;
	const sameNotification = sql`t."notificationId" = ${notifications.notificationId}`;
	const hasNoTargets = sql`not exists (select 1 from ${targets} where ${sameNotification})`;
	if (!service) return hasNoTargets;

	const serviceMatch = service.applicationId
		? sql`t."applicationId" = ${service.applicationId}`
		: sql`t."composeId" = ${service.composeId}`;

	return sql`(${hasNoTargets} or exists (select 1 from ${targets} where ${sameNotification} and ${serviceMatch}))`;
};
