ALTER TABLE app ADD COLUMN repo_version integer NOT NULL DEFAULT 1;
ALTER TABLE app ADD COLUMN approved_repo_version integer;
UPDATE app SET approved_repo_version = repo_version WHERE deploy_approved;
CREATE TABLE github_setting (
 id integer PRIMARY KEY DEFAULT 1, enabled boolean NOT NULL DEFAULT false,
 organization text NOT NULL, app_id text NOT NULL, client_id text NOT NULL, installation_id text NOT NULL,
 client_secret_encrypted text NOT NULL, private_key_encrypted text NOT NULL, organization_id text
);
CREATE TABLE github_account (
 user_id uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, github_id text NOT NULL UNIQUE,
 login text NOT NULL, version uuid NOT NULL DEFAULT gen_random_uuid(), access_token_encrypted text NOT NULL,
 refresh_token_encrypted text, expires_at timestamptz, needs_authorization boolean NOT NULL DEFAULT false,
 org_state text NOT NULL DEFAULT 'unknown', org_role text, checked_at timestamptz, error text NOT NULL DEFAULT ''
);
CREATE TABLE github_oauth_state (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL, user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 token_id uuid NOT NULL, binding_version text, expires_at timestamptz NOT NULL
);
CREATE TABLE github_repository (
 app_id uuid PRIMARY KEY REFERENCES app(id) ON DELETE CASCADE, version integer NOT NULL,
 repository_id text, full_name text, data jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_grant (
 key text PRIMARY KEY, repository_id text NOT NULL, full_name text NOT NULL, github_id text NOT NULL,
 login text NOT NULL, user_id uuid NOT NULL, previous_role text, baseline_safe boolean NOT NULL DEFAULT false,
 applied_role text NOT NULL, managed boolean NOT NULL DEFAULT false, prepared boolean NOT NULL DEFAULT true,
 error text NOT NULL DEFAULT '', role_changed_at timestamptz
);
CREATE TABLE github_task (
 key text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, generation integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, error text NOT NULL DEFAULT '',
 notification text NOT NULL DEFAULT '', retry_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_task_retry_idx ON github_task(state, retry_at);
