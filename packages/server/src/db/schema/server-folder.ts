import { relations, sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { server } from "./server";

export const serverFolders = pgTable(
	"fork_server_folder",
	{
		folderId: text("folderId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("fork_server_folder_org_name_idx").on(
			table.organizationId,
			sql`lower(${table.name})`,
		),
	],
);

// A separate table rather than a column on `server` keeps upstream's schema untouched.
export const serverFolderItems = pgTable(
	"fork_server_folder_item",
	{
		serverId: text("serverId")
			.notNull()
			.primaryKey()
			.references(() => server.serverId, { onDelete: "cascade" }),
		folderId: text("folderId")
			.notNull()
			.references(() => serverFolders.folderId, { onDelete: "cascade" }),
	},
	(table) => [index("fork_server_folder_item_folder_idx").on(table.folderId)],
);

export const serverFolderRelations = relations(
	serverFolders,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [serverFolders.organizationId],
			references: [organization.id],
		}),
		items: many(serverFolderItems),
	}),
);

export const serverFolderItemRelations = relations(
	serverFolderItems,
	({ one }) => ({
		folder: one(serverFolders, {
			fields: [serverFolderItems.folderId],
			references: [serverFolders.folderId],
		}),
		server: one(server, {
			fields: [serverFolderItems.serverId],
			references: [server.serverId],
		}),
	}),
);

const folderName = z.string().trim().min(1).max(64);

export const apiCreateServerFolder = z.object({
	name: folderName,
});

export const apiRenameServerFolder = z.object({
	folderId: z.string().min(1),
	name: folderName,
});

export const apiRemoveServerFolder = z.object({
	folderId: z.string().min(1),
});

export const apiMoveServersToFolder = z.object({
	serverIds: z.array(z.string().min(1)).min(1).max(500),
	folderId: z.string().min(1).nullable(),
});
