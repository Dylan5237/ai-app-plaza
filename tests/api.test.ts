import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/domain/database.js';
import { DEFAULT_TAG, manifest, startGitLabFixture, SHA, TOKEN } from './helpers/gitlab-fixture.js';
import type { Config } from '../server/config.js';
import type { AppView } from '../server/domain/service.js';
import { manifestJson } from '../server/domain/manifest.js';
import { publishContract } from '../server/publish-contract.js';

test('managed first and update contracts keep preparation, preflight and receipt recovery in their own stages', async t => {
  const current: AppView = {
    id: 'fixture-app', revision: 3, manifest: manifestJson(JSON.stringify(manifest()), 'sample-1'), tags: ['文档处理'], version: '1.0.0',
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', documents: {},
    source: { projectId: '123', projectUrl: 'https://gitlab.example.invalid/fixture/app', commitSha: SHA, manifestPath: 'ai-app.json', tag: DEFAULT_TAG },
  };
  const target = { managedAppId: 'fixture-managed-app', projectId: '123', appKey: 'sample-1' };
  for (const publicBasePath of ['', '/plaza']) for (const withIdentity of [false, true]) for (const update of [false, true]) {
    await t.test(`${publicBasePath || '/'} / identity ${withIdentity} / ${update ? 'update' : 'first'}`, async () => {
      const config: Parameters<typeof publishContract>[0] = {
        publicOrigin: 'https://plaza.example.invalid:8443', publicBasePath, gitlabUrl: 'https://gitlab.example.invalid', audience: '合成测试',
        managedPublishing: { groupId: '63', groupPath: 'fixture/apps', token: 'fixture-server-only-token' },
        ...(withIdentity ? { tiangong: { userinfoUrl: 'https://portal.example.invalid/findByToken', successCode: 'ok', tokenStorageKey: 'fixture-token',
          allowedUserTypes: ['03'], sessionHours: 1, identityAdmins: [] } } : {}),
      };
      const contract = await publishContract(config, update ? current : undefined, update ? target : undefined);
      assert.equal(contract.mode, 'managed');
      assert.ok('managed' in contract);
      const origin = `${config.publicOrigin}${publicBasePath}`;
      assert.equal(contract.managed.publisherUrl, `${origin}/api/publisher-cli.py`);
      assert.equal(contract.managed.validationUrl, `${origin}/api/managed-publications/validate`);
      assert.equal(contract.managed.receiptUrl, `${origin}/api/managed-publications/receipt`);
      const prompt = contract.prompt;
      const preparation = prompt.indexOf('1. 先完成资料准备');
      const preflight = prompt.indexOf('5. 资料齐全后');
      const submission = prompt.indexOf('6. 预检通过');
      const handoff = prompt.indexOf('7. 只有工具确认');
      assert.ok(preparation >= 0 && preparation < preflight && preflight < submission && submission < handoff);
      const authorDeclaration = prompt.indexOf('任一缺失时先向我询问');
      assert.ok(authorDeclaration >= preparation && authorDeclaration < preflight, 'author declarations must be requested before preflight');
      assert.match(prompt.slice(preparation, preflight), /必需项补齐前不运行预检或上传/);
      assert.match(prompt.slice(preparation, preflight), /不把 maintainers: \[\]/);
      assert.match(prompt, /--validate 已包含本地检查/);
      assert.match(prompt, /本次仅运行预检时不执行 --status 或 --recover/);
      assert.match(prompt, /不能猜成天宫身份、版本、tag 或 Release 问题/);
      assert.match(prompt, /只有问题已修正或服务恢复后才重试/);
      assert.match(prompt, /已有本次授权时直接继续，不新增重复确认/);
      assert.match(prompt, /正式命令若仍停在本地资料检查，按第5条修正，不查回执/);
      assert.match(prompt, /只有正式提交请求已发出或工具报告已有原提交记录/);
      assert.match(prompt, /不调用确认接口或代我点击确认/);
      assert.match(prompt, /receipt 已安全保存、status 为 preview_ready 且取得有效 previewUrl/);
      assert.ok(!prompt.includes(config.managedPublishing!.token));
      const preflightLine = prompt.slice(preflight, prompt.indexOf('\n', preflight));
      const submissionLine = prompt.slice(submission, prompt.indexOf('\n', submission));
      for (const line of [preflightLine, submissionLine]) assert.ok(line.includes(`--origin "${origin}"`), 'every runnable command retains the complete portal prefix');
      assert.ok(preflightLine.includes('--validate'));
      assert.doesNotMatch(preflightLine, /--managed-app-id|--expected-revision/);
      if (update) {
        assert.ok(submissionLine.includes(`--managed-app-id "${target.managedAppId}"`));
        assert.equal(submissionLine.includes('--expected-revision 3'), withIdentity);
        if (withIdentity) assert.ok(!prompt.includes(`GET ${origin}/api/apps/${current.id}`), 'private updates use the maintenance page revision without sending browser identity to the Host');
      } else assert.doesNotMatch(submissionLine, /--managed-app-id|--expected-revision/);
    });
  }
});

