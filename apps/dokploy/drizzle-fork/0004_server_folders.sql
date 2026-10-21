CREATE TABLE "fork_server_folder_item" (
	"serverId" text PRIMARY KEY NOT NULL,
	"folderId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fork_server_folder" (
	"folderId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fork_server_folder_item" ADD CONSTRAINT "fork_server_folder_item_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_server_folder_item" ADD CONSTRAINT "fork_server_folder_item_folderId_fork_server_folder_folderId_fk" FOREIGN KEY ("folderId") REFERENCES "public"."fork_server_folder"("folderId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_server_folder" ADD CONSTRAINT "fork_server_folder_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_server_folder_item_folder_idx" ON "fork_server_folder_item" USING btree ("folderId");--> statement-breakpoint
CREATE UNIQUE INDEX "fork_server_folder_org_name_idx" ON "fork_server_folder" USING btree ("organizationId",lower("name"));