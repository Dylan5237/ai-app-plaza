import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFuxiEntryPolicy, type FuxiEntryPolicy } from '../server/fuxi-entry.js';
import { createFuxiLauncher, entryPolicy, sameEntryPolicy } from '../src/lib/fuxi-entry.js';
import { startHarness } from './helpers/harness.js';

const appId = '84c2f57f-c0f9-40ee-a8b8-8ff981d3041e';
const configured = {
  PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: appId, PLAZA_FUXI_ENTRY_ID: 'web',
  PLAZA_FUXI_ORIGIN: 'https://fuxi.example.invalid',
  PLAZA_FUXI_CREDENTIAL_STORAGE: 'sessionStorage', PLAZA_FUXI_CREDENTIAL_KEY: 'existing-sky-token',
};
const context = { local: false, publicOrigin: 'https://plaza.example.invalid' };
const policy = loadFuxiEntryPolicy(configured, context)!;

test('Fuxi policy is opt-in, bound by app/entry IDs, and disabled rollback retains only the binding', () => {
  assert.equal(loadFuxiEntryPolicy({}, context), undefined);
  assert.equal(loadFuxiEntryPolicy({ ...configured, PLAZA_FUXI_APP_ID: appId.toUpperCase() }, context)?.appId, appId);
  assert.deepEqual(loadFuxiEntryPolicy({ ...configured, PLAZA_FUXI_ENABLED: '0' }, context), {
    appId, entryId: 'web', plazaOrigin: context.publicOrigin, enabled: false,
  });
  assert.equal(entryPolicy([policy], appId, 'web'), policy);
  assert.equal(entryPolicy([policy], 'another-app', 'web'), undefined);
  assert.equal(entryPolicy([policy], appId, 'other-entry'), undefined);
  assert.equal(sameEntryPolicy(policy, { ...policy, fuxiOrigin: 'https://changed.invalid' }), false);
});

test('Fuxi configuration fails closed on incomplete or misleading origins without echoing inputs', () => {
  for (const field of Object.keys(configured)) {
    if (field === 'PLAZA_FUXI_ENABLED') continue;
    assert.throws(() => loadFuxiEntryPolicy({ ...configured, [field]: undefined }, context), /配置无效/);
  }
  for (const origin of ['*', 'https://fuxi.example.invalid/path', 'https://user:secret@fuxi.example.invalid',
    'https://fuxi.example.invalid?token=secret', 'https://fuxi.example.invalid#secret',
    'javascript:alert(1)', 'http://public.example.invalid', 'http://203.0.113.1',
    'http://127.0.0.1:1234', 'https://localhost', 'http://0xc0a80101', 'http://192.168.001.1',
    'http://3232235777', 'http://192.168.1.1.', 'http://192.168.1.1\\@evil.invalid']) {
    assert.throws(() => loadFuxiEntryPolicy({ ...configured, PLAZA_FUXI_ORIGIN: origin, PLAZA_FUXI_ALLOW_INTRANET_HTTP: '1' }, context),
      error => error instanceof Error && !error.message.includes('secret') && /配置无效/.test(error.message), origin);
  }
  for (const override of [{ PLAZA_FUXI_ENABLED: 'true' }, { PLAZA_FUXI_ALLOW_INTRANET_HTTP: 'true' },
    { PLAZA_FUXI_APP_ID: 'fuxi-name' }, { PLAZA_FUXI_ENTRY_ID: '../web' },
    { PLAZA_FUXI_CREDENTIAL_STORAGE: 'cookie' }, { PLAZA_FUXI_CREDENTIAL_KEY: 'user JSON' }]) {
    assert.throws(() => loadFuxiEntryPolicy({ ...configured, ...override }, context));
  }
});

