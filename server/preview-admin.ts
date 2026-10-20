import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isBoundIntranetHttpOrigin, type Config } from './config.js';
import type { Database } from './domain/database.js';
import { DomainError } from './domain/errors.js';
import { createPreviewAdministration } from './domain/preview-administration.js';

const COOKIE = 'plaza_preview_admin';
const SESSION_MS = 30 * 60 * 1000;
const ATTEMPT_MS = 5 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest();

export function registerPreviewAdmin(app: FastifyInstance, config: Config, db: Database) {
  const adminOrigin = new URL(config.publicOrigin);
  const localLoopback = config.local && config.host === '127.0.0.1' && adminOrigin.hostname === '127.0.0.1';
  const intranetHttp = config.previewAdmin?.allowInsecureIntranet === true && isBoundIntranetHttpOrigin(config.publicOrigin, config.host, config.port);
  if (config.previewAdmin && adminOrigin.protocol !== 'https:' && !localLoopback && !intranetHttp) {
    throw new Error('私有预览管理员功能需要 HTTPS；HTTP 仅允许本地回环验证或显式启用的 RFC1918 IPv4 绑定');
  }
  const proxyIp = config.previewAdmin?.trustedProxyIp;
  if (intranetHttp && proxyIp) throw new Error('内网 HTTP 直连模式不能配置 PLAZA_PREVIEW_ADMIN_PROXY_IP');
  if (config.previewAdmin && ((!localLoopback && !intranetHttp && !proxyIp) || (proxyIp && (!isIP(proxyIp) || proxyIp.includes('%'))))) {
    throw new Error('非本地私有预览管理需配置有效的 PLAZA_PREVIEW_ADMIN_PROXY_IP');
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
      throw new DomainError(403, 'ADMIN_PROXY_REQUIRED', '管理员请求必须经过已配置的 HTTPS 代理');
    }
    return normalizeIp(forwarded);
  };
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
      if (config.previewAdmin) clientIp(request);
    }
  });
  app.addHook('onClose', async () => { sessions.clear(); failures.clear(); });
  // Use the same validated identity for the plugin's request limit and login failures.
  // Route stores also keep public traffic on a shared proxy from locking out admins.
  const routeConfig = { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (request: FastifyRequest) => `preview-admin:${clientIp(request)}` } };
  app.get('/api/preview-admin/session', { config: routeConfig, preHandler: authorize }, async request => ({ authenticated: true, expiresInMs: Math.max(0, sessions.get(sessionKey(request)!)! - Date.now()) }));
  app.post('/api/preview-admin/session', { config: routeConfig }, async (request, reply) => {
    enabled(); requireOrigin(request); prune();
    const sourceIp = clientIp(request);
    const prior = failures.get(sourceIp);
    if (prior && prior.count >= 5) {
      reply.header('Retry-After', String(Math.ceil((prior.until - Date.now()) / 1000)));
      throw new DomainError(429, 'ADMIN_LOGIN_LIMITED', '口令尝试次数过多，请稍后再试');
    }
    const { password } = z.object({ password: z.string().min(1).max(512) }).strict().parse(request.body);
    if (!timingSafeEqual(hash(password), passwordHash!)) {
      if (!prior && failures.size >= 256) failures.delete(failures.keys().next().value!);
      failures.set(sourceIp, { count: (prior?.count || 0) + 1, until: prior?.until || Date.now() + ATTEMPT_MS });
      throw new DomainError(401, 'ADMIN_AUTH_REQUIRED', '管理员口令不正确');
    }
    failures.delete(sourceIp);
    // Re-authentication revokes the browser's prior session instead of accumulating it.
    const old = sessionKey(request);
    if (old) sessions.delete(old);
    while (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    sessions.set(hash(token).toString('hex'), Date.now() + SESSION_MS);
    return reply.header('Set-Cookie', cookie(token, SESSION_MS / 1000)).send({ authenticated: true, expiresInMs: SESSION_MS });
  });
  app.delete('/api/preview-admin/session', { config: routeConfig, preHandler: authorize }, async (request, reply) => {
    requireOrigin(request);
    sessions.delete(sessionKey(request)!);
    return reply.header('Set-Cookie', cookie('', 0)).send({ authenticated: false });
  });
  app.get('/api/preview-admin/publications', { config: routeConfig, preHandler: authorize }, async request => {
    const options = z.object({
      query: z.string().max(200).default(''),
      status: z.enum(['all', 'preview_ready', 'expired', 'checking', 'failed']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }).strict().parse(request.query);
    return reader.list(options);
  });
  app.get('/api/preview-admin/publications/:id', { config: routeConfig, preHandler: authorize }, async request => {
    return reader.detail(z.object({ id: z.string().uuid() }).parse(request.params).id);
  });
}
