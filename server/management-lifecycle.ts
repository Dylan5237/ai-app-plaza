import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { managementEnabled, type Config } from './config.js';
import type { Database } from './domain/database.js';
import { DomainError } from './domain/errors.js';
import type { ManagedPublisher } from './domain/managed-publisher.js';
import type { PlazaService } from './domain/service.js';
import { publishContract } from './publish-contract.js';

const appIdSchema = z.object({ id: z.string().uuid() }).strict();
const lifecycleSchema = z.object({
  action: z.enum(['offline', 'online', 'delete', 'restore']),
  expectedAppRevision: z.number().int().positive(),
  expectedLifecycleRevision: z.number().int().positive(),
}).strict();

export function registerManagementLifecycle(
  app: FastifyInstance,
  config: Config,
  _db: Database,
  service: PlazaService,
  managed?: Pick<ManagedPublisher, 'findByAppId'>,
): void {
  if (!managementEnabled(config)) return;

  app.get('/api/management/apps', async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      tags: z.union([z.string(), z.array(z.string())]).optional(),
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(8),
      status: z.enum(['published', 'offline', 'deleted', 'all']).default('all'),
    }).strict().parse(request.query);
    const tags = typeof options.tags === 'string' ? [options.tags] : options.tags ?? [];
    if (tags.length > 12 || tags.some(tag => [...tag].length > 32)) {
      throw new DomainError(400, 'INVALID_REQUEST', '标签筛选超出限制');
    }
    return service.list({
      query: options.query,
      tags,
      page: options.page,
      pageSize: options.pageSize,
      includeHidden: true,
      lifecycleStatus: options.status,
    });
  });

  app.get('/api/management/apps/:id', async request => {
    const id = appIdSchema.parse(request.params).id;
    return service.app(id, { includeHidden: true });
  });

  app.get('/api/management/apps/:id/instructions/:entryId', async request => {
    const params = z.object({ id: z.string().uuid(), entryId: z.string().min(1).max(64) }).strict().parse(request.params);
    return service.instructions(params.id, params.entryId, { includeHidden: true });
  });

  app.get('/api/management/apps/:id/publish-contract', async request => {
    const id = appIdSchema.parse(request.params).id;
    const current = await service.app(id, { includeHidden: true });
    const managedTarget = await managed?.findByAppId(id);
    const contract = await publishContract(config, current, managedTarget, false, await service.tags());
    if ('prompt' in contract && typeof contract.prompt === 'string') {
      const publicReadback = `GET ${config.publicOrigin}/api/apps/${id}`;
      const managementReadback = `GET ${config.publicOrigin}/api/management/apps/${id}`;
      return { ...contract, prompt: contract.prompt.replaceAll(publicReadback, managementReadback) };
    }
    return contract;
  });

  app.post('/api/management/apps/:id/lifecycle', async request => {
    const id = appIdSchema.parse(request.params).id;
    const body = lifecycleSchema.parse(request.body);
    return service.changeLifecycle(id, body.action, body.expectedAppRevision, body.expectedLifecycleRevision);
  });
}
