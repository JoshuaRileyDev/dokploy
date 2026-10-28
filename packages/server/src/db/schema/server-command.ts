import { relations, sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { server } from "./server";
import { user } from "./user";

export const serverCommandStatus = pgEnum("serverCommandStatus", [
	"running",
	"success",
	"error",
	"cancelled",
]);

export type ServerCommandStatus =
	(typeof serverCommandStatus.enumValues)[number];

export const serverCommands = pgTable(
	"server_command",
	{
		serverCommandId: text("serverCommandId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		serverId: text("serverId")
			.notNull()
			.references(() => server.serverId, { onDelete: "cascade" }),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("userId").references(() => user.id, { onDelete: "set null" }),
		command: text("command").notNull(),
		status: serverCommandStatus("status").notNull().default("running"),
		exitCode: integer("exitCode"),
		errorMessage: text("errorMessage"),
		timeoutSeconds: integer("timeoutSeconds").notNull(),
		logPath: text("logPath").notNull(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		finishedAt: text("finishedAt"),
	},
	(table) => [
		index("server_command_server_created_idx").on(
			table.serverId,
			sql`${table.createdAt} DESC`,
		),
		index("server_command_status_idx").on(table.status),
	],
);

export const serverCommandRelations = relations(serverCommands, ({ one }) => ({
	server: one(server, {
		fields: [serverCommands.serverId],
		references: [server.serverId],
	}),
}));

export const SERVER_COMMAND_DEFAULT_TIMEOUT_SECONDS = 60 * 60;
export const SERVER_COMMAND_MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

export const apiRunServerCommand = z.object({
	serverId: z.string().min(1),
	command: z
		.string()
		.trim()
		.min(1)
		.max(64 * 1024),
	timeoutSeconds: z
		.number()
		.int()
		.min(1)
		.max(SERVER_COMMAND_MAX_TIMEOUT_SECONDS)
		.default(SERVER_COMMAND_DEFAULT_TIMEOUT_SECONDS),
});

export const apiFindServerCommand = z.object({
	serverCommandId: z.string().min(1),
});

export const apiFindServerCommands = z.object({
	serverId: z.string().min(1),
	limit: z.number().int().min(1).max(100).default(20),
});

export const SERVER_COMMAND_MAX_READ_BYTES = 1024 * 1024;

export const apiReadServerCommandLogs = z.object({
	serverCommandId: z.string().min(1),
	offset: z.number().int().min(0).default(0),
	limit: z
		.number()
		.int()
		.min(1)
		.max(SERVER_COMMAND_MAX_READ_BYTES)
		.default(SERVER_COMMAND_MAX_READ_BYTES),
});

export const serverCommandSchema = z.object({
	serverCommandId: z.string(),
	serverId: z.string(),
	organizationId: z.string(),
	userId: z.string().nullable(),
	command: z.string(),
	status: z.enum(serverCommandStatus.enumValues),
	exitCode: z.number().int().nullable(),
	errorMessage: z.string().nullable(),
	timeoutSeconds: z.number().int(),
	createdAt: z.string(),
	finishedAt: z.string().nullable(),
});

export const serverCommandLogChunkSchema = z.object({
	serverCommandId: z.string(),
	status: z.enum(serverCommandStatus.enumValues),
	exitCode: z.number().int().nullable(),
	errorMessage: z.string().nullable(),
	data: z.string(),
	nextOffset: z.number().int(),
	size: z.number().int(),
});
