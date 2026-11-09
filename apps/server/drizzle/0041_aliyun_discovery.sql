CREATE TABLE "aliyun_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"access_key_id_encrypted" text NOT NULL,
	"access_key_secret_encrypted" text NOT NULL,
	"default_region" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliyun_connection_name_unique" UNIQUE("name"),
	CONSTRAINT "aliyun_connection_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "aliyun_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"policy_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cloud_exists" boolean DEFAULT true NOT NULL,
	"open" boolean DEFAULT false NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"data_scope" text DEFAULT '' NOT NULL,
	"owner_id" uuid,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aliyun_permission" ADD CONSTRAINT "aliyun_permission_connection_id_aliyun_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."aliyun_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_permission" ADD CONSTRAINT "aliyun_permission_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aliyun_permission_connection_policy_unique" ON "aliyun_permission" USING btree ("connection_id","policy_name");