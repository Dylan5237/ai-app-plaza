import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadFuxiEntryPolicy } from '../server/fuxi-entry.js';
import { sameEntryPolicy } from '../src/lib/fuxi-entry.js';
import { createPortalParentEntry } from '../src/lib/portal-parent-entry.js';
const { startPortalAuthBridge } = await import(new URL('../ops/integration/tiangong-bridge/portal-auth-bridge.js', import.meta.url).href);

const profile = { enabled: true, appId: '84c2f57f-c0f9-40ee-a8b8-8ff981d3041e', entryId: 'web', portalOrigin: 'https://portal.example.invalid', plazaOrigin: 'https://plaza.example.invalid', fuxiOrigin: 'https://fuxi.example.invalid' };
const env = { PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: profile.appId, PLAZA_FUXI_ENTRY_ID: 'web', PLAZA_FUXI_ORIGIN: profile.fuxiOrigin, PLAZA_FUXI_MODE: 'portal-parent', PLAZA_FUXI_PORTAL_ORIGIN: profile.portalOrigin };
const policy = loadFuxiEntryPolicy(env, { local: false, publicOrigin: profile.plazaOrigin })!;

function rootBrowser(latest = async () => profile) {
  const listeners = new Set<any>(), messages: any[] = [], children: any[] = [], timers = new Map<number, () => void>();
  let timerId = 0, reads = 0;
  const frame = { postMessage: (data: any, origin: string) => messages.push({ data, origin }) };
  const host = {
    location: { origin: profile.portalOrigin, href: profile.portalOrigin + '/fuxi-plaza.html' },
    top: { location: { origin: profile.portalOrigin } }, navigator: { userActivation: { isActive: true } }, crypto: webcrypto,
    addEventListener: (type: string, fn: any) => { if (type === 'message') listeners.add(fn); }, removeEventListener: (_: string, fn: any) => listeners.delete(fn),
    setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
    localStorage: { getItem: (key: string) => { assert.equal(key, 'sky-token'); reads++; return 'fixture-valid-a'; } },
    open: (url: string) => { assert.equal(url, profile.fuxiOrigin + '/auth/tiangong'); const child = { closed: false, close() { child.closed = true; }, sends: [] as any[], postMessage(data: any, origin: string) { child.sends.push({ data, origin }); } }; children.push(child); return child; },
  };
  const bridge = startPortalAuthBridge(host as any, profile, { frameWindow: () => frame, readPolicy: latest });
  const fire = async (data: any, override: any = {}) => { for (const fn of [...listeners]) await fn({ isTrusted: true, source: frame, origin: profile.plazaOrigin, data: { version: 1, appId: profile.appId, entryId: 'web', ...data }, ...override }); };
  const ready = async (child = children.at(-1)) => fire({ type: 'fuxi:tiangong:ready', requestId: 'synthetic-request' }, { source: child, origin: profile.fuxiOrigin });
  const approve = async (enabled = true) => { const message = [...messages].reverse().find(item => item.data.type === 'fuxi:portal:policy-check')!.data; await fire({ type: 'fuxi:portal:policy-result', requestId: message.requestId, policyRequestId: message.policyRequestId, enabled }); };
  return { host, bridge, fire, ready, approve, frame, messages, children, timers, reads: () => reads };
}

test('parent protocol policy has only fixed origins and no UI or credential configuration', () => {
  assert.deepEqual(policy, { appId: profile.appId, entryId: 'web', plazaOrigin: profile.plazaOrigin, enabled: true, mode: 'portal-parent', fuxiOrigin: profile.fuxiOrigin, portal: { origin: profile.portalOrigin } });
  assert.equal(sameEntryPolicy(policy, { ...policy, portal: { origin: 'https://other.invalid' } }), false);
  assert.deepEqual(loadFuxiEntryPolicy({ ...env, PLAZA_FUXI_ENABLED: '0' }, { local: false, publicOrigin: profile.plazaOrigin }), { appId: profile.appId, entryId: 'web', plazaOrigin: profile.plazaOrigin, enabled: false });
  for (const extra of [{ PLAZA_FUXI_WIDGET_URL: 'https://portal.example.invalid/fuxi-portal-widget.html' }, { PLAZA_FUXI_CREDENTIAL_KEY: 'sky-token' }, { PLAZA_FUXI_PORTAL_ORIGIN: 'http://192.168.5.143' }, { PLAZA_FUXI_PORTAL_ORIGIN: profile.portalOrigin + '/path' }, { PLAZA_FUXI_PORTAL_ORIGIN: profile.portalOrigin + '?redirect=other' }]) {
    assert.throws(() => loadFuxiEntryPolicy({ ...env, ...extra }, { local: false, publicOrigin: profile.plazaOrigin }));
  }
});

