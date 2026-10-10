import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabSourceReader, validateProjectId } from '../server/domain/gitlab-source.js';
import { parseStrictJson } from '../server/domain/manifest.js';
import { startGitLabFixture, SHA, TOKEN } from './helpers/gitlab-fixture.js';

test('source digest covers original bytes; unsafe file modes and conflicting tag targets are rejected', async t => {
  const gitlab = await startGitLabFixture();
  t.after(gitlab.close);
  const reader = new GitLabSourceReader(gitlab.url);
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA };
  const original = await reader.load(input, TOKEN);
  gitlab.state.files.set('docs/usage-1.md', '\ufeff' + gitlab.state.files.get('docs/usage-1.md'));
  const changed = await reader.load(input, TOKEN);
  assert.equal(changed.documents['docs/usage-1.md'], original.documents['docs/usage-1.md']);
  assert.notEqual(changed.digest, original.digest, 'a byte change must invalidate preview even if rendered text is identical');
  gitlab.state.modes.set('docs/usage-1.md', '120000');
  await assert.rejects(reader.load(input, TOKEN), /符号链接/);
  gitlab.state.modes.clear();
  gitlab.state.tagSha = 'b'.repeat(40);
  await assert.rejects(reader.load({ ...input, tag: 'v1.0.0' }, TOKEN), /tag 当前未指向/);
});

test('JSON and numeric identity parsing cannot silently change the submitted contract', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"a":1,"a":2}}', '{"a":1,}', '{/* comment */"a":1}', '{"a":1}{}']) {
    assert.throws(() => parseStrictJson(text));
  }
  assert.deepEqual(parseStrictJson('{"a":[1,"x"]}'), { a: [1, 'x'] });
  assert.throws(() => validateProjectId(Number.MAX_SAFE_INTEGER + 1), /安全整数/);
  assert.equal(validateProjectId('9007199254740993'), '9007199254740993');
});