test('Fuxi HTTP permits only explicit RFC1918 literals or local-test loopback, never production test origins', () => {
  for (const origin of ['http://10.0.0.1:16088', 'http://172.16.0.1', 'http://192.168.2.145:16088']) {
    assert.throws(() => loadFuxiEntryPolicy({ ...configured, PLAZA_FUXI_ORIGIN: origin }, context));
    assert.equal(loadFuxiEntryPolicy({ ...configured, PLAZA_FUXI_ORIGIN: origin, PLAZA_FUXI_ALLOW_INTRANET_HTTP: '1' }, context)?.fuxiOrigin, origin);
  }
  assert.ok(loadFuxiEntryPolicy({ ...configured, PLAZA_FUXI_ORIGIN: 'http://127.0.0.1:1234' }, { ...context, local: true }));
});

test('entry policy API exposes only deployment policy, keeps Host/Origin defenses and never adds login to the catalog', async () => {
  const harness = await startHarness();
  try {
    const read = (path: string, headers = {}) => harness.app.inject({ url: path, headers: { host: new URL(harness.origin).host, ...headers } });
    assert.deepEqual((await read('/api/entry-policies')).json(), { policies: [] });
    harness.config.fuxiEntry = { ...policy, plazaOrigin: harness.origin };
    const result = await read('/api/entry-policies');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(result.json(), { policies: [harness.config.fuxiEntry] });
    assert.equal((await read('/api/entry-policies', { origin: 'https://unapproved.invalid' })).statusCode, 403);
    assert.equal((await read('/api/entry-policies', { host: 'unapproved.invalid' })).statusCode, 403);
    assert.equal((await read('/api/apps')).statusCode, 200);
    assert.equal((await read('/api/health')).json().loginRequired, false);
  } finally { await harness.close(); }
});

function fakeBrowser(options: { blocked?: boolean; token?: string | null; storageThrows?: boolean; origin?: string } = {}) {
  let reads = 0, nextId = 0;
  const errors: string[] = [];
  const listeners = new Set<(event: MessageEvent) => void | Promise<void>>();
  const timeouts = new Map<number, () => void>(), intervals = new Map<number, () => void>();
  const opens: { url: string; target: string; popup: any }[] = [];
  const messages: any[] = [];
  const storage = { getItem: (key: string) => {
    reads++; assert.equal(key, policy.credential!.key);
    if (options.storageThrows) throw new Error('synthetic storage rejection');
    return options.token === undefined ? 'synthetic-credential-a' : options.token;
  } };
  const host = {
    location: { origin: options.origin || policy.plazaOrigin }, sessionStorage: storage, localStorage: storage,
    addEventListener: (_: string, listener: any) => listeners.add(listener),
    removeEventListener: (_: string, listener: any) => listeners.delete(listener),
    setTimeout: (fn: () => void) => { timeouts.set(++nextId, fn); return nextId; }, clearTimeout: (id: number) => timeouts.delete(id),
    setInterval: (fn: () => void) => { intervals.set(++nextId, fn); return nextId; }, clearInterval: (id: number) => intervals.delete(id),
    open: (url: string, target: string) => {
      const popup = { closed: false, close() { this.closed = true; }, postMessage: (data: unknown, targetOrigin: string) => messages.push({ data, targetOrigin }) };
      opens.push({ url, target, popup });
      return options.blocked ? null : popup;
    },
  } as unknown as Window;
  const ready = async (override: Record<string, unknown> = {}) => {
    const event = { source: opens.at(-1)?.popup, origin: policy.fuxiOrigin,
      data: { type: 'fuxi:tiangong:ready', requestId: 'browser-bound-request' }, ...override } as MessageEvent;
    await Promise.all([...listeners].map(listener => listener(event)));
  };
  return { host, errors, opens, messages, listeners, timeouts, intervals, ready, get reads() { return reads; } };
}

