-- Versioned cache keys and per-request authorization make invalidation unnecessary.
-- Remove the trigger before discarding pending maintenance work; leave Folio/CDN state intact.
DROP TRIGGER IF EXISTS eat_folio_cdn_invalidate ON "site";
--> statement-breakpoint
DROP FUNCTION IF EXISTS eat_folio_cdn_invalidate();
--> statement-breakpoint
DROP TABLE IF EXISTS "site_cdn_purge";
