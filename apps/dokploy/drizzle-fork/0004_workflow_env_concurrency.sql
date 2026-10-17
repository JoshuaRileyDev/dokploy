CREATE TYPE "public"."workflowEnvKind" AS ENUM('secret', 'variable');--> statement-breakpoint
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
ALTER TABLE "workflow_run" ADD COLUMN "concurrencyGroup" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "concurrencyCancelInProgress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_env" ADD CONSTRAINT "workflow_env_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_env" ADD CONSTRAINT "workflow_env_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;