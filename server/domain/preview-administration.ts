import { appAccessPredicate } from './app-access.js';
import type { Database } from './database.js';
import { DomainError } from './errors.js';
import type { AppView, PublicationChange, PublicationStatus } from './service.js';

export type AdminPreviewStatus = 'all' | 'preview_ready' | 'expired' | 'checking' | 'failed';
export interface AdminPreviewSummary {
  id: string; name: string; appKey: string; version: string;
  maintainers: Array<string | { name: string; nameEn?: string }>;
  status: PublicationStatus; expired: boolean;
  createdAt: string; updatedAt: string; expiresAt: string;
  nextAction: string; error?: { code: string; message: string };
}
interface RecordRow {
  id: string; app_key: string; version: string; manifest: any;
  status: PublicationStatus; created_at: string | Date; updated_at: string | Date;
  expires_at: string | Date; next_action: string; error_code: string | null;
  error_message: string | null; preview_jsonb?: any;
}
const PUBLICATION_STATUSES = "status IN ('checking', 'preview_ready', 'failed')";
const BASE = `${PUBLICATION_STATUSES} AND confirmed_at IS NULL`;
const FIELDS = `id, submission->>'appKey' AS app_key,
  COALESCE(preview_jsonb->>'version', preview_jsonb->'manifest'->>'projectVersion', '') AS version,
  preview_jsonb->'manifest' AS manifest, status, created_at, updated_at, expires_at,
  next_action, error_code, error_message`;
const iso = (value: string | Date) => new Date(value).toISOString();
const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;

function summary(row: RecordRow): AdminPreviewSummary {
  const manifest = json(row.manifest) || {};
  const maintainers = Array.isArray(manifest.maintainers) ? manifest.maintainers.flatMap((m: any) => {
    if (typeof m === 'string') return [m];
    if (m && typeof m.name === 'string') return [{ name: m.name, ...(typeof m.nameEn === 'string' ? { nameEn: m.nameEn } : {}) }];
    return [];
  }) : [];
  return {
    id: row.id, name: typeof manifest.name === 'string' ? manifest.name : row.app_key || '待核验应用',
    appKey: row.app_key || '', version: row.version, maintainers,
    status: row.status, expired: new Date(row.expires_at).getTime() <= Date.now(),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), expiresAt: iso(row.expires_at),
    nextAction: row.next_action,
    ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message } } : {}),
  };
}

