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
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_repository" ADD CONSTRAINT "workflow_repository_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_repository" ADD CONSTRAINT "workflow_repository_githubId_github_githubId_fk" FOREIGN KEY ("githubId") REFERENCES "public"."github"("githubId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_repository" ADD CONSTRAINT "workflow_repository_defaultServerId_server_serverId_fk" FOREIGN KEY ("defaultServerId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_repo_path_idx" ON "workflow_definition" USING btree ("workflowRepositoryId","path");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_repository_org_repo_idx" ON "workflow_repository" USING btree ("organizationId","githubId","owner","repository");