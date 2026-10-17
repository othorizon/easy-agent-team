CREATE TABLE "site_blob" (
	"site_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"size" integer NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_cleanup" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_upload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"publisher_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"files" jsonb NOT NULL,
	"message" text NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signed_until" timestamp with time zone,
	"lease" uuid,
	"lease_until" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_version" ADD COLUMN "layout" text DEFAULT 'legacy-v0' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_blob" ADD CONSTRAINT "site_blob_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_upload" ADD CONSTRAINT "site_upload_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_upload" ADD CONSTRAINT "site_upload_publisher_id_user_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_blob_hash_idx" ON "site_blob" USING btree ("site_id","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "site_upload_request_idx" ON "site_upload" USING btree ("site_id","request_id");--> statement-breakpoint
CREATE INDEX "site_upload_expiry_idx" ON "site_upload" USING btree ("expires_at");