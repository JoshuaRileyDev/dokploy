import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	deployments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "@dokploy/server/db/schema";
import { desc, inArray } from "drizzle-orm";

export type ServerServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

export type ServerServiceStatus = "running" | "deploying" | "error" | "stopped";

export interface ServerServiceSummary {
	id: string;
	type: ServerServiceType;
	name: string;
	appName: string;
	serverId: string;
	projectId: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
	status: ServerServiceStatus;
	lastDeployedAt: string | null;
	domain: string | null;
	url: string;
}

// Dokploy keeps "done" after a successful deploy and resets to "idle" when a service is stopped.
const toStatus = (
	status: "idle" | "running" | "done" | "error",
): ServerServiceStatus => {
	switch (status) {
		case "done":
			return "running";
		case "running":
			return "deploying";
		case "error":
			return "error";
		default:
			return "stopped";
	}
};

const environmentWith = {
	environment: {
		columns: { environmentId: true, name: true },
		with: { project: { columns: { projectId: true, name: true } } },
	},
} as const;

const domainWith = {
	domains: {
		columns: { host: true, https: true, path: true },
		limit: 1,
	},
} as const;

type Row = {
	name: string;
	appName: string;
	serverId: string | null;
	environment: {
		environmentId: string;
		name: string;
		project: { projectId: string; name: string };
	};
	domains?: { host: string; https: boolean; path: string | null }[];
	deployments?: { createdAt: string }[];
};

const toSummary = (
	type: ServerServiceType,
	id: string,
	status: "idle" | "running" | "done" | "error",
	row: Row,
): ServerServiceSummary => {
	const domain = row.domains?.[0];
	const { environment } = row;
	return {
		id,
		type,
		name: row.name,
		appName: row.appName,
		serverId: row.serverId!,
		projectId: environment.project.projectId,
		projectName: environment.project.name,
		environmentId: environment.environmentId,
		environmentName: environment.name,
		status: toStatus(status),
		lastDeployedAt: row.deployments?.[0]?.createdAt ?? null,
		domain: domain
			? `${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`
			: null,
		url: `/dashboard/project/${environment.project.projectId}/environment/${environment.environmentId}/services/${type}/${id}`,
	};
};

/** Every application, compose stack and database deployed to the given servers. */
export const getServerServices = async (
	serverIds: string[],
): Promise<ServerServiceSummary[]> => {
	if (serverIds.length === 0) return [];

	const latestDeployment = {
		deployments: {
			columns: { createdAt: true },
			orderBy: desc(deployments.createdAt),
			limit: 1,
		},
	} as const;

	const [apps, stacks, pg, my, maria, mgo, rds, lsql] = await Promise.all([
		db.query.applications.findMany({
			where: inArray(applications.serverId, serverIds),
			columns: {
				applicationId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: { ...environmentWith, ...domainWith, ...latestDeployment },
		}),
		db.query.compose.findMany({
			where: inArray(compose.serverId, serverIds),
			columns: {
				composeId: true,
				name: true,
				appName: true,
				serverId: true,
				composeStatus: true,
			},
			with: { ...environmentWith, ...domainWith, ...latestDeployment },
		}),
		db.query.postgres.findMany({
			where: inArray(postgres.serverId, serverIds),
			columns: {
				postgresId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: environmentWith,
		}),
		db.query.mysql.findMany({
			where: inArray(mysql.serverId, serverIds),
			columns: {
				mysqlId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: environmentWith,
		}),
		db.query.mariadb.findMany({
			where: inArray(mariadb.serverId, serverIds),
			columns: {
				mariadbId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: environmentWith,
		}),
		db.query.mongo.findMany({
			where: inArray(mongo.serverId, serverIds),
			columns: {
				mongoId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: environmentWith,
		}),
		db.query.redis.findMany({
			where: inArray(redis.serverId, serverIds),
			columns: {
				redisId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: environmentWith,
		}),
		db.query.libsql.findMany({
			where: inArray(libsql.serverId, serverIds),
			columns: {
				libsqlId: true,
				name: true,
				appName: true,
				serverId: true,
				applicationStatus: true,
			},
			with: environmentWith,
		}),
	]);

	return [
		...apps.map((r) =>
			toSummary("application", r.applicationId, r.applicationStatus, r),
		),
		...stacks.map((r) => toSummary("compose", r.composeId, r.composeStatus, r)),
		...pg.map((r) =>
			toSummary("postgres", r.postgresId, r.applicationStatus, r),
		),
		...my.map((r) => toSummary("mysql", r.mysqlId, r.applicationStatus, r)),
		...maria.map((r) =>
			toSummary("mariadb", r.mariadbId, r.applicationStatus, r),
		),
		...mgo.map((r) => toSummary("mongo", r.mongoId, r.applicationStatus, r)),
		...rds.map((r) => toSummary("redis", r.redisId, r.applicationStatus, r)),
		...lsql.map((r) => toSummary("libsql", r.libsqlId, r.applicationStatus, r)),
	];
};
