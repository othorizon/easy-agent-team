-- Refuse unsupported data; this migration never deletes or relabels existing versions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "site_version" WHERE "layout" <> 'blobs-v1') THEN
    RAISE EXCEPTION 'Folio 旧布局版本尚未处理，无法移除兼容；请先处理旧历史版本'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "site_version" ALTER COLUMN "layout" SET DEFAULT 'blobs-v1';--> statement-breakpoint
ALTER TABLE "site_version" ALTER COLUMN "storage" SET DEFAULT 'oss';--> statement-breakpoint
ALTER TABLE "site_version" ADD CONSTRAINT "site_version_layout_check" CHECK ("site_version"."layout" = 'blobs-v1');
--> statement-breakpoint
ALTER TABLE "site_version" ADD CONSTRAINT "site_version_storage_check" CHECK ("site_version"."storage" = 'oss');
