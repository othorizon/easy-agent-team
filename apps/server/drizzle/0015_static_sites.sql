CREATE TABLE "site_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"token_id" uuid,
	"revision" integer NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"return_path" text DEFAULT '/' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "site_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "site_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"page" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"author_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"publisher_id" uuid NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"storage" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"access" text DEFAULT 'authenticated' NOT NULL,
	"password_hash" text,
	"access_revision" integer DEFAULT 1 NOT NULL,
	"spa" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"next_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "site_comment" ADD CONSTRAINT "site_comment_thread_id_site_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."site_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_comment" ADD CONSTRAINT "site_comment_version_id_site_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."site_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_comment" ADD CONSTRAINT "site_comment_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_session" ADD CONSTRAINT "site_session_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_session" ADD CONSTRAINT "site_session_token_id_api_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_thread" ADD CONSTRAINT "site_thread_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_thread" ADD CONSTRAINT "site_thread_version_id_site_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."site_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_thread" ADD CONSTRAINT "site_thread_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_version" ADD CONSTRAINT "site_version_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_version" ADD CONSTRAINT "site_version_publisher_id_user_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_comment_thread_idx" ON "site_comment" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "site_session_expiry_idx" ON "site_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "site_thread_page_idx" ON "site_thread" USING btree ("site_id","page");--> statement-breakpoint
CREATE UNIQUE INDEX "site_version_number_idx" ON "site_version" USING btree ("site_id","number");