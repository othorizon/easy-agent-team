ALTER TABLE "site_cdn" ADD COLUMN "verify_origin_certificate" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Preserve an administrator's previously recorded explicit override during upgrade.
UPDATE "site_cdn" SET "verify_origin_certificate" = false
WHERE "resources" #> '{originCertificateVerification,enabled}' = 'false'::jsonb;
