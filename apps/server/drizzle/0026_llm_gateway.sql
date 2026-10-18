CREATE TABLE "llm_gateway_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"upstream_id" integer,
	"upstream_name" text NOT NULL,
	"state" text DEFAULT 'creating' NOT NULL,
	"creation_attempted" boolean DEFAULT false NOT NULL,
	"masked_key" text DEFAULT '' NOT NULL,
	"upstream_status" integer DEFAULT 1 NOT NULL,
	"remaining_quota" bigint DEFAULT 0 NOT NULL,
	"used_quota" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	CONSTRAINT "llm_gateway_key_upstream_id_unique" UNIQUE("upstream_id"),
	CONSTRAINT "llm_gateway_key_upstream_name_unique" UNIQUE("upstream_name")
);
--> statement-breakpoint
CREATE TABLE "llm_gateway_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_gateway_setting" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"api_url" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"account_id" integer NOT NULL,
	"account_name" text NOT NULL,
	"default_quota" bigint DEFAULT 0 NOT NULL,
	"currency" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_gateway_user" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"initial_quota" bigint,
	"gift_claimed" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"allocated_quota" bigint DEFAULT 0 NOT NULL,
	"user_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_gateway_key" ADD CONSTRAINT "llm_gateway_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_gateway_operation" ADD CONSTRAINT "llm_gateway_operation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_gateway_operation" ADD CONSTRAINT "llm_gateway_operation_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_gateway_user" ADD CONSTRAINT "llm_gateway_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_gateway_one_current_key" ON "llm_gateway_key" USING btree ("user_id") WHERE "llm_gateway_key"."state" <> 'retired';--> statement-breakpoint
CREATE INDEX "llm_gateway_key_owner" ON "llm_gateway_key" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_gateway_operations_owner" ON "llm_gateway_operation" USING btree ("user_id");