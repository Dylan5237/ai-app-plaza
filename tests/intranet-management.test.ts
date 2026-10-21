import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { openDatabase } from '../server/domain/database.js';
import { manifest } from './helpers/gitlab-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';

const SECRET = 'intranet-management-test-secret-with-at-least-32-bytes';
const HOST = '192.168.2.145:16090';

function makeBundle() {
  const appManifest = {
    ...manifest(1),
    appKey: 'intranet-synthetic',
    name: '合成内网管理应用',
    projectVersion: '1.0.0',
    docs: { readme: 'README.md', usage: 'docs/usage.md' },
    entries: [{ id: 'agent', kind: 'agent', label: 'Agent 接入说明', instructionsPath: 'docs/agent.md', compatibility: ['Fixture Agent'] }],
    primaryEntry: 'agent',
  };
  const files = [
    { path: 'ai-app.json', text: JSON.stringify(appManifest) },
    { path: 'README.md', text: '# 合成应用\n\n仅供隔离测试。' },
    { path: 'docs/usage.md', text: '# 使用说明\n\n这是合成验证资料。' },
    { path: 'docs/agent.md', text: '# Agent 说明\n\n不执行真实安装。' },
  ];
  return {
    appKey: 'intranet-synthetic',
    manifestPath: 'ai-app.json',
    files: files.map(file => ({ path: file.path, content: Buffer.from(file.text, 'utf8').toString('base64') })),
  };
}

