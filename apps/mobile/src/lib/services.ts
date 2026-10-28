import type { SFSymbol } from "expo-symbols";

import type {
	EnvironmentRow,
	ServiceDetail,
	ServiceKind,
	ServiceStatus,
	ServiceSummary,
} from "./types";

export type ServiceAction =
	| "deploy"
	| "redeploy"
	| "start"
	| "stop"
	| "reload"
	| "rebuild"
	| "cancelDeployment";

interface KindMeta {
	label: string;
	idKey: string;
	symbol: SFSymbol;
	/** Background of the Settings-style icon tile. */
	hue: string;
	isDatabase: boolean;
	actions: ServiceAction[];
	hasDeployments: boolean;
	hasDomains: boolean;
	hasRuntimeLogs: boolean;
}

const dbActions: ServiceAction[] = [
	"deploy",
	"start",
	"stop",
	"reload",
	"rebuild",
];

export const KINDS: Record<ServiceKind, KindMeta> = {
	application: {
		label: "Application",
		idKey: "applicationId",
		symbol: "shippingbox.fill",
		hue: "#5E5CE6",
		isDatabase: false,
		actions: [
			"deploy",
			"redeploy",
			"start",
			"stop",
			"reload",
			"cancelDeployment",
		],
		hasDeployments: true,
		hasDomains: true,
		hasRuntimeLogs: true,
	},
	compose: {
		label: "Compose",
		idKey: "composeId",
		symbol: "square.stack.3d.up.fill",
		hue: "#0A84FF",
		isDatabase: false,
		actions: ["deploy", "redeploy", "start", "stop", "cancelDeployment"],
		hasDeployments: true,
		hasDomains: true,
		hasRuntimeLogs: false,
	},
	postgres: {
		label: "PostgreSQL",
		idKey: "postgresId",
		symbol: "cylinder.split.1x2.fill",
		hue: "#336791",
		isDatabase: true,
		actions: dbActions,
		hasDeployments: false,
		hasDomains: false,
		hasRuntimeLogs: true,
	},
	mysql: {
		label: "MySQL",
		idKey: "mysqlId",
		symbol: "cylinder.fill",
		hue: "#E48E00",
		isDatabase: true,
		actions: dbActions,
		hasDeployments: false,
		hasDomains: false,
		hasRuntimeLogs: true,
	},
	mariadb: {
		label: "MariaDB",
		idKey: "mariadbId",
		symbol: "cylinder.fill",
		hue: "#C0765A",
		isDatabase: true,
		actions: dbActions,
		hasDeployments: false,
		hasDomains: false,
		hasRuntimeLogs: true,
	},
	mongo: {
		label: "MongoDB",
		idKey: "mongoId",
		symbol: "leaf.fill",
		hue: "#13AA52",
		isDatabase: true,
		actions: dbActions,
		hasDeployments: false,
		hasDomains: false,
		hasRuntimeLogs: true,
	},
	redis: {
		label: "Redis",
		idKey: "redisId",
		symbol: "bolt.horizontal.fill",
		hue: "#D82C20",
		isDatabase: true,
		actions: dbActions,
		hasDeployments: false,
		hasDomains: false,
		hasRuntimeLogs: true,
	},
	libsql: {
		label: "libSQL",
		idKey: "libsqlId",
		symbol: "externaldrive.fill",
		hue: "#2BB6A3",
		isDatabase: true,
		actions: dbActions,
		hasDeployments: false,
		hasDomains: false,
		hasRuntimeLogs: true,
	},
};

export const ACTION_META: Record<
	ServiceAction,
	{ label: string; symbol: SFSymbol; destructive?: boolean; confirm?: string }
> = {
	deploy: { label: "Deploy", symbol: "paperplane.fill" },
	redeploy: { label: "Redeploy", symbol: "arrow.triangle.2.circlepath" },
	start: { label: "Start", symbol: "play.fill" },
	stop: {
		label: "Stop",
		symbol: "stop.fill",
		destructive: true,
		confirm: "The service will stop serving traffic until you start it again.",
	},
	reload: { label: "Reload", symbol: "arrow.clockwise" },
	rebuild: {
		label: "Rebuild",
		symbol: "hammer.fill",
		destructive: true,
		confirm:
			"The container is recreated from scratch. Data in volumes is kept.",
	},
	cancelDeployment: {
		label: "Cancel Build",
		symbol: "xmark.octagon.fill",
		destructive: true,
	},
};

export function serviceStatus(
	detail: Pick<ServiceDetail, "applicationStatus" | "composeStatus">,
): ServiceStatus {
	return detail.applicationStatus ?? detail.composeStatus ?? "idle";
}

export function flattenEnvironment(env: EnvironmentRow): ServiceSummary[] {
	return [
		...env.applications.map((s) => ({
			kind: "application" as const,
			id: s.applicationId,
			name: s.name,
			status: s.applicationStatus,
		})),
		...env.compose.map((s) => ({
			kind: "compose" as const,
			id: s.composeId,
			name: s.name,
			status: s.composeStatus,
		})),
		...env.postgres.map((s) => ({
			kind: "postgres" as const,
			id: s.postgresId,
			name: s.name,
			status: s.applicationStatus,
		})),
		...env.mysql.map((s) => ({
			kind: "mysql" as const,
			id: s.mysqlId,
			name: s.name,
			status: s.applicationStatus,
		})),
		...env.mariadb.map((s) => ({
			kind: "mariadb" as const,
			id: s.mariadbId,
			name: s.name,
			status: s.applicationStatus,
		})),
		...env.mongo.map((s) => ({
			kind: "mongo" as const,
			id: s.mongoId,
			name: s.name,
			status: s.applicationStatus,
		})),
		...env.redis.map((s) => ({
			kind: "redis" as const,
			id: s.redisId,
			name: s.name,
			status: s.applicationStatus,
		})),
		...(env.libsql ?? []).map((s) => ({
			kind: "libsql" as const,
			id: s.libsqlId,
			name: s.name,
			status: s.applicationStatus,
		})),
	];
}
