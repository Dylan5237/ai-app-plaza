import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './domain/database.js';
import type { PlazaService, PublicationStatus } from './domain/service.js';

type ManagementStatus = 'all' | 'preview_ready' | 'checking' | 'failed' | 'expired';

interface PublicationRow {
  id: string;
  app_key: string | null;
  version: string | null;
  manifest: unknown;
  status: PublicationStatus;
  created_at: string | Date;
  updated_at: string | Date;
  expires_at: string | Date;
  next_action: string;
  error_code: string | null;
  error_message: string | null;
}

interface UploadRow {
  id: string;
  app_key: string;
  tag: string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const PUBLICATION_BASE = "status IN ('checking', 'preview_ready', 'failed')";
const publicationFields = `id, submission->>'appKey' AS app_key,
  COALESCE(preview_jsonb->>'version', preview_jsonb->'manifest'->>'projectVersion', '') AS version,
  preview_jsonb->'manifest' AS manifest, status, created_at, updated_at, expires_at,
  next_action, error_code, error_message`;
const iso = (value: string | Date) => new Date(value).toISOString();
const json = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;

function summary(row: PublicationRow) {
  const manifest = json(row.manifest) || {};
  const maintainers = Array.isArray(manifest.maintainers) ? manifest.maintainers.flatMap((value: any) => {
    if (typeof value === 'string') return [value];
    if (value && typeof value.name === 'string') {
      return [{ name: value.name, ...(typeof value.nameEn === 'string' ? { nameEn: value.nameEn } : {}) }];
    }
    return [];
  }) : [];
  return {
    id: row.id,
    name: typeof manifest.name === 'string' ? manifest.name : row.app_key || '待核验应用',
    appKey: row.app_key || '',
    version: row.version || '',
    maintainers,
    status: row.status,
    expired: new Date(row.expires_at).getTime() <= Date.now(),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    nextAction: row.next_action,
    ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message } } : {}),
  };
}

function searchParam(query: string, params: unknown[]): string {
  params.push(`%${query.trim().replace(/[\\%_]/g, '\\$&')}%`);
  return `$${params.length}`;
}

export function registerManagement(app: FastifyInstance, config: Config, db: Database, service: PlazaService) {
  if (!config.localManagement) return;

  app.get('/api/management/publications', async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      status: z.enum(['all', 'preview_ready', 'checking', 'failed', 'expired']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(request.query);
    const params: unknown[] = [];
    let where = PUBLICATION_BASE;
    if (options.query.trim()) {
      const pattern = searchParam(options.query, params);
      where += ` AND (COALESCE(preview_jsonb->'manifest'->>'name', '') ILIKE ${pattern}
        OR COALESCE(submission->>'appKey', '') ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(preview_jsonb->'manifest'->'maintainers') = 'array'
            THEN preview_jsonb->'manifest'->'maintainers' ELSE '[]'::jsonb END
        ) AS maintainer(value) WHERE
          (CASE WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}' ELSE '' END) ILIKE ${pattern}
          OR COALESCE(value->>'name', '') ILIKE ${pattern} OR COALESCE(value->>'nameEn', '') ILIKE ${pattern}))`;
    }
    const stats = (await db.query<any>(`SELECT count(*) AS total_all,
      count(*) FILTER (WHERE expires_at > now() AND status = 'preview_ready') AS preview_ready,
      count(*) FILTER (WHERE expires_at <= now()) AS expired,
      count(*) FILTER (WHERE expires_at > now() AND status = 'checking') AS checking,
      count(*) FILTER (WHERE expires_at > now() AND status = 'failed') AS failed
      FROM publications WHERE ${where}`, params)).rows[0];
    const counts = Object.fromEntries(Object.entries({
      all: stats.total_all, preview_ready: stats.preview_ready, expired: stats.expired,
      checking: stats.checking, failed: stats.failed,
    }).map(([key, value]) => [key, Number(value)])) as Record<ManagementStatus, number>;

    if (options.status === 'expired') where += ' AND expires_at <= now()';
    else if (options.status !== 'all') {
      params.push(options.status);
      where += ` AND expires_at > now() AND status = $${params.length}`;
    }
    params.push(20, (options.page - 1) * 20);
    const rows = await db.query<PublicationRow>(`SELECT ${publicationFields} FROM publications WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows.map(summary), total: counts[options.status], page: options.page, pageSize: 20, counts };
  });

  app.get('/api/management/publications/:id', async request => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(request.params).id;
    return service.managementPublication(id);
  });

  const confirmation = z.object({
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict();
  const emptyBody = z.object({}).strict();
  app.post('/api/management/publications/:id/confirm', async request => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(request.params).id;
    return service.managementConfirm(id, confirmation.parse(request.body));
  });
  app.post('/api/management/publications/:id/retry', async request => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(request.params).id;
    emptyBody.parse(request.body ?? {});
    return service.managementRetry(id);
  });

  app.get('/api/management/uploads', async request => {
    const options = z.object({ query: z.string().max(200).default(''), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().parse(request.query);
    const params: unknown[] = [];
    let where = 'operation.publication_id IS NULL';
    if (options.query.trim()) {
      const pattern = searchParam(options.query, params);
      where += ` AND (binding.app_key ILIKE ${pattern} OR operation.tag ILIKE ${pattern})`;
    }
    const total = Number((await db.query<{ total: number | string }>(
      `SELECT count(*) AS total FROM managed_publish_operations AS operation
       JOIN managed_app_bindings AS binding ON binding.id = operation.binding_id WHERE ${where}`,
      params,
    )).rows[0]?.total ?? 0);
    params.push(20, (options.page - 1) * 20);
    const rows = await db.query<UploadRow>(`SELECT operation.id, binding.app_key, operation.tag,
        operation.status, operation.created_at, operation.updated_at
      FROM managed_publish_operations AS operation
      JOIN managed_app_bindings AS binding ON binding.id = operation.binding_id
      WHERE ${where} ORDER BY operation.created_at DESC, operation.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return {
      items: rows.rows.map(row => ({
        id: row.id, appKey: row.app_key, version: row.tag,
        status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      })),
      total, page: options.page, pageSize: 20,
    };
  });
}
