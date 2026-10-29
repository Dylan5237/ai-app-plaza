import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFuxiEntryPolicy } from '../server/fuxi-entry.js';
import { sameEntryPolicy } from '../src/lib/fuxi-entry.js';
import { createFuxiWidgetResponder } from '../src/lib/fuxi-widget.js';

const appId = '84c2f57f-c0f9-40ee-a8b8-8ff981d3041e';
const context = { local: false, publicOrigin: 'https://plaza.example.invalid' };
const env = {
  PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: appId, PLAZA_FUXI_ENTRY_ID: 'web',
  PLAZA_FUXI_ORIGIN: 'https://fuxi.example.invalid', PLAZA_FUXI_MODE: 'portal-widget',
  PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/assets/fuxi-portal-widget.html',
};
const policy = loadFuxiEntryPolicy(env, context)!;

test('widget policy is explicit, carries no credential and binds exact deployed origins', () => {
  assert.deepEqual(policy, { appId, entryId: 'web', enabled: true, plazaOrigin: context.publicOrigin,
    fuxiOrigin: 'https://fuxi.example.invalid', mode: 'portal-widget',
    widget: { url: env.PLAZA_FUXI_WIDGET_URL, portalOrigin: 'https://portal.example.invalid' } });
  assert.deepEqual(loadFuxiEntryPolicy({ ...env, PLAZA_FUXI_ENABLED: '0' }, context),
    { appId, entryId: 'web', plazaOrigin: context.publicOrigin, enabled: false });
  assert.equal(sameEntryPolicy(policy, policy), true);
  assert.equal(sameEntryPolicy(policy, { ...policy, enabled: false }), false);
  assert.equal(sameEntryPolicy(policy, { ...policy, widget: { ...policy.widget!, url: 'https://portal.example.invalid/other' } }), false);
  assert.equal(sameEntryPolicy(policy, { ...policy, fuxiOrigin: 'https://other.invalid' }), false);
});

