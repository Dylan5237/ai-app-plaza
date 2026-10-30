import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeLegacyGuide, normalizeLegacyRequirements, prepareLegacyDistribution } from '../server/domain/legacy-distribution.js';
import { manifest } from './helpers/gitlab-fixture.js';

const gitlab = 'http://gitlab.example.invalid:11980';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

test('legacy guides replace repository acquisition but preserve build and use instructions', () => {
  const input = '# 安装\n\n- 仓库地址：尚未分配（托管空间还在准备；\n  或直接用广场应用页给出的链接）\n\n## 固定版本取得\n从私有 GitLab 获取。\n\n## 源码安装与本地配置\n源码可以下载固定 commit 的源码包，或使用下面的 Git 方式。\n```sh\ngit clone --no-checkout https://example.invalid/private.git app\ncd app\ngit checkout --detach abcdef\nnpm ci\nnpm run build\n```\n\n## 最小验证\n查看工具清单。';
  const guide = normalizeLegacyGuide(input, gitlab);
  assert.match(guide, /广场下载当前入口的固定分发包/);
  assert.match(guide, /npm ci/);
  assert.match(guide, /npm run build/);
  assert.match(guide, /查看工具清单/);
  assert.doesNotMatch(guide, /git clone|git checkout|GitLab|example\.invalid\/private|Git 方式|仓库地址：尚未分配|应用页给出的链接/);
});

test('legacy version marker remains provenance and does not become an installation source', () => {
  const guide = normalizeLegacyGuide('# 安装\n## 固定版本取得\n从 **v1.1.1 正式 GitLab Release** 取得源码。\n## 安装\n复制解压内容。', gitlab);
  assert.match(guide, /\*\*v1\.1\.1 正式 GitLab Release\*\*/);
  assert.match(guide, /仅供溯源，安装仍使用广场固定分发包/);
  assert.doesNotMatch(guide, /从 \*\*v1\.1\.1 正式 GitLab Release\*\* 取得/);
});

test('legacy source permissions are removed from displayed requirements while runtime prerequisites remain', () => {
  const original = ['源码安装需要 Node.js 18 或更高版本、npm，以及固定来源的仓库读取权限和依赖下载网络；通过 Git 取得源码时还需要 Git。',
    '从接入提示词给出的统一托管来源项目和固定 commit 取得 v0.2.1 源码，不使用浮动 main；构建后确认包版本为 0.2.1。',
    '完整回归需要 requirements-dev.txt 中的 pytest；固定版本源码需从接入提示词指定的来源项目和完整 commit 取得。',
    '业务任务需要访问用户指定的 GitLab 项目。'];
  const displayed = normalizeLegacyRequirements(original);
  assert.match(displayed[0]!, /Node\.js 18/);
  assert.match(displayed[0]!, /依赖下载网络/);
  assert.match(displayed[1]!, /v0\.2\.1/);
  assert.match(displayed[2]!, /pytest/);
  assert.doesNotMatch(displayed.slice(0, 3).join('\n'), /仓库读取权限|通过 Git 取得|来源项目/);
  assert.equal(displayed[3], original[3]);
  assert.match(original[0]!, /仓库读取权限/, 'the source manifest remains unchanged');
});

