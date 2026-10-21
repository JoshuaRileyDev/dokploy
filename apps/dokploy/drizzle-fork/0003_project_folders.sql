CREATE TABLE "fork_project_folder_item" (
	"projectId" text PRIMARY KEY NOT NULL,
	"folderId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fork_project_folder" (
	"folderId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parentFolderId" text,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fork_project_folder_item" ADD CONSTRAINT "fork_project_folder_item_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_project_folder_item" ADD CONSTRAINT "fork_project_folder_item_folderId_fork_project_folder_folderId_fk" FOREIGN KEY ("folderId") REFERENCES "public"."fork_project_folder"("folderId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_project_folder" ADD CONSTRAINT "fork_project_folder_parentFolderId_fork_project_folder_folderId_fk" FOREIGN KEY ("parentFolderId") REFERENCES "public"."fork_project_folder"("folderId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_project_folder" ADD CONSTRAINT "fork_project_folder_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;