test('HTTP publication -> confirmation -> catalog -> usage, with boundary failures', async t => {
  const gitlab = await startGitLabFixture();
  const db = await openDatabase({ path: 'memory://' });
  const config: Config = { host: '127.0.0.1', port: 4173, publicOrigin: 'http://127.0.0.1:4173', gitlabUrl: gitlab.url, secret: 'test-only-secret-key-with-more-than-32-characters', dataDir: '', local: true, audience: '所有能访问本门户的人', staticDir: resolve('not-built-test-static'), rateLimit: false };
  const { app } = await createApp(config, db);
  t.after(async () => { await app.close(); await db.close(); await gitlab.close(); });
  const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.inject({ method, url, payload, headers: { host: '127.0.0.1:4173', ...extra } });
  for (const path of ['/', '/index.html', '/admin']) {
    const missing = await request('GET', path);
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.json().error.code, 'FRONTEND_NOT_BUILT');
    assert.match(missing.json().error.message, /npm run build/);
  }
  assert.equal((await request('GET', '/api/apps')).json().total, 0);
  assert.equal((await request('GET', '/api/health')).json().loginRequired, false);
  const contract = (await request('GET', '/api/publish-contract')).json();
  assert.equal(contract.schema.properties.schemaVersion.const, '2');
  assert.ok(contract.prompt.includes('不要调用确认接口'));
  assert.ok(contract.prompt.includes('中文姓名和英文全名或完整拼音'));
  assert.ok(contract.prompt.includes('正式 GitLab Release'));
  assert.ok(contract.prompt.includes('Release.commit.id、tag.commit.id'));
  assert.deepEqual(contract.schema.properties.maintainers.items.required, ['name', 'nameEn']);
  const projectVersionPattern = new RegExp(contract.schema.properties.projectVersion.pattern);
  assert.equal(projectVersionPattern.test('1.2.3'), true);
  assert.equal(projectVersionPattern.test('1.2.3\n'), false, 'schema must reject a final line break');
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  assert.equal((await request('POST', '/api/publications', input)).statusCode, 401);
  const key = randomUUID();
  const submitHeaders = { 'x-gitlab-token': TOKEN, 'idempotency-key': key };
  assert.equal((await request('POST', '/api/publications', input, { ...submitHeaders, origin: 'https://attacker.invalid' })).statusCode, 403);
  assert.equal((await request('GET', '/api/apps', undefined, { host: 'attacker.invalid' })).statusCode, 403);
  assert.equal((await request('POST', '/api/publications', { ...input, commitSha: 'main' }, submitHeaders)).statusCode, 400);
  const { tag: _requiredTag, ...withoutTag } = input;
  assert.equal((await request('POST', '/api/publications', withoutTag, submitHeaders)).statusCode, 400);
  assert.equal((await request('POST', '/api/publications', { ...input, tag: 'v1.0.0\n' }, submitHeaders)).statusCode, 400, 'HTTP must reject a version with a final line break');
  assert.equal((await request('POST', '/api/publications', { ...input, projectId: Number.MAX_SAFE_INTEGER + 1 }, submitHeaders)).statusCode, 400);
  const submitted = await request('POST', '/api/publications', input, submitHeaders);
  assert.equal(submitted.statusCode, 201, submitted.body);
  const publication = submitted.json();
  assert.equal(publication.status, 'preview_ready', submitted.body);
  assert.equal((await request('GET', '/api/apps')).json().total, 0, 'unconfirmed draft must remain private');
  assert.equal((await request('GET', `/api/publications/${publication.id}`)).statusCode, 404);
  const owner = { authorization: `Bearer ${publication.ticket}` };
  assert.equal((await request('GET', `/api/publications/${publication.id}`, undefined, { authorization: 'Bearer wrong' })).statusCode, 404);
  const repeated = (await request('POST', '/api/publications', input, submitHeaders)).json();
  assert.equal(repeated.id, publication.id);
  assert.equal(repeated.ticket, publication.ticket);
  const badConfirmation = await request('POST', `/api/publications/${publication.id}/confirm`, { revision: publication.revision, digest: '0'.repeat(64) }, owner);
  assert.equal(badConfirmation.statusCode, 409);
  const confirmed = await request('POST', `/api/publications/${publication.id}/confirm`, { revision: publication.revision, digest: publication.digest }, owner);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().status, 'registered');
  const again = await request('POST', `/api/publications/${publication.id}/confirm`, { revision: publication.revision, digest: publication.digest }, owner);
  assert.equal(again.json().appId, confirmed.json().appId);
  const listing = (await request('GET', '/api/apps?query=Word&tags=%E6%96%87%E6%A1%A3%E5%A4%84%E7%90%86')).json();
  assert.equal(listing.total, 1);
  assert.equal((await request('GET', '/api/apps?tags=%E6%96%87%E6%A1%A3%E5%A4%84%E7%90%86&tags=%E4%BB%A3%E7%A0%81%E5%AE%A1%E6%9F%A5')).json().total, 0, 'tags are AND');
  const detail = (await request('GET', `/api/apps/${confirmed.json().appId}`)).json();
  assert.equal(detail.source.commitSha, SHA);
  assert.equal(detail.version, '1.0.0');
  assert.equal(detail.manifest.entries[0].url, 'https://example.invalid/docpilot');
  const instructions = (await request('GET', `/api/apps/${detail.id}/instructions/agent`)).json();
  assert.ok(instructions.text.includes('最小验证'));
  const publicText = JSON.stringify({ listing, detail, instructions });
  assert.ok(!publicText.includes(TOKEN) && !publicText.includes(publication.ticket));
  assert.ok(gitlab.state.requests.every(r => r.method === 'GET' || r.method === 'HEAD'), 'portal must never write GitLab');

  gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), schemaVersion: '1', maintainers: ['fixture-author'] }));
  const legacy = await request('POST', '/api/publications', input, { 'x-gitlab-token': TOKEN, 'idempotency-key': randomUUID() });
  assert.equal(legacy.statusCode, 201);
  assert.equal(legacy.json().error.code, 'VALIDATION_FAILED');
  assert.match(legacy.json().error.message, /schemaVersion 2.*GET \/api\/publish-contract/);
});
