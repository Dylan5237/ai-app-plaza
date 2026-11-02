import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { openDatabase } from '../server/domain/database.js';
import { loadFuxiEntryPolicy } from '../server/fuxi-entry.js';

const primary = 'http://127.0.0.1:4173';
const secure = 'https://127.0.0.1:44173';
async function fixture(rateLimit = false) {
  const db = await openDatabase({ path: 'memory://' });
  const config: Config = { host: '127.0.0.1', port: 4173, publicOrigin: primary, httpsOrigin: secure,
    gitlabUrl: 'https://gitlab.example.invalid', secret: 'synthetic-https-ingress-test-secret-only',
    dataDir: '', local: true, audience: 'fixture audience', staticDir: resolve('dist'), rateLimit };
  config.fuxiEntry = loadFuxiEntryPolicy({ PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: '7e17af1b-23d2-4a10-a8d5-32dd0ae51bef',
    PLAZA_FUXI_ENTRY_ID: 'web', PLAZA_FUXI_MODE: 'portal-widget', PLAZA_FUXI_ORIGIN: 'https://127.0.0.1:44188',
    PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/web/design-portal-web/fuxi-portal-widget.html' }, { local: true, publicOrigin: secure });
  const { app } = await createApp(config, db);
  await app.ready();
  return { app, config, close: async () => { await app.close(); await db.close(); } };
}
const tlsHeaders = (client = '198.51.100.20') => ({ host: '127.0.0.1:44173', origin: secure, 'x-real-ip': client });
const plainHeaders = { host: '127.0.0.1:4173', origin: primary };

test('legacy HTTP and the trusted HTTPS ingress share business APIs while retaining canonical publication URLs', async t => {
  const f = await fixture(); t.after(f.close);
  const http = await f.app.inject({ url: '/api/publish-contract', headers: plainHeaders, remoteAddress: '198.51.100.20' });
  const https = await f.app.inject({ url: '/api/publish-contract', headers: tlsHeaders(), remoteAddress: '127.0.0.1' });
  assert.equal(http.statusCode, 200); assert.equal(https.statusCode, 200);
  assert.deepEqual(https.json(), http.json());
  assert.equal(https.json().submitUrl, `${primary}/api/publications`);
  assert(https.json().prompt.includes(primary));
  assert(!https.json().prompt.includes(secure));
  const noOrigin = await f.app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4173' }, remoteAddress: '198.51.100.20' });
  assert.equal(noOrigin.statusCode, 200, 'existing non-browser clients need no Origin header');
});

test('HTTPS ingress rejects external connections, missing or invalid client IP, wrong Host and crossed Origin', async t => {
  const f = await fixture(); t.after(f.close);
  const denied = [
    { headers: tlsHeaders(), remoteAddress: '198.51.100.20' },
    { headers: { host: '127.0.0.1:44173', origin: secure }, remoteAddress: '127.0.0.1' },
    { headers: { ...tlsHeaders(), 'x-real-ip': '198.51.100.20, 198.51.100.21' }, remoteAddress: '127.0.0.1' },
    { headers: { ...tlsHeaders(), 'x-real-ip': 'fe80::1%eth0' }, remoteAddress: '127.0.0.1' },
    { headers: { ...tlsHeaders(), host: 'untrusted.invalid:44173' }, remoteAddress: '127.0.0.1' },
    { headers: { ...tlsHeaders(), origin: primary }, remoteAddress: '127.0.0.1' },
    { headers: { ...plainHeaders, origin: secure }, remoteAddress: '127.0.0.1' },
    { headers: { ...tlsHeaders(), origin: 'https://attacker.invalid', 'x-forwarded-host': '127.0.0.1:44173', 'x-forwarded-proto': 'https' }, remoteAddress: '127.0.0.1' },
  ];
  for (const request of denied) {
    const response = await f.app.inject({ url: '/api/entry-policies', ...request });
    assert.equal(response.statusCode, 403);
    assert(!response.body.includes('portal.example.invalid'));
  }
  const forged = await f.app.inject({ url: '/api/entry-policies', headers: { ...tlsHeaders(), 'x-forwarded-for': '127.0.0.1' }, remoteAddress: '198.51.100.20' });
  assert.equal(forged.statusCode, 403, 'forwarded headers do not turn a public connection into the trusted gateway');
});

test('only HTTPS returns the widget policy, freshly reflects its switch, and keeps HTTP test configuration separate', async t => {
  const f = await fixture(); t.after(f.close);
  const http = await f.app.inject({ url: '/api/entry-policies', headers: plainHeaders, remoteAddress: '198.51.100.20' });
  assert.deepEqual(http.json(), { policies: [] });
  const enabled = await f.app.inject({ url: '/api/entry-policies', headers: tlsHeaders(), remoteAddress: '127.0.0.1' });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().policies[0].plazaOrigin, secure);
  assert.equal(enabled.json().policies[0].enabled, true);
  assert.equal(enabled.headers['cache-control'], 'no-store');
  f.config.fuxiEntry = { ...f.config.fuxiEntry!, enabled: false };
  const disabled = await f.app.inject({ url: '/api/entry-policies', headers: tlsHeaders(), remoteAddress: '127.0.0.1' });
  assert.equal(disabled.json().policies[0].enabled, false);
  f.config.fuxiTest = { enabled: true, plazaOrigin: primary, portalOrigin: 'https://portal.example.invalid', fuxiOrigin: 'http://127.0.0.1:16077' };
  const legacyTest = await f.app.inject({ url: '/api/integration/fuxi-test/config', headers: plainHeaders });
  assert.equal(legacyTest.json().enabled, true);
  const secureTest = await f.app.inject({ url: '/api/integration/fuxi-test/config', headers: tlsHeaders(), remoteAddress: '127.0.0.1' });
  assert.deepEqual(secureTest.json(), { enabled: false, plazaOrigin: secure });
});

test('gateway clients keep independent limits; original HTTP clients cannot spoof a new bucket', async t => {
  const f = await fixture(true); t.after(f.close);
  for (let n = 0; n < 120; n++) {
    const response = await f.app.inject({ url: '/api/health', headers: tlsHeaders(), remoteAddress: '127.0.0.1' });
    assert.equal(response.statusCode, 200);
  }
  assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders(), remoteAddress: '127.0.0.1' })).statusCode, 429);
  assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders('198.51.100.21'), remoteAddress: '127.0.0.1' })).statusCode, 200);
  const spoof = await f.app.inject({ url: '/api/health', headers: { ...plainHeaders, 'x-real-ip': '198.51.100.99', 'x-forwarded-for': '198.51.100.99' }, remoteAddress: '198.51.100.20' });
  assert.equal(spoof.statusCode, 429, 'HTTP retains the actual connection identity and shares the existing client limit');
});

test('HTTPS client limits retain IPv6 /64 grouping and IPv4-mapped address normalization', async t => {
  const f = await fixture(true); t.after(f.close);
  for (let n = 0; n < 120; n++) {
    assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders('2001:db8:1:2::1'), remoteAddress: '127.0.0.1' })).statusCode, 200);
  }
  assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders('2001:db8:1:2::2'), remoteAddress: '127.0.0.1' })).statusCode, 429);
  assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders('2001:db8:1:3::1'), remoteAddress: '127.0.0.1' })).statusCode, 200);
  for (let n = 0; n < 120; n++) {
    assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders('::ffff:198.51.100.25'), remoteAddress: '127.0.0.1' })).statusCode, 200);
  }
  assert.equal((await f.app.inject({ url: '/api/health', headers: tlsHeaders('198.51.100.25'), remoteAddress: '127.0.0.1' })).statusCode, 429);
});
