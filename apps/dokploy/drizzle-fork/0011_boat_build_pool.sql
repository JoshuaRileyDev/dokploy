CREATE TYPE "public"."boatBuildMachineStatus" AS ENUM('provisioning', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "boat_build_machine" (
	"serverId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"sandboxId" text NOT NULL,
	"status" "boatBuildMachineStatus" DEFAULT 'provisioning' NOT NULL,
	"error" text,
	"lastServiceId" text,
	"lastUsedAt" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "forkBoatBuildPool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "forkBoatBuildPool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD COLUMN "buildsEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD COLUMN "buildPoolSize" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD COLUMN "buildMachineType" "boatMachineType" DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD COLUMN "buildIdleStopMinutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD COLUMN "buildSshKeyId" text;--> statement-breakpoint
ALTER TABLE "boat_build_machine" ADD CONSTRAINT "boat_build_machine_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boat_build_machine" ADD CONSTRAINT "boat_build_machine_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boat_settings" ADD CONSTRAINT "boat_settings_buildSshKeyId_ssh-key_sshKeyId_fk" FOREIGN KEY ("buildSshKeyId") REFERENCES "public"."ssh-key"("sshKeyId") ON DELETE set null ON UPDATE no action;