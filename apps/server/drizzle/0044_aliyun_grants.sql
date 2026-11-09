CREATE TABLE "aliyun_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permission_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"error" text,
	"granted_by" uuid NOT NULL,
	"revoked_by" uuid,
	"revocation_reason" text,
	"relinquished" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aliyun_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"actor_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"ram_name" text NOT NULL,
	"cloud_user_id" text,
	"user_enabled" boolean DEFAULT true NOT NULL,
	"sync_pending" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aliyun_grant" ADD CONSTRAINT "aliyun_grant_permission_id_aliyun_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."aliyun_permission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_grant" ADD CONSTRAINT "aliyun_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_grant" ADD CONSTRAINT "aliyun_grant_identity_id_cloud_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."cloud_identity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_grant" ADD CONSTRAINT "aliyun_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_grant" ADD CONSTRAINT "aliyun_grant_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_operation" ADD CONSTRAINT "aliyun_operation_grant_id_aliyun_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."aliyun_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliyun_operation" ADD CONSTRAINT "aliyun_operation_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD CONSTRAINT "cloud_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aliyun_grant_permission_user_unique" ON "aliyun_grant" USING btree ("permission_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aliyun_operation_grant_unique" ON "aliyun_operation" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "aliyun_operation_retry_idx" ON "aliyun_operation" USING btree ("state","retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_identity_account_user_unique" ON "cloud_identity" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_identity_account_ram_unique" ON "cloud_identity" USING btree ("account_id","ram_name");