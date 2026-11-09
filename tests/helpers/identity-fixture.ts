import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/domain/database.js';
import { tiangongConfig } from '../../server/domain/tiangong-identity.js';
import { startGitLabFixture } from './gitlab-fixture.js';

export async function startIdentityHarness(basePath = '', options: { analytics?: boolean; rateLimit?: boolean; trustedProxyIp?: string } = {}) {
  const users: Record<string, any> = {
    'fixture-admin': { userId: '9223372036854775807', tenantId: null, userName: '测试名册管理员', account: 'fixture.admin', enabled: true, isAnonymous: false, userTypeCode: '03' },
    'fixture-member': { userId: '9223372036854775806', tenantId: '12', userName: '测试普通成员', account: 'fixture.member', enabled: true, isAnonymous: false, userTypeCode: '04' },
  };
  const portalState = { unavailable: false, redirect: false, calls: 0 };
  const portal = createServer(async (req, res) => {
    if (req.url !== '/findByToken' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    portalState.calls++;
    if (portalState.unavailable) { res.writeHead(503).end('fixture unavailable'); return; }
    if (portalState.redirect) { res.writeHead(302, { location: '/unexpected' }).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = users[JSON.parse(body).token] ?? null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Actual portal emits long numbers. Do not let fixture serialization hide precision loss.
    res.end(JSON.stringify({ code: '00000000', success: true, data }).replace(/"userId":"(\d+)"/, '"userId":$1'));
  });
  await new Promise<void>(done => portal.listen(0, '127.0.0.1', done));
  const tiangong = tiangongConfig({ TIANGONG_AUTH_ENABLED: 'true',
    TIANGONG_USERINFO_URL: `http://127.0.0.1:${(portal.address() as AddressInfo).port}/findByToken`,
    TIANGONG_SUCCESS_CODE: '00000000', TIANGONG_TOKEN_STORAGE_KEY: 'fixture-sky-token',
    PLAZA_IDENTITY_ADMIN_SUBJECTS: users['fixture-admin'].userId })!;
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  const gitlab = await startGitLabFixture();
  const db = await openDatabase({ path: 'memory://' });
  const origin = `http://127.0.0.1:${port}`;
  const config = { host: '127.0.0.1', port, publicOrigin: origin, gitlabUrl: gitlab.url,
    secret: 'fixture-only-identity-test-secret-0000', dataDir: '', local: true,
    audience: '所有能访问本门户的人', staticDir: resolve('dist'), rateLimit: options.rateLimit ?? false, tiangong, publicBasePath: basePath,
    ...(options.trustedProxyIp ? { trustedProxyIp: options.trustedProxyIp } : {}),
    ...(options.analytics ? { analytics: { environment: 'local' as const, siteInstanceId: 'identity-fixture' } } : {}) };
  const { app, service, identity } = await createApp(config, db);
  // Explicit test-only portal page, not a production route or authentication fallback.
  app.get('/fixture/portal', async (_request, reply) => reply.type('text/html').send(`<!doctype html><html lang="zh"><head><meta charset="UTF-8"><title>合成天宫测试门户</title></head><body>
    <h1>合成天宫测试门户</h1><p>仅用于本地身份与小组验证，不连接真实账号。</p>
    <button onclick="localStorage.setItem('fixture-sky-token','fixture-admin');location.href='${basePath}/'">以测试名册管理员进入</button>
    <button onclick="localStorage.setItem('fixture-sky-token','fixture-member');location.href='${basePath}/'">以测试普通成员进入</button>
    <button onclick="localStorage.removeItem('fixture-sky-token');location.href='${basePath}/'">以访客进入</button></body></html>`));
  await app.listen({ port, host: '127.0.0.1' });
  const headers = (extra: Record<string, string> = {}) => ({ host: new URL(origin).host, origin, ...extra });
  const login = async (token: string, session?: string, switchAccount = false) => {
    const challenge = await app.inject({ method: 'POST', url: `${basePath}/api/auth/tiangong/requests`, headers: headers(), payload: {} });
    const requestCookie = String(challenge.headers['set-cookie']).split(';')[0];
    const response = await app.inject({ method: 'POST', url: `${basePath}/api/auth/tiangong/exchange`, headers: headers({ cookie: `${requestCookie}${session ? `; ${session}` : ''}` }),
      payload: { requestId: challenge.json().requestId, token, switchAccount } });
    return { response, cookie: String(response.headers['set-cookie']).split(';')[0], user: response.json().user };
  };
  return { app, service, identity: identity!, db, gitlab, config, origin, users, portalState, headers, login,
    close: async () => { await app.close(); await db.close(); await gitlab.close(); await new Promise<void>(done => portal.close(() => done())); } };
}