test('legacy refresh preserves skill content and a nested app scope, updating its integrity list', () => {
  const value: any = manifest();
  value.docs = { readme: 'daily/docs/plaza-usage.md', usage: 'daily/docs/plaza-usage.md' };
  value.entries = [{ id: 'agent', kind: 'agent', label: '技能', instructionsPath: 'daily/SKILL.md', compatibility: ['Codex'] }];
  value.primaryEntry = 'agent';
  const guide = '# 说明\n## 固定版本取得\ngit clone https://example.invalid/repo.git\n## 安装\n复制整个目录。';
  const skill = '# 技能正文\n业务任务可能读取用户指定的 GitLab 项目。';
  const inventory = JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', files: { 'docs/plaza-usage.md': hash(guide), 'SKILL.md': hash(skill) } });
  const source = { files: new Map([['daily/docs/plaza-usage.md', Buffer.from(guide)], ['daily/SKILL.md', Buffer.from(skill)],
    ['daily/distribution-files.json', Buffer.from(inventory)], ['other/private.txt', Buffer.from('unrelated')], ['daily/.env', Buffer.from('secret')]]), executable: new Set<string>() };
  const [result] = prepareLegacyDistribution({ manifest: value, manifestPath: 'daily/ai-app.json', documents: { 'daily/docs/plaza-usage.md': guide }, source, gitlabUrl: gitlab, token: 'fixture-token' });
  assert.ok(result);
  assert.deepEqual(result.excludedPaths, ['daily/.env']);
  assert.deepEqual(result.transformedPaths, ['daily/docs/plaza-usage.md', 'daily/distribution-files.json']);
  assert.equal(result.pack.files.find(file => file.path === 'daily/SKILL.md')?.sha256, hash(skill));
  assert.ok(!result.pack.files.some(file => file.path.startsWith('other/')));
  assert.doesNotMatch(result.guide, /git clone|GitLab/);
  assert.throws(() => prepareLegacyDistribution({ manifest: value, manifestPath: 'another/ai-app.json', documents: { 'daily/docs/plaza-usage.md': guide }, source, gitlabUrl: gitlab, token: 'fixture-token' }), (error: any) => error.code === 'LEGACY_SCOPE_AMBIGUOUS');
  source.files.set('daily/distribution-files.json', Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', files: { '.env': hash('secret') } })));
  assert.throws(() => prepareLegacyDistribution({ manifest: value, manifestPath: 'daily/ai-app.json', documents: { 'daily/docs/plaza-usage.md': guide }, source, gitlabUrl: gitlab, token: 'fixture-token' }), (error: any) => error.code === 'LEGACY_INTEGRITY_MISMATCH');
  source.files.set('daily/distribution-files.json', Buffer.from(inventory));
  source.files.set('daily/SKILL.md', Buffer.from('changed'));
  assert.throws(() => prepareLegacyDistribution({ manifest: value, manifestPath: 'daily/ai-app.json', documents: { 'daily/docs/plaza-usage.md': guide }, source, gitlabUrl: gitlab, token: 'fixture-token' }), (error: any) => error.code === 'LEGACY_INTEGRITY_MISMATCH');
});

test('remote MCP entry uses only its dedicated connection section', () => {
  const value: any = manifest();
  value.entries = [{ id: 'agent-remote', kind: 'agent', label: '远程 MCP', instructionsPath: 'docs/agent-1.md', compatibility: ['Streamable HTTP'] }];
  value.primaryEntry = 'agent-remote';
  const text = '# 使用\n## 取得固定版本\ngit clone https://example.invalid/repo.git\n## 连接现有远程 MCP\nMCP 地址：https://example.invalid/mcp\n由本人完成业务授权。\n## 最小验证\n查看工具。';
  const source = { files: new Map([['docs/usage-1.md', Buffer.from(text)], ['src/main.js', Buffer.from('console.log(1)')]]), executable: new Set<string>() };
  const [result] = prepareLegacyDistribution({ manifest: value, manifestPath: 'ai-app.json', documents: { 'docs/usage-1.md': text }, source, gitlabUrl: gitlab, token: 'fixture-token' });
  assert.equal(result?.delivery, 'remote');
  assert.match(result!.guide, /https:\/\/example\.invalid\/mcp/);
  assert.doesNotMatch(result!.guide, /git clone|repo\.git/);
});

test('legacy packages reject repository dependencies in lockfiles and installation scripts', () => {
  const value: any = manifest();
  value.entries = [{ id: 'agent', kind: 'agent', label: '技能', instructionsPath: 'docs/usage-1.md', compatibility: ['Codex'] }];
  value.primaryEntry = 'agent';
  const guide = '# 安装\n## 安装\n解压广场分发包。';
  const source = { files: new Map([['docs/usage-1.md', Buffer.from(guide)], ['requirements.txt', Buffer.from('x @ git+https://example.invalid/x.git')]]), executable: new Set<string>() };
  const input = { manifest: value, manifestPath: 'ai-app.json', documents: { 'docs/usage-1.md': guide }, source, gitlabUrl: gitlab, token: 'fixture-token' };
  assert.throws(() => prepareLegacyDistribution(input), (error: any) => error.code === 'LEGACY_DEPENDENCY_CONFLICT');
  source.files.delete('requirements.txt');
  source.files.set('install.sh', Buffer.from('git -C /tmp clone https://example.invalid/x.git'));
  assert.throws(() => prepareLegacyDistribution(input), (error: any) => error.code === 'LEGACY_DEPENDENCY_CONFLICT');
});
