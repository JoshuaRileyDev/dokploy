import { relations, sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
	WorkflowJobSummary,
	WorkflowTrigger,
} from "../../utils/workflows/parser";
import { organization } from "./account";
import { github } from "./github";
import { notifications } from "./notification";
import { server } from "./server";

export const workflowSource = pgEnum("workflowSource", ["github", "dokploy"]);

export const workflowRunStatus = pgEnum("workflowRunStatus", [
	"queued",
	"in_progress",
	"success",
	"failure",
	"cancelled",
	"skipped",
]);

export const workflowJobStatus = pgEnum("workflowJobStatus", [
	"queued",
	"in_progress",
	"success",
	"failure",
	"cancelled",
	"skipped",
]);

export type WorkflowRunStatus = (typeof workflowRunStatus.enumValues)[number];
export type WorkflowJobStatus = (typeof workflowJobStatus.enumValues)[number];

export type WorkflowStepState = {
	key: string;
	name: string;
	status: WorkflowJobStatus;
	startedAt?: string;
	durationMs?: number;
};

export const workflowRepositories = pgTable(
	"workflow_repository",
	{
		workflowRepositoryId: text("workflowRepositoryId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		githubId: text("githubId").references(() => github.githubId, {
			onDelete: "cascade",
		}),
		owner: text("owner").notNull(),
		repository: text("repository").notNull(),
		defaultBranch: text("defaultBranch").notNull().default("main"),
		runGithubWorkflows: boolean("runGithubWorkflows").notNull().default(false),
		runDokployWorkflows: boolean("runDokployWorkflows").notNull().default(true),
		defaultServerId: text("defaultServerId").references(() => server.serverId, {
			onDelete: "set null",
		}),
		lastSyncedAt: text("lastSyncedAt"),
		syncError: text("syncError"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("workflow_repository_org_repo_idx").on(
			table.organizationId,
			table.githubId,
			table.owner,
			table.repository,
		),
	],
);

export const workflowDefinitions = pgTable(
	"workflow_definition",
	{
		workflowDefinitionId: text("workflowDefinitionId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		workflowRepositoryId: text("workflowRepositoryId")
			.notNull()
			.references(() => workflowRepositories.workflowRepositoryId, {
				onDelete: "cascade",
			}),
		path: text("path").notNull(),
		source: workflowSource("source").notNull(),
		name: text("name").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		triggers: jsonb("triggers")
			.$type<WorkflowTrigger[]>()
			.notNull()
			.default([]),
		jobs: jsonb("jobs").$type<WorkflowJobSummary[]>().notNull().default([]),
		sha: text("sha"),
		parseError: text("parseError"),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("workflow_definition_repo_path_idx").on(
			table.workflowRepositoryId,
			table.path,
		),
	],
);

export const workflowRepositoryRelations = relations(
	workflowRepositories,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [workflowRepositories.organizationId],
			references: [organization.id],
		}),
		github: one(github, {
			fields: [workflowRepositories.githubId],
			references: [github.githubId],
		}),
		defaultServer: one(server, {
			fields: [workflowRepositories.defaultServerId],
			references: [server.serverId],
		}),
		definitions: many(workflowDefinitions),
		runs: many(workflowRuns),
	}),
);

export const workflowDefinitionRelations = relations(
	workflowDefinitions,
	({ one }) => ({
		repository: one(workflowRepositories, {
			fields: [workflowDefinitions.workflowRepositoryId],
			references: [workflowRepositories.workflowRepositoryId],
		}),
	}),
);

