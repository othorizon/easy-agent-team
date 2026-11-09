ALTER TABLE "db_personal_role" ADD COLUMN "login_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD COLUMN "sync_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD COLUMN "sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD COLUMN "sync_retry_at" timestamp with time zone;