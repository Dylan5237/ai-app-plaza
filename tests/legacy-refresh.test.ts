import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { refreshLegacyDistributions } from '../server/domain/legacy-refresh.js';
import { runRefresh } from '../scripts/refresh-agent-distributions.js';
import { startHarness } from './helpers/harness.js';
import { DEFAULT_TAG, manifest, SHA, TOKEN } from './helpers/gitlab-fixture.js';

async function setup(t: any, remote = false, count = 1) {
  const root = resolve('artifacts', 'distribution-tests');
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, 'plaza-legacy-refresh-'));
  const h = await startHarness(count, 'memory://', { dataDir: temp } as any);
  t.after(async () => {
    await h.close();
    assert.ok(resolve(temp).startsWith(root + sep));
    assert.ok(temp.split(/[\\/]/).at(-1)?.startsWith('plaza-legacy-refresh-'));
    await rm(temp, { recursive: true, force: true });
  });
  const value: any = manifest();
  value.requirements = ['源码安装需要 Node.js 18 或更高版本、npm，以及固定来源的仓库读取权限和依赖下载网络；通过 Git 取得源码时还需要 Git。'];
  value.entries = [{ id: 'agent', kind: 'agent', label: '本地 Skill', instructionsPath: 'docs/agent-1.md', compatibility: ['Codex'] }];
  if (remote) value.entries.push({ id: 'agent-remote', kind: 'agent', label: '远程 MCP', instructionsPath: 'docs/agent-1.md', compatibility: ['Streamable HTTP'] });
  value.primaryEntry = 'agent';
  const guide = '# 安装\n## 获取源码（固定版本）\ngit clone https://example.invalid/private.git\n## 安装\n解压后复制 SKILL.md。'
    + (remote ? '\n## 连接现有远程 MCP\nMCP 地址：https://example.invalid/mcp\n使用本人业务授权。' : '');
  h.gitlab.state.files.set('ai-app.json', JSON.stringify(value));
  h.gitlab.state.files.set('docs/usage-1.md', guide);
  h.gitlab.state.files.set('docs/agent-1.md', guide);
  h.gitlab.state.files.set('SKILL.md', '# 本技能\n本机使用测试。');
  h.gitlab.state.files.set('.env', 'PRIVATE=do-not-share');
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const p = await h.service.submit(input, TOKEN, randomUUID());
  assert.equal(p.status, 'preview_ready', JSON.stringify(p.error));
  const registered = await h.service.confirm(p.id, p.ticket, { revision: p.revision, digest: p.digest! });
  assert.equal(registered.status, 'registered', JSON.stringify(registered.error));
  const options = { db: h.db, gitlabUrl: h.gitlab.url, token: TOKEN, directory: join(temp, 'distribution'), staticDir: resolve('dist') };
  return { h, temp, options, appId: registered.appId! };
}

