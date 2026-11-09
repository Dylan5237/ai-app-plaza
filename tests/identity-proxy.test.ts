import test from 'node:test';
import assert from 'node:assert/strict';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { createApp } from '../server/app.js';

test('Tiangong clients behind an explicitly trusted proxy have independent limits for public and protected requests', async t => {
  const h = await startIdentityHarness('/plaza', { rateLimit: true, trustedProxyIp: '127.0.0.1' });
  t.after(h.close);
  const request = (client: string, options: Record<string, any> = {}) => h.app.inject({
    url: '/plaza/api/health', remoteAddress: '::ffff:127.0.0.1', ...options,
    headers: h.headers({ 'x-real-ip': client, ...options.headers }),
  });
  for (let n = 0; n < 120; n++) assert.equal((await request('198.51.100.20')).statusCode, 200);
  const limited = await request('198.51.100.20');
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.equal((await request('198.51.100.21')).statusCode, 200, 'another user must not inherit the exhausted proxy bucket');
  const challenge = await request('198.51.100.21', { method: 'POST', url: '/plaza/api/auth/tiangong/requests', payload: {} });
  assert.equal(challenge.statusCode, 200);
  const exchange = await request('198.51.100.21', { method: 'POST', url: '/plaza/api/auth/tiangong/exchange',
    headers: { cookie: String(challenge.headers['set-cookie']).split(';')[0] },
    payload: { requestId: challenge.json().requestId, token: 'fixture-member' } });
  assert.equal(exchange.statusCode, 200);
  const favorites = await request('198.51.100.21', { url: '/plaza/api/personal/favorite-ids',
    headers: { cookie: String(exchange.headers['set-cookie']).split(';')[0], 'x-plaza-portal-token': 'fixture-member' } });
  assert.equal(favorites.statusCode, 200);
  assert.deepEqual(favorites.json().ids, []);
});

test('untrusted peers cannot reset their quota with forged client or forwarding headers', async t => {
  const h = await startIdentityHarness('/plaza', { rateLimit: true, trustedProxyIp: '127.0.0.1' });
  t.after(h.close);
  for (let n = 0; n < 120; n++) {
    const response = await h.app.inject({ url: '/plaza/api/health', remoteAddress: '198.51.100.40',
      headers: h.headers({ 'x-real-ip': `203.0.113.${n + 1}`, 'x-forwarded-for': `203.0.113.${n + 1}, 127.0.0.1` }) });
    assert.equal(response.statusCode, 200);
  }
  const spoofed = await h.app.inject({ url: '/plaza/api/health', remoteAddress: '198.51.100.40',
    headers: h.headers({ 'x-real-ip': '203.0.113.200', 'x-forwarded-for': '127.0.0.1' }) });
  assert.equal(spoofed.statusCode, 429);
  const deniedHeaders: Array<Record<string, string>> = [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }];
  for (const headers of deniedHeaders) {
    const response = await h.app.inject({ url: '/plaza/api/health', remoteAddress: '127.0.0.1',
      headers: h.headers({ 'x-real-ip': '198.51.100.41', 'x-forwarded-host': new URL(h.origin).host, 'x-forwarded-proto': 'https', ...headers }) });
    assert.equal(response.statusCode, 403, 'proxy rate keys must not replace Host/Origin validation');
  }
  await assert.rejects(createApp({ ...h.config, trustedProxyIp: 'localhost' }, h.db), /PLAZA_TRUSTED_PROXY_IP/);
});

test('missing, malformed and repeated proxy client headers retain the socket quota', async t => {
  const h = await startIdentityHarness('/plaza', { rateLimit: true, trustedProxyIp: '127.0.0.1' });
  t.after(h.close);
  const invalid: Array<Record<string, string | string[]>> = [{}, { 'x-real-ip': '' }, { 'x-real-ip': 'not-an-ip' },
    { 'x-real-ip': '198.51.100.50, 198.51.100.51' }, { 'x-real-ip': ['198.51.100.50', '198.51.100.50'] },
    { 'x-real-ip': 'fe80::1%eth0' }];
  for (let n = 0; n < 120; n++) {
    assert.equal((await h.app.inject({ url: '/plaza/api/health', remoteAddress: '127.0.0.1',
      headers: { ...h.headers(), ...invalid[n % invalid.length] } })).statusCode, 200);
  }
  assert.equal((await h.app.inject({ url: '/plaza/api/health', remoteAddress: '127.0.0.1', headers: h.headers() })).statusCode, 429);
  assert.equal((await h.app.inject({ url: '/plaza/api/health', remoteAddress: '127.0.0.1',
    headers: h.headers({ 'x-real-ip': '198.51.100.52' }) })).statusCode, 200, 'a valid client keeps its own quota');
});

test('identity mode never implicitly trusts forwarded headers without proxy configuration', async t => {
  const h = await startIdentityHarness('/plaza', { rateLimit: true });
  t.after(h.close);
  for (let n = 0; n < 120; n++) {
    assert.equal((await h.app.inject({ url: '/plaza/api/health', remoteAddress: '127.0.0.1',
      headers: h.headers({ 'x-real-ip': `203.0.113.${n + 1}` }) })).statusCode, 200);
  }
  assert.equal((await h.app.inject({ url: '/plaza/api/health', remoteAddress: '127.0.0.1',
    headers: h.headers({ 'x-real-ip': '203.0.113.200' }) })).statusCode, 429);
});

test('trusted IPv6 peers preserve client IPv6 /64 quotas and mapped IPv4 normalization', async t => {
  const h = await startIdentityHarness('/plaza', { rateLimit: true, trustedProxyIp: '::1' });
  t.after(h.close);
  const request = (client: string) => h.app.inject({ url: '/plaza/api/health', remoteAddress: '0:0:0:0:0:0:0:1',
    headers: h.headers({ 'x-real-ip': client }) });
  for (let n = 0; n < 120; n++) assert.equal((await request('2001:db8:1:2::1')).statusCode, 200);
  assert.equal((await request('2001:DB8:1:2::2')).statusCode, 429);
  assert.equal((await request('2001:db8:1:3::1')).statusCode, 200);
  for (let n = 0; n < 120; n++) assert.equal((await request('::ffff:198.51.100.60')).statusCode, 200);
  assert.equal((await request('198.51.100.60')).statusCode, 429);
});

test('proxied analytics quotas remain per client and cannot consume the business API quota', async t => {
  const h = await startIdentityHarness('/plaza', { rateLimit: true, trustedProxyIp: '127.0.0.1', analytics: true });
  t.after(h.close);
  const event = (client: string) => h.app.inject({ method: 'POST', url: '/plaza/api/analytics/events', remoteAddress: '127.0.0.1',
    headers: h.headers({ 'x-real-ip': client }), payload: {} });
  for (let n = 0; n < 240; n++) assert.equal((await event('198.51.100.70')).statusCode, 400);
  assert.equal((await event('198.51.100.70')).statusCode, 429);
  assert.equal((await event('198.51.100.71')).statusCode, 400, 'another client has not exhausted its event quota');
  assert.equal((await h.app.inject({ url: '/plaza/api/apps', remoteAddress: '127.0.0.1',
    headers: h.headers({ 'x-real-ip': '198.51.100.70' }) })).statusCode, 200);
});
