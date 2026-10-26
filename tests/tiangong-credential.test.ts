import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { requestPortalCredential } from '../src/lib/tiangong-credential.js';
import { loadFuxiTestProfile } from '../server/fuxi-entry.js';
import { startHarness } from './helpers/harness.js';

const { createPortalTestBridge } = await import(pathToFileURL(resolve('ops/integration/tiangong-test/fuxi-entry-test-bridge.js')).href);
const portalOrigin = 'https://portal.example.invalid';
const plazaOrigin = 'http://127.0.0.1:4567';
const requestId = 'a'.repeat(64);

function portalHarness(token: string | null = 'fixture-only-token') {
  const events = new Map<string, Set<Function>>();
  const timers = new Map<number, Function>();
  const clicks = new Set<Function>();
  const sent: any[] = [], opened: string[] = [];
  let reads = 0, next = 0;
  const child = { closed: false, postMessage: (data: unknown, origin: string) => sent.push({ data, origin }) };
  const button = { disabled: true, addEventListener: (_: string, fn: Function) => clicks.add(fn), removeEventListener: (_: string, fn: Function) => clicks.delete(fn) };
  const status = { textContent: '' };
  const host = {
    location: { origin: portalOrigin }, document: { getElementById: (id: string) => id === 'open-test' ? button : status },
    localStorage: { getItem: (key: string) => { reads++; assert.equal(key, 'sky-token'); return token; } },
    open: (url: string) => { opened.push(url); return child; },
    addEventListener: (type: string, fn: Function) => { if (!events.has(type)) events.set(type, new Set()); events.get(type)!.add(fn); },
    removeEventListener: (type: string, fn: Function) => events.get(type)?.delete(fn),
    setTimeout: (fn: Function) => { timers.set(++next, fn); return next; }, clearTimeout: (id: number) => timers.delete(id),
  };
  const emit = (override: Record<string, unknown> = {}) => {
    const event = { origin: plazaOrigin, source: child, data: { type: 'plaza:tiangong:credential-request', requestId, purpose: 'fuxi-test' }, ...override };
    for (const fn of [...events.get('message') || []]) fn(event);
  };
  const open = () => { for (const fn of clicks) fn(); };
  return { host, emit, open, child, sent, opened, timers, button, status, get reads() { return reads; } };
}

test('portal page grants only its clicked window and consumes before one raw-token read/send', () => {
  const h = portalHarness();
  const bridge = createPortalTestBridge(h.host, { portalOrigin, plazaOrigin, credentialKey: 'sky-token', ttlMs: 120_000 });
  assert.equal(h.reads, 0);
  h.emit(); assert.equal(h.sent.length, 0);
  h.open(); assert.equal(h.reads, 0);
  assert.deepEqual(h.opened, [`${plazaOrigin}/integration/fuxi-test`]);
  h.emit({ source: {} }); h.emit({ origin: 'https://wrong.invalid' });
  h.emit({ data: { type: 'plaza:tiangong:credential-request', requestId, purpose: 'another-app' } });
  h.emit({ data: { type: 'plaza:tiangong:credential-request', requestId: '', purpose: 'fuxi-test' } });
  assert.equal(h.reads, 0);
  h.emit(); h.emit();
  assert.equal(h.reads, 1);
  assert.deepEqual(h.sent, [{ data: { type: 'plaza:tiangong:credential-result', requestId, token: 'fixture-only-token' }, origin: plazaOrigin }]);
  assert.equal(h.timers.size, 0);
  bridge.dispose();
});

test('portal wrong context, expired/closed windows and absent/oversized credentials fail closed', () => {
  const wrong = portalHarness();
  wrong.host.location.origin = 'https://wrong.invalid';
  createPortalTestBridge(wrong.host, { portalOrigin, plazaOrigin, credentialKey: 'sky-token', ttlMs: 120_000 });
  wrong.open(); wrong.emit();
  assert.equal(wrong.button.disabled, true); assert.equal(wrong.reads, 0);
  for (const scenario of ['expired', 'closed']) {
    const h = portalHarness();
    createPortalTestBridge(h.host, { portalOrigin, plazaOrigin, credentialKey: 'sky-token', ttlMs: 120_000 }); h.open();
    if (scenario === 'expired') [...h.timers.values()][0](); else h.child.closed = true;
    h.emit(); assert.equal(h.reads, 0); assert.equal(h.sent.length, 0);
  }
  for (const token of [null, '', ' x ', 'x'.repeat(8193), 'x\ncredential']) {
    const h = portalHarness(token);
    createPortalTestBridge(h.host, { portalOrigin, plazaOrigin, credentialKey: 'sky-token', ttlMs: 120_000 }); h.open(); h.emit(); h.emit();
    assert.equal(h.reads, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].data.error, 'NO_PORTAL_CREDENTIAL'); assert.equal('token' in h.sent[0].data, false);
  }
});

