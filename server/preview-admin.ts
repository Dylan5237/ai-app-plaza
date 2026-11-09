import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './domain/database.js';
import { DomainError } from './domain/errors.js';
import { createPreviewAdministration } from './domain/preview-administration.js';

export function registerPreviewAdmin(app: FastifyInstance, config: Config, db: Database) {
  const proxyIp = config.previewAdmin?.trustedProxyIp;
  if (proxyIp && (!isIP(proxyIp) || proxyIp.includes('%'))) {
    throw new Error('PLAZA_PREVIEW_ADMIN_PROXY_IP 必须是单一可信代理 IP');
  }
  const normalizeIp = (value: string) => {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
    if (mapped && isIP(mapped[1]) === 4) return mapped[1];
    return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;
  };
  const clientIp = (request: FastifyRequest) => {
    if (!proxyIp) return request.ip;
    const remote = request.raw.socket.remoteAddress;
    const forwarded = request.headers['x-real-ip'];
    const identityHeaders = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-real-ip').length;
    if (!remote || normalizeIp(remote) !== normalizeIp(proxyIp) || identityHeaders !== 1 || typeof forwarded !== 'string' || !isIP(forwarded) || forwarded.includes('%')) {
      throw new DomainError(403, 'ADMIN_PROXY_REQUIRED', '预览管理请求必须经过已配置的代理');
    }
    return normalizeIp(forwarded);
  };
  const reader = createPreviewAdministration(db, { sourceInstance: new URL(config.gitlabUrl).toString().replace(/\/+$/, '') });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0].startsWith('/api/preview-admin')) {
      reply.header('Cache-Control', 'no-store').header('Cross-Origin-Resource-Policy', 'same-origin').header('X-Robots-Tag', 'noindex, nofollow');
      clientIp(request);
    }
  });
  // Read-only access follows the same visitor boundary as the portal.
  // Keep per-client limits independent of the public proxy bucket.
  const routeConfig = { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (request: FastifyRequest) => `preview-admin:${clientIp(request)}` } };
  app.get('/api/preview-admin/publications', { config: routeConfig }, async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      status: z.enum(['all', 'preview_ready', 'expired', 'checking', 'failed']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(request.query);
    return reader.list(options);
  });
  app.get('/api/preview-admin/publications/:id', { config: routeConfig }, async request => {
    return reader.detail(z.object({ id: z.string().uuid() }).parse(request.params).id);
  });
}
