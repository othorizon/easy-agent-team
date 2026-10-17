CREATE TABLE "site_cdn_purge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Transactional outbox covers REST, CLI, MCP, publish, rollback and deletion uniformly.
CREATE FUNCTION eat_folio_cdn_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.current_version_id IS DISTINCT FROM NEW.current_version_id
     OR OLD.access_revision IS DISTINCT FROM NEW.access_revision OR OLD.spa IS DISTINCT FROM NEW.spa THEN
    IF EXISTS (SELECT 1 FROM site_cdn WHERE id = 1 AND (enabled OR connected OR (resources->>'owned' = 'true' AND status <> 'disabled'))) THEN
      INSERT INTO site_cdn_purge (slug, versions)
        SELECT OLD.slug, COALESCE(jsonb_agg(number), '[]'::jsonb) FROM site_version WHERE site_id = OLD.id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER eat_folio_cdn_invalidate BEFORE UPDATE OR DELETE ON site
  FOR EACH ROW EXECUTE FUNCTION eat_folio_cdn_invalidate();
