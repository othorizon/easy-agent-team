CREATE TABLE "db_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"db_name" text NOT NULL,
	"db_user" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"environment_id" uuid,
	"error" text,
	"decided_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"admin_user" text NOT NULL,
	"admin_password_encrypted" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'team' NOT NULL,
	"owner_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_config_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "mcp_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_template_selection" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"template_id" uuid NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_subscription" ADD COLUMN "excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "db_assignment" ADD CONSTRAINT "db_assignment_instance_id_db_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."db_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_assignment" ADD CONSTRAINT "db_assignment_requester_id_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_assignment" ADD CONSTRAINT "db_assignment_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_assignment" ADD CONSTRAINT "db_assignment_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_instance" ADD CONSTRAINT "db_instance_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_config" ADD CONSTRAINT "mcp_config_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_subscription" ADD CONSTRAINT "mcp_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_subscription" ADD CONSTRAINT "mcp_subscription_config_id_mcp_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mcp_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template" ADD CONSTRAINT "role_template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_item" ADD CONSTRAINT "template_item_template_id_role_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."role_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_template_selection" ADD CONSTRAINT "user_template_selection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_template_selection" ADD CONSTRAINT "user_template_selection_template_id_role_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."role_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "db_assignment_requester_idx" ON "db_assignment" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "db_assignment_instance_dbname_idx" ON "db_assignment" USING btree ("instance_id","db_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_subscription_user_config_idx" ON "mcp_subscription" USING btree ("user_id","config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_item_idx" ON "template_item" USING btree ("template_id","item_type","item_id");