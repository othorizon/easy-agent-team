CREATE TABLE "oss_migration_result" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"old_ram_name" text NOT NULL,
	"target_ram_name" text NOT NULL,
	"cloud_user_id" text,
	"stage" text DEFAULT 'preflight' NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oss_account" ADD COLUMN "identity_id" uuid;--> statement-breakpoint
ALTER TABLE "oss_account" ADD COLUMN "key_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oss_setting" ADD COLUMN "migration_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "oss_migration_result" ADD CONSTRAINT "oss_migration_result_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oss_account" ADD CONSTRAINT "oss_account_identity_id_cloud_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."cloud_identity"("id") ON DELETE restrict ON UPDATE no action;