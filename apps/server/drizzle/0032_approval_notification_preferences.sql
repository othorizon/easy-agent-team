ALTER TABLE user_notification ADD COLUMN notify_approval_request boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE user_notification ADD COLUMN notify_approval_result boolean NOT NULL DEFAULT true;
