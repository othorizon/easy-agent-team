ALTER TABLE "mcp_subscription" ADD COLUMN "status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_subscription" ADD COLUMN "reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_subscription" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "mcp_subscription" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_subscription" ADD CONSTRAINT "mcp_subscription_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_subscription_status_idx" ON "mcp_subscription" USING btree ("status");