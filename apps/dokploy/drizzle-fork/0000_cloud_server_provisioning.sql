CREATE TYPE "public"."serverProvisioningStatus" AS ENUM('pending', 'creating_server', 'waiting_for_ssh', 'installing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "cloud_provider_account" (
	"cloudProviderAccountId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"providerType" text NOT NULL,
	"credentials" text NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_provisioning" (
	"serverProvisioningId" text PRIMARY KEY NOT NULL,
	"cloudProviderAccountId" text,
	"serverId" text,
	"providerType" text NOT NULL,
	"status" "serverProvisioningStatus" DEFAULT 'pending' NOT NULL,
	"message" text,
	"error" text,
	"config" jsonb NOT NULL,
	"providerServerId" text,
	"providerSshKeyId" text,
	"ipAddress" text,
	"providerServerDeletedAt" text,
	"dismissedAt" text,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL,
	"completedAt" text
);
--> statement-breakpoint
ALTER TABLE "cloud_provider_account" ADD CONSTRAINT "cloud_provider_account_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_provisioning" ADD CONSTRAINT "server_provisioning_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_provisioning" ADD CONSTRAINT "server_provisioning_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_provisioning" ADD CONSTRAINT "server_provisioning_account_fk" FOREIGN KEY ("cloudProviderAccountId") REFERENCES "public"."cloud_provider_account"("cloudProviderAccountId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_provider_account_org_name_idx" ON "cloud_provider_account" USING btree ("organizationId","name");