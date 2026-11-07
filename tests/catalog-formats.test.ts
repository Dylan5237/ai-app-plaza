import test from 'node:test';
import assert from 'node:assert/strict';
import { appFormats, catalogPageCapacity, catalogUsage, platformEntry, primaryAction, safeHttpUrl } from '../src/lib/catalog.js';

test('card formats describe the delivered entry rather than its output or compatibility tools', () => {
  const skill = { manifest: { summary: '创建浏览器插件，使用 CLI 和 MCP 完成操作。', entries: [
    { id: 'create-browser-plugin', kind: 'agent', label: 'Agent 技能', instructionsPath: 'SKILL.md', compatibility: ['CLI', 'MCP'] },
  ] } };
  assert.deepEqual(appFormats(skill), ['Skill']);
  skill.manifest.entries[0].label = '创建浏览器插件的 Skill';
  assert.deepEqual(appFormats(skill), ['Skill']);
  assert.deepEqual(appFormats({ manifest: { entries: [{ id: 'agent-stdio', kind: 'agent', label: 'stdio MCP Server 与 CLI 接入' }] } }), ['MCP', 'CLI']);
  assert.deepEqual(appFormats({ manifest: { summary: 'DSH 连接集成插件包与便携部署发行', entries: [{ kind: 'agent', label: 'Agent 安装与升级（DSH Harness）' }] } }), ['插件']);
  assert.deepEqual(appFormats({ manifest: { entries: [{ kind: 'agent', label: '接入我的Agent' }] } }), ['Agent能力']);
});

test('flat all-results pages use every row while category pages reserve their heading', () => {
  const layout = { availableHeight: 400, columns: 4, cardHeight: 158, gap: 10, headingHeight: 30, usage: 'all' };
  assert.equal(catalogPageCapacity(layout), 8, 'mixed categories share the same two rows');
  assert.equal(catalogPageCapacity({ ...layout, availableHeight: 330 }), 8, 'all results do not reserve a category heading');
  assert.equal(catalogPageCapacity({ ...layout, availableHeight: 330, usage: 'platform' }), 4, 'category results still reserve their heading');
  assert.equal(catalogPageCapacity({ ...layout, usage: 'agent' }), 8);
  assert.equal(catalogPageCapacity({ ...layout, availableHeight: 480, columns: 1, cardHeight: 200 }), 2, 'mobile can show two cards in one grid');
});

test('mixed apps appear once as a platform and open a safe registered web entry', () => {
  const app = { manifest: { primaryEntry: 'agent-skill', entries: [
    { id: 'agent-skill', kind: 'agent', label: 'Skill' },
    { id: 'unsafe', kind: 'web', label: '无效入口', url: 'https://user:secret@example.invalid/' },
    { id: 'web', kind: 'web', label: '平台', url: 'https://example.invalid/app' },
  ] } };
  assert.equal(catalogUsage(app), 'platform');
  assert.deepEqual(appFormats(app), ['Web平台', 'Skill']);
  assert.equal(platformEntry(app)?.id, 'web');
  app.manifest.primaryEntry = 'unsafe';
  assert.equal(platformEntry(app)?.id, 'web');
  app.manifest.entries.push({ id: 'other', kind: 'web', label: '另一平台', url: 'https://example.invalid/other' });
  app.manifest.primaryEntry = 'other';
  assert.equal(platformEntry(app)?.id, 'other');
  for (const value of ['javascript:alert(1)', 'data:text/html,unsafe', '//example.invalid/', 'https://user:secret@example.invalid/']) assert.equal(safeHttpUrl(value), '');
  assert.equal(platformEntry({ manifest: { entries: [{ kind: 'web', url: 'javascript:alert(1)' }] } }), undefined);
});

test('card primary action honors the author, including missing, disabled and unsafe entries', () => {
  const app = { manifest: { primaryEntry: 'agent', entries: [
    { id: 'web', kind: 'web', url: 'https://example.invalid' },
    { id: 'agent', kind: 'agent', instructionsPath: 'docs/agent.md' },
  ] } };
  assert.equal(catalogUsage(app), 'platform');
  assert.equal(primaryAction(app).entry?.id, 'agent');
  assert.equal(primaryAction(app).label, '接入我的Agent');
  assert.equal(primaryAction(app).reason, '');
  assert.equal(primaryAction({ ...app, entryAvailability: { agent: { status: 'disabled', reason: '缺少分发源' } } }).reason, '缺少分发源');
  app.manifest.primaryEntry = 'web';
  assert.equal(primaryAction(app).label, '打开平台');
  app.manifest.entries[0]!.url = 'javascript:alert(1)';
  assert.match(primaryAction(app).reason, /不安全/);
  app.manifest.primaryEntry = 'missing';
  assert.equal(primaryAction(app).entry, undefined);
  assert.match(primaryAction(app).reason, /缺失/);
  assert.match(primaryAction({ manifest: { entries: [{ kind: 'web', url: 'https://example.invalid' }] } }).reason, /缺失/);
  assert.match(primaryAction({ ...app, lifecycle: { status: 'offline' } }).reason, /下架/);
});
