import { relations } from "drizzle-orm";
import { boolean, integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { organization } from "./account";
import { server } from "./server";
import { sshKeys } from "./ssh-key";
import { encryptedText } from "./utils";

export const boatMachineType = pgEnum("boatMachineType", [
	"small",
	"default",
	"large",
	"xlarge",
]);

export const boatSnapshotStatus = pgEnum("boatSnapshotStatus", [
	"none",
	"building",
	"ready",
	"failed",
]);

/** An organization's Boat (boat.dev) connection and what Dokploy uses it for. */
export const boatSettings = pgTable("boat_settings", {
	organizationId: text("organizationId")
		.notNull()
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	apiKey: encryptedText("apiKey").notNull(),
	workflowsEnabled: boolean("workflowsEnabled").notNull().default(true),
	workflowMachineType: boatMachineType("workflowMachineType")
		.notNull()
		.default("default"),
	workflowMaxConcurrentRuns: integer("workflowMaxConcurrentRuns")
		.notNull()
		.default(10),
	workflowSnapshotName: text("workflowSnapshotName"),
	workflowSnapshotStatus: boatSnapshotStatus("workflowSnapshotStatus")
		.notNull()
		.default("none"),
	workflowSnapshotError: text("workflowSnapshotError"),
	workflowSnapshotBuiltAt: text("workflowSnapshotBuiltAt"),
	buildsEnabled: boolean("buildsEnabled").notNull().default(false),
	buildPoolSize: integer("buildPoolSize").notNull().default(3),
	buildMachineType: boatMachineType("buildMachineType")
		.notNull()
		.default("default"),
	buildIdleStopMinutes: integer("buildIdleStopMinutes").notNull().default(10),
	// Dokploy's key for the pool machines; their server rows point at it.
	buildSshKeyId: text("buildSshKeyId").references(() => sshKeys.sshKeyId, {
		onDelete: "set null",
	}),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const apiSaveBoatConnection = z.object({
	apiKey: z.string().trim().startsWith("boat_"),
});

export const apiSaveBoatWorkflowSettings = z.object({
	enabled: z.boolean(),
	machineType: z.enum(boatMachineType.enumValues),
	maxConcurrentRuns: z.number().int().min(1).max(100),
});

export const apiSaveBoatBuildSettings = z.object({
	enabled: z.boolean(),
	poolSize: z.number().int().min(1).max(20),
	machineType: z.enum(boatMachineType.enumValues),
	idleStopMinutes: z.number().int().min(1).max(240),
});

export const boatBuildMachineStatus = pgEnum("boatBuildMachineStatus", [
	"provisioning",
	"ready",
	"failed",
]);

/** A Boat sandbox that Dokploy keeps as a build server and wakes only while it builds. */
export const boatBuildMachines = pgTable("boat_build_machine", {
	serverId: text("serverId")
		.notNull()
		.primaryKey()
		.references(() => server.serverId, { onDelete: "cascade" }),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	sandboxId: text("sandboxId").notNull(),
	status: boatBuildMachineStatus("status").notNull().default("provisioning"),
	error: text("error"),
	// The service it last built, so that service goes back to the machine holding its build cache.
	lastServiceId: text("lastServiceId"),
	lastUsedAt: text("lastUsedAt"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const boatBuildMachineRelations = relations(
	boatBuildMachines,
	({ one }) => ({
		server: one(server, {
			fields: [boatBuildMachines.serverId],
			references: [server.serverId],
		}),
	}),
);

export const apiFindBoatBuildMachine = z.object({
	serverId: z.string().min(1),
});
