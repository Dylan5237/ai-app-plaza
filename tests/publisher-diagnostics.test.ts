import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/publisher-cli.py');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const RESPONSE_SECRET = 'PRIVATE_RESPONSE_SENTINEL';
const SOURCE_SECRET = 'PRIVATE_SOURCE_SENTINEL';

function runCli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-u', cliPath, ...args], {
      env: { ...process.env, PYTHONUTF8: '1' }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', code => resolve({
      code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function projectFixture(t: { after: (callback: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-diagnostics-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'private-project');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const manifest = {
    schemaVersion: '2', appKey: 'sample-diagnostics', name: '离线测试', summary: '诊断回归',
    projectVersion: '1.0.0', tags: ['测试'], maintainers: [{ name: '测试作者', nameEn: 'Test Author' }],
    capabilities: { scenarios: ['测试'], inputs: [], outputs: ['结果'] },
    examples: [{ request: '开始', expectedResult: '完成' }], requirements: [], limitations: [],
    docs: { readme: 'docs/README.md', usage: 'docs/usage.md' },
    entries: [{ id: 'agent', kind: 'agent', label: 'Agent', instructionsPath: 'docs/agent.md', compatibility: ['Codex'] }],
    primaryEntry: 'agent',
  };
  await writeFile(path.join(root, 'ai-app.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'docs/README.md'), '# 离线测试\n');
  await writeFile(path.join(root, 'docs/usage.md'), '使用说明\n');
  await writeFile(path.join(root, 'docs/agent.md'), '接入说明\n');
  await writeFile(path.join(root, 'main.py'), `print("${SOURCE_SECRET}")\n`);
  const stateDir = path.join(temporary, 'private-state');
  return { root, manifest, stateDir, manifestPath: path.join(root, 'ai-app.json') };
}

async function portalFixture(handler: (response: ServerResponse) => void) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the credential-free preflight body */ }
    requests += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/managed-publications/validate');
    assert.equal(request.headers['x-plaza-publish-key'], undefined);
    assert.equal(request.headers['idempotency-key'], undefined);
    handler(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function assertPrivate(result: { stdout: string; stderr: string }, root: string, ...extras: string[]) {
  const output = result.stdout + result.stderr;
  for (const value of [root, root.replaceAll('\\', '/'), SOURCE_SECRET, RESPONSE_SECRET, ...extras]) {
    assert.ok(!output.includes(value), 'diagnostics must not echo private inputs or raw response content');
  }
  assert.ok(!output.includes('receipt 已保留'), 'preflight must not claim that a receipt exists');
}

test('local manifest diagnostics identify maintainers and other failing fields without HTTP or receipts', async t => {
  const fixture = await projectFixture(t);
  const portal = await portalFixture(response => { response.writeHead(500); response.end(); });
  t.after(portal.close);
  const cases = [
    { patch: { maintainers: [] }, code: 'MAINTAINER_NAME_REQUIRED', field: 'maintainers', hint: /name.*nameEn.*Git\/GitLab/ },
    { patch: { maintainers: [{ name: '测试作者' }] }, code: 'MAINTAINER_NAME_REQUIRED', field: 'maintainers[0].nameEn', hint: /英文全名或完整拼音/ },
    { patch: { docs: null }, code: 'MANIFEST_SCHEMA_INVALID', field: 'docs', hint: /readme.*usage/ },
    { patch: { entries: null }, code: 'MANIFEST_SCHEMA_INVALID', field: 'entries', hint: /entries/ },
    { patch: { docs: { readme: '../PRIVATE_PATH_SENTINEL.md', usage: 'docs/usage.md' } }, code: 'REPOSITORY_PATH_INVALID', field: 'docs.readme', hint: /相对路径/ },
    { patch: { entries: [{ kind: 'agent', instructionsPath: 'https://private.invalid/PRIVATE_PATH_SENTINEL' }] }, code: 'REPOSITORY_PATH_INVALID', field: 'entries[0].instructionsPath', hint: /相对路径/ },
    { patch: { entries: [{ kind: 'agent', instructionsPath: 'docs/agent.md', distribution: { type: 'source', files: [] } }] }, code: 'DISTRIBUTION_FILE_INVALID', field: 'entries[0].distribution', hint: /type.*files/ },
    { patch: { schemaVersion: '1' }, code: 'SCHEMA_VERSION_UNSUPPORTED', field: 'schemaVersion', hint: /schemaVersion 2/ },
    { patch: { appKey: 'Upper Case' }, code: 'APP_KEY_INVALID', field: 'appKey', hint: /小写字母/ },
    { patch: { projectVersion: '1.0' }, code: 'PROJECT_VERSION_INVALID', field: 'projectVersion', hint: /MAJOR.MINOR.PATCH/ },
    { patch: { tags: ['test', 'ＴＥＳＴ'] }, code: 'CAPABILITY_TAGS_INVALID', field: 'tags', hint: /唯一/ },
  ];
  for (const scenario of cases) {
    await writeFile(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, ...scenario.patch }));
    const result = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
    assert.equal(result.code, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.stage, 'local_validation');
    assert.equal(output.httpStatus, undefined);
    assert.equal(output.diagnostics[0].code, scenario.code);
    assert.equal(output.diagnostics[0].field, scenario.field);
    assert.equal(output.diagnostics[0].path, 'ai-app.json');
    assert.match(output.diagnostics[0].suggestion, scenario.hint);
    assertPrivate(result, fixture.root, 'PRIVATE_PATH_SENTINEL');
  }
  assert.equal(portal.requests(), 0);
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('local JSON, UTF-8 and missing document diagnostics retain only safe locations', async t => {
  const fixture = await projectFixture(t);
  const portal = await portalFixture(response => { response.writeHead(500); response.end(); });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--dry-run'];
  const cases = [
    { content: Buffer.from('{\n  "schemaVersion":\n}'), code: 'MANIFEST_JSON_INVALID', line: 3, column: 1 },
    { content: Buffer.from([0xff, 0xfe]), code: 'MANIFEST_UTF8_INVALID' },
    { content: Buffer.from('{"schemaVersion":"2","schemaVersion":"2"}'), code: 'MANIFEST_JSON_INVALID' },
  ];
  for (const scenario of cases) {
    await writeFile(fixture.manifestPath, scenario.content);
    const result = await runCli(args);
    assert.equal(result.code, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.stage, 'local_validation');
    assert.equal(output.diagnostics[0].code, scenario.code);
    assert.equal(output.diagnostics[0].path, 'ai-app.json');
    assert.equal(output.diagnostics[0].line, scenario.line);
    assert.equal(output.diagnostics[0].column, scenario.column);
    assertPrivate(result, fixture.root);
  }
  await writeFile(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, docs: { ...fixture.manifest.docs, usage: 'docs/missing.md' } }));
  const missing = await runCli(args);
  assert.equal(missing.code, 2);
  const missingOutput = JSON.parse(missing.stdout);
  assert.equal(missingOutput.diagnostics[0].code, 'DOCUMENT_MISSING');
  assert.equal(missingOutput.diagnostics[0].path, 'docs/missing.md');
  assert.match(missingOutput.diagnostics[0].suggestion, /补齐.*文件.*修正.*引用/);
  await rm(fixture.manifestPath);
  const noManifest = await runCli(args);
  assert.equal(JSON.parse(noManifest.stdout).diagnostics[0].code, 'MANIFEST_MISSING');
  assert.equal(portal.requests(), 0);
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('local size and unsafe secret-path diagnostics remain actionable without leaking input', async t => {
  const fixture = await projectFixture(t);
  const args = ['--origin', 'http://127.0.0.1:9', '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate'];
  await writeFile(path.join(fixture.root, 'large.py'), Buffer.alloc(5 * 1024 * 1024 + 1, 32));
  const oversized = await runCli(args);
  assert.equal(oversized.code, 2);
  const largeOutput = JSON.parse(oversized.stdout);
  assert.equal(largeOutput.stage, 'local_validation');
  assert.equal(largeOutput.diagnostics[0].code, 'FILE_SIZE_EXCEEDED');
  assert.equal(largeOutput.diagnostics[0].path, 'large.py');
  assert.match(largeOutput.diagnostics[0].suggestion, /5 MiB/);
  await rm(path.join(fixture.root, 'large.py'));
  const privatePath = 'LOCAL_PRIVATE_CREDENTIAL_PATH_SENTINEL_LONG.py';
  const privateValue = 'LOCAL_PRIVATE_CREDENTIAL_VALUE_SENTINEL';
  await writeFile(path.join(fixture.root, privatePath), `password = "${privateValue}"\n`);
  const secret = await runCli(args);
  const secretOutput = JSON.parse(secret.stdout);
  assert.equal(secretOutput.diagnostics[0].code, 'SECRET_MARKER_FOUND');
  assert.equal(secretOutput.diagnostics[0].path, undefined);
  assert.match(secretOutput.diagnostics[0].suggestion, /运行时配置/);
  assertPrivate(secret, fixture.root, privatePath, privateValue);
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('preflight HTTP rejections expose observed status and maintainer next steps, including repeated 404', async t => {
  const fixture = await projectFixture(t);
  for (const status of [404, 404, 405, 401, 403, 413, 429, 500, 503, 302, 201]) {
    const portal = await portalFixture(response => {
      response.writeHead(status, { 'content-type': 'application/json', location: '/PRIVATE_REDIRECT_SENTINEL' });
      response.end(JSON.stringify({ error: { code: RESPONSE_SECRET, message: RESPONSE_SECRET }, requestId: RESPONSE_SECRET }));
    });
    try {
      const result = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
      assert.equal(result.code, 2);
      const output = JSON.parse(result.stdout);
      assert.equal(output.stage, 'portal_response');
      assert.equal(output.httpStatus, status);
      assert.equal(output.diagnostics[0].code, 'PORTAL_REJECTED');
      assert.equal(output.diagnostics[0].field, undefined);
      assert.match(output.diagnostics[0].suggestion, new RegExp(`HTTP ${status}`));
      assert.match(output.diagnostics[0].suggestion, /维护人/);
      if (status === 404 || status === 405) assert.match(output.diagnostics[0].suggestion, /挂载路径.*代理路由.*部署版本/);
      if (status >= 500) assert.match(output.diagnostics[0].suggestion, /发生时间.*网关错误日志.*临时目录权限.*上游服务.*不能确定/);
      assertPrivate(result, fixture.root, 'PRIVATE_REDIRECT_SENTINEL');
      assert.equal(portal.requests(), 1);
    } finally {
      await portal.close();
    }
  }
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('HTTP 400 without allowlisted diagnostics escalates to maintainers instead of inventing a local field', async t => {
  const fixture = await projectFixture(t);
  for (const body of [
    '<html>' + RESPONSE_SECRET + '</html>',
    JSON.stringify({ error: { message: RESPONSE_SECRET } }),
    JSON.stringify({ error: { diagnostics: [{ code: 'UNTRUSTED_CODE', ruleId: 'untrusted.rule', field: RESPONSE_SECRET, suggestion: RESPONSE_SECRET }] } }),
  ]) {
    const portal = await portalFixture(response => { response.writeHead(400); response.end(body); });
    try {
      const result = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
      assert.equal(result.code, 2);
      const output = JSON.parse(result.stdout);
      assert.equal(output.stage, 'portal_validation');
      assert.equal(output.httpStatus, 400);
      assert.equal(output.diagnostics[0].code, 'PORTAL_DIAGNOSTICS_UNAVAILABLE');
      assert.equal(output.diagnostics[0].path, undefined);
      assert.equal(output.diagnostics[0].field, undefined);
      assert.match(output.diagnostics[0].suggestion, /可安全展示.*维护人.*日志/);
      assertPrivate(result, fixture.root);
      assert.equal(portal.requests(), 1);
    } finally { await portal.close(); }
  }
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('preflight only reports confirmed service reasons for the matching HTTP status', async t => {
  const fixture = await projectFixture(t);
  for (const [status, serverCode, action] of [
    [503, 'MANAGED_PUBLISH_DISABLED', '启用'], [429, 'UPLOAD_BUSY', '名额'], [403, 'HOST_DENIED', 'Host'],
    [500, 'MANAGED_PUBLISH_DISABLED', undefined],
  ] as const) {
    const portal = await portalFixture(response => {
      response.writeHead(status);
      response.end(JSON.stringify({ error: { code: serverCode, message: RESPONSE_SECRET } }));
    });
    try {
      const run = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
      const output = JSON.parse(run.stdout);
      assert.equal(run.code, 2);
      assert.equal(output.httpStatus, status);
      assert.equal(output.diagnostics[0].code, 'PORTAL_REJECTED');
      assert.equal(output.diagnostics[0].serverCode, action ? serverCode : undefined);
      if (action) assert.ok(output.diagnostics[0].suggestion.includes(action));
      assertPrivate(run, fixture.root);
    } finally { await portal.close(); }
  }
});

test('server validation preserves safe maintainer and Skill installation guidance and locators', async t => {
  const fixture = await projectFixture(t);
  const diagnostics = [
    { code: 'MAINTAINER_NAME_REQUIRED', ruleId: 'managed.bundle.maintainer_name',
      path: 'ai-app.json', field: 'maintainers[0].nameEn', suggestion: '向作者确认并填写双语姓名，不要根据 GitLab 或 Git 配置推测。' },
    { code: 'INSTALL_SOURCE_CONFLICT', ruleId: 'managed.bundle.install_source',
      path: 'docs/install.md', field: 'entries', suggestion: '将安装与升级步骤修订为广场分发包，重新校验。' },
    { code: 'DISTRIBUTION_FILE_MISSING', ruleId: 'managed.bundle.distribution_file',
      path: 'SKILL.md', field: 'entries', suggestion: '补齐清单中的必要文件后重新校验。' },
  ];
  const portal = await portalFixture(response => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: RESPONSE_SECRET, diagnostics } }));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stage, 'portal_validation');
  assert.equal(output.httpStatus, 400);
  assert.deepEqual(output.diagnostics, diagnostics);
  assertPrivate(result, fixture.root);
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('known server rules with unsafe locators preserve the rule and request maintainer diagnostics', async t => {
  const fixture = await projectFixture(t);
  const portal = await portalFixture(response => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: RESPONSE_SECRET, diagnostics: [{
      code: 'SECRET_MARKER_FOUND', ruleId: 'managed.bundle.secret_marker',
      path: 'C:\\private\\' + RESPONSE_SECRET, field: RESPONSE_SECRET.repeat(2), suggestion: RESPONSE_SECRET,
    }] } }));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stage, 'portal_validation');
  assert.equal(output.httpStatus, 400);
  assert.equal(output.diagnostics[0].code, 'SECRET_MARKER_FOUND');
  assert.equal(output.diagnostics[0].path, undefined);
  assert.equal(output.diagnostics[0].field, undefined);
  assert.match(output.diagnostics[0].suggestion, /未提供可安全展示.*维护人.*诊断/);
  assertPrivate(result, fixture.root);
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('invalid and oversized HTTP 200 responses identify the response stage without a guessed project fix', async t => {
  const fixture = await projectFixture(t);
  for (const body of [
    '<html>' + RESPONSE_SECRET + '</html>',
    '[]',
    JSON.stringify({ status: 'validated', published: false, sourceUploaded: false, fileCount: true, totalBytes: 12 }),
    JSON.stringify({ status: 'validated', published: true, sourceUploaded: true, fileCount: 5, totalBytes: 12 }),
    ' '.repeat(2 * 1024 * 1024 + 1),
  ]) {
    const portal = await portalFixture(response => { response.writeHead(200); response.end(body); });
    try {
      const result = await runCli(['--origin', portal.origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
      assert.equal(result.code, 2);
      const output = JSON.parse(result.stdout);
      assert.equal(output.stage, 'portal_response');
      assert.equal(output.httpStatus, 200);
      assert.equal(output.diagnostics[0].code, 'PORTAL_RESPONSE_INVALID');
      assert.match(output.diagnostics[0].suggestion, /维护人.*接口.*部署版本/);
      assertPrivate(result, fixture.root);
      assert.equal(portal.requests(), 1);
    } finally { await portal.close(); }
  }
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});

test('an unreachable portal identifies the request stage without claiming a receipt or server diagnosis', async t => {
  const fixture = await projectFixture(t);
  const portal = await portalFixture(response => { response.destroy(); });
  const origin = portal.origin;
  await portal.close();
  const before = await readFile(fixture.manifestPath, 'utf8');
  const result = await runCli(['--origin', origin, '--project', fixture.root, '--state-dir', fixture.stateDir, '--validate']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stage, 'portal_request');
  assert.equal(output.httpStatus, undefined);
  assert.equal(output.diagnostics[0].code, 'PORTAL_UNAVAILABLE');
  assert.match(output.diagnostics[0].suggestion, /--origin.*网络连通性.*维护人/);
  assertPrivate(result, fixture.root);
  assert.equal(await readFile(fixture.manifestPath, 'utf8'), before);
  await assert.rejects(access(fixture.stateDir), { code: 'ENOENT' });
});
