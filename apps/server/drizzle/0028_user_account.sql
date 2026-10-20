CREATE TABLE "user_notification" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"webhook_url" text,
	"webhook_secret_encrypted" text,
	"verified_at" timestamp with time zone,
	"notify_help" boolean DEFAULT true NOT NULL,
	"notify_reply" boolean DEFAULT true NOT NULL,
	"notify_mention" boolean DEFAULT true NOT NULL,
	"pending_url" text,
	"pending_secret_encrypted" text,
	"challenge_id" uuid,
	"code_hash" text,
	"expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registration_setting" ADD COLUMN "require_bio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_setting" ADD COLUMN "require_notification" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "bio" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "allow_help" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification" ADD CONSTRAINT "user_notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE "user" u SET "bio" = h."description", "allow_help" = h."available"
FROM "helper_profile" h WHERE h."user_id" = u."id";
--> statement-breakpoint
INSERT INTO "user_notification" ("user_id", "webhook_url", "webhook_secret_encrypted", "notify_help", "notify_reply")
SELECT "user_id", "webhook_url", "webhook_secret_encrypted", "notify_help", "notify_reply"
FROM "helper_profile" ON CONFLICT ("user_id") DO NOTHING;
