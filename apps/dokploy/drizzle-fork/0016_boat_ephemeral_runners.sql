ALTER TABLE "workflow_runner" ADD COLUMN "ephemeralRunId" text;--> statement-breakpoint
ALTER TABLE "workflow_runner" ADD CONSTRAINT "workflow_runner_ephemeralRunId_unique" UNIQUE("ephemeralRunId");