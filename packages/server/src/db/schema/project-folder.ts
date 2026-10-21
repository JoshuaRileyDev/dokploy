import { relations } from "drizzle-orm";
import { type AnyPgColumn, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { projects } from "./project";

export const projectFolders = pgTable("fork_project_folder", {
	folderId: text("folderId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	parentFolderId: text("parentFolderId").references(
		(): AnyPgColumn => projectFolders.folderId,
		{ onDelete: "cascade" },
	),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// A separate table rather than a column on `project` keeps upstream's schema untouched.
export const projectFolderItems = pgTable("fork_project_folder_item", {
	projectId: text("projectId")
		.notNull()
		.primaryKey()
		.references(() => projects.projectId, { onDelete: "cascade" }),
	folderId: text("folderId")
		.notNull()
		.references(() => projectFolders.folderId, { onDelete: "cascade" }),
});

export const projectFolderRelations = relations(
	projectFolders,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [projectFolders.organizationId],
			references: [organization.id],
		}),
		parent: one(projectFolders, {
			fields: [projectFolders.parentFolderId],
			references: [projectFolders.folderId],
			relationName: "folderParent",
		}),
		children: many(projectFolders, { relationName: "folderParent" }),
		items: many(projectFolderItems),
	}),
);

export const projectFolderItemRelations = relations(
	projectFolderItems,
	({ one }) => ({
		folder: one(projectFolders, {
			fields: [projectFolderItems.folderId],
			references: [projectFolders.folderId],
		}),
		project: one(projects, {
			fields: [projectFolderItems.projectId],
			references: [projects.projectId],
		}),
	}),
);

export const apiCreateProjectFolder = z.object({
	name: z.string().trim().min(1).max(100),
	parentFolderId: z.string().min(1).nullable(),
});

export const apiRenameProjectFolder = z.object({
	folderId: z.string().min(1),
	name: z.string().trim().min(1).max(100),
});

export const apiMoveProjectFolder = z.object({
	folderId: z.string().min(1),
	parentFolderId: z.string().min(1).nullable(),
});

export const apiRemoveProjectFolder = z.object({
	folderId: z.string().min(1),
});

export const apiMoveProjectsToFolder = z.object({
	projectIds: z.array(z.string().min(1)).min(1),
	folderId: z.string().min(1).nullable(),
});
