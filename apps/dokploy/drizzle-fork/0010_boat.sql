CREATE TYPE "public"."boatMachineType" AS ENUM('small', 'default', 'large', 'xlarge');--> statement-breakpoint
CREATE TYPE "public"."boatSnapshotStatus" AS ENUM('none', 'building', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "boat_settings" (
	"organizationId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"workflowsEnabled" boolean DEFAULT true NOT NULL,
	"workflowMachineType" "boatMachineType" DEFAULT 'default' NOT NULL,
	"workflowMaxConcurrentRuns" integer DEFAULT 10 NOT NULL,
	"workflowSnapshotName" text,
	"workflowSnapshotStatus" "boatSnapshotStatus" DEFAULT 'none' NOT NULL,
	"workflowSnapshotError" text,
	"workflowSnapshotBuiltAt" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "runsOnBoat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "boatSandboxId" text;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD CONSTRAINT "boat_settings_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;