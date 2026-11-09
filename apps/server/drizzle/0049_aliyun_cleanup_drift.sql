ALTER TABLE "aliyun_connection" ADD COLUMN "cleanup_state" text;--> statement-breakpoint
ALTER TABLE "aliyun_connection" ADD COLUMN "cleanup_stage" text;--> statement-breakpoint
ALTER TABLE "aliyun_connection" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
ALTER TABLE "aliyun_connection" ADD COLUMN "cleanup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "aliyun_connection" ADD COLUMN "cleanup_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "aliyun_connection" ADD COLUMN "cleanup_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "cleanup_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_identity" ADD COLUMN "drift" jsonb;--> statement-breakpoint
ALTER TABLE "aliyun_connection" ADD CONSTRAINT "aliyun_connection_cleanup_actor_id_user_id_fk" FOREIGN KEY ("cleanup_actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;