test('root rejects wrong origin/source, untrusted messages, invalid nonce and absent activation before storage reads', async () => {
  const b = rootBrowser();
  const launch = { type: 'fuxi:portal:launch', requestId: 'a'.repeat(64) };
  for (const change of [{ origin: 'https://other.invalid' }, { source: {} }, { isTrusted: false }]) await b.fire(launch, change);
  for (const requestId of ['', 'short', 42, new String('a'.repeat(64))]) await b.fire({ ...launch, requestId });
  b.host.navigator.userActivation.isActive = false; await b.fire(launch);
  assert.equal(b.children.length, 0); assert.equal(b.reads(), 0); b.bridge.dispose();
});

test('only a click-bound fixed child and two fresh policies can receive one credential; Plaza receives none', async () => {
  const b = rootBrowser();
  await b.fire({ type: 'fuxi:portal:launch', requestId: 'a'.repeat(64) });
  assert.equal(b.reads(), 0);
  await b.fire({ type: 'fuxi:tiangong:ready', requestId: 'synthetic-request' }, { source: {}, origin: profile.fuxiOrigin });
  assert.equal(b.messages.length, 0);
  await b.ready(); await b.approve(); await b.approve();
  assert.equal(b.reads(), 1); assert.equal(b.children[0].sends.length, 1);
  assert.equal(b.children[0].sends[0].origin, profile.fuxiOrigin);
  assert.equal(b.children[0].sends[0].data.type, 'fuxi:tiangong:login');
  assert(!JSON.stringify(b.messages).includes('fixture-valid-a'));
  await b.fire({ type: 'fuxi:portal:launch', requestId: 'a'.repeat(64) });
  assert.equal(b.children.length, 1); b.bridge.dispose();
});

test('disabled/changed portal policy and declined Plaza policy block storage reads', async () => {
  for (const latest of [{ ...profile, enabled: false }, { ...profile, fuxiOrigin: 'https://other.invalid' }, null]) {
    const b = rootBrowser(async () => latest as any);
    await b.fire({ type: 'fuxi:portal:launch', requestId: 'a'.repeat(64) }); await b.ready(); await b.approve();
    assert.equal(b.reads(), 0); assert(b.children[0].closed); b.bridge.dispose();
  }
  const b = rootBrowser(); await b.fire({ type: 'fuxi:portal:launch', requestId: 'a'.repeat(64) }); await b.ready(); await b.approve(false);
  assert.equal(b.reads(), 0); assert(b.children[0].closed); b.bridge.dispose();
});

test('replacement, timeout, closed popup and dispose invalidate late completions', async () => {
  for (const action of ['replace', 'timeout', 'close', 'dispose']) {
    let finish!: (value: any) => void;
    const b = rootBrowser(() => new Promise(resolve => { finish = resolve; }));
    await b.fire({ type: 'fuxi:portal:launch', requestId: 'a'.repeat(64) }); await b.ready(); const pending = b.approve();
    if (action === 'replace') await b.fire({ type: 'fuxi:portal:launch', requestId: 'b'.repeat(64) });
    if (action === 'timeout') [...b.timers.values()][0]();
    if (action === 'close') b.children[0].closed = true;
    if (action === 'dispose') b.bridge.dispose();
    finish(profile); await pending; assert.equal(b.reads(), 0); b.bridge.dispose();
  }
});

test('Plaza client accepts only its parent handshake, requires trusted active input and never contains identity', async () => {
  const listeners = new Set<any>(), sends: any[] = [], ready: boolean[] = [];
  const parent = { postMessage: (data: any, origin: string) => sends.push({ data, origin }) };
  const host: any = { location: { origin: profile.plazaOrigin }, parent, navigator: { userActivation: { isActive: true } }, crypto: webcrypto,
    addEventListener: (_: any, fn: any) => listeners.add(fn), removeEventListener: (_: any, fn: any) => listeners.delete(fn), setInterval: () => 1, clearInterval() {} };
  const launcher = createPortalParentEntry(host, policy, async () => true, value => ready.push(value), () => {});
  const hello = sends[0].data;
  const fire = async (data: any, override: any = {}) => { for (const fn of [...listeners]) await fn({ isTrusted: true, source: parent, origin: profile.portalOrigin, data: { version: 1, appId: profile.appId, entryId: 'web', ...data }, ...override }); };
  await fire({ type: 'fuxi:portal:ready', requestId: hello.requestId }, { source: {} });
  assert.equal(launcher.launch({ isTrusted: true } as Event), false);
  await fire({ type: 'fuxi:portal:ready', requestId: hello.requestId });
  assert.equal(launcher.launch({ isTrusted: false } as Event), false);
  assert.equal(launcher.launch({ isTrusted: true } as Event), true);
  assert(sends.every(item => item.origin === profile.portalOrigin));
  assert(!JSON.stringify(sends).includes('token')); assert(!JSON.stringify(sends).includes('userId'));
  assert.deepEqual(ready, [true]); launcher.dispose(); assert.equal(listeners.size, 0);
});
