import { relations } from "drizzle-orm";
import {
	boolean,
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
import { server } from "./server";

export const workflowSource = pgEnum("workflowSource", ["github", "dokploy"]);

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
