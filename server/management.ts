import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { managementEnabled, type Config } from './config.js';
import type { Database } from './domain/database.js';
import type { ManagedPublisher } from './domain/managed-publisher.js';
import { createPreviewAdministration } from './domain/preview-administration.js';
import type { PlazaService } from './domain/service.js';
import { registerManagementEditor } from './management-editor.js';
import { registerManagementLifecycle } from './management-lifecycle.js';
import { appAccessPredicate } from './domain/app-access.js';

interface UploadRow {
  id: string;
  app_key: string;
  tag: string;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (value: string | Date) => new Date(value).toISOString();

function searchParam(query: string, params: unknown[]): string {
  params.push(`%${query.trim().replace(/[\\%_]/g, '\\$&')}%`);
  return `$${params.length}`;
}

export function registerManagement(app: FastifyInstance, config: Config, db: Database, service: PlazaService, managed?: ManagedPublisher) {
  if (!managementEnabled(config)) return;
  registerManagementLifecycle(app, config, db, service, managed);
  registerManagementEditor(app, config, db, service, managed);
  const publications = createPreviewAdministration(db, { includeConfirmed: true, identityMode: !!config.tiangong,
    sourceInstance: new URL(config.gitlabUrl).toString().replace(/\/+$/, '') });

  app.get('/api/management/publications', async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      status: z.enum(['all', 'preview_ready', 'checking', 'failed', 'expired']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).strict().parse(request.query);
    return publications.list({ ...options, viewerId: request.plazaUserId });
  });

  app.get('/api/management/publications/:id', async request => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(request.params).id;
    const result = await service.managementPublication(id, request.plazaUserId);
    return config.analytics ? { ...result, analyticsEnabled: true } : result;
  });

  const confirmation = z.object({
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict();
  const emptyBody = z.object({}).strict();
  app.post('/api/management/publications/:id/confirm', async request => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(request.params).id;
    return service.managementConfirm(id, confirmation.parse(request.body), request.plazaUserId);
  });
  app.post('/api/management/publications/:id/retry', async request => {
    const id = z.object({ id: z.string().uuid() }).strict().parse(request.params).id;
    emptyBody.parse(request.body ?? {});
    return service.managementRetry(id, request.plazaUserId);
  });

  app.get('/api/management/uploads', async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).strict().parse(request.query);
    const params: unknown[] = [];
    let where = 'operation.publication_id IS NULL';
    if (config.tiangong) {
      params.push(request.plazaUserId, new URL(config.gitlabUrl).toString().replace(/\/+$/, ''), config.audience);
      where += ` AND EXISTS(SELECT 1 FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
        WHERE a.instance_id=$2 AND a.project_id=binding.project_id AND a.app_key=binding.app_key
        AND s.audience=$3 AND ${appAccessPredicate('$1::uuid', true)})`;
    }
    if (options.query.trim()) {
      const pattern = searchParam(options.query, params);
      where += ` AND (binding.app_key ILIKE ${pattern} OR operation.tag ILIKE ${pattern})`;
    }
    const total = Number((await db.query<{ total: number | string }>(
      `SELECT count(*) AS total FROM managed_publish_operations AS operation
       JOIN managed_app_bindings AS binding ON binding.id = operation.binding_id WHERE ${where}`,
      params,
    )).rows[0]?.total ?? 0);
    params.push(options.pageSize, (options.page - 1) * options.pageSize);
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
      total, page: options.page, pageSize: options.pageSize,
    };
  });
}
