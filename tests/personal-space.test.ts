import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { createApp } from '../server/app.js';

test('favorites use the authenticated account, are idempotent and retain no inaccessible application metadata', async t => {
  const h = await startIdentityHarness('/plaza'); t.after(h.close);
  const admin = await h.login('fixture-admin'), member = await h.login('fixture-member');
  const first = await seedTagCatalog(h.db, h.config.audience, ['公开标签']);
  const otherAudience = await seedTagCatalog(h.db, '另一访问范围', ['不可泄露标签'], 2);
  const req = (method: any, path: string, who = member, token = 'fixture-member', payload?: Record<string, unknown>) =>
    h.app.inject({ method, url: `/plaza/api/personal/${path}`, headers: h.headers({ cookie: who.cookie, 'x-plaza-portal-token': token }), payload });
  const save = () => req('PUT', `favorites/${first.appId}`, member, 'fixture-member', { saved: true });
  assert.equal((await h.app.inject({ url: '/plaza/api/personal/favorites', headers: h.headers() })).statusCode, 401);
  assert.equal((await save()).statusCode, 200);
  assert.equal((await save()).statusCode, 200);
  assert.deepEqual((await req('GET', 'favorite-ids')).json().ids, [first.appId]);
  assert.deepEqual((await req('GET', 'favorite-ids', admin, 'fixture-admin')).json().ids, []);
  assert.equal((await req('PUT', `favorites/${otherAudience.appId}`, member, 'fixture-member', { saved: true })).statusCode, 404);
  assert.equal((await req('PUT', `favorites/${first.appId}`, member, 'fixture-member', { saved: true, userId: admin.user.id })).statusCode, 400);
  const list = await req('GET', 'favorites');
  assert.equal(list.json().total, 1); assert.equal(list.json().items[0].app.id, first.appId);
  assert.equal(list.json().items[0].app.documents, undefined);
  await h.service.changeLifecycle(first.appId, 'offline', 1, 1);
  const unavailable = await req('GET', 'favorites');
  assert.deepEqual(unavailable.json().items, [{ id: first.appId, app: null }]);
  assert.ok(!unavailable.body.includes(first.source.name));
  assert.ok(!unavailable.body.includes('公开标签'));
  assert.equal((await save()).statusCode, 404);
  assert.equal((await req('PUT', `favorites/${first.appId}`, member, 'fixture-member', { saved: false })).statusCode, 200);
  assert.equal((await req('PUT', `favorites/${first.appId}`, member, 'fixture-member', { saved: false })).statusCode, 200);
  assert.equal((await req('GET', 'favorites')).json().total, 0);
  assert.equal((await h.db.query('SELECT count(*) AS n FROM analytics_events')).rows[0].n, 0, 'favorites are not usage events');
});

test('favorite writes reject cross-site requests, stopped identities and account switching without changing saved data', async t => {
  const h = await startIdentityHarness(); t.after(h.close);
  const member = await h.login('fixture-member');
  const first = await seedTagCatalog(h.db, h.config.audience, ['公开标签']);
  const write = (extra: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url: `/api/personal/favorites/${first.appId}`,
    headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member', ...extra }), payload: { saved: true } });
  assert.equal((await write({ origin: 'https://attacker.invalid' })).statusCode, 403);
  assert.equal((await write({ 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal((await write({ 'x-plaza-portal-token': 'fixture-admin' })).statusCode, 409);
  h.portalState.unavailable = true;
  assert.equal((await write()).statusCode, 503);
  h.portalState.unavailable = false; h.users['fixture-member'].enabled = false;
  assert.equal((await write()).statusCode, 401);
  assert.equal((await h.db.query('SELECT count(*) AS n FROM plaza_favorites')).rows[0].n, 0);
});

test('same-origin mounting preserves query links and isolates Secure cookies from other Plaza environments', async t => {
  const h = await startIdentityHarness('/plaza'); t.after(h.close);
  const appId = randomUUID();
  const redirect = await h.app.inject({ url: `/plaza?app=${appId}`, headers: h.headers() });
  assert.equal(redirect.headers.location, `/plaza/?app=${appId}`);
  const secure = await createApp({ ...h.config, publicOrigin: 'https://portal.example.invalid' }, h.db);
  t.after(() => secure.app.close());
  const challenge = await secure.app.inject({ method: 'POST', url: '/plaza/api/auth/tiangong/requests',
    headers: { host: 'portal.example.invalid', origin: 'https://portal.example.invalid' }, payload: {} });
  assert.equal(challenge.statusCode, 200);
  const secureCookie = String(challenge.headers['set-cookie']);
  assert.match(secureCookie, /^__Secure-plaza_request_/);
  assert.match(secureCookie, /; Secure$/);
  assert.match(secureCookie, /; HttpOnly; SameSite=Strict;/);
  const plain = await h.app.inject({ method: 'POST', url: '/plaza/api/auth/tiangong/requests', headers: h.headers(), payload: {} });
  assert.notEqual(secureCookie.split('=')[0], String(plain.headers['set-cookie']).split('=')[0]);
});
