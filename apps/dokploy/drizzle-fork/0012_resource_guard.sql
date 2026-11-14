ALTER TABLE "server" ADD COLUMN "forkGuardReservedMemoryMb" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "forkGuardAppMemoryPercent" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN "forkGuardReservedMemoryMb" integer;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN "forkGuardAppMemoryPercent" integer DEFAULT 25 NOT NULL;