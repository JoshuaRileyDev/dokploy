import { relations } from "drizzle-orm";
import {
	foreignKey,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { cloudProviderTypes } from "../../utils/cloud-providers/types";
import { organization } from "./account";
import { server } from "./server";
import { encryptedText } from "./utils";

export const serverProvisioningStatus = pgEnum("serverProvisioningStatus", [
	"pending",
	"creating_server",
	"waiting_for_ssh",
	"installing",
	"completed",
	"failed",
]);

export type ServerProvisioningStatus =
	(typeof serverProvisioningStatus.enumValues)[number];

export const cloudProviderAccount = pgTable(
	"cloud_provider_account",
	{
		cloudProviderAccountId: text("cloudProviderAccountId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		// Plain text rather than an enum so adding a provider needs no migration;
		// values are validated against the provider registry.
		providerType: text("providerType").notNull(),
		// JSON object of the provider's credential fields.
		credentials: encryptedText("credentials").notNull(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("cloud_provider_account_org_name_idx").on(
			table.organizationId,
			table.name,
		),
	],
);

export interface ServerProvisioningConfig {
	name: string;
	location: string;
	serverType: string;
	image: string;
	role: "deploy" | "build";
}

export const serverProvisioning = pgTable(
	"server_provisioning",
	{
		serverProvisioningId: text("serverProvisioningId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		cloudProviderAccountId: text("cloudProviderAccountId"),
		serverId: text("serverId").references(() => server.serverId, {
			onDelete: "set null",
		}),
		providerType: text("providerType").notNull(),
		status: serverProvisioningStatus("status").notNull().default("pending"),
		message: text("message"),
		error: text("error"),
		config: jsonb("config").$type<ServerProvisioningConfig>().notNull(),
		providerServerId: text("providerServerId"),
		providerSshKeyId: text("providerSshKeyId"),
		ipAddress: text("ipAddress"),
		providerServerDeletedAt: text("providerServerDeletedAt"),
		dismissedAt: text("dismissedAt"),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		completedAt: text("completedAt"),
	},
	(table) => [
		// The generated name exceeds Postgres' 63-character identifier limit.
		foreignKey({
			name: "server_provisioning_account_fk",
			columns: [table.cloudProviderAccountId],
			foreignColumns: [cloudProviderAccount.cloudProviderAccountId],
		}).onDelete("set null"),
	],
);

export const serverProvisioningRelations = relations(
	serverProvisioning,
	({ one }) => ({
		account: one(cloudProviderAccount, {
			fields: [serverProvisioning.cloudProviderAccountId],
			references: [cloudProviderAccount.cloudProviderAccountId],
		}),
		server: one(server, {
			fields: [serverProvisioning.serverId],
			references: [server.serverId],
		}),
	}),
);

const accountNameSchema = z
	.string()
	.trim()
	.min(1, "Name is required")
	.max(64)
	.regex(
		/^[a-zA-Z0-9_-]+$/,
		"Name can only contain letters, numbers, dashes and underscores",
	);

const credentialsSchema = z.record(
	z.string(),
	z
		.string()
		.optional()
		.transform((value) => value ?? ""),
);

export const apiCreateCloudProviderAccount = z.object({
	name: accountNameSchema,
	providerType: z.enum(cloudProviderTypes),
	credentials: credentialsSchema,
});

export const apiUpdateCloudProviderAccount = z.object({
	cloudProviderAccountId: z.string().min(1),
	name: accountNameSchema,
	// Blank secret fields keep their stored value.
	credentials: credentialsSchema,
});

export const apiFindOneCloudProviderAccount = z.object({
	cloudProviderAccountId: z.string().min(1),
});

export const apiTestCloudProviderAccount = z.object({
	cloudProviderAccountId: z.string().min(1).optional(),
	providerType: z.enum(cloudProviderTypes),
	credentials: credentialsSchema,
});

// RFC 1123 hostname label, accepted by every major provider.
export const cloudServerNameSchema = z
	.string()
	.trim()
	.min(1, "Name is required")
	.max(63, "Name must be 63 characters or fewer")
	.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
		"Use lowercase letters, numbers and hyphens (no leading or trailing hyphen)",
	);

export const apiProvisionCloudServer = z.object({
	cloudProviderAccountId: z.string().min(1),
	name: cloudServerNameSchema,
	location: z.string().min(1),
	serverType: z.string().min(1),
	image: z.string().min(1),
	role: z.enum(["deploy", "build"]).default("deploy"),
});

export const apiFindServerProvisioning = z.object({
	serverProvisioningId: z.string().min(1),
});

export const apiFindProvisioningByServer = z.object({
	serverId: z.string().min(1),
});
