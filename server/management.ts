import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './domain/database.js';
import { createPreviewAdministration } from './domain/preview-administration.js';
import type { PlazaService } from './domain/service.js';

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

export function registerManagement(app: FastifyInstance, config: Config, db: Database, service: PlazaService) {
  if (!config.localManagement) return;
  const publications = createPreviewAdministration(db, { includeConfirmed: true });

  app.get('/api/management/publications', async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      status: z.enum(['all', 'preview_ready', 'checking', 'failed', 'expired']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(request.query);
    return publications.list(options);
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
