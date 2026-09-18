CREATE TABLE "mcp_gateway_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid,
	"user_id" uuid,
	"config_id" uuid,
	"method" text,
	"tool_name" text,
	"status" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_gateway_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_config" ADD COLUMN "gateway_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_gateway_token" ADD CONSTRAINT "mcp_gateway_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_gateway_token" ADD CONSTRAINT "mcp_gateway_token_config_id_mcp_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_gateway_call_config_idx" ON "mcp_gateway_call" USING btree ("config_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_gateway_call_user_idx" ON "mcp_gateway_call" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_gateway_call_created_idx" ON "mcp_gateway_call" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_gateway_token_hash_idx" ON "mcp_gateway_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_gateway_token_user_config_idx" ON "mcp_gateway_token" USING btree ("user_id","config_id");--> statement-breakpoint
-- 存量数据（决策 51）：http 配置随 DEFAULT true 一次性迁到网关分发；
-- stdio 没有可代理的端点，就地关掉，避免建/改配置时才发现开关是个空档。
UPDATE "mcp_config" SET "gateway_enabled" = false WHERE "transport" = 'stdio';
