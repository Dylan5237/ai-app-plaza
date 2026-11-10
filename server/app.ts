import { registerOperationsDashboard } from './operations-dashboard.js';
import { requireAdministrator } from './domain/platform-access.js';
import { publicCatalogAppIds } from './domain/app-access.js';
import { installManagementIdentity } from './management-auth.js';
import { registerApplicationAccess } from './application-access.js';
import { requireAppAction } from './domain/app-access.js';
import type { IdentityHttp } from './identity.js';
import Fastify, { type FastifyRequest } from 'fastify';
import staticPlugin from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createService } from './domain/service.js';
import { normalizeProjectVersion } from './domain/manifest.js';
import { DomainError, type DomainDiagnostic } from './domain/errors.js';
import type { Database } from './domain/database.js';
import { assertManagementConfig, managementEnabled, managementMode, type Config } from './config.js';
import { publishContract } from './publish-contract.js';
import { publisherScript } from './managed-publish-contract.js';
import { createManagedPublisher } from './domain/managed-publisher.js';
import { registerPreviewAdmin } from './preview-admin.js';
import { registerManagement } from './management.js';
import { registerIdentity } from './identity.js';
import { parseHttpsOrigin, parseTrustedProxyIp, publicClientRateKey, publicOriginForRequest } from './public-origins.js';
import { recordBrowserEvent, recordCatalogBaseline, recordPublicationExpirations } from './domain/analytics.js';
import { maintainAnalyticsRetention } from './domain/analytics-retention.js';

const candidate = z.object({
  projectId: z.union([z.string().regex(/^[1-9][0-9]{0,19}$/), z.number().int().positive()]),
  appKey: z.string().min(1).max(64), manifestPath: z.string().min(1).max(512),
  commitSha: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
  tag: z.string().min(1).max(128).refine((value) => normalizeProjectVersion(value) !== undefined), expectedAppRevision: z.number().int().nonnegative().optional(),
}).strict();
const confirmation = z.object({ revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const managedCandidate = z.object({
  appKey: z.string().min(1).max(64), manifestPath: z.string().min(1).max(512),
  files: z.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(7 * 1024 * 1024) }).strict()).min(1).max(1000),
  managedAppId: z.string().uuid().optional(), expectedAppRevision: z.number().int().nonnegative().optional(),
}).strict();
const idValue = z.string().uuid();

function managedRequestField(path: PropertyKey[]): string | undefined {
  const allowed = new Set(['appKey', 'manifestPath', 'files', 'path', 'content', 'managedAppId', 'expectedAppRevision']);
  if (!path.length) return undefined;
  const parts: string[] = [];
  for (const part of path.slice(0, 8)) {
    if (typeof part === 'number' && Number.isInteger(part) && part >= 0 && part < 1000) parts.push(String(part));
    else if (typeof part === 'string' && allowed.has(part)) parts.push(part);
    else return undefined;
  }
  return parts.join('.');
}

function parseManagedCandidate(value: unknown) {
  try {
    return managedCandidate.parse(value);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const diagnostics: DomainDiagnostic[] = error.issues.slice(0, 50).map(issue => ({
      code: 'REQUEST_FIELD_INVALID',
      ruleId: 'managed.request.schema',
      ...(managedRequestField(issue.path) ? { field: managedRequestField(issue.path) } : { field: 'request' }),
      suggestion: '检查字段类型、长度和格式后重新校验。',
    }));
    throw new DomainError(400, 'INVALID_REQUEST', '请求字段不符合发布规范', diagnostics);
  }
}

