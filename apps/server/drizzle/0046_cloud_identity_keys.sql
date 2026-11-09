ALTER TABLE "cloud_identity" ADD COLUMN "key_id_encrypted" text;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "key_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "key_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "retiring_key_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "key_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "key_target_generation" integer;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "key_ready_at" timestamp with time zone;