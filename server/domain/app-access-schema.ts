export const APP_ACCESS_SCHEMA = [
  `ALTER TABLE publications ADD COLUMN IF NOT EXISTS identity_required boolean NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS plaza_platform_roles (
    user_id uuid PRIMARY KEY REFERENCES plaza_identities(id),
    role text NOT NULL CHECK(role IN ('member','administrator','super_administrator')),
    revision integer NOT NULL DEFAULT 1 CHECK(revision>0))`,
  `CREATE TABLE IF NOT EXISTS plaza_bootstrap_bindings (
    purpose text PRIMARY KEY, source text NOT NULL, subject text NOT NULL,
    account text NOT NULL, user_id uuid NOT NULL REFERENCES plaza_identities(id))`,
  `CREATE TABLE IF NOT EXISTS plaza_app_access (
    app_id uuid PRIMARY KEY REFERENCES catalog_apps(id), owner_id uuid NOT NULL REFERENCES plaza_identities(id),
    scope text NOT NULL DEFAULT 'self' CHECK(scope IN ('all','members','groups','self')),
    member_ids uuid[] NOT NULL DEFAULT '{}', group_ids uuid[] NOT NULL DEFAULT '{}',
    maintainer_ids uuid[] NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
    CHECK(cardinality(member_ids)<=500 AND cardinality(group_ids)<=500 AND cardinality(maintainer_ids)<=500),
    CHECK((scope='members' AND cardinality(member_ids)>0 OR scope<>'members' AND cardinality(member_ids)=0)
      AND (scope='groups' AND cardinality(group_ids)>0 OR scope<>'groups' AND cardinality(group_ids)=0)))`,
  `CREATE TABLE IF NOT EXISTS plaza_access_operations (
    id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES plaza_identities(id),
    resource_id text NOT NULL, action text NOT NULL, request_value jsonb NOT NULL,
    before_value jsonb, after_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS plaza_app_transfers (
    id uuid PRIMARY KEY, app_id uuid NOT NULL REFERENCES catalog_apps(id),
    owner_id uuid NOT NULL REFERENCES plaza_identities(id), receiver_id uuid NOT NULL REFERENCES plaza_identities(id),
    access_revision integer NOT NULL, status text NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','accepted','cancelled','declined')),
    created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS plaza_publication_actors (
    publication_id uuid PRIMARY KEY REFERENCES publications(id),
    user_id uuid NOT NULL REFERENCES plaza_identities(id))`,
];
