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
ALTER TABLE "workflow_run" ADD COLUMN "checkRunId" text;--> statement-breakpoint
ALTER TABLE "workflow_notification" ADD CONSTRAINT "workflow_notification_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_notification" ADD CONSTRAINT "workflow_notification_notificationId_notification_notificationId_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."notification"("notificationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_notification" ADD CONSTRAINT "workflow_notification_workflowRepositoryId_workflow_repository_workflowRepositoryId_fk" FOREIGN KEY ("workflowRepositoryId") REFERENCES "public"."workflow_repository"("workflowRepositoryId") ON DELETE cascade ON UPDATE no action;