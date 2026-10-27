CREATE TABLE "feishu_bind_code" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_bind_code_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "feishu_binding" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"open_id" text NOT NULL,
	"union_id" text,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"state" text NOT NULL,
	"update_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_card_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "feishu_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_setting" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"channel" text DEFAULT 'webhook' NOT NULL,
	"app_id" text DEFAULT '' NOT NULL,
	"app_secret_encrypted" text,
	"verification_token_encrypted" text,
	"encrypt_key_encrypted" text,
	"bot_name" text,
	"bot_avatar_url" text,
	"last_check" jsonb,
	"callback_verified_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feishu_setting_singleton" CHECK ("feishu_setting"."id" = 1),
	CONSTRAINT "feishu_setting_channel" CHECK ("feishu_setting"."channel" IN ('webhook','app'))
);
--> statement-breakpoint
ALTER TABLE "feishu_bind_code" ADD CONSTRAINT "feishu_bind_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_binding" ADD CONSTRAINT "feishu_binding_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_card" ADD CONSTRAINT "feishu_card_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_binding_open_id_idx" ON "feishu_binding" USING btree ("app_id","open_id");--> statement-breakpoint
CREATE INDEX "feishu_card_request_idx" ON "feishu_card" USING btree ("request_id");--> statement-breakpoint
INSERT INTO "feishu_setting" ("id") VALUES (1) ON CONFLICT DO NOTHING;
