CREATE TYPE "public"."serverCommandStatus" AS ENUM('running', 'success', 'error', 'cancelled');--> statement-breakpoint
CREATE TABLE "server_command" (
	"serverCommandId" text PRIMARY KEY NOT NULL,
	"serverId" text NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text,
	"command" text NOT NULL,
	"status" "serverCommandStatus" DEFAULT 'running' NOT NULL,
	"exitCode" integer,
	"errorMessage" text,
	"timeoutSeconds" integer NOT NULL,
	"logPath" text NOT NULL,
	"createdAt" text NOT NULL,
	"finishedAt" text
);
--> statement-breakpoint
ALTER TABLE "server_command" ADD CONSTRAINT "server_command_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_command" ADD CONSTRAINT "server_command_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_command" ADD CONSTRAINT "server_command_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_command_server_created_idx" ON "server_command" USING btree ("serverId","createdAt" DESC);--> statement-breakpoint
CREATE INDEX "server_command_status_idx" ON "server_command" USING btree ("status");