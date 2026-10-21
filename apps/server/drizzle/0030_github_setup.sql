ALTER TABLE github_setting ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE github_setting ADD COLUMN app_slug text;
ALTER TABLE github_setting ADD COLUMN connection_state text NOT NULL DEFAULT 'app_ready';
ALTER TABLE github_setting ADD COLUMN connection_error text NOT NULL DEFAULT '';
ALTER TABLE github_setting ADD COLUMN checked_at timestamptz;
ALTER TABLE github_oauth_state ADD COLUMN config_revision uuid;
CREATE TABLE github_setup_state (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL,
 user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, token_id uuid NOT NULL,
 kind text NOT NULL, config_revision uuid, organization text NOT NULL, expires_at timestamptz NOT NULL
);
