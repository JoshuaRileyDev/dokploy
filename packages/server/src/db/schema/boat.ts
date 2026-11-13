import { boolean, integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { organization } from "./account";
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
