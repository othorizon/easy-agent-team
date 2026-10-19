CREATE TABLE "oss_account" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"ram_name" text NOT NULL,
	"policy_name" text NOT NULL,
	"key_id_encrypted" text,
	"key_secret_encrypted" text,
	"key_baseline" jsonb,
	"retiring_key_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_generation" integer DEFAULT 0 NOT NULL,
	"user_enabled" boolean DEFAULT true NOT NULL,
	"sync_pending" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oss_account_ram_name_unique" UNIQUE("ram_name"),
	CONSTRAINT "oss_account_policy_name_unique" UNIQUE("policy_name")
);
--> statement-breakpoint
CREATE TABLE "oss_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"user_id" uuid,
	"space_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oss_setting" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"region" text NOT NULL,
	"account_id" text,
	"access_key_id_encrypted" text NOT NULL,
	"access_key_secret_encrypted" text NOT NULL,
	"status" text DEFAULT 'disabled' NOT NULL,
	"custom_domains_enabled" boolean DEFAULT false NOT NULL,
	"domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"managed_policy" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_policy" jsonb,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oss_space" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"prefix" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"public_read" boolean DEFAULT false NOT NULL,
	"requested_public_read" boolean DEFAULT false NOT NULL,
	"operation_pending" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"rejection_reason" text,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oss_space_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
ALTER TABLE "oss_account" ADD CONSTRAINT "oss_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oss_space" ADD CONSTRAINT "oss_space_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oss_space" ADD CONSTRAINT "oss_space_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oss_operation_state_idx" ON "oss_operation" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "oss_space_request_idx" ON "oss_space" USING btree ("owner_id","request_id");--> statement-breakpoint
CREATE INDEX "oss_space_owner_idx" ON "oss_space" USING btree ("owner_id");