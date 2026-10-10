import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResult as PgQueryResult, type QueryResultRow } from "pg";
import { PGlite, type Transaction } from "@electric-sql/pglite";

export interface QueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  rowCount: number;
}

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  url?: string;
  path?: string;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS catalog_apps (
    id uuid PRIMARY KEY,
    instance_id text NOT NULL,
    project_id text NOT NULL,
    app_key text NOT NULL,
    current_snapshot_id uuid,
    revision integer NOT NULL CHECK (revision >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (instance_id, project_id, app_key)
  )`,
  `CREATE TABLE IF NOT EXISTS published_snapshots (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES catalog_apps(id),
    commit_sha text NOT NULL,
    manifest_path text NOT NULL,
    tag text,
    digest text NOT NULL,
    audience text NOT NULL,
    version text NOT NULL,
    manifest jsonb NOT NULL,
    documents jsonb NOT NULL,
    search_text text NOT NULL,
    project_url text NOT NULL,
    source_created_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (app_id, commit_sha, digest, audience)
  )`,
  `CREATE TABLE IF NOT EXISTS publications (
    id uuid PRIMARY KEY,
    actor_id text NOT NULL,
    idempotency_digest text NOT NULL,
    request_hash text NOT NULL,
    submission jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('checking', 'preview_ready', 'registered', 'failed', 'cancelled')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    digest text,
    candidate_app_id uuid NOT NULL,
    expected_app_revision integer,
    app_id uuid,
    preview_jsonb jsonb,
    token_ciphertext text,
    token_iv text,
    token_auth_tag text,
    confirmed_at timestamptz,
    error_code text,
    error_message text,
    next_action text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (actor_id, idempotency_digest)
  )`,
  `CREATE INDEX IF NOT EXISTS published_snapshots_audience_idx ON published_snapshots (audience, app_id)`,
  `CREATE INDEX IF NOT EXISTS publications_expiry_idx ON publications (expires_at)`,
];

function result<Row extends QueryResultRow>(value: PgQueryResult<Row>): QueryResult<Row> {
  return { rows: value.rows, rowCount: value.rowCount ?? value.rows.length };
}

function pgQueryable(client: PoolClient): Queryable {
  return {
    query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
      const response = await client.query(sql, [...params]) as PgQueryResult<Row>;
      return result(response);
    },
  };
}

function pgliteQueryable(client: PGlite | Transaction): Queryable {
  return {
    query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
      const response = await client.query<Row>(sql, [...params]);
      return { rows: response.rows, rowCount: response.affectedRows ?? response.rows.length };
    },
  };
}

/**
 * Opens PostgreSQL when `url` is set, or a persistent PGlite database when
 * `path` is set. Tests may explicitly pass `path: "memory://"`; there is no
 * implicit in-memory fallback.
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  if (Boolean(options.url) === Boolean(options.path)) {
    throw new Error("Exactly one of DATABASE_URL or PGlite path must be configured.");
  }

  if (options.url) {
    const pool = new Pool({ connectionString: options.url, max: 10 });
    const database: Database = {
      query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
        const response = await pool.query(sql, [...params]) as PgQueryResult<Row>;
        return result(response);
      },
      transaction: async <T>(work: (tx: Queryable) => Promise<T>) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await work(pgQueryable(client));
          await client.query("COMMIT");
          return value;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the operation error; the connection is discarded by pg if broken.
          }
          throw error;
        } finally {
          client.release();
        }
      },
      close: async () => { await pool.end(); },
    };
    try {
      await migrate(database);
    } catch (error) {
      await database.close();
      throw error;
    }
    return database;
  }

  const dataPath = options.path!;
  if (dataPath !== "memory://") await mkdir(path.resolve(dataPath), { recursive: true });
  const pglite = dataPath === "memory://" ? new PGlite() : new PGlite(path.resolve(dataPath));
  const database: Database = {
    ...pgliteQueryable(pglite),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>) =>
      pglite.transaction((tx) => work(pgliteQueryable(tx))),
    close: async () => { await pglite.close(); },
  };
  try {
    await migrate(database);
  } catch (error) {
    await database.close();
    throw error;
  }
  return database;
}

async function migrate(database: Queryable): Promise<void> {
  for (const statement of MIGRATIONS) await database.query(statement);
}
