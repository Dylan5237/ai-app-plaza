import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './domain/database.js';
import type { ManagedPublisher } from './domain/managed-publisher.js';
import { DomainError } from './domain/errors.js';
import type { PlazaService } from './domain/service.js';

const appId = z.string().uuid();
const editRequest = z.object({
  expectedAppRevision: z.number().int().nonnegative(),
  manifest: z.unknown(),
  documents: z.record(z.string(), z.string()),
}).strict();

export function registerManagementEditor(
  app: FastifyInstance,
  config: Config,
  db: Database,
  service: PlazaService,
  managed?: ManagedPublisher,
) {
  if (!config.localManagement) return;
  void db;

  app.get('/api/management/apps/:id/editor', async request => {
    const id = appId.parse((request.params as { id?: unknown }).id);
    if (!managed) return { app: await service.app(id, { includeHidden: true }), editable: false, reason: '当前服务未启用统一托管发布，请使用原发布新版本流程。' };
    return managed.editorContext(id);
  });

  app.post('/api/management/apps/:id/editor', { bodyLimit: 1024 * 1024 }, async request => {
    const id = appId.parse((request.params as { id?: unknown }).id);
    if (!managed) throw new DomainError(503, 'MANAGED_PUBLISH_DISABLED', '当前服务未启用统一托管发布，请使用原发布新版本流程。');
    const idempotencyKey = z.string().uuid().parse(request.headers['idempotency-key']);
    const input = editRequest.parse(request.body);
    const result = await managed.editMetadata(id, input, idempotencyKey);
    const managementPublication = await service.managementPublication(result.id);
    if (managementPublication.id !== result.id) {
      throw new DomainError(409, 'PUBLICATION_STATE_CONFLICT', '托管修订预览与原始提交记录不一致。');
    }
    return { managementPublication, operationId: result.operationId };
  });
}