test('widget configuration rejects insecure, ambiguous or non-fixed targets', () => {
  for (const override of [
    { PLAZA_FUXI_MODE: 'wrong' },
    { PLAZA_FUXI_WIDGET_URL: '' },
    { PLAZA_FUXI_WIDGET_URL: 'http://portal.example.invalid/fuxi-portal-widget.html' },
    { PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/other.html' },
    { PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/fuxi-portal-widget.html?target=evil' },
    { PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/fuxi-portal-widget.html?' },
    { PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/fuxi-portal-widget.html#' },
    { PLAZA_FUXI_WIDGET_URL: 'https://user:secret@portal.example.invalid/fuxi-portal-widget.html' },
    { PLAZA_FUXI_WIDGET_URL: 'http://127.0.0.1/fuxi-portal-widget.html' },
    { PLAZA_FUXI_CREDENTIAL_KEY: 'token' },
    { PLAZA_FUXI_CREDENTIAL_STORAGE: 'localStorage' },
    { PLAZA_FUXI_MODE: 'storage' },
  ]) assert.throws(() => loadFuxiEntryPolicy({ ...env, ...override }, context), /配置无效/);
  assert.throws(() => loadFuxiEntryPolicy(env, { ...context, publicOrigin: 'http://192.168.2.145:16090' }), /配置无效/);
  assert.ok(loadFuxiEntryPolicy({ ...env, PLAZA_FUXI_WIDGET_URL: 'http://127.0.0.1:3000/fuxi-portal-widget.html' },
    { local: true, publicOrigin: 'http://127.0.0.1:3001' }));
});

function browser() {
  const listeners = new Set<(event: MessageEvent) => Promise<void>>();
  const sends: Array<{ data: any; origin: string }> = [];
  const frame = { postMessage: (data: unknown, origin: string) => sends.push({ data, origin }) } as unknown as Window;
  let currentFrame: Window | null = frame;
  const host = {
    location: { origin: context.publicOrigin },
    addEventListener: (_type: string, listener: (event: MessageEvent) => Promise<void>) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MessageEvent) => Promise<void>) => listeners.delete(listener),
  } as unknown as Window;
  const event = (override: Record<string, unknown> = {}) => ({
    isTrusted: true, source: frame, origin: policy.widget!.portalOrigin,
    data: { type: 'fuxi:widget:policy-request', requestId: 'a'.repeat(64), appId, entryId: 'web' }, ...override,
  }) as MessageEvent;
  const fire = async (override: Record<string, unknown> = {}) => {
    await Promise.all([...listeners].map(listener => listener(event(override))));
  };
  return { host, frame, sends, listeners, fire, getFrame: () => currentFrame, detach: () => { currentFrame = null; } };
}

test('only the mounted portal frame with a valid request receives one rechecked result', async () => {
  const b = browser(); let checks = 0;
  const responder = createFuxiWidgetResponder(b.host, policy, b.getFrame, async () => { checks++; return true; });
  await b.fire({ isTrusted: false });
  await b.fire({ source: {} });
  await b.fire({ origin: 'https://other.invalid' });
  for (const data of [null, {}, { type: 'fuxi:widget:policy-request', requestId: 'x', appId, entryId: 'web' },
    { type: 'fuxi:widget:policy-request', requestId: 'a'.repeat(64), appId: 'other', entryId: 'web' },
    { type: 'fuxi:widget:policy-request', requestId: 'a'.repeat(64), appId, entryId: 'other' }]) await b.fire({ data });
  assert.equal(checks, 0);
  await b.fire(); await b.fire();
  assert.equal(checks, 1);
  assert.deepEqual(b.sends, [{ origin: policy.widget!.portalOrigin, data: {
    type: 'fuxi:widget:policy-result', requestId: 'a'.repeat(64), enabled: true,
    appId, entryId: 'web', portalOrigin: policy.widget!.portalOrigin, fuxiOrigin: policy.fuxiOrigin,
  } }]);
  responder.dispose();
  assert.equal(b.listeners.size, 0);
});

test('disabled policy, failed recheck, unmount and frame replacement cannot approve handoff', async () => {
  for (const confirm of [async () => false, async () => { throw new Error('synthetic'); }]) {
    const b = browser();
    const responder = createFuxiWidgetResponder(b.host, policy, b.getFrame, confirm);
    await b.fire();
    assert.equal(b.sends.length, 1);
    assert.equal(b.sends[0].data.enabled, false);
    responder.dispose();
  }
  for (const change of ['dispose', 'detach']) {
    const b = browser(); let resolve!: (value: boolean) => void;
    const responder = createFuxiWidgetResponder(b.host, policy, b.getFrame, () => new Promise(r => { resolve = r; }));
    const pending = b.fire();
    if (change === 'dispose') responder.dispose(); else b.detach();
    resolve(true); await pending;
    assert.equal(b.sends.length, 0);
    responder.dispose();
  }
  const b = browser();
  const responder = createFuxiWidgetResponder(b.host, { ...policy, enabled: false }, b.getFrame, async () => true);
  await b.fire(); assert.equal(b.sends.length, 0); responder.dispose();
});

test('status messages accept only known codes from the mounted portal frame', async () => {
  const b = browser(); const statuses: string[] = [];
  const responder = createFuxiWidgetResponder(b.host, policy, b.getFrame, async () => true, code => statuses.push(code));
  const data = { type: 'fuxi:widget:status', code: 'STORAGE_DENIED' };
  await b.fire({ data, origin: 'https://other.invalid' });
  await b.fire({ data, source: {} });
  await b.fire({ data: { ...data, code: '<img src=x>' } });
  await b.fire({ data });
  assert.deepEqual(statuses, ['STORAGE_DENIED']);
  assert.equal(b.sends.length, 0);
  responder.dispose();
});

const portalProfile = {
  portalOrigin: 'https://portal.example.invalid', plazaOrigin: 'https://plaza.example.invalid',
  fuxiOrigin: 'https://fuxi.example.invalid', policyUrl: 'https://portal.example.invalid/widget/fuxi-widget-test-policy.json',
  appId, entryId: 'web', credentialKey: 'sky-token', ttlMs: 10_000,
};

async function portalFixture() {
  // The portal asset is deliberately plain JavaScript for independent hosting.
  const { startPortalWidget } = await import(new URL('../ops/integration/tiangong-widget/fuxi-portal-widget.js', import.meta.url).href);
  const events = new Map<string, (event?: any) => any>();
  const buttonEvents = new Map<string, (event: any) => any>();
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const parentMessages: any[] = [], childMessages: any[] = [];
  const state = { reads: 0, opens: 0, accesses: 0, policyEnabled: true, policyFuxi: portalProfile.fuxiOrigin };
  let timerId = 0;
  const child = { closed: false, close() { this.closed = true; }, postMessage(data: any, target: string) { childMessages.push({ data, target }); } };
  const parent = { postMessage(data: any, target: string) { parentMessages.push({ data, target }); } };
  const button = { disabled: true, textContent: '', addEventListener(type: string, fn: (event: any) => any) { buttonEvents.set(type, fn); },
    removeEventListener(type: string) { buttonEvents.delete(type); } };
  const status = { textContent: '' };
  const storage = { getItem(key: string) { assert.equal(key, 'sky-token'); state.reads++; return 'synthetic-portal-credential'; } };
  const host: any = {
    parent, top: {}, isSecureContext: true, location: { origin: portalProfile.portalOrigin },
    document: { getElementById: (id: string) => id === 'open-fuxi' ? button : status,
      requestStorageAccess: async (options: unknown) => { assert.deepEqual(options, { localStorage: true }); state.accesses++; return { localStorage: storage }; } },
    navigator: { userActivation: { isActive: true } },
    crypto: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(0x42); return bytes; } },
    fetch: async (url: string, options: any) => {
      assert.equal(url, portalProfile.policyUrl); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ enabled: state.policyEnabled, portalOrigin: portalProfile.portalOrigin,
        plazaOrigin: portalProfile.plazaOrigin, fuxiOrigin: state.policyFuxi, appId, entryId: 'web' }) };
    },
    open: (url: string, target: string) => { assert.equal(url, `${portalProfile.fuxiOrigin}/auth/tiangong`); assert.equal(target, '_blank'); state.opens++; return child; },
    addEventListener: (type: string, fn: (event?: any) => any) => events.set(type, fn),
    removeEventListener: (type: string) => events.delete(type),
    setTimeout: (fn: () => void, delay: number) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  startPortalWidget(host, portalProfile);
  const click = async (trusted: boolean) => buttonEvents.get('click')?.({ isTrusted: trusted });
  const message = async (data: any, overrides: Record<string, unknown> = {}) => events.get('message')?.({
    isTrusted: true, source: child, origin: portalProfile.fuxiOrigin, data, ...overrides,
  });
  const request = () => parentMessages.find(item => item.data.type === 'fuxi:widget:policy-request')?.data;
  const answer = () => ({ type: 'fuxi:widget:policy-result', requestId: request()?.requestId, enabled: true,
    appId, entryId: 'web', portalOrigin: portalProfile.portalOrigin, fuxiOrigin: portalProfile.fuxiOrigin });
  return { host, state, child, parent, storage, button, status, events, timers, parentMessages, childMessages, click, message, request, answer };
}

