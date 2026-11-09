ALTER TABLE "db_catalog" ALTER COLUMN "assignment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "db_catalog" ALTER COLUMN "creator_role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "db_catalog" ADD COLUMN "source" text DEFAULT 'eat' NOT NULL;--> statement-breakpoint
ALTER TABLE "db_catalog" ADD COLUMN "public_check" jsonb;