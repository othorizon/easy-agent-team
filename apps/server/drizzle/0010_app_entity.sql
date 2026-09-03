-- 决策 31：平台实体「项目」改为「应用」，与 Dokploy 的 application 对齐。
-- 平台尚无存量数据，直接删旧表建新表，不做数据搬迁。
ALTER TABLE "deployment" DROP CONSTRAINT "deployment_project_id_project_id_fk";
--> statement-breakpoint
DROP INDEX "deployment_project_idx";--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "project_member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "project_member" CASCADE;--> statement-breakpoint
DROP TABLE "project" CASCADE;--> statement-breakpoint
CREATE TABLE "app" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"repo_url" text DEFAULT '' NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"build_type" text,
	"dockerfile" text DEFAULT 'Dockerfile' NOT NULL,
	"docker_context_path" text DEFAULT '' NOT NULL,
	"publish_directory" text DEFAULT '.' NOT NULL,
	"static_spa" boolean DEFAULT false NOT NULL,
	"dokploy_application_id" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"managed" boolean DEFAULT true NOT NULL,
	"deploy_approved" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_member" ADD CONSTRAINT "app_member_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_member" ADD CONSTRAINT "app_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_member_idx" ON "app_member" USING btree ("app_id","user_id");--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "app_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "source" text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_app_idx" ON "deployment" USING btree ("app_id");--> statement-breakpoint
ALTER TABLE "dokploy_setting" ADD COLUMN "project_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dokploy_setting" ADD COLUMN "environment_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dokploy_setting" ADD COLUMN "ssh_key_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "claim" text;
