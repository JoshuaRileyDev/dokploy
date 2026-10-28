export type ServiceStatus = "idle" | "running" | "done" | "error";
export type DeploymentStatus = "running" | "done" | "error" | "cancelled";
export type RunStatus =
	| "queued"
	| "in_progress"
	| "success"
	| "failure"
	| "cancelled"
	| "skipped";

export type ServiceKind =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

export interface ServiceSummary {
	kind: ServiceKind;
	id: string;
	name: string;
	status: ServiceStatus;
}

export interface EnvironmentRow {
	environmentId: string;
	name: string;
	isDefault?: boolean;
	applications: {
		applicationId: string;
		name: string;
		applicationStatus: ServiceStatus;
	}[];
	compose: { composeId: string; name: string; composeStatus: ServiceStatus }[];
	postgres: {
		postgresId: string;
		name: string;
		applicationStatus: ServiceStatus;
	}[];
	mysql: { mysqlId: string; name: string; applicationStatus: ServiceStatus }[];
	mariadb: {
		mariadbId: string;
		name: string;
		applicationStatus: ServiceStatus;
	}[];
	mongo: { mongoId: string; name: string; applicationStatus: ServiceStatus }[];
	redis: { redisId: string; name: string; applicationStatus: ServiceStatus }[];
	libsql: {
		libsqlId: string;
		name: string;
		applicationStatus: ServiceStatus;
	}[];
}

export interface Project {
	projectId: string;
	name: string;
	description: string | null;
	createdAt: string;
	environments: EnvironmentRow[];
}

export interface Deployment {
	deploymentId: string;
	title: string;
	description: string | null;
	status: DeploymentStatus | null;
	logPath: string;
	serverId: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	errorMessage: string | null;
	application?: CentralizedOwner | null;
	compose?: CentralizedOwner | null;
}

interface CentralizedOwner {
	name: string;
	appName: string;
	applicationId?: string;
	composeId?: string;
	environment: {
		environmentId: string;
		name: string;
		project: { projectId: string; name: string };
	};
	server: { serverId: string; name: string } | null;
}

export interface Domain {
	domainId: string;
	host: string;
	https: boolean;
	port: number | null;
	path: string | null;
	certificateType: "letsencrypt" | "none" | "custom";
}

/** The union of fields the detail screen reads from application.one / compose.one / <db>.one. */
export interface ServiceDetail {
	name: string;
	appName: string;
	description: string | null;
	env: string | null;
	createdAt: string;
	serverId: string | null;
	applicationStatus?: ServiceStatus;
	composeStatus?: ServiceStatus;
	sourceType?: string;
	repository?: string | null;
	owner?: string | null;
	branch?: string | null;
	buildType?: string;
	dockerImage?: string | null;
	composeType?: string;
	databaseName?: string;
	databaseUser?: string;
	externalPort?: number | null;
	replicas?: number;
	memoryLimit?: string | null;
	cpuLimit?: string | null;
	autoDeploy?: boolean | null;
	domains?: Domain[];
	deployments?: Deployment[];
	server?: { serverId: string; name: string; ipAddress: string } | null;
	environment: {
		environmentId: string;
		name: string;
		project: { projectId: string; name: string };
	};
}

export interface Server {
	serverId: string;
	name: string;
	description: string | null;
	ipAddress: string;
	port: number;
	username: string;
	serverStatus: "active" | "inactive";
	serverRoles: ("deploy" | "build" | "workflow")[];
	enableDockerCleanup: boolean;
	createdAt: string;
}

export interface StorageVolume {
	mount: string;
	filesystem?: string;
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	usedPercent: number;
}

export interface ServerStorage {
	status: "ok" | "stale" | "error";
	sample: {
		checkedAt: number;
		dockerRoot: string;
		volumes: StorageVolume[];
	} | null;
	history: { t: number; usedBytes: number; totalBytes: number }[];
	error: string | null;
}

export interface Container {
	containerId: string;
	name: string;
	image: string;
	ports: string;
	state: string;
	status: string;
	serverId?: string | null;
}

export interface WorkflowRepository {
	workflowRepositoryId: string;
	owner: string;
	repository: string;
	defaultBranch: string;
	runDokployWorkflows: boolean;
	runGithubWorkflows: boolean;
	lastSyncedAt: string | null;
	syncError: string | null;
	definitions?: WorkflowDefinition[];
}

export interface WorkflowDefinition {
	workflowDefinitionId: string;
	path: string;
	name: string;
	enabled: boolean;
	triggers?: unknown;
}

export interface WorkflowJob {
	workflowJobId: string;
	jobId: string;
	name: string;
	status: RunStatus;
	startedAt: string | null;
	finishedAt: string | null;
	steps?: { name: string; status: RunStatus }[];
}

export interface WorkflowRun {
	workflowRunId: string;
	workflowRepositoryId: string;
	workflowName: string;
	workflowPath: string;
	runNumber: number;
	attempt: number;
	event: string;
	branch: string | null;
	sha: string;
	title: string;
	actor: string | null;
	status: RunStatus;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	jobs?: WorkflowJob[];
	repository?: { owner: string; repository: string };
}

export interface WorkflowLogs {
	workflowRunId: string;
	status: RunStatus;
	runLog: string | null;
	jobs: {
		workflowJobId: string;
		name: string;
		status: RunStatus;
		failedSteps: string[];
		log: string;
	}[];
}

export interface ServerCommand {
	serverCommandId: string;
	command: string;
	status: "running" | "success" | "error" | "cancelled";
	exitCode: number | null;
	errorMessage: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface User {
	userId?: string;
	role: string;
	user: {
		id: string;
		email: string;
		firstName: string | null;
		lastName: string | null;
		image: string | null;
	};
}

export interface Organization {
	id: string;
	name: string;
	logo: string | null;
}
