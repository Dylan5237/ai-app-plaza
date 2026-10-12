import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compareProjectVersions } from '../server/domain/manifest.js';
import { startHarness } from './helpers/harness.js';
import { manifest, SHA, SHA2, TOKEN, DEFAULT_TAG } from './helpers/gitlab-fixture.js';

test('supported release ordering prevents regressions including prereleases and large numbers', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareProjectVersions(versions[i]!, versions[i - 1]!), 1);
    assert.equal(compareProjectVersions(versions[i - 1]!, versions[i]!), -1);
  }
  assert.equal(compareProjectVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareProjectVersions('1.0.0-alpha-x', '1.0.0-alpha-w'), 1);
  assert.equal(compareProjectVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  assert.equal(compareProjectVersions('1.0.0', '快照 22eba6cb'), undefined);
});

test('author update preserves identity, previews changes, rejects old versions and feeds latest local upgrade guidance', async t => {
  const h = await startHarness(); t.after(() => h.close());
  const base = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const first = await h.service.submit(base, TOKEN, randomUUID());
  assert.equal(first.change?.kind, 'create');
  const saved = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  const original = await h.service.app(saved.appId!);
  const get = (path: string) => h.app.inject({ method: 'GET', url: path, headers: { host: new URL(h.origin).host } });
  const contractResponse = await get(`/api/apps/${original.id}/publish-contract`);
  assert.equal(contractResponse.statusCode, 200);
  const contract = contractResponse.json();
  assert.deepEqual(contract.updateTarget, { appId: original.id, name: original.manifest.name, version: original.version, projectId: '1', appKey: 'sample-1', manifestPath: 'ai-app.json', expectedAppRevision: 1 });
  assert.match(contract.prompt, /保持同一 GitLab 项目、appKey 和 manifestPath/);
  assert.match(contract.prompt, /不要调用确认接口/);
  assert.match(contract.prompt, /升级的步骤、兼容变化/);
  assert.equal((await get(`/api/apps/${randomUUID()}/publish-contract`)).statusCode, 404);

  const updated = { ...manifest(), summary: '文档转换新增批量处理能力。', projectVersion: '1.1.0' };
  h.gitlab.state.files.set('ai-app.json', JSON.stringify(updated));
  h.gitlab.state.files.set('docs/agent-1.md', '# 升级说明\n\n保留用户配置，升级程序文件后执行最小验证。');
  h.gitlab.state.tagName = 'v1.1.0'; h.gitlab.state.tagSha = SHA2; h.gitlab.state.releaseSha = SHA2;
  const input = { ...base, commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: 1 };
  const candidate = await h.service.submit(input, TOKEN, randomUUID());
  assert.equal(candidate.status, 'preview_ready');
  assert.equal(candidate.preview?.id, original.id);
  assert.deepEqual(candidate.change, { kind: 'update', previousVersion: '1.0.0', changedFields: ['应用简介', '使用文档'] });
  assert.deepEqual((await h.service.publication(candidate.id, candidate.ticket)).change, candidate.change);
  assert.deepEqual(await h.service.app(original.id), original, 'unconfirmed update must not change the catalog');

  const confirmed = await h.service.confirm(candidate.id, candidate.ticket, { revision: candidate.revision, digest: candidate.digest! });
  assert.equal(confirmed.status, 'registered');
  assert.equal(confirmed.appId, original.id);
  assert.deepEqual(confirmed.change, candidate.change, 'update result remains explicit after a reload');
  assert.deepEqual((await h.service.publication(candidate.id, candidate.ticket)).change, candidate.change);
  const current = await h.service.app(original.id);
  assert.equal(current.createdAt, original.createdAt);
  assert.equal(current.version, '1.1.0'); assert.equal(current.revision, 2);
  assert.equal((await h.service.list()).total, 1);
  assert.ok(!('change' in current), 'publication metadata must not leak into catalog apps');
  const latestContract = (await get(`/api/apps/${original.id}/publish-contract`)).json();
  assert.equal(latestContract.updateTarget.expectedAppRevision, 2);

  const repeated = await h.service.submit({ ...input, expectedAppRevision: 2 }, TOKEN, randomUUID());
  assert.equal(repeated.status, 'registered'); assert.equal(repeated.change?.kind, 'unchanged');
  assert.equal((await h.service.app(original.id)).revision, 2);
  const guide = (await get(`/api/apps/${original.id}/instructions/agent`)).json();
  assert.equal(guide.version, '1.1.0'); assert.equal(guide.source.commitSha, SHA2);
  assert.equal(guide.instructionsPath, 'docs/agent-1.md');
  for (const instruction of [h.origin + '/api/apps/' + original.id, '当前已确认收录', '未安装', '已安装旧版', '已是目标版本', '先问我', '本地修改', '备份', '不自动降级', '最小验证', '不代表安装/升级成功']) assert.ok(guide.text.includes(instruction), instruction);
  assert.ok(guide.text.includes('# 升级说明'));
  assert.ok(!JSON.stringify({ contract, guide }).includes(TOKEN));

  for (const version of ['1.1.0', '1.0.0']) {
    h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...updated, projectVersion: version, summary: '不应覆盖新版的另一份资料。' }));
    h.gitlab.state.tagName = `v${version}`; h.gitlab.state.tagSha = SHA; h.gitlab.state.releaseSha = SHA;
    const rejected = await h.service.submit({ ...base, tag: `v${version}`, expectedAppRevision: 2 }, TOKEN, randomUUID());
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.error?.code, 'VERSION_NOT_NEWER');
    assert.equal(rejected.nextAction, 'submit_again');
    assert.deepEqual(await h.service.app(original.id), current);
  }
  assert.ok(h.gitlab.state.requests.every(request => request.method === 'GET' || request.method === 'HEAD'));
});

test('a historical snapshot can be updated to its first formal release without changing its app id', async t => {
  const h = await startHarness(); t.after(() => h.close());
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const first = await h.service.submit(input, TOKEN, randomUUID());
  const saved = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  await h.db.query("UPDATE published_snapshots SET version='快照 22eba6cb', tag=NULL WHERE app_id=$1", [saved.appId]);
  h.gitlab.state.tagSha = SHA2; h.gitlab.state.releaseSha = SHA2;
  const update = await h.service.submit({ ...input, commitSha: SHA2, expectedAppRevision: 1 }, TOKEN, randomUUID());
  assert.equal(update.change?.previousVersion, '快照 22eba6cb');
  const confirmed = await h.service.confirm(update.id, update.ticket, { revision: update.revision, digest: update.digest! });
  assert.equal(confirmed.appId, saved.appId); assert.equal(confirmed.preview?.version, '1.0.0');
});
