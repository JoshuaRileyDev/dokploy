import { relations, sql } from "drizzle-orm";
import {
	boolean,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { certificates } from "./certificate";
import { compose } from "./compose";
import { deployments } from "./deployment";
import { libsql } from "./libsql";
import { mariadb } from "./mariadb";
import { mongo } from "./mongo";
import { mysql } from "./mysql";
import { network } from "./network";
import { postgres } from "./postgres";
import { redis } from "./redis";
import { schedules } from "./schedule";
import { sshKeys } from "./ssh-key";
import { generateAppName } from "./utils";
export const serverStatus = pgEnum("serverStatus", ["active", "inactive"]);
export const serverType = pgEnum("serverType", ["deploy", "build"]);
export const serverRoleValues = ["deploy", "build", "workflow"] as const;
export type ServerRole = (typeof serverRoleValues)[number];
export const serverRole = pgEnum("serverRole", serverRoleValues);

export const server = pgTable("server", {
	serverId: text("serverId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	ipAddress: text("ipAddress").notNull(),
	port: integer("port").notNull(),
	username: text("username").notNull().default("root"),
	appName: text("appName")
		.notNull()
		.$defaultFn(() => generateAppName("server")),
	enableDockerCleanup: boolean("enableDockerCleanup").notNull().default(false),
	telemetryProviderIds: text("telemetryProviderIds")
		.array()
		.notNull()
		.default(sql`ARRAY[]::text[]`),
	buildsConcurrency: integer("buildsConcurrency").notNull().default(1),
	createdAt: text("createdAt").notNull(),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	serverStatus: serverStatus("serverStatus").notNull().default("active"),
	// Upstream column, kept so upstream migrations still apply on this fork.
	// Derived from serverRoles on write; read serverRoles instead.
	serverType: serverType("serverType").notNull().default("deploy"),
	serverRoles: serverRole("serverRoles")
		.array()
		.notNull()
		.default(sql`ARRAY['deploy']::"serverRole"[]`),
	command: text("command").notNull().default(""),
	sshKeyId: text("sshKeyId").references(() => sshKeys.sshKeyId, {
		onDelete: "set null",
	}),
	metricsConfig: jsonb("metricsConfig")
		.$type<{
			server: {
				type: "Dokploy" | "Remote";
				refreshRate: number;
				port: number;
				token: string;
				urlCallback: string;
				retentionDays: number;
				cronJob: string;
				thresholds: {
					cpu: number;
					memory: number;
				};
			};
			containers: {
				refreshRate: number;
				services: {
					include: string[];
					exclude: string[];
				};
			};
		}>()
		.notNull()
		.default({
			server: {
				type: "Remote",
				refreshRate: 60,
				port: 4500,
				token: "",
				urlCallback: "",
				cronJob: "",
				retentionDays: 2,
				thresholds: {
					cpu: 0,
					memory: 0,
				},
			},
			containers: {
				refreshRate: 60,
				services: {
					include: [],
					exclude: [],
				},
			},
		}),
});

export const serverRelations = relations(server, ({ one, many }) => ({
	deployments: many(deployments, {
		relationName: "deploymentServer",
	}),
	buildDeployments: many(deployments, {
		relationName: "deploymentBuildServer",
	}),
	sshKey: one(sshKeys, {
		fields: [server.sshKeyId],
		references: [sshKeys.sshKeyId],
	}),
	applications: many(applications, {
		relationName: "applicationServer",
	}),
	buildApplications: many(applications, {
		relationName: "applicationBuildServer",
	}),
	compose: many(compose),
	libsql: many(libsql),
	redis: many(redis),
	mariadb: many(mariadb),
	mongo: many(mongo),
	mysql: many(mysql),
	postgres: many(postgres),
	certificates: many(certificates),
	networks: many(network),
	organization: one(organization, {
		fields: [server.organizationId],
		references: [organization.id],
	}),
	schedules: many(schedules),
}));

const createSchema = createInsertSchema(server, {
	serverId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
});

const serverRolesInput = {
	serverRoles: z.array(z.enum(serverRoleValues)).min(1).optional(),
	/** @deprecated Use `serverRoles`. */
	serverType: z.enum(["deploy", "build"]).optional(),
};

export const legacyServerType = (roles: ServerRole[]) =>
	roles.includes("deploy") ? "deploy" : "build";

export const resolveServerRoles = ({
	serverRoles,
	serverType,
}: {
	serverRoles?: ServerRole[];
	serverType?: "deploy" | "build";
}): ServerRole[] | undefined => {
	if (serverRoles) return [...new Set(serverRoles)];
	if (serverType) return [serverType];
	return undefined;
};

export type ServerRoleUsage = {
	deploy: boolean;
	build: number;
	workflow: number;
};

const ROLE_USAGE_MESSAGES: Record<
	ServerRole,
	(usage: ServerRoleUsage) => string
> = {
	deploy: () => "it still hosts services",
	build: (usage) =>
		`${usage.build} application${usage.build === 1 ? " uses" : "s use"} it as their build server`,
	workflow: (usage) =>
		`${usage.workflow} workflow repositor${usage.workflow === 1 ? "y is" : "ies are"} pinned to it`,
};

/** Describes what stops `removed` roles from being taken off a server; empty when nothing does. */
export const describeRoleRemovalBlockers = (
	removed: ServerRole[],
	usage: ServerRoleUsage,
) =>
	removed.flatMap((role) => {
		const inUse = role === "deploy" ? usage.deploy : usage[role] > 0;
		return inUse
			? [`Can't remove the ${role} role: ${ROLE_USAGE_MESSAGES[role](usage)}.`]
			: [];
	});

export const apiCreateServer = createSchema
	.pick({
		name: true,
		description: true,
		ipAddress: true,
		port: true,
		username: true,
		sshKeyId: true,
		enableDockerCleanup: true,
	})
	.required()
	.extend({
		...serverRolesInput,
		enableDockerCleanup: z.boolean().default(true),
	});

export const apiFindOneServer = z.object({
	serverId: z.string().min(1),
});

export const apiRemoveServer = createSchema
	.pick({
		serverId: true,
	})
	.required();

export const apiUpdateServer = createSchema
	.pick({
		name: true,
		description: true,
		serverId: true,
		ipAddress: true,
		port: true,
		username: true,
		sshKeyId: true,
		enableDockerCleanup: true,
	})
	.required()
	.extend({
		...serverRolesInput,
		command: z.string().optional(),
		enableDockerCleanup: z.boolean().default(true),
	});

export const apiUpdateServerBuildsConcurrency = z.object({
	serverId: z.string().min(1),
	buildsConcurrency: z.number().int().min(1).max(100),
});

export const apiUpdateServerMonitoring = createSchema
	.pick({
		serverId: true,
	})
	.required()
	.extend({
		metricsConfig: z
			.object({
				server: z.object({
					refreshRate: z.number().min(2),
					port: z.number().min(1),
					token: z.string(),
					urlCallback: z.string().url(),
					retentionDays: z.number().min(1),
					cronJob: z.string().min(1),
					thresholds: z.object({
						cpu: z.number().min(0),
						memory: z.number().min(0),
					}),
				}),
				containers: z.object({
					refreshRate: z.number().min(2),
					services: z.object({
						include: z.array(z.string()).optional(),
						exclude: z.array(z.string()).optional(),
					}),
				}),
			})
			.required(),
	});
