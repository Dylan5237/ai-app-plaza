export const IDENTITY_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS plaza_identities (
      id uuid PRIMARY KEY, source text NOT NULL, subject text NOT NULL, name text NOT NULL,
      account text, tenant_id text, verified_at timestamptz NOT NULL, UNIQUE(source, subject))`,
    `CREATE TABLE IF NOT EXISTS plaza_login_requests (
      id_hash text PRIMARY KEY, browser_hash text NOT NULL, expires_at timestamptz NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS plaza_sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES plaza_identities(id), expires_at timestamptz NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS plaza_groups (
      id uuid PRIMARY KEY, name text NOT NULL, revision integer NOT NULL DEFAULT 1,
      enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS plaza_group_members (
      group_id uuid NOT NULL REFERENCES plaza_groups(id), user_id uuid NOT NULL REFERENCES plaza_identities(id),
      PRIMARY KEY(group_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS plaza_identity_operations (
      id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES plaza_identities(id), group_id uuid NOT NULL,
      action text NOT NULL, before_value jsonb, after_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS plaza_favorites (
      user_id uuid NOT NULL REFERENCES plaza_identities(id), app_id uuid NOT NULL REFERENCES catalog_apps(id),
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,app_id))`,
];
