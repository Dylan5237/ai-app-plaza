import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Config } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/domain/database.js';
import type { SubmitResult } from '../../server/domain/service.js';
import { manifest } from './gitlab-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './managed-gitlab-fixture.js';

const LOCAL_SECRET = 'local-management-fixture-secret-only-32-bytes-minimum';
const FIXTURE_AUTHOR = (letter: string) => ({ name: `本地验证作者${letter}`, nameEn: `Local Fixture Author ${letter}` });

export interface ManagementFixtureOptions {
  port?: number;
  path?: string;
  staticDir?: string;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function bundle(options: {
  appKey: string;
  name: string;
  author: string;
  version: string;
  summary: string;
  entry: 'agent' | 'web';
}) {
  const data = {
    ...manifest(1),
    appKey: options.appKey,
    name: options.name,
    summary: options.summary,
    projectVersion: options.version,
    maintainers: [FIXTURE_AUTHOR(options.author)],
    requirements: ['仅使用本地合成资料进行试用'],
    limitations: ['这是本地 fixture，不代表正式应用或真实业务结果。'],
    docs: { readme: 'README.md', usage: 'docs/usage.md' },
    entries: options.entry === 'web'
      ? [{ id: 'web', kind: 'web', label: '本地 Web 入口示例', url: 'https://example.invalid/local-fixture' }]
      : [{ id: 'agent', kind: 'agent', label: 'Agent 接入说明', instructionsPath: 'docs/agent.md', compatibility: ['Fixture Agent'] }],
    primaryEntry: options.entry === 'web' ? 'web' : 'agent',
  };
  const files = [
    { path: 'src/keep-source.ts', text: 'export const retainedSource = \"fixture source must survive metadata edits\";\n' },
    { path: 'ai-app.json', text: JSON.stringify(data, null, 2) },
    { path: 'README.md', text: `# ${options.name}\n\n本地合成 fixture，仅用于管理后台交互试用。` },
    { path: 'docs/usage.md', text: `# 使用说明\n\n${options.summary}\n\n此内容来自本地 fixture，不代表真实业务能力。` },
    ...(options.entry === 'agent'
      ? [{ path: 'docs/agent.md', text: '# Agent 接入说明\n\n仅供本地预览，不执行真实安装。可在这里检查说明弹窗与复制交互。' }]
      : []),
  ];
  return {
    appKey: options.appKey,
    manifestPath: 'ai-app.json',
    files: files.map(file => ({ path: file.path, content: Buffer.from(file.text, 'utf8').toString('base64') })),
  };
}

async function confirm(fixture: Pick<Awaited<ReturnType<typeof createApp>>, 'service'>, publication: SubmitResult) {
  if (!publication.digest) throw new Error('Fixture publication is missing its confirmation digest.');
  const registered = await fixture.service.confirm(publication.id, publication.ticket, {
    revision: publication.revision,
    digest: publication.digest,
  });
  return registered;
}

async function seed(fixture: Awaited<ReturnType<typeof createApp>>, db: Awaited<ReturnType<typeof openDatabase>>) {
  const managed = fixture.managed;
  if (!managed) throw new Error('Managed publishing must be enabled for the management fixture.');

  const updateKey = randomBytes(32).toString('base64url');
  const initial = await managed.submit(bundle({
    appKey: 'fixture-docpilot-update',
    name: '本地验证：已收录文档助手',
    author: 'A',
    version: '1.0.0',
    summary: '用于本地验证已收录应用及版本更新流程。',
    entry: 'agent',
  }), updateKey, randomUUID());
  const registeredInitial = await confirm(fixture, initial);
  const current = await managed.current(initial.managedAppId, updateKey);
  if (!current.appId) throw new Error('Fixture live application was not registered.');
  const update = await managed.submit({
    ...bundle({
      appKey: 'fixture-docpilot-update',
      name: '本地验证：已收录文档助手',
      author: 'A',
      version: '1.1.0',
      summary: '用于本地验证从 1.0.0 更新到 1.1.0 的确认流程。',
      entry: 'agent',
    }),
    managedAppId: initial.managedAppId,
    expectedAppRevision: current.revision,
  }, updateKey, randomUUID());

  const firstUpload = await managed.submit(bundle({
    appKey: 'fixture-first-upload',
    name: '本地验证：首次上传待确认',
    author: 'B',
    version: '1.0.0',
    summary: '用于本地验证首次发布已就绪、等待确认的状态。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());

  const webKey = randomBytes(32).toString('base64url');
  const webUpload = await managed.submit(bundle({
    appKey: 'fixture-web-only',
    name: '本地验证：Web 示例应用',
    author: 'C',
    version: '1.0.0',
    summary: '仅用于查看已收录 Web 类应用详情；入口为 example.invalid。',
    entry: 'web',
  }), webKey, randomUUID());
  const registeredWeb = await confirm(fixture, webUpload);
  const webCurrent = await managed.current(webUpload.managedAppId, webKey);
  if (!registeredWeb.appId || !webCurrent.appId) throw new Error('Fixture Web application was not registered.');

  const prepared = await seedPreparedPlaceholder(db);
  return {
    update: {
      appId: current.appId,
      managedAppId: initial.managedAppId,
      publicationId: update.id,
      fromVersion: '1.0.0',
      version: '1.1.0',
      status: update.status,
    },
    firstUpload: {
      previewAppId: firstUpload.preview?.id,
      managedAppId: firstUpload.managedAppId,
      publicationId: firstUpload.id,
      version: '1.0.0',
      status: firstUpload.status,
    },
    webApp: { appId: webCurrent.appId, managedAppId: webUpload.managedAppId, version: '1.0.0' },
    preparedUpload: prepared,
    initialPublicationId: initial.id,
    registeredInitialAppId: registeredInitial.appId,
  };
}

async function seedPreparedPlaceholder(db: Awaited<ReturnType<typeof openDatabase>>) {
  const bindingId = randomUUID();
  const operationId = randomUUID();
  const publishKey = randomBytes(32).toString('base64url');
  const idempotencyKey = randomUUID();
  const publishKeyDigest = createHmac('sha256', LOCAL_SECRET).update('managed-publish-key-v1\0').update(publishKey).digest('hex');
  const idempotencyDigest = createHmac('sha256', LOCAL_SECRET).update(`managed-idempotency-v1\0${bindingId}\0`).update(idempotencyKey).digest('hex');
  const requestDigest = createHash('sha256').update('prepared management fixture only').digest('hex');
  const now = new Date();
  await db.query(
    `INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [bindingId, 'fixture-prepared-placeholder', publishKeyDigest, now],
  );
  await db.query(
    `INSERT INTO managed_publish_operations
       (id, binding_id, idempotency_digest, request_digest, manifest_path, expected_app_revision,
        base_commit_sha, project_id, branch, commit_sha, tag, publication_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ai-app.json', NULL, NULL, NULL, 'main', NULL, 'v0.1.0', NULL, 'prepared', $5, $5)`,
    [operationId, bindingId, idempotencyDigest, requestDigest, now],
  );
  return { bindingId, operationId, appKey: 'fixture-prepared-placeholder', status: 'prepared' as const };
}

export async function startManagementFixture({ port, path = 'memory://', staticDir = resolve(process.cwd(), 'dist') }: ManagementFixtureOptions = {}) {
  const chosenPort = port && port > 0 ? port : await availablePort();
  const db = await openDatabase({ path });
  let gitlab: Awaited<ReturnType<typeof startManagedGitLabFixture>> | undefined;
  let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
  try {
    gitlab = await startManagedGitLabFixture('main');
    const origin = `http://127.0.0.1:${chosenPort}`;
    const config = {
      host: '127.0.0.1',
      port: chosenPort,
      publicOrigin: origin,
      gitlabUrl: gitlab.url,
      secret: LOCAL_SECRET,
      dataDir: '',
      local: true,
      localManagement: true,
      audience: '仅限本地管理试用',
      staticDir,
      rateLimit: false,
      managedPublishing: { groupId: '63', groupPath: 'local-fixture', token: MANAGED_GITLAB_TOKEN },
    } as Config & { localManagement: true };
    const created = await createApp(config, db);
    app = created.app;
    if (!created.managed) throw new Error('Managed publishing is unavailable in this app configuration.');
    await app.listen({ port: chosenPort, host: '127.0.0.1' });
    const seeds = await seed(created, db);
    let closed = false;
    return {
      app,
      service: created.service,
      managed: created.managed,
      db,
      gitlab,
      origin,
      seeds,
      close: async () => {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([app!.close(), db.close(), gitlab!.close()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      },
    };
  } catch (error) {
    await Promise.allSettled([app?.close(), db.close(), gitlab?.close()]);
    throw error;
  }
}