// This reader deliberately does not use publication(id, ticket): reading an expired
// publication there clears credentials. Administration must only SELECT safe fields.
export function createPreviewAdministration(db: Database, options: { includeConfirmed?: boolean; identityMode?: boolean; sourceInstance?: string } = {}) {
  const listBase = options.includeConfirmed ? PUBLICATION_STATUSES : BASE;
  const identityMode = options.identityMode;
  const sourceInstance = options.sourceInstance;
  const appMatch = (instanceParameter?: string) => `a.project_id=publications.submission->>'projectId'
    AND a.app_key=publications.submission->>'appKey'${instanceParameter ? ` AND a.instance_id=${instanceParameter}` : ''}`;
  return {
    async list(options: { query: string; status: AdminPreviewStatus; page: number; pageSize?: number; viewerId?: string }) {
      if (identityMode && !options.viewerId) throw new DomainError(401, 'LOGIN_REQUIRED', '请登录后查看本人的发布候选。');
      const params: unknown[] = sourceInstance ? [sourceInstance] : [];
      const matchingApp = appMatch(sourceInstance ? '$1' : undefined);
      let where = listBase;
      if (options.query.trim()) {
        params.push(`%${options.query.trim().replace(/[\\%_]/g, '\\$&')}%`);
        const pattern = `$${params.length}`;
        where += ` AND (COALESCE(preview_jsonb->'manifest'->>'name', '') ILIKE ${pattern}
          OR COALESCE(submission->>'appKey', '') ILIKE ${pattern}
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(preview_jsonb->'manifest'->'maintainers') = 'array'
              THEN preview_jsonb->'manifest'->'maintainers' ELSE '[]'::jsonb END
          ) AS maintainer(value) WHERE
            (CASE WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}' ELSE '' END) ILIKE ${pattern}
            OR COALESCE(value->>'name', '') ILIKE ${pattern} OR COALESCE(value->>'nameEn', '') ILIKE ${pattern}))`;
      }
      if (options.viewerId) {
        params.push(options.viewerId);
        const actor = `$${params.length}::uuid`;
        where += ` AND (EXISTS(SELECT 1 FROM plaza_publication_actors pa WHERE pa.publication_id=publications.id AND pa.user_id=${actor}
            AND NOT EXISTS(SELECT 1 FROM catalog_apps a WHERE ${matchingApp}))
          OR EXISTS(SELECT 1 FROM catalog_apps a WHERE ${matchingApp}
            AND ${appAccessPredicate(actor, true)}))`;
      }
      if (!options.viewerId) where += ` AND identity_required=false
        AND NOT EXISTS(SELECT 1 FROM plaza_publication_actors pa WHERE pa.publication_id=publications.id)
        AND NOT EXISTS(SELECT 1 FROM catalog_apps a JOIN plaza_app_access ap ON ap.app_id=a.id WHERE ${matchingApp})`;
      const stats = (await db.query<any>(`SELECT count(*) AS all,
        count(*) FILTER (WHERE expires_at > now() AND status = 'preview_ready') AS preview_ready,
        count(*) FILTER (WHERE expires_at <= now()) AS expired,
        count(*) FILTER (WHERE expires_at > now() AND status = 'checking') AS checking,
        count(*) FILTER (WHERE expires_at > now() AND status = 'failed') AS failed
        FROM publications WHERE ${where}`, params)).rows[0];
      const counts = Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value)])) as Record<AdminPreviewStatus, number>;
      if (options.status === 'expired') where += ' AND expires_at <= now()';
      else if (options.status !== 'all') {
        params.push(options.status);
        where += ` AND expires_at > now() AND status = $${params.length}`;
      }
      const pageSize = options.pageSize ?? 20;
      params.push(pageSize, (options.page - 1) * pageSize);
      const rows = await db.query<RecordRow>(`SELECT ${FIELDS} FROM publications WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return { items: rows.rows.map(summary), total: counts[options.status], page: options.page, pageSize, counts };
    },
    async detail(id: string) {
      const row = (await db.query<RecordRow>(`SELECT ${FIELDS}, preview_jsonb FROM publications WHERE id = $1 AND ${BASE} AND identity_required=false
        AND NOT EXISTS(SELECT 1 FROM plaza_publication_actors pa WHERE pa.publication_id=publications.id)
        AND NOT EXISTS(SELECT 1 FROM catalog_apps a JOIN plaza_app_access ap ON ap.app_id=a.id
          WHERE ${appMatch(sourceInstance ? '$2' : undefined)})`, sourceInstance ? [id, sourceInstance] : [id])).rows[0];
      if (!row) throw new DomainError(404, 'NOT_FOUND', '未找到未确认的发布记录');
      const stored = json(row.preview_jsonb);
      let preview: AppView | undefined;
      let change: PublicationChange | undefined;
      if (stored) {
        // Explicit projection: never forward stored envelope fields such as ticket,
        // digest, submission, encrypted GitLab credentials, or actor identifiers.
        preview = {
          id: stored.id, revision: stored.revision, manifest: stored.manifest,
          tags: stored.tags, version: stored.version, createdAt: stored.createdAt,
          updatedAt: stored.updatedAt, source: stored.source, documents: stored.documents,
        };
        if (stored.change) change = {
          kind: stored.change.kind,
          ...(stored.change.previousVersion ? { previousVersion: stored.change.previousVersion } : {}),
          changedFields: stored.change.changedFields,
        };
      }
      return { ...summary(row), ...(preview ? { preview } : {}), ...(change ? { change } : {}) };
    },
  };
}
