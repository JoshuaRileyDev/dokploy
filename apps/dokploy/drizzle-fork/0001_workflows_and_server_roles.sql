CREATE TYPE "public"."serverRole" AS ENUM('deploy', 'build', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."workflowEnvKind" AS ENUM('secret', 'variable');--> statement-breakpoint
CREATE TYPE "public"."workflowJobStatus" AS ENUM('queued', 'in_progress', 'success', 'failure', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."workflowRunStatus" AS ENUM('queued', 'in_progress', 'success', 'failure', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."workflowSource" AS ENUM('github', 'dokploy');--> statement-breakpoint
CREATE TABLE "workflow_definition" (
	"workflowDefinitionId" text PRIMARY KEY NOT NULL,
	"workflowRepositoryId" text NOT NULL,
	"path" text NOT NULL,
	"source" "workflowSource" NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sha" text,
	"parseError" text,
	"updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_env" (
	"workflowEnvId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"workflowRepositoryId" text,
	"kind" "workflowEnvKind" NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "workflow_env_scope_name_unique" UNIQUE NULLS NOT DISTINCT("organizationId","workflowRepositoryId","kind","name")
);
--> statement-breakpoint
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
CREATE TABLE "workflow_notification" (
	"workflowNotificationId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"notificationId" text NOT NULL,
	"workflowRepositoryId" text,
	"branches" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"onFailure" boolean DEFAULT true NOT NULL,
	"onSuccess" boolean DEFAULT false NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_repository" (
	"workflowRepositoryId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"githubId" text,
	"owner" text NOT NULL,
	"repository" text NOT NULL,
	"defaultBranch" text DEFAULT 'main' NOT NULL,
	"runGithubWorkflows" boolean DEFAULT false NOT NULL,
	"runDokployWorkflows" boolean DEFAULT true NOT NULL,
	"defaultServerId" text,
	"lastSyncedAt" text,
	"syncError" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runner" (
	"workflowRunnerId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"labels" text[] NOT NULL,
	"allowedRepositoryIds" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"tokenHash" text,
	"registrationTokenHash" text,
	"registrationExpiresAt" text,
	"lastSeenAt" text,
	"version" text,
	"os" text,
	"arch" text,
	"createdAt" text NOT NULL,
	CONSTRAINT "workflow_runner_tokenHash_unique" UNIQUE("tokenHash"),
	CONSTRAINT "workflow_runner_registrationTokenHash_unique" UNIQUE("registrationTokenHash")
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
	"checkRunId" text,
	"concurrencyGroup" text,
	"runsOn" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"requiresRunner" boolean DEFAULT false NOT NULL,
	"workflowRunnerId" text,
	"cancelRequested" boolean DEFAULT false NOT NULL,
	"concurrencyCancelInProgress" boolean DEFAULT false NOT NULL,
	"createdAt" text NOT NULL,
	"startedAt" text,
	"finishedAt" text
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "serverRoles" "serverRole"[] DEFAULT ARRAY['deploy']::"serverRole"[] NOT NULL;--> statement-breakpoint
UPDATE "server" SET "serverRoles" = ARRAY["serverType"::text::"serverRole"];--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_env" ADD CONSTRAINT "workflow_env_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_env" ADD CONSTRAINT "workflow_env_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_workflowRunId_workflow_run_workflowRunId_fk" FOREIGN KEY ("workflowRunId") REFERENCES "public"."workflow_run"("workflowRunId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_notification" ADD CONSTRAINT "workflow_notification_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_notification" ADD CONSTRAINT "workflow_notification_notificationId_notification_notificationId_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."notification"("notificationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_notification" ADD CONSTRAINT "workflow_notification_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_repository" ADD CONSTRAINT "workflow_repository_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_repository" ADD CONSTRAINT "workflow_repository_githubId_github_githubId_fk" FOREIGN KEY ("githubId") REFERENCES "public"."github"("githubId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_repository" ADD CONSTRAINT "workflow_repository_defaultServerId_server_serverId_fk" FOREIGN KEY ("defaultServerId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runner" ADD CONSTRAINT "workflow_runner_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowDefinitionId_workflow_definition_workflowDefinitionId_fk" FOREIGN KEY ("workflowDefinitionId") REFERENCES "public"."workflow_definition"("workflowDefinitionId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowRunnerId_workflow_runner_workflowRunnerId_fk" FOREIGN KEY ("workflowRunnerId") REFERENCES "public"."workflow_runner"("workflowRunnerId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_repo_path_idx" ON "workflow_definition" USING btree ("workflowRepositoryId","path");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_repository_org_repo_idx" ON "workflow_repository" USING btree ("organizationId","githubId","owner","repository");--> statement-breakpoint
CREATE INDEX "workflow_run_repo_created_idx" ON "workflow_run" USING btree ("workflowRepositoryId","createdAt");--> statement-breakpoint
CREATE INDEX "workflow_run_status_idx" ON "workflow_run" USING btree ("status");