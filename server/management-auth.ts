import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './domain/database.js';
import type { IdentityHttp } from './identity.js';
import { requireAppAction } from './domain/app-access.js';
import { DomainError } from './domain/errors.js';

declare module 'fastify' { interface FastifyRequest { plazaUserId?: string } }

export async function requirePublicationMaintenance(db: Queryable, publicationId: string, sourceInstance: string, userId?: string) {
  if (!userId) throw new DomainError(401, 'LOGIN_REQUIRED', '请使用天宫身份登录后确认本次发布。');
  const record = (await db.query(`SELECT a.id AS app_id,pa.user_id FROM publications p
    LEFT JOIN catalog_apps a ON a.instance_id=$2 AND a.project_id=p.submission->>'projectId'
      AND a.app_key=p.submission->>'appKey' AND a.current_snapshot_id IS NOT NULL
    LEFT JOIN plaza_publication_actors pa ON pa.publication_id=p.id WHERE p.id=$1`, [publicationId, sourceInstance])).rows[0];
  if (!record) throw new DomainError(404, 'PUBLICATION_NOT_FOUND', '未找到本次发布。');
  if (record.app_id) {
    await requireAppAction(db, record.app_id, userId);
  } else if (record.user_id !== userId) {
    throw new DomainError(404, 'PUBLICATION_NOT_FOUND', '未找到本次发布。');
  }
}

export function installManagementIdentity(app: FastifyInstance, db: Database, identity: () => IdentityHttp | undefined, enabled: boolean, sourceInstance: string) {
  app.addHook('preHandler', async (request: FastifyRequest) => {
    if (!enabled || !request.url.split('?')[0].startsWith('/api/management/')) return;
    const auth = identity();
    if (!auth) throw new DomainError(503, 'IDENTITY_UNAVAILABLE', '身份服务尚未就绪。');
    if (!['GET', 'HEAD'].includes(request.method)) auth.sameOrigin(request);
    const actor = await auth.authenticate(request);
    request.plazaUserId = actor.id;
    const appId = /^\/api\/management\/apps\/([a-f0-9-]{36})(?:\/|$)/i.exec(request.url)?.[1];
    if (appId) await requireAppAction(db, appId, actor.id);
    const publicationId = /^\/api\/management\/publications\/([a-f0-9-]{36})(?:\/|$)/i.exec(request.url)?.[1];
    if (publicationId) await requirePublicationMaintenance(db, publicationId, sourceInstance, actor.id);
  });
}