function receiverHarness() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const timers = new Map<number, Function>();
  const requests: any[] = [];
  const opener = { closed: false, postMessage: (data: unknown, origin: string) => requests.push({ data, origin }) };
  const host = {
    opener, crypto: webcrypto,
    addEventListener: (_: string, fn: any) => listeners.add(fn), removeEventListener: (_: string, fn: any) => listeners.delete(fn),
    setTimeout: (fn: Function) => { timers.set(1, fn); return 1; }, clearTimeout: (id: number) => timers.delete(id),
  } as unknown as Window;
  const emit = (override: Record<string, unknown> = {}) => {
    const event = { source: opener, origin: portalOrigin,
      data: { type: 'plaza:tiangong:credential-result', requestId: requests[0]?.data.requestId, token: 'fixture-only-token' }, ...override } as unknown as MessageEvent;
    for (const fn of [...listeners]) fn(event);
  };
  return { host, emit, opener, requests, timers, listeners };
}

test('receiver pins original opener/origin and random correlation; wrong/replayed messages cannot complete', async () => {
  const h = receiverHarness();
  const controller = new AbortController();
  const result = requestPortalCredential(h.host, portalOrigin, controller.signal);
  assert.equal(h.requests[0].origin, portalOrigin);
  assert.match(h.requests[0].data.requestId, /^[0-9a-f]{64}$/);
  assert.equal(h.requests[0].data.purpose, 'fuxi-test');
  h.emit({ source: {} }); h.emit({ origin: 'https://wrong.invalid' });
  h.emit({ data: { type: 'plaza:tiangong:credential-result', requestId, token: 'forged' } });
  assert.equal(h.listeners.size, 1);
  h.emit(); assert.equal(await result, 'fixture-only-token'); h.emit();
  assert.equal(h.listeners.size + h.timers.size, 0);
});

test('receiver error, timeout, cancellation and missing opener release listeners without fallback', async () => {
  for (const mode of ['error', 'timeout', 'cancel', 'missing']) {
    const h = receiverHarness();
    if (mode === 'missing') Object.assign(h.host, { opener: null });
    const controller = new AbortController();
    const pending = requestPortalCredential(h.host, portalOrigin, controller.signal);
    const rejected = assert.rejects(pending, /未取得本次天宫凭证/);
    if (mode === 'error') h.emit({ data: { type: 'plaza:tiangong:credential-result', requestId: h.requests[0].data.requestId, error: 'NO_PORTAL_CREDENTIAL' } });
    if (mode === 'timeout') [...h.timers.values()][0]();
    if (mode === 'cancel') controller.abort();
    await rejected;
    assert.equal(h.listeners.size + h.timers.size, 0);
  }
});

test('test profile is independent, explicitly configured and cannot target 16088 or production loopback', () => {
  const context = { local: false, publicOrigin: 'http://192.168.2.145:16090' };
  const env = { PLAZA_FUXI_TEST_ENABLED: '1', PLAZA_FUXI_TEST_ORIGIN: 'http://192.168.2.145:16077',
    PLAZA_FUXI_TEST_PORTAL_ORIGIN: 'https://192.168.5.143:17090', PLAZA_FUXI_TEST_ALLOW_INTRANET_HTTP: '1' };
  assert.deepEqual(loadFuxiTestProfile({}, context), { enabled: false, plazaOrigin: context.publicOrigin });
  assert.equal(loadFuxiTestProfile(env, context).enabled, true);
  for (const change of [{ PLAZA_FUXI_TEST_ENABLED: 'true' }, { PLAZA_FUXI_TEST_ALLOW_INTRANET_HTTP: '0' },
    { PLAZA_FUXI_TEST_ORIGIN: 'http://192.168.2.145:16088' }, { PLAZA_FUXI_TEST_ORIGIN: 'http://127.0.0.1:16077' },
    { PLAZA_FUXI_TEST_ORIGIN: 'http://0xc0a80291:16077' }, { PLAZA_FUXI_TEST_ORIGIN: 'https://wrong.invalid:16077' },
    { PLAZA_FUXI_TEST_PORTAL_ORIGIN: 'https://portal.invalid/path' }, { PLAZA_FUXI_TEST_PORTAL_ORIGIN: undefined }]) {
    assert.throws(() => loadFuxiTestProfile({ ...env, ...change }, context), /配置无效/);
  }
});

test('new test config endpoint leaves normal catalog policy untouched and retains request defenses', async () => {
  const h = await startHarness();
  try {
    const get = (url: string, headers = {}) => h.app.inject({ url, headers: { host: new URL(h.origin).host, ...headers } });
    assert.equal((await get('/api/integration/fuxi-test/config')).json().enabled, false);
    h.config.fuxiTest = { enabled: true, plazaOrigin: h.origin, fuxiOrigin: 'http://127.0.0.1:1234', portalOrigin };
    assert.equal((await get('/api/integration/fuxi-test/config')).json().fuxiOrigin, 'http://127.0.0.1:1234');
    assert.deepEqual((await get('/api/entry-policies')).json(), { policies: [] });
    assert.equal((await get('/api/integration/fuxi-test/config', { origin: 'https://wrong.invalid' })).statusCode, 403);
    assert.equal((await get('/api/integration/fuxi-test/config', { host: 'wrong.invalid' })).statusCode, 403);
  } finally { await h.close(); }
});
