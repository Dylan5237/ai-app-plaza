import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './domain/database.js';
import { DomainError } from './domain/errors.js';
import { createPreviewAdministration } from './domain/preview-administration.js';

const COOKIE = 'plaza_preview_admin';
const SESSION_MS = 30 * 60 * 1000;
const ATTEMPT_MS = 5 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest();

export function registerPreviewAdmin(app: FastifyInstance, config: Config, db: Database) {
  const adminOrigin = new URL(config.publicOrigin);
  if (config.previewAdmin && adminOrigin.protocol !== 'https:' && !(config.local && config.host === '127.0.0.1' && adminOrigin.hostname === '127.0.0.1')) {
    throw new Error('私有预览管理员功能需要 HTTPS；仅本地回环验证允许 HTTP');
  }
  const reader = createPreviewAdministration(db);
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const passwordHash = config.previewAdmin ? hash(config.previewAdmin.password) : undefined;
  const cookie = (value: string, age: number) => `${COOKIE}=${value}; Path=/api/preview-admin; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(config.publicOrigin).protocol === 'https:' ? '; Secure' : ''}`;
  const enabled = () => {
    if (!passwordHash) throw new DomainError(404, 'PREVIEW_ADMIN_DISABLED', '私有预览管理尚未启用');
  };
  const requireOrigin = (request: FastifyRequest) => {
    if (request.headers.origin !== config.publicOrigin) throw new DomainError(403, 'ORIGIN_DENIED', '请从本门户页面操作');
  };
  const sessionKey = (request: FastifyRequest) => {
    const tokens = (request.headers.cookie || '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${COOKIE}=`));
    if (tokens.length !== 1) return undefined;
    const token = tokens[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token).toString('hex') : undefined;
  };
  const authorize = async (request: FastifyRequest) => {
    enabled();
    const key = sessionKey(request);
    const expires = key ? sessions.get(key) : undefined;
    if (!expires || expires <= Date.now()) {
      if (key) sessions.delete(key);
      throw new DomainError(401, 'ADMIN_AUTH_REQUIRED', '请先验证管理员口令');
    }
  };
  const prune = () => {
    const now = Date.now();
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
    for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key);
  };
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0].startsWith('/api/preview-admin')) {
      reply.header('Cache-Control', 'no-store').header('Cross-Origin-Resource-Policy', 'same-origin').header('X-Robots-Tag', 'noindex, nofollow');
    }
  });
  app.addHook('onClose', async () => { sessions.clear(); failures.clear(); });
  app.get('/api/preview-admin/session', { preHandler: authorize }, async () => ({ authenticated: true }));
  app.post('/api/preview-admin/session', async (request, reply) => {
    enabled(); requireOrigin(request); prune();
    const prior = failures.get(request.ip);
    if (prior && prior.count >= 5) {
      reply.header('Retry-After', String(Math.ceil((prior.until - Date.now()) / 1000)));
      throw new DomainError(429, 'ADMIN_LOGIN_LIMITED', '口令尝试次数过多，请稍后再试');
    }
    const { password } = z.object({ password: z.string().min(1).max(512) }).strict().parse(request.body);
    if (!timingSafeEqual(hash(password), passwordHash!)) {
      if (!prior && failures.size >= 256) failures.delete(failures.keys().next().value!);
      failures.set(request.ip, { count: (prior?.count || 0) + 1, until: prior?.until || Date.now() + ATTEMPT_MS });
      throw new DomainError(401, 'ADMIN_AUTH_REQUIRED', '管理员口令不正确');
    }
    failures.delete(request.ip);
    // Re-authentication revokes the browser's prior session instead of accumulating it.
    const old = sessionKey(request);
    if (old) sessions.delete(old);
    while (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    sessions.set(hash(token).toString('hex'), Date.now() + SESSION_MS);
    return reply.header('Set-Cookie', cookie(token, SESSION_MS / 1000)).send({ authenticated: true });
  });
  app.delete('/api/preview-admin/session', { preHandler: authorize }, async (request, reply) => {
    requireOrigin(request);
    sessions.delete(sessionKey(request)!);
    return reply.header('Set-Cookie', cookie('', 0)).send({ authenticated: false });
  });
  app.get('/api/preview-admin/publications', { preHandler: authorize }, async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      status: z.enum(['all', 'preview_ready', 'expired', 'checking', 'failed']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(request.query);
    return reader.list(options);
  });
  app.get('/api/preview-admin/publications/:id', { preHandler: authorize }, async request => {
    return reader.detail(z.object({ id: z.string().uuid() }).parse(request.params).id);
  });
}
