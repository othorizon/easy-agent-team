CREATE TABLE "site_cdn_purge" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "url" text NOT NULL,
  "task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "submitted_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "retry_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "site_cdn_purge_pending_idx" ON "site_cdn_purge" ("retry_at") WHERE completed_at IS NULL;
--> statement-breakpoint
-- Snapshot concrete hosts before ON DELETE CASCADE removes version records. Publication and
-- rollback use immutable version URLs, so they do not invalidate useful historical caches.
CREATE FUNCTION eat_folio_cdn_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE suffix text;
BEGIN
  IF TG_OP = 'DELETE' OR OLD.access IS DISTINCT FROM NEW.access
     OR OLD.access_revision IS DISTINCT FROM NEW.access_revision THEN
    IF EXISTS (SELECT 1 FROM site_cdn WHERE id = 1 AND
      (enabled OR connected OR resources->>'owned' = 'true')) THEN
      SELECT domain INTO suffix FROM site_setting WHERE id = 1;
      IF suffix IS NOT NULL THEN
        INSERT INTO site_cdn_purge (url)
          SELECT 'https://' || host || '.' || suffix || '/__eat/cdn/' || OLD.id || '/'
          FROM (SELECT OLD.slug AS host UNION SELECT 'v' || number || '--' || OLD.slug
                FROM site_version WHERE site_id = OLD.id) AS hosts;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER eat_folio_cdn_invalidate BEFORE UPDATE OR DELETE ON site
  FOR EACH ROW EXECUTE FUNCTION eat_folio_cdn_invalidate();
