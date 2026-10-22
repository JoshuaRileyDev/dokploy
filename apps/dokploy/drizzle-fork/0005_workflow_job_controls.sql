ALTER TABLE "workflow_definition" ADD COLUMN "disabledJobs" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "targetJob" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "skippedJobs" text[] DEFAULT ARRAY[]::text[] NOT NULL;