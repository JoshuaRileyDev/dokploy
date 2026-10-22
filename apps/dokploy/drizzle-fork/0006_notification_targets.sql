CREATE TABLE "fork_notification_target" (
	"targetId" text PRIMARY KEY NOT NULL,
	"notificationId" text NOT NULL,
	"applicationId" text,
	"composeId" text,
	CONSTRAINT "fork_notification_target_one_service" CHECK (num_nonnulls("fork_notification_target"."applicationId", "fork_notification_target"."composeId") = 1)
);
--> statement-breakpoint
ALTER TABLE "fork_notification_target" ADD CONSTRAINT "fork_notification_target_notificationId_notification_notificationId_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."notification"("notificationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_notification_target" ADD CONSTRAINT "fork_notification_target_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_notification_target" ADD CONSTRAINT "fork_notification_target_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_notification_target_notification_idx" ON "fork_notification_target" USING btree ("notificationId");--> statement-breakpoint
CREATE UNIQUE INDEX "fork_notification_target_application_idx" ON "fork_notification_target" USING btree ("notificationId","applicationId");--> statement-breakpoint
CREATE UNIQUE INDEX "fork_notification_target_compose_idx" ON "fork_notification_target" USING btree ("notificationId","composeId");