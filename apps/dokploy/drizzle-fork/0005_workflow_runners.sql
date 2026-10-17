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
ALTER TABLE "workflow_run" ADD COLUMN "runsOn" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "requiresRunner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "workflowRunnerId" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "cancelRequested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runner" ADD CONSTRAINT "workflow_runner_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowRunnerId_workflow_runner_workflowRunnerId_fk" FOREIGN KEY ("workflowRunnerId") REFERENCES "public"."workflow_runner"("workflowRunnerId") ON DELETE set null ON UPDATE no action;