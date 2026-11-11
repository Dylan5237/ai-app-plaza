import test from 'node:test';
import assert from 'node:assert/strict';

test('package download invalidates identity only on confirmed identity errors below 500', async t => {
  const events = new EventTarget();
  let invalidations = 0;
  events.addEventListener('plaza-identity-invalid', () => invalidations++);
  const globals = globalThis as any;
  const previous = Object.fromEntries(['window', 'document', 'location', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(globals, key, descriptor) : delete globals[key]; });
  globals.window = { localStorage: { getItem: () => 'fixture-token' }, dispatchEvent: events.dispatchEvent.bind(events) };
  globals.document = { querySelector: () => null };
  globals.location = new URL('https://plaza.example/');
  const modulePath = '../src/lib/api.js';
  const api = await import(modulePath);
  api.configurePortalIdentity('fixture-token-key');
  api.configureWebIdentity(true);
  for (const [status, code, expected] of [[503, 'IDENTITY_UNAVAILABLE', 0], [503, 'LOGIN_REQUIRED', 0], [401, 'PORTAL_IDENTITY_INVALID', 1]] as const) {
    globals.fetch = async () => new Response(JSON.stringify({ error: { code, message: 'fixture download failure' } }), { status, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(api.downloadPackage('/api/apps/fixture/packages/fixture'), { status, code });
    assert.equal(invalidations, expected);
  }
});
