ALTER TABLE "deployment" ADD COLUMN "stopped_by" uuid;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_stopped_by_user_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;