test('portal requires an activated click and exact child, parent and nonce; replay sends only once', async () => {
  const x = await portalFixture();
  await x.click(false);
  x.host.navigator.userActivation.isActive = false; await x.click(true);
  assert.equal(x.state.opens, 0); assert.equal(x.state.accesses, 0); assert.equal(x.state.reads, 0);
  assert.equal(x.parentMessages.at(-1)?.data.code, 'REQUEST_EXPIRED');
  x.host.navigator.userActivation.isActive = true; await x.click(true);
  assert.equal(x.state.opens, 1); assert.equal(x.state.reads, 0);
  const ready = { type: 'fuxi:tiangong:ready', requestId: 'fuxi-request' };
  await x.message(ready, { isTrusted: false }); await x.message(ready, { source: {} });
  await x.message(ready, { origin: 'https://other.invalid' }); await x.message({ ...ready, requestId: '' });
  assert.equal(x.request(), undefined);
  await x.message(ready); await x.message(ready);
  assert.equal(x.request().requestId, '42'.repeat(32));
  await x.message(x.answer(), { source: {}, origin: portalProfile.plazaOrigin });
  await x.message(x.answer(), { source: x.parent, origin: 'https://other.invalid' });
  await x.message({ ...x.answer(), requestId: '0'.repeat(64) }, { source: x.parent, origin: portalProfile.plazaOrigin });
  assert.equal(x.state.reads, 0);
  await x.message(x.answer(), { source: x.parent, origin: portalProfile.plazaOrigin });
  await x.message(x.answer(), { source: x.parent, origin: portalProfile.plazaOrigin });
  assert.equal(x.state.reads, 1); assert.equal(x.childMessages.length, 1);
  assert.equal(x.childMessages[0].target, portalProfile.fuxiOrigin);
  assert.equal(x.childMessages[0].data.requestId, 'fuxi-request');
});

test('portal rejects either disabled policy, changed target and parent timeout without reading a credential', async () => {
  for (const scenario of ['portal-disabled', 'portal-changed', 'parent-disabled', 'parent-timeout']) {
    const x = await portalFixture(); await x.click(true);
    await x.message({ type: 'fuxi:tiangong:ready', requestId: 'fuxi-request' });
    if (scenario === 'portal-disabled') x.state.policyEnabled = false;
    if (scenario === 'portal-changed') x.state.policyFuxi = 'https://changed.invalid';
    if (scenario === 'parent-timeout') {
      const pending = [...x.timers.values()].find(item => item.delay === 5000); assert.ok(pending); pending.fn();
    } else {
      const answer = { ...x.answer(), enabled: scenario !== 'parent-disabled' };
      await x.message(answer, { source: x.parent, origin: portalProfile.plazaOrigin });
    }
    await x.message(x.answer(), { source: x.parent, origin: portalProfile.plazaOrigin });
    assert.equal(x.state.reads, 0, scenario); assert.equal(x.child.closed, true, scenario); assert.equal(x.childMessages.length, 0, scenario);
  }
});

test('teardown during a pending storage permission cannot open a Fuxi window', async () => {
  const x = await portalFixture(); let resolve!: (value: unknown) => void;
  x.host.document.requestStorageAccess = () => new Promise(r => { resolve = r; });
  const pending = x.click(true);
  x.events.get('pagehide')?.();
  resolve({ localStorage: x.storage }); await pending;
  assert.equal(x.state.opens, 0); assert.equal(x.state.reads, 0);
});