export async function createApp(config: Config, db: Database) {
  assertManagementConfig(config);
  const basePath = config.publicBasePath || '';
  if (basePath && !/^\/[a-zA-Z0-9_-]+$/.test(basePath)) throw new Error('PLAZA_PUBLIC_BASE_PATH 必须是单层固定路径');
  parseHttpsOrigin(config.httpsOrigin, config);
  parseTrustedProxyIp(config.trustedProxyIp);
  const service = createService({ db, gitlabUrl: config.gitlabUrl, publicOrigin: config.publicOrigin, publicBasePath: basePath, secret: config.secret, audience: config.audience,
    distributionDir: resolve(config.dataDir || 'artifacts/plaza-local', 'distribution'), staticDir: config.staticDir, analytics: config.analytics, applicationIdentity: !!config.tiangong });
  const managed = config.managedPublishing ? createManagedPublisher({ db, service, gitlabUrl: config.gitlabUrl, gitlabToken: config.managedPublishing.token, groupId: config.managedPublishing.groupId, secret: config.secret, analytics: config.analytics }) : undefined;
  // No request/body/header logging: publication links and GitLab credentials are capabilities.
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 30_000, trustProxy: false,
    rewriteUrl: request => {
      const url = request.url || '/';
      if (basePath && (url === basePath || url.startsWith(`${basePath}?`))) return `/__plaza_mount${url.slice(basePath.length)}`;
      return basePath && url.startsWith(`${basePath}/`) ? url.slice(basePath.length) : url;
    } });
  let identity: IdentityHttp | undefined;
  installManagementIdentity(app, db, () => identity, !!config.tiangong, new URL(config.gitlabUrl).toString().replace(/\/+$/, ''));
  const viewerId = async (request: FastifyRequest) => {
    if (!identity || typeof request.headers['x-plaza-portal-token'] !== 'string') return undefined;
    return (await identity.authenticate(request)).id;
  };
  const publicationActor = async (request: FastifyRequest) => {
    if (!identity) return undefined;
    identity.sameOrigin(request);
    return (await identity.authenticate(request)).id;
  };
  const protectReceipt = async (result: any, request: FastifyRequest) => {
    if (!result?.id || !result?.ticket) return result;
    const visible = await service.receiptView(result.id, result.ticket, await viewerId(request));
    if (!visible.requiresIdentity) return result;
    return { ...visible, ticket: result.ticket, previewUrl: result.previewUrl,
      ...(result.managedAppId ? { managedAppId: result.managedAppId } : {}),
      ...(result.operationId ? { operationId: result.operationId } : {}),
      ...(result.sourceUploaded !== undefined ? { sourceUploaded: result.sourceUploaded } : {}) };
  };
  let managedActive = 0;
  let downloadActive = 0;
  const releaseManagedSlot = (request: any) => {
    if (!request.managedSlot) return;
    request.managedSlot = false;
    managedActive -= 1;
  };
  const releaseDownloadSlot = (request: any) => {
    if (!request.distributionSlot) return;
    request.distributionSlot = false;
    downloadActive -= 1;
  };
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupInFlight: Promise<void> | undefined;
  let nextAnalyticsRetentionAt = 0;
  app.addHook('onReady', async () => {
    await service.cleanupExpiredTokens();
    await identity?.service.cleanup();
    if (config.analytics) await recordCatalogBaseline(db, config).then(() => recordPublicationExpirations(db, config)).catch(() => { console.error('统计基线或到期检查未完成，后续将重试'); });
    cleanupTimer = setInterval(() => {
      if (cleanupInFlight) return;
      cleanupInFlight = service.cleanupExpiredTokens()
        .then(() => identity?.service.cleanup())
        .then(async () => {
          if (config.analytics) await recordCatalogBaseline(db, config).then(() => recordPublicationExpirations(db, config))
            .catch(() => { console.error('统计基线或到期检查未完成，后续将重试'); });
          if (!(config.analyticsRetention || config.analytics) || Date.now() < nextAnalyticsRetentionAt) return;
          try {
            await maintainAnalyticsRetention(db, config);
            nextAnalyticsRetentionAt = Date.now() + 60 * 60_000;
          } catch { console.error('统计保留策略未完成，后续将重试'); }
        })
        .catch(() => { console.error('过期发布授权清理未完成，将在下一周期重试'); })
        .finally(() => { cleanupInFlight = undefined; });
    }, 60_000);
    cleanupTimer.unref();
  });
  app.addHook('onClose', async () => { clearInterval(cleanupTimer); await cleanupInFlight; });
  if (config.rateLimit) await app.register(rateLimit, { max: 120, timeWindow: '1 minute',
    ...(config.httpsOrigin || config.trustedProxyIp ? { keyGenerator: (request: FastifyRequest) => publicClientRateKey(config, request) } : {}) });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    const requestOrigin = request.headers.origin;
    const expectedOrigin = publicOriginForRequest(config, request);
    if (requestOrigin && requestOrigin !== expectedOrigin) {
      return reply.code(403).send({ error: { code: 'ORIGIN_DENIED', message: '请从本门户页面操作' } });
    }
    // Host checking also prevents websites using DNS rebinding to address a local portal.
    if (!expectedOrigin) {
      return reply.code(403).send({ error: { code: 'HOST_DENIED', message: '访问地址与 PUBLIC_ORIGIN 不一致' } });
    }
    const path = request.url.split('?')[0];
    if (request.method === 'GET' && /^\/api\/apps\/[^/]+\/packages\/[^/]+$/.test(path)) {
      if (downloadActive >= 4) return reply.code(429).send({ error: { code: 'ASSET_BUSY', message: '分发下载繁忙，请稍后重试' } });
      downloadActive++;
      (request as any).distributionSlot = true;
    }
    if (managementEnabled(config) && /^\/api\/management(?:\/|$)/.test(path)) {
      const fetchSite = request.headers['sec-fetch-site'];
      const values = Array.isArray(fetchSite) ? fetchSite : fetchSite === undefined ? [] : [fetchSite];
      if (values.some(value => value.toLowerCase() === 'cross-site')) {
        return reply.code(403).send({ error: { code: 'CROSS_SITE_DENIED', message: '后台管理请求不接受跨站来源' } });
      }
    }
    const managedPostPath = request.url.split('?')[0];
    const isManagedPublicationPost = ['/api/managed-publications', '/api/managed-publications/validate'].includes(managedPostPath);
    const isManagementEditorPost = /^\/api\/management\/apps\/[^/]+\/editor$/.test(managedPostPath);
    if (managed && request.method === 'POST' && (isManagedPublicationPost || isManagementEditorPost)) {
      if (managedActive >= 2) return reply.code(429).send({ error: { code: 'UPLOAD_BUSY', message: '正在处理其他上传，请保留本次记录后稍后重试' } });
      managedActive += 1;
      (request as any).managedSlot = true;
      (request as any).releaseManagedSlot = () => releaseManagedSlot(request);
    }
  });
  app.addHook('onResponse', async request => { releaseManagedSlot(request); releaseDownloadSlot(request); });
  app.addHook('onRequestAbort', async request => { if (!(request as any).managedRunning) releaseManagedSlot(request); releaseDownloadSlot(request); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '请求字段不符合发布规范' } });
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: {
      code: error.code,
      message: error.message,
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    } });
    const status = (error as any).statusCode;
    if (status === 413) return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE', message: request.url.startsWith('/api/managed-publications') ? '应用文件过大，请精简上传范围；不要遗漏必要源码' : '请求过大，只应提交资料定位' } });
    if (status === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '操作较频繁，请稍后重试' } });
    if (status === 400 || status === 415) return reply.code(status).send({ error: { code: 'INVALID_REQUEST', message: '请使用有效 JSON 请求' } });
    return reply.code(500).send({ error: { code: 'SERVICE_UNAVAILABLE', message: '处理未完成，请保留本次发布链接后重试' } });
  });
  const ticket = (header?: string) => {
    if (!header?.startsWith('Bearer ') || header.length > 1024) throw new DomainError(404, 'NOT_FOUND', '未找到本次发布');
    return header.slice(7);
  };
  const publicationId = (params: unknown) => idValue.parse((params as any).id);
  app.get('/api/health', async () => ({ status: 'ok', mode: config.local ? 'local' : 'configured', loginRequired: false,
    managementEnabled: managementEnabled(config), managementMode: managementMode(config) }));
  app.get('/api/publish-contract', async (request) => {
    const query = z.object({ mode: z.enum(['managed', 'gitlab']).optional() }).parse(request.query);
    return publishContract(config, undefined, undefined, query.mode === 'gitlab', await service.tags());
  });
  app.get('/api/publisher-cli.py', async (_request, reply) => {
    if (!managed) throw new DomainError(503, 'MANAGED_PUBLISH_DISABLED', '当前服务尚未启用统一托管发布');
    const script = await publisherScript();
    return reply.type('text/x-python; charset=utf-8').header('X-Content-SHA256', script.sha256).send(script.text);
  });
  app.get('/api/apps', async (request) => {
    const search = z.object({ query: z.string().max(200).default(''), tags: z.union([z.string(), z.array(z.string())]).optional(), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(8), usage: z.enum(['all', 'platform', 'agent']).optional(), sort: z.literal('updated').optional() }).parse(request.query);
    const tags = typeof search.tags === 'string' ? [search.tags] : search.tags || [];
    if (tags.length > 12 || tags.some(t => [...t].length > 32)) throw new DomainError(400, 'INVALID_REQUEST', '标签筛选超出限制');
    const result = await service.list({ query: search.query, tags, page: search.page, pageSize: search.pageSize, usage: search.usage, sort: search.sort, viewerId: await viewerId(request) });
    return config.analytics ? { ...result, analyticsEnabled: true } : result;
  });
  app.post('/api/analytics/events', { config: { rateLimit: { groupId: ':analytics', max: 240, timeWindow: '1 minute' } } }, async request =>
    recordBrowserEvent(db, config, request.body, await viewerId(request)));
  app.get('/api/apps/random', async (request) => {
    const search = z.object({ exclude: z.union([z.string().uuid(), z.array(z.string().uuid()).max(6)]).optional() }).parse(request.query);
    return service.random(typeof search.exclude === 'string' ? [search.exclude] : search.exclude, await viewerId(request));
  });
  app.get('/api/tags', async request => ({ tags: await service.tags(await viewerId(request)), maxTagsPerApp: 3 }));
  app.get('/api/apps/:id', async request => service.app(publicationId(request.params), { viewerId: await viewerId(request) }));
  app.get('/api/apps/:id/publish-contract', async (request) => {
    const id = publicationId(request.params);
    const actorId = await viewerId(request);
    if (config.tiangong) await requireAppAction(db, id, actorId);
    const current = await service.app(id, { viewerId: actorId, management: !!config.tiangong });
    return publishContract(config, current, await managed?.findByAppId(id), false, await service.tags());
  });
  app.get('/api/managed-apps/:id/status', (request) => {
    if (!managed) throw new DomainError(503, 'MANAGED_PUBLISH_DISABLED', '统一托管发布尚未配置，请联系广场维护者');
    const publishKey = z.string().min(43).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['x-plaza-publish-key']);
    return managed.current(publicationId(request.params), publishKey);
  });
  app.get('/api/apps/:id/instructions/:entryId', async request => {
    const params = request.params as any;
    return service.instructions(idValue.parse(params.id), z.string().min(1).max(64).parse(params.entryId), { viewerId: await viewerId(request) });
  });
  app.get('/api/apps/:id/packages/:assetId', async (request, reply) => {
    const params = request.params as any;
    const asset = await service.distributionPackage(idValue.parse(params.id), idValue.parse(params.assetId), await viewerId(request));
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="plaza-${asset.id}.zip"`)
      .header('Content-Length', asset.bytes.length).header('X-Content-SHA256', asset.sha256).send(asset.bytes);
  });
  app.post('/api/publications', async (request, reply) => {
    const token = request.headers['x-gitlab-token'];
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new DomainError(401, 'GITLAB_AUTH_REQUIRED', '作者 Agent 需要使用已有 GitLab 授权');
    }
    const key = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    const result = await service.submit(candidate.parse(request.body), token, key);
    return reply.code(201).send(await protectReceipt(result, request));
  });
  app.post('/api/managed-publications', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    if (!managed) throw new DomainError(503, 'MANAGED_PUBLISH_DISABLED', '统一托管发布尚未配置，请联系广场维护者');
    (request as any).managedRunning = true;
    try {
      const publishKey = z.string().min(43).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['x-plaza-publish-key']);
      const key = z.string().uuid().parse(request.headers['idempotency-key']);
      const result = await managed.submit(parseManagedCandidate(request.body), publishKey, key);
      return reply.code(201).send(await protectReceipt(result, request));
    } finally { releaseManagedSlot(request); }
  });
  app.post('/api/managed-publications/validate', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    if (!managed) throw new DomainError(503, 'MANAGED_PUBLISH_DISABLED', '统一托管发布尚未配置，请联系广场维护者');
    (request as any).managedRunning = true;
    try {
      const result = await managed.validate(parseManagedCandidate(request.body));
      return reply.code(200).send({ status: 'validated', published: false, sourceUploaded: false, ...result });
    } finally { releaseManagedSlot(request); }
  });
  app.get('/api/managed-publications/receipt', async (request) => {
    if (!managed) throw new DomainError(503, 'MANAGED_PUBLISH_DISABLED', '统一托管发布尚未配置，请联系广场维护者');
    const publishKey = z.string().min(43).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['x-plaza-publish-key']);
    const key = idValue.parse(request.headers['idempotency-key']);
    return protectReceipt(await managed.receipt(publishKey, key), request);
  });
  app.get('/api/publications/:id', async request => {
    const result = await service.publication(publicationId(request.params), ticket(request.headers.authorization), await viewerId(request));
    return config.analytics ? { ...result, analyticsEnabled: true } : result;
  });
  app.post('/api/publications/:id/confirm', async request => service.confirm(publicationId(request.params), ticket(request.headers.authorization), confirmation.parse(request.body), await publicationActor(request)));
  app.post('/api/publications/:id/retry', async request => service.retry(publicationId(request.params), ticket(request.headers.authorization), await publicationActor(request)));
  registerManagement(app, config, db, service, managed);
  if (!config.tiangong) registerPreviewAdmin(app, config, db);
  identity = await registerIdentity(app, config, db, service);
  if (identity) {
    registerApplicationAccess(app, db, config.audience, identity);
    registerOperationsDashboard(app, db, { analytics: config.analytics,
      authenticateAdministrator: async request => {
        const actor = await identity!.authenticate(request);
        await requireAdministrator(db, actor.id);
        return actor;
      },
      visibleAppIds: () => publicCatalogAppIds(db, config.audience) });
  }
  // API-only tests and local development must not depend on a prior frontend build.
  // Keep mounting/redirect routes registered and report missing assets at their entry point.
  const index = async (_request: FastifyRequest, reply: any) => {
    let html: string;
    try { html = await readFile(resolve(config.staticDir, 'index.html'), 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      throw new DomainError(503, 'FRONTEND_NOT_BUILT', '前端构建产物缺失，请先运行 npm run build');
    }
    return reply.type('text/html').header('Cache-Control', 'no-store')
      .send(html.replace('<head>', `<head><meta name="plaza-base-path" content="${basePath}">`));
  };
  app.get('/', index);
  app.get('/index.html', index);
  if (basePath) app.get('/__plaza_mount', (request, reply) => reply.redirect(`${basePath}/${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`));
  await app.register(staticPlugin, { root: config.staticDir, index: false, dotfiles: 'deny' });
  app.get('/admin', (request, reply) => { reply.header('X-Robots-Tag', 'noindex, nofollow'); return index(request, reply); });
  app.get('/admin/', (_request, reply) => reply.redirect(`${basePath}/admin`));
  app.get('/private-previews', (_request, reply) => reply.redirect(`${basePath}/admin`));
  app.get('/private-previews/', (_request, reply) => reply.redirect(`${basePath}/admin`));
  return { app, service, managed, identity };
}
