import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabSourceReader, validateProjectId } from '../server/domain/gitlab-source.js';
import { parseStrictJson } from '../server/domain/manifest.js';
import { DEFAULT_TAG, startGitLabFixture, SHA, TOKEN } from './helpers/gitlab-fixture.js';

test('source digest covers original bytes; unsafe file modes and conflicting tag targets are rejected', async t => {
  const gitlab = await startGitLabFixture();
  t.after(gitlab.close);
  const reader = new GitLabSourceReader(gitlab.url);
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const original = await reader.load(input, TOKEN);
  gitlab.state.files.set('docs/usage-1.md', '\ufeff' + gitlab.state.files.get('docs/usage-1.md'));
  const changed = await reader.load(input, TOKEN);
  assert.equal(changed.documents['docs/usage-1.md'], original.documents['docs/usage-1.md']);
  assert.notEqual(changed.digest, original.digest, 'a byte change must invalidate preview even if rendered text is identical');
  gitlab.state.modes.set('docs/usage-1.md', '120000');
  await assert.rejects(reader.load(input, TOKEN), /符号链接/);
  gitlab.state.modes.clear();
  gitlab.state.tagSha = 'b'.repeat(40);
  await assert.rejects(reader.load(input, TOKEN), /可能已移动/);
  gitlab.state.tagSha = SHA;
  gitlab.state.releasePresent = false;
  await assert.rejects(reader.load(input, TOKEN), /尚无正式 GitLab Release/);
  gitlab.state.releasePresent = true;
  gitlab.state.releaseSha = 'b'.repeat(40);
  await assert.rejects(reader.load(input, TOKEN), /Release 关联的 commit 与请求不一致/);
  gitlab.state.releaseSha = SHA;
  gitlab.state.files.set('ai-app.json', JSON.stringify({
    ...JSON.parse(gitlab.state.files.get('ai-app.json')!), projectVersion: '1.2.0',
  }));
  await assert.rejects(reader.load(input, TOKEN), /projectVersion 必须与 GitLab Release tag/);

  gitlab.state.tagName = 'v1.2.3-rc.1';
  gitlab.state.files.set('ai-app.json', JSON.stringify({
    ...JSON.parse(gitlab.state.files.get('ai-app.json')!), projectVersion: '1.2.3-rc.1',
  }));
  const prerelease = await reader.load({ ...input, tag: 'v1.2.3-rc.1' }, TOKEN);
  assert.equal(prerelease.version, '1.2.3-rc.1');
  await assert.rejects(reader.load({ ...input, tag: 'v1.2.3-rc.01' }, TOKEN), /合法预发布号/);
  await assert.rejects(reader.load({ ...input, tag: 'v1.2.3\n' }, TOKEN), /合法预发布号/);
  gitlab.state.files.set('ai-app.json', JSON.stringify({
    ...JSON.parse(gitlab.state.files.get('ai-app.json')!), projectVersion: '1.2.3\n',
  }));
  await assert.rejects(reader.load({ ...input, tag: 'v1.2.3-rc.1' }, TOKEN), /projectVersion 必须是有效的/);
});

test('JSON and numeric identity parsing cannot silently change the submitted contract', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"a":1,"a":2}}', '{"a":1,}', '{/* comment */"a":1}', '{"a":1}{}']) {
    assert.throws(() => parseStrictJson(text));
  }
  assert.deepEqual(parseStrictJson('{"a":[1,"x"]}'), { a: [1, 'x'] });
  assert.throws(() => validateProjectId(Number.MAX_SAFE_INTEGER + 1), /安全整数/);
  assert.equal(validateProjectId('9007199254740993'), '9007199254740993');
});
