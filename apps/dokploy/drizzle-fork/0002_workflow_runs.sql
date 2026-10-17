CREATE TYPE "public"."workflowJobStatus" AS ENUM('queued', 'in_progress', 'success', 'failure', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."workflowRunStatus" AS ENUM('queued', 'in_progress', 'success', 'failure', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TABLE "workflow_job" (
	"workflowJobId" text PRIMARY KEY NOT NULL,
	"workflowRunId" text NOT NULL,
	"actKey" text NOT NULL,
	"jobId" text NOT NULL,
	"name" text NOT NULL,
	"matrix" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "workflowJobStatus" DEFAULT 'in_progress' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"logPath" text NOT NULL,
	"position" integer NOT NULL,
	"startedAt" text,
	"finishedAt" text
);
--> statement-breakpoint
CREATE TABLE "workflow_run" (
	"workflowRunId" text PRIMARY KEY NOT NULL,
	"workflowRepositoryId" text NOT NULL,
	"workflowDefinitionId" text,
	"workflowPath" text NOT NULL,
	"workflowName" text NOT NULL,
	"source" "workflowSource" NOT NULL,
	"runNumber" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"event" text NOT NULL,
	"eventAction" text,
	"payload" jsonb NOT NULL,
	"inputs" jsonb,
	"jobNames" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ref" text NOT NULL,
	"sha" text NOT NULL,
	"branch" text,
	"title" text NOT NULL,
	"actor" text,
	"pullRequestNumber" integer,
	"trusted" boolean DEFAULT true NOT NULL,
	"status" "workflowRunStatus" DEFAULT 'queued' NOT NULL,
	"errorMessage" text,
	"serverId" text,
	"logPath" text,
	"createdAt" text NOT NULL,
	"startedAt" text,
	"finishedAt" text
);
--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_workflowRunId_workflow_run_workflowRunId_fk" FOREIGN KEY ("workflowRunId") REFERENCES "public"."workflow_run"("workflowRunId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowDefinitionId_workflow_definition_workflowDefinitionId_fk" FOREIGN KEY ("workflowDefinitionId") REFERENCES "public"."workflow_definition"("workflowDefinitionId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_run_repo_created_idx" ON "workflow_run" USING btree ("workflowRepositoryId","createdAt");--> statement-breakpoint
CREATE INDEX "workflow_run_status_idx" ON "workflow_run" USING btree ("status");