async function harness() {
  const db = await openDatabase({ path: 'memory://' });
  const gitlab = await startManagedGitLabFixture('main');
  const config: Config = {
    host: '0.0.0.0',
    port: 16090,
    publicOrigin: `http://${HOST}`,
    gitlabUrl: gitlab.url,
    secret: SECRET,
    dataDir: '',
    local: false,
    intranetManagement: true,
    audience: '所有能访问本门户的人',
    staticDir: resolve('not-built-intranet-management-static'),
    rateLimit: false,
    managedPublishing: { groupId: '63', groupPath: 'team/ai-apps', token: MANAGED_GITLAB_TOKEN },
  };
  try {
    const created = await createApp(config, db);
    return {
      ...created,
      config,
      db,
      gitlab,
      close: async () => {
        const results = await Promise.allSettled([created.app.close(), db.close(), gitlab.close()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      },
    };
  } catch (error) {
    await Promise.allSettled([db.close(), gitlab.close()]);
    throw error;
  }
}

function request(h: Awaited<ReturnType<typeof harness>>, method: 'GET' | 'POST', url: string, payload?: unknown, extra: Record<string, string> = {}): Promise<any> {
  return h.app.inject({ method, url, payload: payload as any, headers: { host: HOST, ...extra } }) as Promise<any>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('intranet management serves the shared API, validates request origin, and edits only synthetic fixture data', async t => {
  const h = await harness();
  t.after(() => h.close());

  await assert.rejects(createApp({ ...h.config, publicOrigin: 'https://plaza.example.invalid:16090' }, h.db), /RFC1918/);
  await assert.rejects(createApp({ ...h.config, port: 16091 }, h.db), /端口与 PORT 一致/);

  const health = await request(h, 'GET', '/api/health');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(
    { enabled: health.json().managementEnabled, mode: health.json().managementMode, loginRequired: health.json().loginRequired },
    { enabled: true, mode: 'intranet', loginRequired: false },
  );

  assert.equal((await request(h, 'GET', '/api/management/apps')).statusCode, 200);
  assert.equal((await request(h, 'GET', '/api/management/apps', undefined, { host: '203.0.113.10:16090' })).statusCode, 403);
  assert.equal((await request(h, 'GET', '/api/management/apps', undefined, { origin: 'https://attacker.invalid' })).statusCode, 403);
  assert.equal((await request(h, 'GET', '/api/management/apps', undefined, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);

  const publishKey = randomBytes(32).toString('base64url');
  const first = await h.managed!.submit(makeBundle(), publishKey, randomUUID());
  assert.equal(first.status, 'preview_ready');
  const appId = first.preview!.id;
  const confirmed = await request(h, 'POST', `/api/management/publications/${first.id}/confirm`, {
    revision: first.revision,
    digest: first.digest,
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, 'registered');

  const listed = await request(h, 'GET', '/api/management/apps?status=published');
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().total, 1);
  const row = listed.json().items[0];
  assert.equal(row.id, appId);

  const offline = await request(h, 'POST', `/api/management/apps/${appId}/lifecycle`, {
    action: 'offline', expectedAppRevision: row.revision, expectedLifecycleRevision: row.lifecycle.revision,
  });
  assert.equal(offline.statusCode, 200, offline.body);
  assert.equal(offline.json().lifecycle.status, 'offline');

  const editor = await request(h, 'GET', `/api/management/apps/${appId}/editor`);
  assert.equal(editor.statusCode, 200, editor.body);
  assert.equal(editor.json().editable, true);
  const editorApp = editor.json().app;
  const revisedManifest = structuredClone(editorApp.manifest);
  revisedManifest.name = '内网管理修改后的合成应用';
  revisedManifest.summary = '只验证内网管理编辑流程的合成资料。';
  revisedManifest.projectVersion = editor.json().suggestedVersion;
  const documents = structuredClone(editorApp.documents);
  documents['README.md'] = '# 合成应用\n\n通过内网管理路由提交的合成修订。';
  const editKey = randomUUID();
  const edited = await request(h, 'POST', `/api/management/apps/${appId}/editor`, {
    expectedAppRevision: editorApp.revision,
    manifest: revisedManifest,
    documents,
  }, { 'idempotency-key': editKey });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().managementPublication.status, 'preview_ready');
  assert.ok(edited.json().operationId);
  assert.ok(h.gitlab.state.writes.length > 0, 'writes are confined to the isolated GitLab fixture');

  const managed = h.managed!;
  const originalEdit = managed.editMetadata.bind(managed);
  const originalValidate = managed.validate.bind(managed);
  const editStarted = deferred();
  const validateStarted = deferred();
  const editGate = deferred();
  const validateGate = deferred();
  managed.editMetadata = async (...args) => {
    editStarted.resolve();
    await editGate.promise;
    return originalEdit(...args);
  };
  managed.validate = async (...args) => {
    validateStarted.resolve();
    await validateGate.promise;
    return originalValidate(...args);
  };
  try {
    const inFlightEdit = request(h, 'POST', `/api/management/apps/${appId}/editor`, {
      expectedAppRevision: editorApp.revision,
      manifest: revisedManifest,
      documents,
    }, { 'idempotency-key': editKey });
    await editStarted.promise;
    const inFlightValidation = request(h, 'POST', '/api/managed-publications/validate', makeBundle());
    await validateStarted.promise;
    const rejected = await request(h, 'POST', '/api/managed-publications/validate', makeBundle());
    assert.equal(rejected.statusCode, 429);
    assert.equal(rejected.json().error.code, 'UPLOAD_BUSY');
    editGate.resolve();
    validateGate.resolve();
    const [editResponse, validateResponse] = await Promise.all([inFlightEdit, inFlightValidation]);
    assert.equal(editResponse.statusCode, 200, editResponse.body);
    assert.equal(validateResponse.statusCode, 200, validateResponse.body);
    const replay = await request(h, 'POST', `/api/management/apps/${appId}/editor`, {
      expectedAppRevision: editorApp.revision,
      manifest: revisedManifest,
      documents,
    }, { 'idempotency-key': editKey });
    assert.equal(replay.statusCode, 200, replay.body, 'the editor releases its managed-operation slot after completion');
  } finally {
    managed.editMetadata = originalEdit;
    managed.validate = originalValidate;
    editGate.resolve();
    validateGate.resolve();
  }
});
