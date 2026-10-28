ALTER TABLE "help_request" ADD COLUMN "reply_callback_url" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "can_notify_all" boolean DEFAULT false NOT NULL;