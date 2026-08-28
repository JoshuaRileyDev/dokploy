ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "isFolder" boolean DEFAULT false NOT NULL;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "parentProjectId" text;
DO $$ BEGIN
 ALTER TABLE "project" ADD CONSTRAINT "project_parentProjectId_project_projectId_fk" FOREIGN KEY ("parentProjectId") REFERENCES "public"."project"("projectId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "project_parentProjectId_idx" ON "project" USING btree ("parentProjectId");
