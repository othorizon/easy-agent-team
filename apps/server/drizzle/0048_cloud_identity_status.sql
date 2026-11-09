ALTER TABLE "cloud_identity" ADD COLUMN "sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "next_sync_at" timestamp with time zone;