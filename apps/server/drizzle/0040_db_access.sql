CREATE TABLE "db_access_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"level" text DEFAULT 'read' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"granted_by" uuid NOT NULL,
	"revoked_by" uuid,
	"revocation_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"db_name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"open" boolean DEFAULT false NOT NULL,
	"schemas" jsonb DEFAULT '["public"]'::jsonb NOT NULL,
	"creator_role" text NOT NULL,
	"read_role" text NOT NULL,
	"write_role" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_personal_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_name" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "db_access_grant" ADD CONSTRAINT "db_access_grant_catalog_id_db_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."db_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_access_grant" ADD CONSTRAINT "db_access_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_access_grant" ADD CONSTRAINT "db_access_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_access_grant" ADD CONSTRAINT "db_access_grant_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_catalog" ADD CONSTRAINT "db_catalog_instance_id_db_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."db_instance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_catalog" ADD CONSTRAINT "db_catalog_assignment_id_db_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."db_assignment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_catalog" ADD CONSTRAINT "db_catalog_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_catalog" ADD CONSTRAINT "db_catalog_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD CONSTRAINT "db_personal_role_instance_id_db_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."db_instance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_personal_role" ADD CONSTRAINT "db_personal_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "db_access_grant_catalog_user_idx" ON "db_access_grant" USING btree ("catalog_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "db_catalog_instance_name_idx" ON "db_catalog" USING btree ("instance_id","db_name");--> statement-breakpoint
CREATE UNIQUE INDEX "db_catalog_assignment_idx" ON "db_catalog" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "db_personal_role_instance_user_idx" ON "db_personal_role" USING btree ("instance_id","user_id");