test('launcher reads nothing before a click, pins URL/origin/window and transfers exactly once', async () => {
  const browser = fakeBrowser();
  const launcher = createFuxiLauncher(browser.host, message => browser.errors.push(message));
  assert.equal(browser.reads, 0);
  launcher.launch(policy);
  assert.equal(browser.reads, 1);
  assert.equal(browser.opens[0].url, `${policy.fuxiOrigin}/auth/tiangong`);
  assert.equal(browser.opens[0].target, '_blank');
  await browser.ready({ source: {} });
  await browser.ready({ origin: 'https://unapproved.invalid' });
  for (const data of [null, {}, { type: 'fuxi:tiangong:login', requestId: 'x' },
    { type: 'fuxi:tiangong:ready', requestId: '' }, { type: 'fuxi:tiangong:ready', requestId: 'x'.repeat(129) }]) {
    await browser.ready({ data });
  }
  assert.equal(browser.messages.length, 0);
  await browser.ready();
  await browser.ready();
  assert.deepEqual(browser.messages, [{ targetOrigin: policy.fuxiOrigin,
    data: { type: 'fuxi:tiangong:login', requestId: 'browser-bound-request', token: 'synthetic-credential-a' } }]);
  assert.equal(browser.listeners.size + browser.timeouts.size + browser.intervals.size, 0);
  assert.deepEqual(browser.errors, []);
});

test('disabled, missing, oversized or inaccessible credentials cannot open a login or expose token in errors', () => {
  const disabled = fakeBrowser();
  createFuxiLauncher(disabled.host, text => disabled.errors.push(text)).launch({ ...policy, enabled: false });
  assert.equal(disabled.reads, 0);
  assert.equal(disabled.opens.length, 0);
  for (const options of [{ token: null }, { token: ' ' }, { token: 'x'.repeat(8193) }, { token: 'synthetic\ncredential' },
    { storageThrows: true }, { origin: 'https://different.invalid' }]) {
    const browser = fakeBrowser(options);
    createFuxiLauncher(browser.host, text => browser.errors.push(text)).launch(policy);
    assert.equal(browser.opens.length, 0);
    assert.equal(browser.errors.length, 1);
    assert.ok(browser.errors.every(error => !error.includes('synthetic')));
  }
});

test('popup blocking, timeout, close and unmount release handlers and send no credential', async () => {
  for (const scenario of ['blocked', 'timeout', 'close', 'unmount']) {
    const browser = fakeBrowser({ blocked: scenario === 'blocked' });
    const launcher = createFuxiLauncher(browser.host, text => browser.errors.push(text));
    launcher.launch(policy);
    if (scenario === 'timeout') [...browser.timeouts.values()][0]();
    if (scenario === 'close') { browser.opens[0].popup.closed = true; [...browser.intervals.values()][0](); }
    if (scenario === 'unmount') launcher.dispose();
    await browser.ready();
    assert.equal(browser.messages.length, 0);
    assert.equal(browser.listeners.size + browser.timeouts.size + browser.intervals.size, 0);
  }
});

test('repeat clicks cancel the old window; it cannot transfer the second user credential', async () => {
  const browser = fakeBrowser();
  const launcher = createFuxiLauncher(browser.host, text => browser.errors.push(text));
  launcher.launch(policy);
  const old = browser.opens[0].popup;
  launcher.launch(policy);
  assert.equal(old.closed, true);
  await browser.ready({ source: old });
  assert.equal(browser.messages.length, 0);
  await browser.ready();
  assert.equal(browser.messages.length, 1);
});

test('fresh server rollback/reconfiguration, failed recheck and cancellation during recheck all fail closed', async () => {
  for (const confirmPolicy of [async () => false, async () => { throw new Error('synthetic rejection'); }]) {
    const browser = fakeBrowser();
    createFuxiLauncher(browser.host, text => browser.errors.push(text), { confirmPolicy }).launch(policy);
    await browser.ready();
    assert.equal(browser.messages.length, 0);
    assert.equal(browser.opens[0].popup.closed, true);
  }
  const browser = fakeBrowser();
  let confirm!: (value: boolean) => void;
  const launcher = createFuxiLauncher(browser.host, text => browser.errors.push(text), {
    confirmPolicy: () => new Promise(resolve => { confirm = resolve; }),
  });
  launcher.launch(policy);
  const pending = browser.ready();
  await browser.ready(); // no second recheck or transfer
  launcher.dispose();
  confirm(true);
  await pending;
  assert.equal(browser.messages.length, 0);
});
