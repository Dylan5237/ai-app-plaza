import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './domain/database.js';
import { DomainError } from './domain/errors.js';
import { createIdentityService } from './domain/identity.js';
import type { PlazaService } from './domain/service.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
function cookie(request: FastifyRequest, name: string): string | undefined {
  const matches = (request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export async function registerIdentity(app: FastifyInstance, config: Config, db: Database, catalog: PlazaService) {
  const settings = config.tiangong;
  app.get('/api/auth/tiangong/status', async () => settings ? {
    enabled: true, tokenStorage: { storage: 'localStorage', key: settings.tokenStorageKey },
  } : { enabled: false });
  if (!settings) return;
  if (config.localManagement || config.intranetManagement || config.previewAdmin) throw new Error('天宫身份模式不能同时启用旧的无身份管理入口');
  if (config.httpsOrigin) throw new Error('天宫身份模式需配置单一门户同源 PUBLIC_ORIGIN');
  const service = await createIdentityService(db, settings);
  // Cookies are shared across ports on a host. Isolate environments and mounts.
  const scope = createHash('sha256').update(`${config.publicOrigin}${config.publicBasePath || '/'}`).digest('hex').slice(0, 16);
  const prefix = config.publicOrigin.startsWith('https:') ? '__Secure-' : '';
  const SESSION = `${prefix}plaza_session_${scope}`;
  const REQUEST = `${prefix}plaza_request_${scope}`;
  const setCookie = (reply: FastifyReply, name: string, value: string, age: number) => {
    reply.header('Set-Cookie', `${name}=${value}; Path=${config.publicBasePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=${age}${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
  };
  const sameOrigin = (request: FastifyRequest) => {
    if (request.headers.origin !== config.publicOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new DomainError(403, 'ORIGIN_DENIED', '请从天宫同源的广场入口操作。');
    }
  };
  const authenticate = (request: FastifyRequest) => service.authenticate(cookie(request, SESSION),
    typeof request.headers['x-plaza-portal-token'] === 'string' ? request.headers['x-plaza-portal-token'] : undefined);
  app.post('/api/auth/tiangong/requests', async (request, reply) => {
    sameOrigin(request);
    z.object({}).strict().parse(request.body ?? {});
    const result = await service.challenge();
    setCookie(reply, REQUEST, result.browserSecret, 120);
    return { requestId: result.requestId };
  });
  app.post('/api/auth/tiangong/exchange', async (request, reply) => {
    sameOrigin(request);
    const input = z.object({ requestId: opaque, token: z.string().min(1).max(8192), switchAccount: z.boolean().default(false) }).strict().parse(request.body);
    const browserSecret = cookie(request, REQUEST);
    if (!browserSecret) throw new DomainError(409, 'LOGIN_REQUEST_EXPIRED', '本次登录请求已失效，请重新发起登录。');
    const result = await service.login({ ...input, browserSecret, session: cookie(request, SESSION) });
    setCookie(reply, SESSION, result.credential, settings.sessionHours * 3600);
    return { user: result.user };
  });
  app.get('/api/auth/me', async request => ({ user: await authenticate(request) }));
  app.post('/api/auth/logout', async (request, reply) => {
    sameOrigin(request);
    z.object({}).strict().parse(request.body ?? {});
    await service.logout(cookie(request, SESSION));
    setCookie(reply, SESSION, '', 0);
    return { loggedOut: true };
  });
  app.get('/api/identity/users', async request => ({ items: await service.users(await authenticate(request)) }));
  app.get('/api/identity/groups', async request => ({ items: await service.groups(await authenticate(request)) }));
  const group = z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean(),
    members: z.array(z.string().uuid()).max(500), confirmed: z.literal(true) }).strict();
  app.post('/api/identity/groups', async (request, reply) => {
    sameOrigin(request);
    const actor = await authenticate(request);
    return reply.code(201).send(await service.saveGroup(actor, group.extend({ requestId: z.string().uuid() }).parse(request.body)));
  });
  app.put('/api/identity/groups/:id', async request => {
    sameOrigin(request);
    const actor = await authenticate(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = group.extend({ revision: z.number().int().positive() }).parse(request.body);
    return service.saveGroup(actor, { ...input, id });
  });
  app.get('/api/personal/favorites', async request => {
    const actor = await authenticate(request);
    const options = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(24).default(12) }).strict().parse(request.query);
    const result = await service.favorites(actor, options);
    const items = await Promise.all(result.items.map(async saved => {
      try {
        const { documents: _documents, distributions: _distributions, ...app } = await catalog.app(saved.app_id, { viewerId: actor.id });
        return { id: saved.app_id, app };
      } catch (error) {
        if (!(error instanceof DomainError) || error.statusCode !== 404) throw error;
        return { id: saved.app_id, app: null };
      }
    }));
    return { ...result, items };
  });
  app.get('/api/personal/favorite-ids', async request => ({ ids: await service.favoriteIds(await authenticate(request)) }));
  app.put('/api/personal/favorites/:id', async request => {
    sameOrigin(request);
    const actor = await authenticate(request);
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params);
    const { saved } = z.object({ saved: z.boolean() }).strict().parse(request.body);
    if (saved) await catalog.app(id, { viewerId: actor.id });
    await service.saveFavorite(actor, id, saved, config.audience);
    return { id, saved };
  });
  return { service, authenticate, sameOrigin };
}

export type IdentityHttp = NonNullable<Awaited<ReturnType<typeof registerIdentity>>>;