export const workflowRuns = pgTable(
	"workflow_run",
	{
		workflowRunId: text("workflowRunId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		workflowRepositoryId: text("workflowRepositoryId")
			.notNull()
			.references(() => workflowRepositories.workflowRepositoryId, {
				onDelete: "cascade",
			}),
		workflowDefinitionId: text("workflowDefinitionId").references(
			() => workflowDefinitions.workflowDefinitionId,
			{ onDelete: "set null" },
		),
		workflowPath: text("workflowPath").notNull(),
		workflowName: text("workflowName").notNull(),
		source: workflowSource("source").notNull(),
		runNumber: integer("runNumber").notNull(),
		attempt: integer("attempt").notNull().default(1),
		event: text("event").notNull(),
		eventAction: text("eventAction"),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		inputs: jsonb("inputs").$type<Record<string, string>>(),
		jobNames: jsonb("jobNames")
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		ref: text("ref").notNull(),
		sha: text("sha").notNull(),
		branch: text("branch"),
		title: text("title").notNull(),
		actor: text("actor"),
		pullRequestNumber: integer("pullRequestNumber"),
		trusted: boolean("trusted").notNull().default(true),
		status: workflowRunStatus("status").notNull().default("queued"),
		errorMessage: text("errorMessage"),
		serverId: text("serverId").references(() => server.serverId, {
			onDelete: "set null",
		}),
		logPath: text("logPath"),
		checkRunId: text("checkRunId"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
	},
	(table) => [
		index("workflow_run_repo_created_idx").on(
			table.workflowRepositoryId,
			table.createdAt,
		),
		index("workflow_run_status_idx").on(table.status),
	],
);

export const workflowJobs = pgTable("workflow_job", {
	workflowJobId: text("workflowJobId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	workflowRunId: text("workflowRunId")
		.notNull()
		.references(() => workflowRuns.workflowRunId, { onDelete: "cascade" }),
	actKey: text("actKey").notNull(),
	jobId: text("jobId").notNull(),
	name: text("name").notNull(),
	matrix: jsonb("matrix")
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	status: workflowJobStatus("status").notNull().default("in_progress"),
	steps: jsonb("steps").$type<WorkflowStepState[]>().notNull().default([]),
	logPath: text("logPath").notNull(),
	position: integer("position").notNull(),
	startedAt: text("startedAt"),
	finishedAt: text("finishedAt"),
});

export const workflowRunRelations = relations(
	workflowRuns,
	({ one, many }) => ({
		repository: one(workflowRepositories, {
			fields: [workflowRuns.workflowRepositoryId],
			references: [workflowRepositories.workflowRepositoryId],
		}),
		definition: one(workflowDefinitions, {
			fields: [workflowRuns.workflowDefinitionId],
			references: [workflowDefinitions.workflowDefinitionId],
		}),
		server: one(server, {
			fields: [workflowRuns.serverId],
			references: [server.serverId],
		}),
		jobs: many(workflowJobs),
	}),
);

export const workflowJobRelations = relations(workflowJobs, ({ one }) => ({
	run: one(workflowRuns, {
		fields: [workflowJobs.workflowRunId],
		references: [workflowRuns.workflowRunId],
	}),
}));

export const workflowNotifications = pgTable("workflow_notification", {
	workflowNotificationId: text("workflowNotificationId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	notificationId: text("notificationId")
		.notNull()
		.references(() => notifications.notificationId, { onDelete: "cascade" }),
	workflowRepositoryId: text("workflowRepositoryId").references(
		() => workflowRepositories.workflowRepositoryId,
		{ onDelete: "cascade" },
	),
	branches: text("branches").array().notNull().default(sql`ARRAY[]::text[]`),
	onFailure: boolean("onFailure").notNull().default(true),
	onSuccess: boolean("onSuccess").notNull().default(false),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const workflowNotificationRelations = relations(
	workflowNotifications,
	({ one }) => ({
		notification: one(notifications, {
			fields: [workflowNotifications.notificationId],
			references: [notifications.notificationId],
		}),
		repository: one(workflowRepositories, {
			fields: [workflowNotifications.workflowRepositoryId],
			references: [workflowRepositories.workflowRepositoryId],
		}),
	}),
);

export const apiImportWorkflowRepository = z.object({
	githubId: z.string().min(1),
	owner: z.string().min(1),
	repository: z.string().min(1),
	defaultServerId: z.string().nullable().optional(),
});

export const apiFindOneWorkflowRepository = z.object({
	workflowRepositoryId: z.string().min(1),
});

export const apiUpdateWorkflowRepository = z.object({
	workflowRepositoryId: z.string().min(1),
	runGithubWorkflows: z.boolean().optional(),
	runDokployWorkflows: z.boolean().optional(),
	defaultServerId: z.string().nullable().optional(),
});

export const apiSetWorkflowDefinitionEnabled = z.object({
	workflowDefinitionId: z.string().min(1),
	enabled: z.boolean(),
});

export const apiFindWorkflowRuns = z.object({
	workflowRepositoryId: z.string().optional(),
	status: z.enum(workflowRunStatus.enumValues).optional(),
	limit: z.number().int().min(1).max(200).default(50),
});

export const apiFindOneWorkflowRun = z.object({
	workflowRunId: z.string().min(1),
});

export const apiDispatchWorkflow = z.object({
	workflowDefinitionId: z.string().min(1),
	branch: z.string().min(1),
	inputs: z.record(z.string(), z.string()).default({}),
});

export const apiCreateWorkflowNotification = z.object({
	notificationId: z.string().min(1),
	workflowRepositoryId: z.string().nullable().default(null),
	branches: z.array(z.string().min(1)).default([]),
	onFailure: z.boolean().default(true),
	onSuccess: z.boolean().default(false),
});

export const apiRemoveWorkflowNotification = z.object({
	workflowNotificationId: z.string().min(1),
});