function zipNames(bytes: Buffer): string[] {
  const p = spawnSync('python', ['-c', 'import io,sys,zipfile,json; print(json.dumps(zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).namelist()))'], { input: bytes, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

test('refresh command requires an exact preview plan before apply', async () => {
  await assert.rejects(runRefresh(['--apply'], {}), (error: any) => error.code === 'VALIDATION_FAILED' && /预览的 --expect-plan/.test(error.message));
  await assert.rejects(runRefresh(['--expect-plan', 'a'.repeat(64)], {}), (error: any) => error.code === 'VALIDATION_FAILED');
  await assert.rejects(runRefresh(['--show-guides'], {}), (error: any) => error.code === 'VALIDATION_FAILED' && /DATABASE_URL/.test(error.message));
});

test('bulk refresh previews, binds the old snapshot, downloads without GitLab and is idempotent', async t => {
  const { h, options, appId } = await setup(t);
  const preview = await refreshLegacyDistributions(options);
  assert.equal(preview.status, 'ready', JSON.stringify(preview.problems));
  const review = await refreshLegacyDistributions({ ...options, includeGuides: true });
  assert.equal(review.planId, preview.planId);
  assert.match(review.guides![0]!.text, /广场下载当前入口的固定分发包/);
  assert.doesNotMatch(review.guides![0]!.text, /git clone/);
  assert.match(preview.planId!, /^[a-f0-9]{64}$/);
  assert.equal(preview.items.length, 1);
  assert.deepEqual(preview.items[0]!.excludedPaths, ['.env']);
  assert.deepEqual(preview.items[0]!.transformedPaths, ['docs/usage-1.md']);
  assert.equal((await h.db.query('SELECT * FROM distribution_assets')).rows.length, 0, 'preview has no database writes');
  const applied = await refreshLegacyDistributions({ ...options, apply: true, expectedPlan: preview.planId });
  assert.equal(applied.status, 'applied'); assert.equal(applied.applied, 1);
  const again = await refreshLegacyDistributions(options);
  assert.equal(again.planId, preview.planId, 'a completed refresh is replayable');
  const replay = await refreshLegacyDistributions({ ...options, apply: true, expectedPlan: again.planId });
  assert.equal(replay.unchanged, 1); assert.equal(replay.applied, 0);
  h.gitlab.state.offline = true;
  const count = h.gitlab.state.requests.length;
  const guide = await h.service.instructions(appId, 'agent');
  assert.equal(guide.distribution.status, 'ready');
  assert.match(guide.text, /广场下载当前入口的固定分发包/);
  assert.doesNotMatch(guide.text, /git clone|example\.invalid\/private/);
  const publicView = await h.service.app(appId);
  assert.match(publicView.distributions![0]!.guide!, /广场下载当前入口的固定分发包/);
  assert.doesNotMatch(publicView.distributions![0]!.guide!, /git clone|example\.invalid\/private/);
  assert.match(publicView.displayRequirements![0]!, /Node\.js 18/);
  assert.doesNotMatch(publicView.displayRequirements![0]!, /仓库读取权限|通过 Git/);
  assert.match(publicView.manifest.requirements[0]!, /仓库读取权限/, 'the confirmed snapshot remains untouched');
  assert.deepEqual(publicView.displayRequirements, preview.items[0]!.displayRequirements);
  assert.deepEqual(publicView.derivedDocumentPaths, ['docs/agent-1.md', 'docs/usage-1.md']);
  assert.match(publicView.installationBasis!, /安装以对应入口的广场接入说明及分发包为准/);
  assert.doesNotMatch(publicView.documents['docs/usage-1.md']!, /git clone/);
  assert.doesNotMatch(publicView.documents['docs/agent-1.md']!, /git clone/);
  const saved = await h.db.query<{ documents: Record<string, string> }>('SELECT documents FROM published_snapshots WHERE app_id = $1', [appId]);
  assert.match(saved.rows[0]!.documents['docs/usage-1.md']!, /git clone/, 'the confirmed source documents remain untouched');
  const response = await fetch(String(guide.distribution.url));
  assert.equal(response.status, 200);
  const names = zipNames(Buffer.from(await response.arrayBuffer()));
  assert.ok(names.includes('SKILL.md'));
  assert.ok(!names.includes('.env'));
  assert.equal(h.gitlab.state.requests.length, count);
});

test('a changed source or lifecycle invalidates the plan before any asset mapping is created', async t => {
  const { h, options, appId } = await setup(t);
  const preview = await refreshLegacyDistributions(options);
  h.gitlab.state.files.set('SKILL.md', '# changed after preview');
  await assert.rejects(refreshLegacyDistributions({ ...options, apply: true, expectedPlan: preview.planId }), (error: any) => error.code === 'REFRESH_PLAN_MISMATCH');
  assert.equal((await h.db.query('SELECT * FROM distribution_assets')).rows.length, 0);
  h.gitlab.state.files.set('SKILL.md', '# 本技能\n本机使用测试。');
  await h.service.changeLifecycle(appId, 'offline', 1, 1);
  await assert.rejects(refreshLegacyDistributions({ ...options, apply: true, expectedPlan: preview.planId }), (error: any) => error.code === 'REFRESH_PLAN_MISMATCH');
  assert.equal((await h.db.query('SELECT * FROM distribution_assets')).rows.length, 0);
});

test('remote MCP refresh keeps remote connection usable without a local server installation', async t => {
  const { h, temp, options, appId } = await setup(t, true);
  const preview = await refreshLegacyDistributions(options);
  assert.equal(preview.status, 'ready', JSON.stringify(preview.problems));
  assert.deepEqual(new Set(preview.items.map(item => item.delivery)), new Set(['package', 'remote']));
  await refreshLegacyDistributions({ ...options, apply: true, expectedPlan: preview.planId });
  const remote = await h.service.instructions(appId, 'agent-remote');
  assert.equal(remote.distribution.delivery, 'remote');
  assert.match(remote.text, /无需在本机安装服务端或配置 GitLab 权限/);
  assert.match(remote.text, /https:\/\/example\.invalid\/mcp/);
  assert.doesNotMatch(remote.text, /git clone|example\.invalid\/private/);
  await writeFile(join(temp, 'distribution', `${remote.distribution.sha256}.zip`), 'corrupted');
  assert.match((await h.service.instructions(appId, 'agent-remote')).text, /远程 MCP/);
  await assert.rejects(h.service.instructions(appId, 'agent'), (error: any) => error.code === 'ASSET_UNAVAILABLE');
});

test('one ambiguous legacy app blocks the entire batch and preserves existing records', async t => {
  const { h, options } = await setup(t, false, 2);
  const p = await h.service.submit({ projectId: 1, appKey: 'sample-2', manifestPath: '.ai-apps/sample-2/ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  assert.equal(p.status, 'preview_ready');
  assert.equal((await h.service.confirm(p.id, p.ticket, { revision: p.revision, digest: p.digest! })).status, 'registered');
  const preview = await refreshLegacyDistributions(options);
  assert.equal(preview.status, 'blocked');
  assert.ok(preview.problems.some(problem => problem.appKey === 'sample-2' && problem.code === 'LEGACY_SCOPE_AMBIGUOUS'));
  assert.equal((await h.db.query('SELECT * FROM distribution_assets')).rows.length, 0);
  const applied = await refreshLegacyDistributions({ ...options, apply: true, expectedPlan: 'a'.repeat(64) });
  assert.equal(applied.status, 'blocked');
  assert.equal((await h.db.query('SELECT * FROM distribution_assets')).rows.length, 0);
});
