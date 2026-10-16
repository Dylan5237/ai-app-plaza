import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'server', 'publisher-cli.py');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const MANAGED_ID = 'a86c662d-9f95-4553-8bde-763bb7c8e5a1';
const WRONG_MANAGED_ID = '08fe067e-0b3a-41d1-9b88-c4d27a5d7bb1';
const PUBLIC_ID = '8c6dd160-f247-4ff9-8653-b62b7f2866e0';
const PUBLICATION_ID = '43d40f2f-41bd-49c7-9466-26b8b2e744c4';
const PREVIEW_TICKET = 'A'.repeat(43);

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
};

type PortalHandler = (request: CapturedRequest, response: ServerResponse) => void | Promise<void>;

async function createPortal(handler: PortalHandler) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    await handler({
      method: request.method || '',
      url: request.url || '',
      headers: request.headers,
      body: Buffer.concat(chunks),
    }, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function makeProject(parent: string) {
  const root = path.join(parent, 'project');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  const manifest = {
    schemaVersion: '2',
    appKey: 'demo-assistant',
    name: '本地演示助手',
    summary: '本地发布客户端测试应用',
    projectVersion: '1.2.3',
    tags: ['demo'],
    maintainers: [{ name: '测试作者', nameEn: 'Test Author' }],
    capabilities: { scenarios: ['测试'], inputs: [], outputs: ['结果'] },
    examples: [{ request: '开始', expectedResult: '完成' }],
    requirements: [],
    limitations: [],
    docs: { readme: 'docs/README.md', usage: 'docs/usage.md' },
    entries: [{
      id: 'agent-setup', kind: 'agent', label: 'Agent 接入',
      instructionsPath: 'docs/instructions.md', compatibility: ['Codex'],
    }],
    primaryEntry: 'agent-setup',
  };
  await writeFile(path.join(root, 'ai-app.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(root, 'docs', 'README.md'), '# 本地演示助手\n');
  await writeFile(path.join(root, 'docs', 'usage.md'), '使用说明\n');
  await writeFile(path.join(root, 'docs', 'instructions.md'), '接入说明\n');
  await writeFile(path.join(root, 'src', 'main.py'), 'print("SOURCE_SENTINEL")\n');
  return root;
}

type CliInjection = 'post-response-save-failure' | 'receipt-open-permission' | 'receipt-recovery-url-tamper';

function runCli(args: string[], injectionMode: CliInjection | false = false) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const injection = `import importlib.util,os,sys
target=os.environ['PLAZA_TEST_CLI_PATH']
spec=importlib.util.spec_from_file_location('publisher_cli_test_target', target)
module=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=module
spec.loader.exec_module(module)
if os.environ['PLAZA_TEST_INJECTION'] == 'receipt-open-permission':
 def fail_open(self, *args, **kwargs): raise PermissionError('STATUS_RECEIPT_SECRET_SENTINEL')
 module.ReceiptStore.open=fail_open
elif os.environ['PLAZA_TEST_INJECTION'] == 'receipt-recovery-url-tamper':
 original=module.ReceiptStore.open
 def tamper_recovery_url(self, *args, **kwargs):
  receipt=original(self, *args, **kwargs)
  if receipt is not None:
   receipt['recoveryUrl']=receipt['identity']['origin'] + '/#publish=' + receipt['publicationId'] + '&key=' + ('B'*43)
  return receipt
 module.ReceiptStore.open=tamper_recovery_url
else:
 original=module.ReceiptStore.save
 count=0
 def fail_second_save(self, receipt):
  global count
  count+=1
  if count==2: raise module.CliError('injected receipt save failure')
  return original(self, receipt)
 module.ReceiptStore.save=fail_second_save
sys.argv=[target,*sys.argv[1:]]
raise SystemExit(module.main())`;
    const child = spawn(python, injectionMode ? ['-c', injection, ...args] : ['-u', cliPath, ...args], {
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        ...(injectionMode ? { PLAZA_TEST_CLI_PATH: cliPath, PLAZA_TEST_INJECTION: injectionMode } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

test('CLI dry-run permits three tags and rejects four or normalized duplicates without network or receipts', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-tags-cli-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const file = path.join(root, 'ai-app.json');
  const source = JSON.parse(await readFile(file, 'utf8'));
  const state = path.join(temporary, 'private-state');
  let requests = 0;
  const portal = await createPortal((_request, response) => { requests++; response.writeHead(500); response.end(); });
  t.after(() => portal.close());
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', state, '--dry-run'];
  await writeFile(file, JSON.stringify({ ...source, tags: ['MCP', '需求管理', 'AI协作'] }));
  assert.equal((await runCli(args)).code, 0);
  await writeFile(file, JSON.stringify({ ...source, tags: ['MCP', '需求管理', 'AI协作', '第四项'] }));
  const four = await runCli(args);
  assert.equal(four.code, 2);
  assert.equal(JSON.parse(four.stdout).diagnostics[0].code, 'CAPABILITY_TAGS_INVALID');
  await writeFile(file, JSON.stringify({ ...source, tags: ['MCP', 'ｍｃｐ'] }));
  const duplicate = await runCli(args);
  assert.equal(duplicate.code, 2);
  assert.equal(JSON.parse(duplicate.stdout).diagnostics[0].field, 'tags');
  await writeFile(file, JSON.stringify({ ...source, tags: ['😀'.repeat(32)] }));
  assert.equal((await runCli(args)).code, 0);
  await writeFile(file, JSON.stringify({ ...source, tags: ['😀'.repeat(33)] }));
  assert.equal((await runCli(args)).code, 2);
  assert.equal(requests, 0);
  await assert.rejects(access(state), { code: 'ENOENT' });
});

test('--validate sends one credential-free preflight per invocation and never creates receipt state', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-validate-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/managed-publications/validate');
    assert.equal(request.headers['idempotency-key'], undefined);
    assert.equal(request.headers['x-plaza-publish-key'], undefined);
    const candidate = decodedBody(request);
    assert.equal(candidate.appKey, 'demo-assistant');
    assert.equal(candidate.manifestPath, 'ai-app.json');
    assert.equal(candidate.files.length, 5);
    respondJson(response, { status: 'validated', published: false, sourceUploaded: false, fileCount: 5, totalBytes: 321 });
  });
  t.after(portal.close);

  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--validate'];
  for (let index = 0; index < 2; index += 1) {
    const result = await runCli(args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'validated', published: false, sourceUploaded: false, fileCount: 5, totalBytes: 321,
    });
    await assert.rejects(access(stateDir), { code: 'ENOENT' });
  }
  assert.equal(requests.length, 2, 'each validate makes exactly one preflight request and no other request');
});

test('--validate returns sanitized allowlisted server diagnostics as machine JSON', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-validate-diagnostic-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const secrets = ['SERVER_DIAGNOSTIC_SECRET_SENTINEL', 'diagnostic-hidden-secret'];
  let requests = 0;
  const portal = await createPortal((request, response) => {
    requests += 1;
    assert.equal(request.url, '/api/managed-publications/validate');
    assert.equal(request.headers['idempotency-key'], undefined);
    assert.equal(request.headers['x-plaza-publish-key'], undefined);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: {
      code: 'VALIDATION_FAILED', message: secrets[0], diagnostics: [{
        code: 'SECRET_MARKER_FOUND', ruleId: 'managed.bundle.secret_marker', path: 'src/main.py',
        field: 'files[0].content', line: 3, column: 5, suggestion: secrets[1],
      }, {
        code: 'UNTRUSTED_CODE', ruleId: 'evil.rule', path: 'C:\\private\\credential.txt',
        field: secrets[0], suggestion: secrets[0],
      }],
    } }));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--validate']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(output.status, 'validation_failed');
  assert.equal(output.published, false);
  assert.equal(output.sourceUploaded, false);
  assert.equal(output.diagnostics.length, 1);
  assert.deepEqual(output.diagnostics[0], {
    code: 'SECRET_MARKER_FOUND', ruleId: 'managed.bundle.secret_marker', path: 'src/main.py',
    field: 'files[0].content', line: 3, column: 5, suggestion: '按对应字段提示修正资料后重新校验。',
  });
  for (const secret of secrets) assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  assert.equal(requests, 1);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('--validate preserves exact backend diagnostic rules and rejects unknown or unsafe data', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-validate-backend-rules-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const serverMessage = 'PRIVATE_BACKEND_MESSAGE_SENTINEL';
  const diagnostics = [
    ['APP_KEY_INVALID', 'managed.bundle.app_key'],
    ['FILE_COUNT_INVALID', 'managed.bundle.file_count'],
    ['REVISION_INVALID', 'managed.bundle.expected_app_revision'],
    ['FILE_ENTRY_INVALID', 'managed.bundle.file_entry'],
    ['REPOSITORY_PATH_INVALID', 'managed.bundle.manifest_path'],
    ['REPOSITORY_PATH_INVALID', 'managed.bundle.file_path'],
    ['REPOSITORY_PATH_INVALID', 'managed.bundle.document_path'],
    ['FILE_ENCODING_INVALID', 'managed.bundle.file_encoding'],
    ['FILE_SIZE_EXCEEDED', 'managed.bundle.file_size'],
    ['BUNDLE_SIZE_EXCEEDED', 'managed.bundle.bundle_size'],
    ['FORBIDDEN_PATH', 'managed.bundle.forbidden_path'],
    ['PATH_COLLISION', 'managed.bundle.path_collision'],
    ['SECRET_MARKER_FOUND', 'managed.bundle.secret_marker'],
    ['FILE_DIRECTORY_COLLISION', 'managed.bundle.file_directory_collision'],
    ['MANIFEST_MISSING', 'managed.bundle.manifest_missing'],
    ['MANIFEST_SIZE_EXCEEDED', 'managed.bundle.manifest_size'],
    ['MANIFEST_UTF8_INVALID', 'managed.bundle.manifest_utf8'],
    ['MANIFEST_JSON_INVALID', 'managed.bundle.manifest_json'],
    ['MANIFEST_INVALID', 'managed.bundle.manifest'],
    ['SCHEMA_VERSION_UNSUPPORTED', 'managed.bundle.schema_version'],
    ['CAPABILITY_TAGS_INVALID', 'managed.bundle.capability_tags'],
    ['PROJECT_VERSION_INVALID', 'managed.bundle.project_version'],
    ['MAINTAINER_NAME_REQUIRED', 'managed.bundle.maintainer_name'],
    ['MANIFEST_SCHEMA_INVALID', 'managed.bundle.manifest_schema'],
    ['APP_KEY_MISMATCH', 'managed.bundle.app_key_mismatch'],
    ['MANIFEST_TEXT_EMPTY', 'managed.bundle.manifest_text'],
    ['ENTRY_ID_DUPLICATE', 'managed.bundle.entry_id_unique'],
    ['ENTRY_INSTRUCTIONS_PATH_INVALID', 'managed.bundle.entry_instructions_path'],
    ['PRIMARY_ENTRY_INVALID', 'managed.bundle.primary_entry'],
    ['README_PATH_INVALID', 'managed.bundle.readme_path'],
    ['USAGE_PATH_INVALID', 'managed.bundle.usage_path'],
    ['ENTRY_URL_INVALID', 'managed.bundle.entry_url'],
    ['DOCUMENT_MISSING', 'managed.bundle.document_missing'],
    ['DOCUMENT_SIZE_EXCEEDED', 'managed.bundle.document_size'],
    ['DOCUMENT_TOTAL_SIZE_EXCEEDED', 'managed.bundle.document_total_size'],
    ['DOCUMENT_UTF8_INVALID', 'managed.bundle.document_utf8'],
    ['LFS_POINTER_NOT_ALLOWED', 'managed.bundle.lfs_pointer'],
    ['TAG_NAME_MISMATCH', 'managed.bundle.tags'],
    ['REQUEST_FIELD_INVALID', 'managed.request.schema'],
  ].map(([code, ruleId]) => ({
    code, ruleId, path: 'src/main.py', field: 'files[0].path', line: 2, column: 3,
    suggestion: serverMessage,
  }));
  diagnostics.push(
    {
      code: 'TAG_NAME_MISMATCH', ruleId: 'managed.bundle.tag_name_mismatch',
      path: 'C:\\private\\TOKEN_SENTINEL', field: 'PRIVATE_FIELD_SENTINEL', line: 2, column: 3, suggestion: serverMessage,
    },
    {
      code: 'UNKNOWN_BACKEND_ERROR', ruleId: 'managed.bundle.unknown',
      path: 'https://private.example/TOKEN_SENTINEL', field: 'request', line: 2, column: 3, suggestion: serverMessage,
    },
    {
      code: 'APP_KEY_INVALID', ruleId: 'managed.bundle.app_key',
      path: 'C:\\private\\TOKEN_SENTINEL', field: 'appKey', line: 2, column: 3, suggestion: serverMessage,
    },
  );
  let requests = 0;
  const portal = await createPortal((request, response) => {
    requests += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/managed-publications/validate');
    assert.equal(request.headers['idempotency-key'], undefined);
    assert.equal(request.headers['x-plaza-publish-key'], undefined);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: serverMessage, diagnostics } }));
  });
  t.after(portal.close);

  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--validate']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(output.status, 'validation_failed');
  assert.equal(output.published, false);
  assert.equal(output.sourceUploaded, false);
  assert.equal(output.diagnostics.length, 40);
  assert.deepEqual(output.diagnostics.slice(0, 39), diagnostics.slice(0, 39).map(({ code, ruleId }) => ({
    code, ruleId, path: 'src/main.py', field: 'files[0].path', line: 2, column: 3,
    suggestion: '按对应字段提示修正资料后重新校验。',
  })));
  assert.deepEqual(output.diagnostics[39], {
    code: 'APP_KEY_INVALID', ruleId: 'managed.bundle.app_key', field: 'appKey', line: 2, column: 3,
    suggestion: '按对应字段提示修正资料后重新校验。',
  });
  assert.ok(!result.stdout.includes(serverMessage) && !result.stderr.includes(serverMessage));
  assert.ok(!result.stdout.includes('TOKEN_SENTINEL') && !result.stderr.includes('TOKEN_SENTINEL'));
  assert.ok(!result.stdout.includes('PRIVATE_FIELD_SENTINEL') && !result.stderr.includes('PRIVATE_FIELD_SENTINEL'));
  assert.equal(requests, 1);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('--validate local secret rejection is JSON and makes no request or receipt', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-validate-local-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const secret = 'LocalValidationSecretSentinelLong12345';
  await writeFile(path.join(root, 'src', 'main.py'), `password = "${secret}"\n`);
  let requests = 0;
  const portal = await createPortal((_request, response) => { requests += 1; respondJson(response, {}); });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--validate']);
  assert.equal(result.code, 2);
  const output = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(output.diagnostics[0].code, 'SECRET_MARKER_FOUND');
  assert.equal(output.diagnostics[0].path, 'src/main.py');
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  assert.equal(requests, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

function decodedBody(request: CapturedRequest) {
  return JSON.parse(request.body.toString('utf8')) as {
    appKey: string;
    manifestPath: string;
    managedAppId?: string;
    expectedAppRevision?: number;
    files: Array<{ path: string; content: string }>;
  };
}

function respondJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function publicationResponse(origin: string, overrides: Record<string, unknown> = {}) {
  return {
    id: PUBLICATION_ID,
    status: 'preview_ready',
    revision: 1,
    nextAction: 'confirm',
    expiresAt: '2026-10-17T00:00:00.000Z',
    appId: PUBLIC_ID,
    preview: { id: PUBLIC_ID },
    ticket: PREVIEW_TICKET,
    previewUrl: origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET,
    managedAppId: MANAGED_ID,
    sourceUploaded: true,
    ...overrides,
  };
}

test('non-Git project uploads only safe project files and includes ignored manifest documents', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-nongit-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  await writeFile(path.join(root, '.env'), 'PORTAL_PASSWORD=do-not-send\n');
  await writeFile(path.join(root, '.env.example'), 'PORTAL_PASSWORD=replace-me\n');
  await mkdir(path.join(root, '.env.local'), { recursive: true });
  await writeFile(path.join(root, '.env.local', 'secret.txt'), 'NESTED_ENV_SENTINEL');
  await writeFile(path.join(root, 'credentials.env'), 'GL_TOKEN=do-not-send\n');
  await writeFile(path.join(root, '.mcp.json'), '{"token":"do-not-send"}\n');
  await mkdir(path.join(root, '.ssh'), { recursive: true });
  await writeFile(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE_KEY_SENTINEL');
  await mkdir(path.join(root, 'node_modules', 'sample'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'sample', 'index.js'), 'DEPENDENCY_SENTINEL');
  await writeFile(path.join(root, 'src', 'credential.txt'), 'glpat-12345678901234567890');
  await writeFile(path.join(root, 'src', 'private.pem'), '-----BEGIN PRIVATE KEY-----\nprivate material\n');
  const outside = path.join(temporary, 'outside-secret.txt');
  await writeFile(outside, 'OUTSIDE_SYMLINK_SENTINEL');
  let symlinkCreated = true;
  try {
    await symlink(outside, path.join(root, 'src', 'linked-secret.txt'));
  } catch {
    symlinkCreated = false;
  }

  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/managed-publications');
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);

  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 1);
  const body = decodedBody(requests[0]!);
  const fileMap = new Map(body.files.map((file) => [file.path, Buffer.from(file.content, 'base64').toString('utf8')]));
  for (const required of ['ai-app.json', 'docs/README.md', 'docs/usage.md', 'docs/instructions.md', 'src/main.py', '.env.example']) {
    assert.ok(fileMap.has(required), 'expected ' + required + ' in uploaded bundle');
  }
  for (const excluded of ['.env', '.env.local/secret.txt', 'credentials.env', '.mcp.json', '.ssh/id_rsa', 'node_modules/sample/index.js', 'src/credential.txt', 'src/private.pem']) {
    assert.ok(!fileMap.has(excluded), 'did not expect ' + excluded + ' in uploaded bundle');
  }
  assert.ok(!requests[0]!.body.toString('utf8').includes('PRIVATE_KEY_SENTINEL'));
  assert.ok(!requests[0]!.body.toString('utf8').includes('OUTSIDE_SYMLINK_SENTINEL'));
  if (symlinkCreated) assert.ok(!fileMap.has('src/linked-secret.txt'));
  for (const file of body.files) assert.ok(!file.path.includes('\\'), 'paths must use POSIX separators');
  assert.match(result.stderr, /src\/credential\.txt/);
  assert.match(result.stderr, /src\/private\.pem/);
  assert.ok(!result.stderr.includes('glpat-12345678901234567890'));
  assert.ok(!result.stderr.includes('private material'));

  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'preview_ready');
  assert.equal(output.managedAppId, MANAGED_ID);
  assert.equal(output.sourceUploaded, true);
  let authorPreview: URL | undefined;
  try {
    authorPreview = new URL(String(output.previewUrl));
  } catch {
    // Do not expose a failed fixture URL in test output.
  }
  const previewParams = new URLSearchParams(authorPreview?.hash.slice(1));
  assert.ok(authorPreview?.origin === portal.origin && authorPreview.pathname === '/' &&
    previewParams.get('publish') === PUBLICATION_ID && previewParams.get('key') === PREVIEW_TICKET,
  'same-origin author preview URL retains its publish UUID and ticket fragment');
  assert.ok(!result.stdout.includes(String(requests[0]!.headers['x-plaza-publish-key'])));
  assert.ok(!result.stdout.includes(String(requests[0]!.headers['idempotency-key'])));
  assert.ok(!result.stdout.includes('"ticket"'));
});

test('Git project respects standard excludes and forcibly includes manifest-referenced ignored docs', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-git-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const init = spawn('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
  const initCode = await new Promise<number>((resolve, reject) => {
    init.once('error', reject);
    init.once('close', (code) => resolve(code ?? -1));
  });
  assert.equal(initCode, 0);
  await writeFile(path.join(root, '.gitignore'), 'docs/\nsrc/ignored.txt\n');
  await writeFile(path.join(root, 'src', 'ignored.txt'), 'IGNORE_SENTINEL');
  const add = spawn('git', ['-C', root, 'add', '-f', 'ai-app.json', 'docs/README.md', 'docs/usage.md', 'docs/instructions.md', 'src/main.py'], { stdio: 'ignore' });
  const addCode = await new Promise<number>((resolve, reject) => {
    add.once('error', reject);
    add.once('close', (code) => resolve(code ?? -1));
  });
  assert.equal(addCode, 0);

  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 0, result.stderr);
  const body = decodedBody(requests[0]!);
  const paths = new Set(body.files.map((file) => file.path));
  for (const required of ['docs/README.md', 'docs/usage.md', 'docs/instructions.md']) assert.ok(paths.has(required));
  assert.ok(!paths.has('src/ignored.txt'));
});

test('a suspected secret in necessary source stops the upload and reports only its path', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-secret-source-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const fakeSecret = 'glpat-12345678901234567890';
  await writeFile(path.join(root, 'src', 'main.py'), `TOKEN = "${fakeSecret}"\n`);
  let requestCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, {});
  });
  t.after(portal.close);

  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /必要源码或资料疑似包含真实密钥或 token：src\/main\.py/);
  assert.ok(!result.stdout.includes(fakeSecret));
  assert.ok(!result.stderr.includes(fakeSecret));
  assert.equal(requestCount, 0);
  await assert.rejects(readFile(stateDir));
});

test('secret assignment scanning consumes complete quoted values and fails closed across CLI modes', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-secret-boundaries-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const cases = [
    {
      path: 'src/main.py',
      content: 'password = "correct horse battery staple"\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/triple-double.py',
      content: 'password = """correct horse battery staple"""\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/triple-single.py',
      content: "password = '''correct horse battery staple'''\n",
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/triple-double-multiline.py',
      content: 'password = """\ncorrect horse battery staple\n"""\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/triple-single-multiline.py',
      content: "password = '''\ncorrect horse battery staple\n'''\n",
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/raw-triple-multiline.py',
      content: 'password = r"""\ncorrect horse battery staple\n"""\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/f-triple-multiline.py',
      content: 'password = f"""\ncorrect horse battery staple\n"""\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/rf-triple-multiline.py',
      content: "password = rf'''\ncorrect horse battery staple\n'''\n",
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/fr-triple-multiline.py',
      content: "password = Fr'''\ncorrect horse battery staple\n'''\n",
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/bytes-prefix.py',
      content: 'password = b"correct horse battery staple"\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/unicode-prefix.py',
      content: "password = u'correct horse battery staple'\n",
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/adjacent-short-first.py',
      content: 'password = "" "correct horse battery staple"\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/plus-short-first.py',
      content: 'password = "abc" + "correct horse battery staple"\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/prefixed-short-first.py',
      content: 'password = r"" "correct horse battery staple"\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/js-plus-short-first.ts',
      content: 'const password = "abc" + "correct horse battery staple";\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/js-block-plus.ts',
      content: 'const password = "x" /* note */ + "CorrectHorse@Battery:Staple/More!Secret";\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/js-line-plus.ts',
      content: 'const password = "x" // note\n + "CorrectHorse@Battery:Staple/More!Secret";\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/python-floor-division.py',
      content: 'password = "x" // "CorrectHorse@Battery:Staple/More!Secret"\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/parenthesized-comment-triple.py',
      content: 'password = (\n    # comment\n    """CorrectHorse@Battery:Staple/More!Secret"""\n)\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/parenthesized-js.ts',
      content: 'const password = (\n  "CorrectHorse@Battery:Staple/More!Secret"\n);\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/explicit-continuation.py',
      content: 'password = \\\n  "CorrectHorse@Battery:Staple/More!Secret"\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/parenthesized-nonliteral-prefix.py',
      content: 'password = (\n    fallback or "CorrectHorse@Battery:Staple/More!Secret"\n)\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/unknown-python-continuation.py',
      content: 'password = f() or \\\n    "CorrectHorse@Battery:Staple/More!Secret"\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/unknown-js-continuation.ts',
      content: 'const password = f()\n  || "CorrectHorse@Battery:Staple/More!Secret";\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/commented-js-continuation.ts',
      content: 'const password = f() /* note */\n  || "CorrectHorse@Battery:Staple/More!Secret";\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/unclosed-comment-continuation.ts',
      content: 'const password = f()\n  /* unclosed\n  || "CorrectHorse@Battery:Staple/More!Secret";\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/open-js-expression.ts',
      content: 'const password = f(\n  "CorrectHorse@Battery:Staple/More!Secret");\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/open-python-expression.py',
      content: 'password = f(\n    "CorrectHorse@Battery:Staple/More!Secret"\n)\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/password-block.yaml',
      content: 'password: |\n  CorrectHorse@Battery:Staple/More!Secret\n',
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/unreliable-literal-continuation.py',
      content: 'password = "short" + getPasswordFromVault()\n',
      secret: 'short',
    },
    {
      path: 'src/unclosed-triple.py',
      content: 'password = """correct horse battery staple\n',
      secret: 'correct horse battery staple',
    },
    {
      path: 'src/punctuated.ts',
      content: "const password = 'CorrectHorse@Battery:Staple/More!Secret';\n",
      secret: 'CorrectHorse@Battery:Staple/More!Secret',
    },
    {
      path: 'src/escaped-double.ts',
      content: 'const password = "correct horse \\\"battery staple @:/";\n',
      secret: 'correct horse \\\"battery staple @:/',
    },
    {
      path: 'src/escaped-single.ts',
      content: "const password = 'correct horse \\\'battery staple @:/';\n",
      secret: "correct horse \\\'battery staple @:/",
    },
    {
      path: 'src/unquoted-passphrase.py',
      content: 'password=correct horse battery staple @:/\n',
      secret: 'correct horse battery staple @:/',
    },
    {
      path: 'src/unclosed.ts',
      content: 'const password = "correct horse battery staple @:/;\n',
      secret: 'correct horse battery staple @:/',
    },
  ];
  let requestCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, {});
  });
  t.after(portal.close);

  const modes = [
    { name: 'dry-run', flags: ['--dry-run'] },
    { name: 'validate', flags: ['--validate'] },
    { name: 'publish', flags: [] },
  ];
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  for (const item of cases) {
    const filePath = path.join(root, ...item.path.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, item.content);
    for (const mode of modes) {
      const result = await runCli([...baseArgs, ...mode.flags]);
      assert.equal(result.code, 2, item.path + ' (' + mode.name + '): ' + result.stderr);
      assert.ok(result.stdout.includes(item.path) || result.stderr.includes(item.path), item.path + ' (' + mode.name + '): reports only the safe path');
      assert.ok(!result.stdout.includes(item.secret) && !result.stderr.includes(item.secret), 'does not echo the credential');
      assert.equal(requestCount, 0, mode.name + ' must reject before any HTTP request');
      await assert.rejects(access(stateDir), { code: 'ENOENT' }, mode.name + ' must not create a receipt');
    }
    await rm(filePath, { force: true });
  }
});

test('secret assignment scanning preserves the 20-character literal threshold', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-secret-threshold-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const sourcePath = path.join(root, 'src', 'main.py');
  let requestCount = 0;
  const portal = await createPortal((_request, response) => {
    requestCount += 1;
    response.writeHead(500);
    response.end();
  });
  t.after(() => portal.close());
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--dry-run'];

  await writeFile(sourcePath, 'password = "1234567890123456789"\n');
  const short = await runCli(args);
  assert.equal(short.code, 0, short.stderr);
  assert.equal(JSON.parse(short.stdout).dryRun, true);
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });

  await writeFile(path.join(root, 'src', 'template.ts'), 'const password = `short\ntext`;\n');
  const multilineTemplate = await runCli(args);
  assert.equal(multilineTemplate.code, 0, multilineTemplate.stderr);
  assert.equal(JSON.parse(multilineTemplate.stdout).dryRun, true);
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });

  await writeFile(sourcePath, 'password = "12345678901234567890"\n');
  const threshold = await runCli(args);
  assert.equal(threshold.code, 2, threshold.stderr);
  const output = JSON.parse(threshold.stdout) as Record<string, any>;
  assert.equal(output.status, 'validation_failed');
  assert.ok(JSON.stringify(output.diagnostics).includes('src/main.py'));
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });

  await writeFile(sourcePath, 'password = "short"\n"CorrectHorse@Battery:Staple/More!Secret"\n');
  const nextLogicalLine = await runCli(args);
  assert.equal(nextLogicalLine.code, 0, nextLogicalLine.stderr);
  assert.equal(JSON.parse(nextLogicalLine.stdout).dryRun, true);
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });

  await writeFile(sourcePath, 'def send(password="short"):\n    return password\n');
  const pythonCallBoundary = await runCli(args);
  assert.equal(pythonCallBoundary.code, 0, pythonCallBoundary.stderr);
  assert.equal(JSON.parse(pythonCallBoundary.stdout).dryRun, true);
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });

  await writeFile(path.join(root, 'src', 'call.ts'), 'send(password="short");\n');
  const jsCallBoundary = await runCli(args);
  assert.equal(jsCallBoundary.code, 0, jsCallBoundary.stderr);
  assert.equal(JSON.parse(jsCallBoundary.stdout).dryRun, true);
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('CLI dry-run permits JS/TS credential references but still blocks secret literals and config credentials', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-secret-scan-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const sourcePath = path.join(root, 'src', 'main.ts');
  await writeFile(sourcePath, [
    'const password = patchSegment.password;',
    'function loadPassword(configuredPasswordFromVault) { const password = configuredPasswordFromVault; }',
    'const publishKey = bootstrap.publisher.publishKey;',
    'const accessToken = process.env.ACCESS_TOKEN;',
    'const clientSecret = context.auth.clientSecret;',
    '',
  ].join('\n'));
  await writeFile(
    path.join(root, 'src', 'ReferenceForm.vue'),
    '<script setup lang="ts">\nconst password = patchSegment.password;\n</script>\n',
  );

  let requestCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, {});
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--dry-run'];
  const safeReferences = await runCli(args);
  assert.equal(safeReferences.code, 0, safeReferences.stderr);
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });

  const cases = [
    {
      path: 'src/main.ts',
      content: 'const password = "literalPasswordValueLongEnough123456";\n',
      secret: 'literalPasswordValueLongEnough123456',
    },
    {
      path: 'src/token.ts',
      content: 'const token = "glpat-12345678901234567890";\n',
      secret: 'glpat-12345678901234567890',
    },
    {
      path: 'src/private-key.ts',
      content: 'const key = "-----BEGIN PRIVATE KEY-----\\nprivate material";\n',
      secret: 'private material',
    },
    {
      path: 'src/CredentialForm.vue',
      content: '<CredentialForm password=UnquotedCredentialValueLong12345 />\n',
      secret: 'UnquotedCredentialValueLong12345',
    },
    {
      path: 'src/environment.ts',
      content: 'const envExample = "password=EmbeddedCredentialValueLong12345";\n',
      secret: 'EmbeddedCredentialValueLong12345',
    },
    {
      path: 'src/comment.ts',
      content: '// password=DocumentedCredentialValueLong12345\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/template.ts',
      content: 'const doc = `password=DocumentedCredentialValueLong12345`;\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/regex.ts',
      content: 'const rx = /password=DocumentedCredentialValueLong12345;/;\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/regex-with-string.ts',
      content: 'const rx = /password=referenceIdentifierNameLongEnough; "password=EmbeddedRegexCredentialValueLong12345";/;\n',
      secret: 'EmbeddedRegexCredentialValueLong12345',
    },
    {
      path: 'src/if-regex.ts',
      content: 'if (ready) /password=DocumentedCredentialValueLong12345;/.test(input);\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/if-block-regex.ts',
      content: 'if (ready) {} /password=DocumentedCredentialValueLong12345;/.test(input);\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/for-await-regex.ts',
      content: 'async function f(items) { for await (const item of items) /password=DocumentedCredentialValueLong12345;/.test(item); }\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/labeled-block-regex.ts',
      content: 'function f(input) { label: {} /password=DocumentedCredentialValueLong12345;/.test(input); }\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/return-regex.ts',
      content: 'function find() { return /password=DocumentedCredentialValueLong12345;/; }\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/array-regex.ts',
      content: 'const patterns = [/password=DocumentedCredentialValueLong12345;/];\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/object-regex.ts',
      content: 'const settings = { matcher: /password=DocumentedCredentialValueLong12345;/ };\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/view.tsx',
      content: 'const view = <pre>password=DocumentedCredentialValueLong12345;</pre>;\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/view.js',
      content: 'const view = <pre>password=DocumentedCredentialValueLong12345;</pre>;\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/fragment.js',
      content: 'const view = <>password=DocumentedCredentialValueLong12345;</>;\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/JsxForm.vue',
      content: '<script lang="tsx">const view = <pre>password=DocumentedCredentialValueLong12345;</pre>;</script>\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/Comment.vue',
      content: '<!-- <script>password=DocumentedCredentialValueLong12345;</script> -->\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/Nested.vue',
      content: '<template><pre><script>password=DocumentedCredentialValueLong12345;</script></pre></template>\n',
      secret: 'DocumentedCredentialValueLong12345',
    },
    {
      path: 'src/Unclosed.vue',
      content: '<script>password=UnclosedCredentialValueLong12345;\n',
      secret: 'UnclosedCredentialValueLong12345',
    },
    {
      path: 'src/combined-plus.ts',
      content: 'const password = vault.secretReferenceNameLongEnough + "literalPasswordValueLongEnough123456";\n',
      secret: 'literalPasswordValueLongEnough123456',
    },
    {
      path: 'src/combined-or.ts',
      content: 'const password = vault.secretReferenceNameLongEnough || "literalPasswordValueLongEnough123456";\n',
      secret: 'literalPasswordValueLongEnough123456',
    },
    {
      path: 'config/settings.json',
      content: '{"password":"jsonPasswordValueLongEnough123456"}\n',
      secret: 'jsonPasswordValueLongEnough123456',
    },
    {
      path: 'config/service.yaml',
      content: 'access-token: yamlCredentialValueLongEnough123456\n',
      secret: 'yamlCredentialValueLongEnough123456',
    },
    {
      path: '.env.example',
      content: 'ACCESS_TOKEN=envCredentialValueLongEnough123456\n',
      secret: 'envCredentialValueLongEnough123456',
    },
    {
      path: '.vscode/settings.json',
      content: '{"publishKey":"machineConfigCredential123456789"}\n',
      secret: 'machineConfigCredential123456789',
    },
  ];

  for (const item of cases) {
    const filePath = path.join(root, ...item.path.split('/'));
    let requiredReadme: string | undefined;
    if (item.path === '.env.example') {
      const manifestPath = path.join(root, 'ai-app.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { docs: { readme: string } };
      requiredReadme = manifest.docs.readme;
      manifest.docs.readme = item.path;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, item.content);
    const result = await runCli(args);
    assert.equal(result.code, 2, item.path + ': ' + result.stderr);
    assert.ok(JSON.stringify(JSON.parse(result.stdout).diagnostics).includes(item.path), 'reports the safe relative path for ' + item.path);
    assert.ok(!result.stdout.includes(item.secret) && !result.stderr.includes(item.secret), 'does not echo secrets');
    assert.equal(requestCount, 0, 'dry-run performs no HTTP requests');
    await assert.rejects(access(stateDir), { code: 'ENOENT' });
    await rm(filePath, { force: true });
    if (requiredReadme !== undefined) {
      const manifestPath = path.join(root, 'ai-app.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { docs: { readme: string } };
      manifest.docs.readme = requiredReadme;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
  }
});

test('CLI blocks an embedded credential literal in publish mode before HTTP or receipt creation', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-secret-publish-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const secret = 'EmbeddedCredentialValueLong12345';
  await writeFile(path.join(root, 'src', 'environment.ts'), `const envExample = "password=${secret}";\n`);
  let requestCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, {});
  });
  t.after(portal.close);

  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /src\/environment\.ts/);
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  assert.equal(requestCount, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('external, credentialed, or malformed preview URLs are hidden', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-preview-reject-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const previewUrls = (origin: string) => [
    'https://outside.invalid/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET,
    origin.replace('http://', 'http://user:password@') + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET,
    origin + '/?unexpected=1#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET,
    origin + '/#publish=not-a-uuid&key=short',
    origin + '/#publish=' + WRONG_MANAGED_ID + '&key=' + PREVIEW_TICKET,
    origin + '/#publish=' + PUBLICATION_ID + '&key=' + 'B'.repeat(43),
    origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET + '&key=' + PREVIEW_TICKET,
    origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET,
  ];
  let responseIndex = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    const url = previewUrls(portal.origin)[responseIndex++];
    const missingId = responseIndex === 7 ? { id: undefined } : {};
    const nullTicket = responseIndex === 8 ? { ticket: null } : {};
    respondJson(response, publicationResponse(portal.origin, { previewUrl: url, ...missingId, ...nullTicket }));
  });
  t.after(portal.close);

  const urls = previewUrls(portal.origin);
  for (let index = 0; index < urls.length; index += 1) {
    const result = await runCli([
      '--origin', portal.origin,
      '--project', root,
      '--state-dir', path.join(temporary, 'private-state-' + index),
    ]);
    assert.notEqual(result.code, 0, 'unsafe preview response must not be reported as a completed handoff');
    assert.ok(result.stdout, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.ok(!Object.hasOwn(output, 'previewUrl'), 'unsafe author preview link must be hidden');
  }
});

test('--status is local and read-only, reports the saved handoff state, and does not rescan source', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-status-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  let requests = 0;
  const portal = await createPortal((_request, response) => {
    requests += 1;
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const published = await runCli(args);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(requests, 1);

  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const receiptPath = path.join(stateDir, receiptName);
  const before = await readFile(receiptPath);
  const secret = 'StatusMustNotScanThisSecretLong12345';
  await writeFile(path.join(root, 'src', 'main.py'), `password = "${secret}"\n`);
  const status = await runCli([...args, '--status']);
  assert.equal(status.code, 0, status.stderr);
  const output = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'receipt_saved');
  assert.equal(output.handoffState, 'complete');
  assert.equal(output.publicationStatus, 'preview_ready');
  assert.equal(output.publicationId, PUBLICATION_ID);
  assert.equal(output.managedAppId, MANAGED_ID);
  assert.equal(output.previewUrl, portal.origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET);
  assert.ok(!status.stdout.includes(secret) && !status.stderr.includes(secret));
  assert.equal(requests, 1, 'status makes no HTTP requests');
  assert.deepEqual(await readFile(receiptPath), before, 'status does not rewrite the receipt');
});

test('--status never re-emits a receipt URL whose identity binding no longer verifies', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-status-tamper-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const portal = await createPortal((_request, response) => respondJson(response, publicationResponse(portal.origin)));
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  assert.equal((await runCli(args)).code, 0);
  if (process.platform === 'win32') return;
  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const receiptPath = path.join(stateDir, receiptName);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, any>;
  receipt.previewUrl = 'https://outside.invalid/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET;
  await writeFile(receiptPath, JSON.stringify(receipt));
  const status = await runCli([...args, '--status']);
  assert.equal(status.code, 0);
  const output = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(output.handoffState, 'recovery_required');
  assert.ok(!Object.hasOwn(output, 'previewUrl'));
});

test('--status keeps explicit recovery_required when publicationStatus is unknown and performs no network request', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-status-recovery-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  let requests = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requests += 1;
    respondJson(response, publicationResponse(portal.origin, { status: 'unknown' }));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const unresolved = await runCli(args);
  assert.equal(unresolved.code, 1);
  assert.equal(requests, 1);

  const status = await runCli([...args, '--status']);
  assert.equal(status.code, 0, status.stderr);
  const output = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'receipt_saved');
  assert.equal(output.handoffState, 'recovery_required');
  assert.equal(output.publicationStatus, 'unknown');
  assert.equal(requests, 1, '--status must not make HTTP requests');
});

test('--status omits sourceUploaded when the saved unknown receipt is damaged', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-status-damaged-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  const portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') response.destroy();
    else respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const uncertain = await runCli(args);
  assert.notEqual(uncertain.code, 0);
  assert.deepEqual(requests.map((request) => request.method), ['POST']);

  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const receiptPath = path.join(stateDir, receiptName);
  assert.ok((await readFile(receiptPath)).length > 0, 'the dropped POST persisted an unknown receipt');
  const secret = 'DAMAGED_RECEIPT_SECRET_SENTINEL';
  await writeFile(receiptPath, `{"secret":"${secret}",`);
  const damagedBytes = await readFile(receiptPath);
  const status = await runCli([...args, '--status']);
  assert.equal(status.code, 2, status.stderr);
  const output = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'receipt_error');
  assert.equal(output.handoffState, 'recovery_required');
  assert.equal(output.publicationStatus, 'unknown');
  assert.ok(!Object.hasOwn(output, 'sourceUploaded'), 'a damaged receipt cannot establish upload state');
  assert.ok(!status.stdout.includes(secret) && !status.stderr.includes(secret));
  assert.equal(requests.length, 1, '--status must not make HTTP requests');
  assert.deepEqual(await readFile(receiptPath), damagedBytes, '--status must not rewrite the damaged receipt');
});

test('--status omits sourceUploaded when ReceiptStore.open raises PermissionError', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-status-permission-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  const portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') response.destroy();
    else respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const uncertain = await runCli(args);
  assert.notEqual(uncertain.code, 0);
  assert.deepEqual(requests.map((request) => request.method), ['POST']);
  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const receiptPath = path.join(stateDir, receiptName);
  const before = await readFile(receiptPath);
  assert.ok(before.length > 0, 'the dropped POST persisted an unknown receipt');

  const status = await runCli([...args, '--status'], 'receipt-open-permission');
  assert.equal(status.code, 2, status.stderr);
  const output = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'receipt_error');
  assert.equal(output.handoffState, 'recovery_required');
  assert.equal(output.publicationStatus, 'unknown');
  assert.ok(!Object.hasOwn(output, 'sourceUploaded'), 'an unreadable receipt cannot establish upload state');
  assert.ok(!status.stdout.includes('STATUS_RECEIPT_SECRET_SENTINEL') &&
    !status.stderr.includes('STATUS_RECEIPT_SECRET_SENTINEL'));
  assert.equal(requests.length, 1, '--status must not make HTTP requests');
  assert.deepEqual(await readFile(receiptPath), before, '--status must not rewrite the receipt');
});

test('a changed bundle cannot replace an unresolved checking operation or send another POST', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-pending-update-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 7 });
      return;
    }
    respondJson(response, publicationResponse(portal.origin, { status: 'checking', nextAction: 'retry_original' }));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(args);
  assert.equal(first.code, 1);
  assert.equal(JSON.parse(first.stdout).handoffState, 'pending');
  assert.equal(requests.length, 1);
  const firstPost = requests[0]!;
  assert.equal(firstPost.method, 'POST');
  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const receiptPath = path.join(stateDir, receiptName);
  const before = await readFile(receiptPath);
  assert.ok(firstPost.headers['x-plaza-publish-key']);
  assert.ok(firstPost.headers['idempotency-key']);

  await writeFile(path.join(root, 'src', 'main.py'), 'print("CHANGED_PENDING_SOURCE")\n');
  const changed = await runCli(args);
  assert.notEqual(changed.code, 0);
  assert.equal(JSON.parse(changed.stdout).status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(requests.length, 1, 'must not GET status or POST a changed bundle while the prior operation is pending');
  assert.deepEqual(await readFile(receiptPath), before, 'owner, idempotency key, body, and receipt bytes stay unchanged');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
});

test('--recover GETs the original receipt only and recovers after the project source changes', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-recover-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') {
      response.destroy();
      return;
    }
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const uncertain = await runCli(args);
  assert.notEqual(uncertain.code, 0);
  assert.equal(requests.length, 1);
  const original = requests[0]!;
  const secret = 'ChangedSourceMustNotBeUploadedLong12345';
  await writeFile(path.join(root, 'src', 'main.py'), `password = "${secret}"\n`);
  const recovered = await runCli([...args, '--recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(requests.length, 2);
  const get = requests[1]!;
  assert.equal(get.method, 'GET');
  assert.equal(get.url, '/api/managed-publications/receipt');
  assert.equal(get.body.length, 0);
  assert.equal(get.headers['idempotency-key'], original.headers['idempotency-key']);
  assert.equal(get.headers['x-plaza-publish-key'], original.headers['x-plaza-publish-key']);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
  const output = JSON.parse(recovered.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'preview_ready');
  assert.equal(output.handoffState, 'complete');
  assert.equal(output.publicationId, PUBLICATION_ID);
  assert.ok(!recovered.stdout.includes(secret) && !recovered.stderr.includes(secret));
});

test('--recover preserves the original receipt when the server says the operation is unfinished', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-recover-pending-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  const portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') {
      response.destroy();
      return;
    }
    respondJson(response, {
      status: 'recovery_required', nextAction: 'retry_original', managedAppId: MANAGED_ID,
      recoveryRequired: true, sourceUploaded: false, operationStatus: 'commit_ready',
    });
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  assert.notEqual((await runCli(args)).code, 0);
  const beforeKey = requests[0]!.headers['idempotency-key'];
  const beforeOwner = requests[0]!.headers['x-plaza-publish-key'];
  const recovered = await runCli([...args, '--recover']);
  assert.equal(recovered.code, 1);
  const output = JSON.parse(recovered.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(output.handoffState, 'recovery_required');
  assert.equal(output.managedAppId, MANAGED_ID);
  assert.equal(output.operationStatus, 'commit_ready');
  assert.equal(output.nextAction, 'retry_original');
  assert.equal(output.sourceUploaded, false);
  assert.ok(!Object.hasOwn(output, 'previewUrl'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.method, 'GET');
  assert.equal(requests[1]!.body.length, 0);
  assert.equal(requests[1]!.headers['idempotency-key'], beforeKey);
  assert.equal(requests[1]!.headers['x-plaza-publish-key'], beforeOwner);
});

test('failed retry handoff exposes a bound author recovery URL while recover stays GET-only', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-retry-author-handoff-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let recoveryReads = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  const failedRetry = () => publicationResponse(portal.origin, { status: 'failed', nextAction: 'retry' });
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') {
      respondJson(response, failedRetry());
      return;
    }
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/api/managed-publications/receipt');
    recoveryReads += 1;
    respondJson(response, recoveryReads === 1
      ? failedRetry()
      : publicationResponse(portal.origin));
  });
  t.after(portal.close);

  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const authorRecoveryUrl = portal.origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET;
  const failed = await runCli(args);
  assert.equal(failed.code, 1);
  const failedOutput = JSON.parse(failed.stdout) as Record<string, unknown>;
  assert.equal(failedOutput.status, 'failed');
  assert.equal(failedOutput.handoffState, 'recovery_required');
  assert.equal(failedOutput.recoveryUrl, authorRecoveryUrl);
  assert.ok(!Object.hasOwn(failedOutput, 'previewUrl'), 'failed retry is not a completed preview handoff');
  assert.ok(!Object.hasOwn(failedOutput, 'recoveryTicket'), 'the ticket is exposed only inside the author URL');

  const status = await runCli([...args, '--status']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).recoveryUrl, authorRecoveryUrl);
  assert.equal(requests.length, 1, '--status is local and read-only');

  const tamperedStatus = await runCli([...args, '--status'], 'receipt-recovery-url-tamper');
  assert.equal(tamperedStatus.code, 0, tamperedStatus.stderr);
  assert.ok(!Object.hasOwn(JSON.parse(tamperedStatus.stdout), 'recoveryUrl'), 'status revalidates the stored URL/ticket binding');
  assert.equal(requests.length, 1, 'status never makes a recovery request');

  await writeFile(path.join(root, 'src', 'main.py'), 'print("CHANGED_BUNDLE_MUST_NOT_RETRY")\n');
  const changed = await runCli([...args, '--managed-app-id', MANAGED_ID]);
  assert.equal(changed.code, 1);
  assert.equal(JSON.parse(changed.stdout).status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(requests.length, 1, 'failed retry cannot authorize a changed bundle or new POST');

  const recoveredFailure = await runCli([...args, '--recover']);
  assert.equal(recoveredFailure.code, 1);
  const recoveredFailureOutput = JSON.parse(recoveredFailure.stdout) as Record<string, unknown>;
  assert.equal(recoveredFailureOutput.recoveryUrl, authorRecoveryUrl);
  assert.ok(!Object.hasOwn(recoveredFailureOutput, 'previewUrl'));

  const recoveredPreview = await runCli([...args, '--recover']);
  assert.equal(recoveredPreview.code, 0, recoveredPreview.stderr);
  const previewOutput = JSON.parse(recoveredPreview.stdout) as Record<string, unknown>;
  assert.equal(previewOutput.status, 'preview_ready');
  assert.equal(previewOutput.previewUrl, authorRecoveryUrl);
  assert.ok(!Object.hasOwn(previewOutput, 'recoveryUrl'), 'successful handoff clears the retry capability');
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'GET']);
});

test('--recover clears saved author retry URLs for malformed or non-retry receipts', async (t) => {
  const malformedCases = [
    'missing-url', 'missing-ticket', 'wrong-ticket', 'wrong-publication-id', 'invalid-publication-id',
    'external-origin', 'source-not-uploaded', 'source-unknown', 'cross-managed', 'missing-managed-id', 'other-next-action',
    'registered',
  ] as const;
  for (const malformed of malformedCases) {
    await t.test(malformed, async (subtest) => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-retry-author-invalid-'));
      subtest.after(() => rm(temporary, { recursive: true, force: true }));
      const root = await makeProject(temporary);
      const stateDir = path.join(temporary, 'private-state');
      const requests: CapturedRequest[] = [];
      let portal: Awaited<ReturnType<typeof createPortal>>;
      portal = await createPortal((request, response) => {
        requests.push(request);
        if (request.method === 'POST') {
          respondJson(response, publicationResponse(portal.origin, { status: 'failed', nextAction: 'retry' }));
          return;
        }
        assert.equal(request.method, 'GET');
        assert.equal(request.url, '/api/managed-publications/receipt');
        const invalid: Record<string, unknown> = publicationResponse(portal.origin, { status: 'failed', nextAction: 'retry' });
        switch (malformed) {
          case 'missing-url': delete invalid.previewUrl; break;
          case 'missing-ticket': delete invalid.ticket; break;
          case 'wrong-ticket': invalid.ticket = 'B'.repeat(43); break;
          case 'wrong-publication-id': invalid.previewUrl = portal.origin + '/#publish=' + PUBLIC_ID + '&key=' + PREVIEW_TICKET; break;
          case 'invalid-publication-id': invalid.id = 'not-a-uuid'; break;
          case 'external-origin': invalid.previewUrl = 'https://outside.invalid/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET; break;
          case 'source-not-uploaded': invalid.sourceUploaded = false; break;
          case 'source-unknown': invalid.sourceUploaded = 'unknown'; break;
          case 'cross-managed': invalid.managedAppId = WRONG_MANAGED_ID; break;
          case 'missing-managed-id': delete invalid.managedAppId; break;
          case 'other-next-action': invalid.nextAction = 'submit_again'; break;
          case 'registered': invalid.status = 'registered'; delete invalid.nextAction; break;
        }
        respondJson(response, invalid);
      });
      subtest.after(portal.close);
      const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
      const first = await runCli(args);
      assert.equal(first.code, 1);
      assert.equal(JSON.parse(first.stdout).recoveryUrl,
        portal.origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET,
        'the initial fully bound failed retry has a recovery link');

      const recovered = await runCli([...args, '--recover']);
      assert.equal(recovered.code, 1);
      const output = JSON.parse(recovered.stdout) as Record<string, unknown>;
      assert.ok(!Object.hasOwn(output, 'recoveryUrl'), 'invalid author recovery capability is never delivered');
      assert.ok(!recovered.stdout.includes(PREVIEW_TICKET));

      const status = await runCli([...args, '--status']);
      assert.equal(status.code, 0, status.stderr);
      assert.ok(!Object.hasOwn(JSON.parse(status.stdout), 'recoveryUrl'), 'invalid response clears the prior saved capability');
      assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET']);
    });
  }
});

test('--recover retry_original permits only the exact original POST after a source change', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-retry-original-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let postCount = 0;
  const portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET' && request.url === '/api/managed-apps/' + MANAGED_ID + '/status') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 7 });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/managed-publications/receipt') {
      respondJson(response, {
        status: 'recovery_required', nextAction: 'retry_original', managedAppId: MANAGED_ID,
        recoveryRequired: true, sourceUploaded: true, operationStatus: 'commit_ready',
      });
      return;
    }
    assert.equal(request.method, 'POST');
    postCount += 1;
    if (postCount === 2) {
      respondJson(response, publicationResponse(portal.origin, { status: 'checking' }), 202);
      return;
    }
    if (postCount === 3) {
      response.destroy();
      return;
    }
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];

  assert.equal((await runCli(baseArgs)).code, 0, 'create the original owned publication');
  const manifestPath = path.join(root, 'ai-app.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.projectVersion = '1.2.4';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(path.join(root, 'src', 'main.py'), 'print("ORIGINAL_UPDATE_BODY")\n');
  assert.equal((await runCli([...baseArgs, '--managed-app-id', MANAGED_ID])).code, 1, 'the operation is still checking');
  const posts = () => requests.filter((item) => item.method === 'POST');
  const originalUpdate = posts()[1]!;
  assert.equal(decodedBody(originalUpdate).expectedAppRevision, 7);

  const recovered = await runCli([...baseArgs, '--recover']);
  assert.equal(recovered.code, 1);
  const recoveredOutput = JSON.parse(recovered.stdout) as Record<string, unknown>;
  assert.equal(recoveredOutput.nextAction, 'retry_original');
  assert.equal(recoveredOutput.sourceUploaded, true, 'a valid true recovery value is preserved');
  const status = await runCli([...baseArgs, '--status']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).sourceUploaded, true, 'status preserves the saved true value');

  const changedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  changedManifest.projectVersion = '1.2.5';
  await writeFile(manifestPath, JSON.stringify(changedManifest, null, 2));
  await writeFile(path.join(root, 'src', 'main.py'), 'print("MUST_NOT_REPLACE_ORIGINAL_RETRY")\n');
  const retried = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(retried.code, 2, retried.stderr, 'the replay response is lost after the request is sent');
  const replay = posts()[2]!;
  assert.deepEqual(replay.body, originalUpdate.body, 'recovery replays the exact saved original body');
  assert.equal(replay.headers['idempotency-key'], originalUpdate.headers['idempotency-key']);
  assert.equal(replay.headers['x-plaza-publish-key'], originalUpdate.headers['x-plaza-publish-key']);
  assert.equal(decodedBody(replay).managedAppId, MANAGED_ID);
  assert.equal(decodedBody(replay).expectedAppRevision, 7, 'recovery does not refresh the original revision');
  assert.equal(requests.filter((item) => item.method === 'GET' && item.url === '/api/managed-apps/' + MANAGED_ID + '/status').length, 1);
  const replayFiles = decodedBody(replay).files;
  const originalSource = replayFiles.find((file) => file.path === 'src/main.py');
  assert.equal(Buffer.from(originalSource!.content, 'base64').toString('utf8'), 'print("ORIGINAL_UPDATE_BODY")\n');
  assert.ok(!replay.body.toString('utf8').includes('MUST_NOT_REPLACE_ORIGINAL_RETRY'));
  assert.deepEqual(requests.map((item) => item.method), ['POST', 'GET', 'POST', 'GET', 'POST']);
});

test('--recover rejects stale or unknown retry actions and keeps sourceUploaded unknown', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-retry-unknown-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let recoveryReads = 0;
  const portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') {
      response.destroy();
      return;
    }
    assert.equal(request.url, '/api/managed-publications/receipt');
    recoveryReads += 1;
    if (recoveryReads === 1) {
      respondJson(response, {
        status: 'recovery_required', nextAction: 'retry_original', managedAppId: MANAGED_ID,
        recoveryRequired: true, sourceUploaded: true, operationStatus: 'commit_ready',
      });
    } else if (recoveryReads === 2) {
      respondJson(response, {
        status: 'recovery_required', nextAction: 'not-a-protocol-action', managedAppId: MANAGED_ID,
        recoveryRequired: true, sourceUploaded: 'unknown', operationStatus: 'commit_ready',
      });
    } else {
      respondJson(response, {
        status: 'recovery_required', managedAppId: MANAGED_ID,
        recoveryRequired: true, operationStatus: 'commit_ready',
      });
    }
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  assert.notEqual((await runCli(args)).code, 0);
  assert.equal((await runCli([...args, '--recover'])).code, 1);

  const invalid = await runCli([...args, '--recover']);
  assert.equal(invalid.code, 1);
  const invalidOutput = JSON.parse(invalid.stdout) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(invalidOutput, 'nextAction'));
  assert.ok(!Object.hasOwn(invalidOutput, 'sourceUploaded'), 'invalid boolean data stays unknown');
  const invalidStatus = await runCli([...args, '--status']);
  const invalidStatusOutput = JSON.parse(invalidStatus.stdout) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(invalidStatusOutput, 'nextAction'), 'unknown response clears the prior retry permission');
  assert.ok(!Object.hasOwn(invalidStatusOutput, 'sourceUploaded'));

  const missing = await runCli([...args, '--recover']);
  assert.equal(missing.code, 1);
  assert.ok(!Object.hasOwn(JSON.parse(missing.stdout), 'sourceUploaded'), 'a missing field stays unknown');
  const manifestPath = path.join(root, 'ai-app.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.projectVersion = '1.2.4';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(path.join(root, 'src', 'main.py'), 'print("UNAUTHORIZED_CHANGED_BODY")\n');
  const blocked = await runCli(args);
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stdout).status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1, 'unknown actions never authorize a new POST');
});

test('failed submit_again permits only a changed bundle under the saved managed owner', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-submit-again-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let postCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      assert.equal(request.url, '/api/managed-apps/' + MANAGED_ID + '/status');
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 8 });
      return;
    }
    postCount += 1;
    if (postCount === 1) {
      respondJson(response, publicationResponse(portal.origin, { status: 'failed', nextAction: 'submit_again' }));
    } else {
      respondJson(response, publicationResponse(portal.origin));
    }
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const failed = await runCli(args);
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.stdout).nextAction, 'submit_again');
  const originalPost = requests[0]!;
  const sameBundle = await runCli(args);
  assert.equal(sameBundle.code, 1);
  assert.equal(requests.length, 1, 'submit_again does not retry the same failed package');

  const manifestPath = path.join(root, 'ai-app.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.projectVersion = '1.2.4';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(path.join(root, 'src', 'main.py'), 'print("NEWER_SUBMISSION")\n');
  const submitted = await runCli([...args, '--managed-app-id', MANAGED_ID]);
  assert.equal(submitted.code, 0, submitted.stderr);
  const retry = requests.filter((item) => item.method === 'POST')[1]!;
  assert.equal(retry.headers['x-plaza-publish-key'], originalPost.headers['x-plaza-publish-key']);
  assert.notEqual(retry.headers['idempotency-key'], originalPost.headers['idempotency-key']);
  assert.equal(decodedBody(retry).managedAppId, MANAGED_ID);
  assert.equal(decodedBody(retry).expectedAppRevision, 8);
  const sentManifest = decodedBody(retry).files.find((file) => file.path === 'ai-app.json')!;
  assert.equal(JSON.parse(Buffer.from(sentManifest.content, 'base64').toString('utf8')).projectVersion, '1.2.4');
  assert.deepEqual(requests.map((item) => item.method), ['POST', 'GET', 'POST']);
});

test('malformed failed submit_again recovery cannot authorize a changed bundle', async (t) => {
  for (const malformed of ['missing-publication-id', 'source-not-uploaded'] as const) {
    await t.test(malformed, async (subtest) => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-submit-again-malformed-'));
      subtest.after(() => rm(temporary, { recursive: true, force: true }));
      const root = await makeProject(temporary);
      const stateDir = path.join(temporary, 'private-state');
      const requests: CapturedRequest[] = [];
      const portal = await createPortal((request, response) => {
        requests.push(request);
        assert.equal(request.method, 'POST');
        const failure: Record<string, unknown> = publicationResponse(portal.origin, {
          status: 'failed',
          nextAction: 'submit_again',
          ...(malformed === 'source-not-uploaded' ? { sourceUploaded: false } : {}),
        });
        if (malformed === 'missing-publication-id') {
          delete failure.id;
          delete failure.publicationId;
        }
        respondJson(response, failure);
      });
      subtest.after(portal.close);
      const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
      const failed = await runCli(args);
      assert.equal(failed.code, 1);
      assert.equal(JSON.parse(failed.stdout).nextAction, 'submit_again');

      const manifestPath = path.join(root, 'ai-app.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.projectVersion = '1.2.4';
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      await writeFile(path.join(root, 'src', 'main.py'), `print("${malformed}")\n`);
      const blocked = await runCli([...args, '--managed-app-id', MANAGED_ID]);
      assert.equal(blocked.code, 1);
      assert.equal(JSON.parse(blocked.stdout).status, 'HANDOFF_RECOVERY_REQUIRED');
      assert.equal(requests.length, 1, 'malformed failed receipts cannot authorize another POST');
    });
  }
});

test('--recover rejects a response for a different managed application without changing the saved request', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-recover-identity-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  const foreignPublicationId = 'b7f57658-aea1-4c8d-b353-e5196c9e02c4';
  const foreignTicket = 'B'.repeat(43);
  let postCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET' && request.url === '/api/managed-publications/receipt') {
      respondJson(response, publicationResponse(portal.origin, {
        id: foreignPublicationId,
        managedAppId: WRONG_MANAGED_ID,
        previewUrl: portal.origin + '/#publish=' + foreignPublicationId + '&key=' + foreignTicket,
        ticket: foreignTicket,
      }));
      return;
    }
    if (request.method === 'GET') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 7 });
      return;
    }
    postCount += 1;
    if (postCount === 1) {
      respondJson(response, publicationResponse(portal.origin));
    } else {
      response.destroy();
    }
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  assert.equal((await runCli(args)).code, 0);
  await writeFile(path.join(root, 'src', 'main.py'), 'print("UNCERTAIN_UPDATED_SOURCE")\n');
  assert.notEqual((await runCli(args)).code, 0, 'the update response is intentionally lost');
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'POST']);
  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const receiptPath = path.join(stateDir, receiptName);
  const before = await readFile(receiptPath);
  const updatePost = requests[2]!;

  const recovered = await runCli([...args, '--recover']);
  assert.equal(recovered.code, 1);
  const output = JSON.parse(recovered.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(output.managedAppId, MANAGED_ID);
  assert.ok(!recovered.stdout.includes(WRONG_MANAGED_ID));
  assert.ok(!recovered.stdout.includes(foreignPublicationId));
  assert.ok(!recovered.stdout.includes(foreignTicket));
  assert.deepEqual(await readFile(receiptPath), before, 'mismatched recovery data must not alter the saved request');
  assert.equal(decodedBody(updatePost).managedAppId, MANAGED_ID);
  assert.ok(updatePost.headers['x-plaza-publish-key']);
  assert.ok(updatePost.headers['idempotency-key']);
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'POST', 'GET']);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 2, 'recover must not resubmit source');
  assert.equal(requests[3]!.headers['idempotency-key'], updatePost.headers['idempotency-key']);
  assert.equal(requests[3]!.headers['x-plaza-publish-key'], updatePost.headers['x-plaza-publish-key']);
  assert.equal(requests[3]!.body.length, 0);
});

test('registered publications are reported separately and do not claim preview handoff completion', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-registered-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  let requestCount = 0;
  const portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, publicationResponse(portal.origin, { status: 'registered', nextAction: 'complete' }));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'registered');
  assert.equal(output.handoffState, 'registered');
  assert.equal(output.sourceUploaded, true);
  assert.ok(!Object.hasOwn(output, 'previewUrl'));
  assert.equal(requestCount, 1, 'the CLI does not make a confirm or follow-up request');
});

test('--recover reports MANAGED_OPERATION_NOT_FOUND without changing owner or retrying the POST', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-recover-missing-op-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  const portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'POST') {
      response.destroy();
      return;
    }
    respondJson(response, { error: { code: 'MANAGED_OPERATION_NOT_FOUND', message: 'private server detail' } }, 404);
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  assert.notEqual((await runCli(args)).code, 0);
  const post = requests[0]!;
  const recovered = await runCli([...args, '--recover']);
  assert.equal(recovered.code, 1);
  const output = JSON.parse(recovered.stdout) as Record<string, unknown>;
  assert.equal(output.code, 'MANAGED_OPERATION_NOT_FOUND');
  assert.equal(output.status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.ok(!recovered.stdout.includes('private server detail'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.method, 'GET');
  assert.equal(requests[1]!.body.length, 0);
  assert.equal(requests[1]!.headers['idempotency-key'], post.headers['idempotency-key']);
  assert.equal(requests[1]!.headers['x-plaza-publish-key'], post.headers['x-plaza-publish-key']);
});

test('--recover with no receipt stops without creating state or making a request', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-recover-empty-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  let requests = 0;
  const portal = await createPortal((_request, response) => { requests += 1; respondJson(response, {}); });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--recover']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(requests, 0);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('receipt save failure after POST requires GET recovery and never prints the unsaved URL', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-save-failure-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      respondJson(response, publicationResponse(portal.origin));
      return;
    }
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const failedSave = await runCli(args, 'post-response-save-failure');
  assert.equal(failedSave.code, 1);
  const recoveryOutput = JSON.parse(failedSave.stdout) as Record<string, unknown>;
  assert.equal(recoveryOutput.status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.ok(!Object.hasOwn(recoveryOutput, 'previewUrl'));
  assert.ok(!failedSave.stdout.includes(PREVIEW_TICKET));
  assert.equal(requests.length, 1);
  const post = requests[0]!;
  assert.equal(post.method, 'POST');
  const recovered = await runCli([...args, '--recover']);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.method, 'GET');
  assert.equal(requests[1]!.body.length, 0);
  assert.equal(requests[1]!.headers['idempotency-key'], post.headers['idempotency-key']);
  assert.equal(requests[1]!.headers['x-plaza-publish-key'], post.headers['x-plaza-publish-key']);
  const recoveredOutput = JSON.parse(recovered.stdout) as Record<string, unknown>;
  assert.equal(recoveredOutput.previewUrl, portal.origin + '/#publish=' + PUBLICATION_ID + '&key=' + PREVIEW_TICKET);
  assert.ok(!Object.hasOwn(recoveredOutput, 'ticket'));
});

test('network failure retries the persisted exact bundle with the same owner and idempotency keys', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-retry-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let attempt = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    attempt += 1;
    if (attempt === 1) {
      response.destroy();
      return;
    }
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(args);
  assert.notEqual(first.code, 0);
  assert.equal(requests.length, 1);
  const firstBody = requests[0]!.body.toString('utf8');
  const firstKey = requests[0]!.headers['idempotency-key'];
  const firstOwner = requests[0]!.headers['x-plaza-publish-key'];
  assert.ok(firstKey && firstOwner);
  assert.ok(!first.stdout.includes(String(firstOwner)));
  assert.ok(!first.stdout.includes(String(firstKey)));
  assert.ok(!first.stderr.includes(String(firstOwner)));

  const second = await runCli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.body.equals(Buffer.from(firstBody)), 'retry reuses the exact request body');
  assert.ok(requests[1]!.headers['idempotency-key'] === firstKey, 'retry reuses the same idempotency key');
  assert.ok(requests[1]!.headers['x-plaza-publish-key'] === firstOwner, 'retry reuses the same owner key');
});

test('updates require the receipt target and use its current revision', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-update-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      assert.equal(request.url, '/api/managed-apps/' + MANAGED_ID + '/status');
      assert.equal(request.headers['x-plaza-publish-key'], requests[0]!.headers['x-plaza-publish-key']);
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 7 });
      return;
    }
    const revision = requests.filter((item) => item.method === 'POST').length + 1;
    respondJson(response, publicationResponse(portal.origin, { revision }));
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.equal(first.code, 0, first.stderr);
  const firstRequest = requests.find((item) => item.method === 'POST')!;
  const firstOwner = firstRequest.headers['x-plaza-publish-key'];
  const firstIdempotency = firstRequest.headers['idempotency-key'];

  await writeFile(path.join(root, 'src', 'main.py'), 'print("UPDATED_SOURCE_SENTINEL")\n');
  const rejected = await runCli([...baseArgs, '--managed-app-id', WRONG_MANAGED_ID]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /receipt 不匹配/);
  assert.equal(requests.length, 1, 'mismatched target must not make HTTP requests');

  const update = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(update.code, 0, update.stderr);
  const updateGet = requests.find((item) => item.method === 'GET');
  const updatePost = requests.filter((item) => item.method === 'POST')[1]!;
  assert.ok(updateGet);
  assert.equal(updateGet.headers['x-plaza-publish-key'], firstOwner);
  const updateBody = decodedBody(updatePost);
  assert.equal(updateBody.managedAppId, MANAGED_ID);
  assert.equal(updateBody.expectedAppRevision, 7);
  assert.ok(updatePost.headers['x-plaza-publish-key'] === firstOwner, 'update keeps the owner key');
  assert.ok(updatePost.headers['idempotency-key'] !== firstIdempotency, 'changed bundle gets a new idempotency key');
  const updatedSource = updateBody.files.find((file) => file.path === 'src/main.py');
  assert.ok(Buffer.from(updatedSource!.content, 'base64').toString('utf8') === 'print("UPDATED_SOURCE_SENTINEL")\n', 'updated source was sent');
});

test('a POST response for a different managed application cannot overwrite the receipt identity', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-post-identity-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  const foreignPublicationId = '4bdc3046-6714-4ec6-bc1b-6976cdb08654';
  const foreignTicket = 'C'.repeat(43);
  let postCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 7 });
      return;
    }
    postCount += 1;
    if (postCount === 1) {
      respondJson(response, publicationResponse(portal.origin));
    } else {
      respondJson(response, publicationResponse(portal.origin, {
        id: foreignPublicationId,
        managedAppId: WRONG_MANAGED_ID,
        previewUrl: portal.origin + '/#publish=' + foreignPublicationId + '&key=' + foreignTicket,
        ticket: foreignTicket,
      }));
    }
  });
  t.after(portal.close);
  const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  assert.equal((await runCli(args)).code, 0);
  const firstPost = requests[0]!;
  await writeFile(path.join(root, 'src', 'main.py'), 'print("MISMATCHED_UPDATE_SOURCE")\n');
  const update = await runCli(args);
  assert.equal(update.code, 1);
  const output = JSON.parse(update.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'HANDOFF_RECOVERY_REQUIRED');
  assert.equal(output.managedAppId, MANAGED_ID);
  assert.ok(!update.stdout.includes(WRONG_MANAGED_ID));
  assert.ok(!update.stdout.includes(foreignPublicationId));
  assert.ok(!update.stdout.includes(foreignTicket));
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'POST']);
  const receiptName = (await readdir(stateDir)).find((name) => name.endsWith('.receipt'));
  assert.ok(receiptName);
  const updatePost = requests[2]!;
  assert.equal(decodedBody(updatePost).managedAppId, MANAGED_ID);
  assert.equal(updatePost.headers['x-plaza-publish-key'], firstPost.headers['x-plaza-publish-key']);
  assert.ok(updatePost.headers['idempotency-key']);
  const status = await runCli([...args, '--status']);
  assert.equal(status.code, 0, status.stderr);
  const statusOutput = JSON.parse(status.stdout) as Record<string, unknown>;
  assert.equal(statusOutput.managedAppId, MANAGED_ID, 'the original managed identity remains authoritative');
  assert.equal(statusOutput.publicationId, PUBLICATION_ID, 'foreign publication metadata is not persisted');
  assert.ok(!Object.hasOwn(statusOutput, 'previewUrl'), 'foreign preview URL is not persisted');
  assert.ok(!status.stdout.includes(WRONG_MANAGED_ID));
  assert.ok(!status.stdout.includes(foreignPublicationId));
  assert.ok(!status.stdout.includes(foreignTicket));
});

for (const errorCode of ['VALIDATION_FAILED', 'INVALID_REQUEST']) {
  test(`known HTTP 400 ${errorCode} allows corrected content with the same owner`, async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-known-400-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const root = await makeProject(temporary);
    const stateDir = path.join(temporary, 'private-state');
    const requests: CapturedRequest[] = [];
    let attempt = 0;
    let portal: Awaited<ReturnType<typeof createPortal>>;
    portal = await createPortal((request, response) => {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) {
        respondJson(response, { error: { code: errorCode, message: 'response-message-secret-sentinel' } }, 400);
        return;
      }
      respondJson(response, publicationResponse(portal.origin));
    });
    t.after(portal.close);
    const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
    const rejected = await runCli(args);
    assert.equal(rejected.code, 2);
    assert.equal(JSON.parse(rejected.stdout).status, 'validation_failed');
    assert.ok(!rejected.stdout.includes('response-message-secret-sentinel'));
    const rejectedOwner = requests[0]!.headers['x-plaza-publish-key'];
    const rejectedKey = requests[0]!.headers['idempotency-key'];

    await writeFile(path.join(root, 'src', 'main.py'), 'print("CORRECTED_AFTER_400")\n');
    const corrected = await runCli(args);
    assert.equal(corrected.code, 0, corrected.stderr);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.headers['x-plaza-publish-key'], rejectedOwner, 'corrected content retains the owner credential');
    assert.notEqual(requests[1]!.headers['idempotency-key'], rejectedKey, 'known rejected content gets a new idempotency key');
    assert.notDeepEqual(requests[1]!.body, requests[0]!.body);
    const correctedBody = decodedBody(requests[1]!);
    const source = correctedBody.files.find((file) => file.path === 'src/main.py')!;
    assert.equal(Buffer.from(source.content, 'base64').toString('utf8'), 'print("CORRECTED_AFTER_400")\n');
    assert.ok(!corrected.stdout.includes('response-message-secret-sentinel'));
  });
}

for (const scenario of [
  { name: 'HTTP 503', status: 503, code: 'SERVICE_UNAVAILABLE' },
  { name: 'unclassified HTTP 409', status: 409, code: 'IDEMPOTENCY_CONFLICT' },
]) {
  test(`${scenario.name} retries the same body and keys`, async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-uncertain-http-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const root = await makeProject(temporary);
    const stateDir = path.join(temporary, 'private-state');
    const requests: CapturedRequest[] = [];
    let attempt = 0;
    let portal: Awaited<ReturnType<typeof createPortal>>;
    portal = await createPortal((request, response) => {
      requests.push(request);
      attempt += 1;
      if (attempt === 1) {
        respondJson(response, { error: { code: scenario.code, message: 'response-body-must-stay-private' } }, scenario.status);
        return;
      }
      respondJson(response, publicationResponse(portal.origin));
    });
    t.after(portal.close);
    const args = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
    const uncertain = await runCli(args);
    assert.equal(uncertain.code, 2);
    assert.match(uncertain.stderr, new RegExp(`HTTP ${scenario.status}`));
    const firstBody = requests[0]!.body;
    const firstKey = requests[0]!.headers['idempotency-key'];
    const firstOwner = requests[0]!.headers['x-plaza-publish-key'];

    const recovered = await runCli(args);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(requests.length, 2);
    assert.ok(requests[1]!.body.equals(firstBody), 'uncertain HTTP response reuses the saved body');
    assert.equal(requests[1]!.headers['idempotency-key'], firstKey);
    assert.equal(requests[1]!.headers['x-plaza-publish-key'], firstOwner);
    assert.ok(!uncertain.stderr.includes('response-body-must-stay-private'));
    assert.ok(!recovered.stdout.includes('response-body-must-stay-private'));
  });
}

test('REVISION_CONFLICT starts a fresh operation and rereads owned status on the next call', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-revision-conflict-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let statusRevision = 7;
  let postAttempt = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: statusRevision });
      return;
    }
    postAttempt += 1;
    if (postAttempt === 1) {
      respondJson(response, publicationResponse(portal.origin));
    } else if (postAttempt === 2) {
      statusRevision = 8;
      respondJson(response, { error: { code: 'REVISION_CONFLICT', message: 'do-not-print-revision-detail' } }, 409);
    } else {
      respondJson(response, publicationResponse(portal.origin));
    }
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.equal(first.code, 0, first.stderr);
  const ownerKey = requests[0]!.headers['x-plaza-publish-key'];
  await writeFile(path.join(root, 'src', 'main.py'), 'print("REVISION_CONFLICT_RETRY")\n');

  const conflict = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /HTTP 409/);
  assert.ok(!conflict.stderr.includes('do-not-print-revision-detail'));
  const postsBeforeRetry = requests.filter((request) => request.method === 'POST');
  assert.equal(decodedBody(postsBeforeRetry[1]!).expectedAppRevision, 7);
  const rejectedKey = postsBeforeRetry[1]!.headers['idempotency-key'];
  assert.equal(postsBeforeRetry[1]!.headers['x-plaza-publish-key'], ownerKey);

  const recovered = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'POST', 'GET', 'POST']);
  const posts = requests.filter((request) => request.method === 'POST');
  const retry = posts[2]!;
  assert.equal(decodedBody(retry).managedAppId, MANAGED_ID);
  assert.equal(decodedBody(retry).expectedAppRevision, 8);
  assert.notEqual(retry.headers['idempotency-key'], rejectedKey, 'revision conflict gets a new operation ID');
  assert.equal(retry.headers['x-plaza-publish-key'], ownerKey, 'revision recovery retains the same owner credential');
  for (const statusRead of requests.filter((request) => request.method === 'GET')) {
    assert.equal(statusRead.headers['x-plaza-publish-key'], ownerKey, 'status refresh remains owner-authenticated');
  }
  assert.ok(!recovered.stdout.includes('do-not-print-revision-detail'));
});

test('VERSION_NOT_NEWER allows a manually corrected higher version in a new operation', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-version-rejected-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let postAttempt = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 1 });
      return;
    }
    postAttempt += 1;
    if (postAttempt === 1) {
      respondJson(response, publicationResponse(portal.origin));
    } else if (postAttempt === 2) {
      respondJson(response, { error: { code: 'VERSION_NOT_NEWER', message: 'do-not-print-version-detail' } }, 409);
    } else {
      respondJson(response, publicationResponse(portal.origin));
    }
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.equal(first.code, 0, first.stderr);
  const ownerKey = requests[0]!.headers['x-plaza-publish-key'];

  const manifestPath = path.join(root, 'ai-app.json');
  const staleManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  staleManifest.projectVersion = '1.2.2';
  await writeFile(manifestPath, JSON.stringify(staleManifest, null, 2));
  const rejected = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /HTTP 409/);
  assert.ok(!rejected.stderr.includes('do-not-print-version-detail'));
  const rejectedPost = requests.filter((request) => request.method === 'POST')[1]!;
  const rejectedKey = rejectedPost.headers['idempotency-key'];

  const correctedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  correctedManifest.projectVersion = '1.2.4';
  await writeFile(manifestPath, JSON.stringify(correctedManifest, null, 2));
  await writeFile(path.join(root, 'src', 'main.py'), 'print("HIGHER_VERSION")\n');
  const corrected = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(corrected.code, 0, corrected.stderr);
  const posts = requests.filter((request) => request.method === 'POST');
  const correctedPost = posts[2]!;
  assert.notEqual(correctedPost.headers['idempotency-key'], rejectedKey);
  assert.equal(correctedPost.headers['x-plaza-publish-key'], ownerKey);
  assert.equal(decodedBody(correctedPost).managedAppId, MANAGED_ID);
  assert.equal(decodedBody(correctedPost).expectedAppRevision, 1);
  const sentManifest = decodedBody(correctedPost).files.find((file) => file.path === 'ai-app.json')!;
  assert.equal(JSON.parse(Buffer.from(sentManifest.content, 'base64').toString('utf8')).projectVersion, '1.2.4');
  assert.ok(!corrected.stdout.includes('do-not-print-version-detail'));
});

test('unconfirmed preview updates use catalog revision zero, not publication revision', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-unconfirmed-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      assert.equal(request.url, '/api/managed-apps/' + MANAGED_ID + '/status');
      assert.equal(request.headers['x-plaza-publish-key'], requests[0]!.headers['x-plaza-publish-key']);
      // The first POST carries publication revision 1, while the app is still unconfirmed.
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', revision: 0 });
      return;
    }
    const postCount = requests.filter((item) => item.method === 'POST').length;
    respondJson(response, publicationResponse(portal.origin, { revision: postCount }));
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'preview_ready');

  await writeFile(path.join(root, 'src', 'main.py'), 'print("UNCONFIRMED_UPDATE")\n');
  const update = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(update.code, 0, update.stderr);
  const updateGet = requests.find((item) => item.method === 'GET');
  const updatePost = requests.filter((item) => item.method === 'POST')[1]!;
  assert.ok(updateGet);
  assert.equal(decodedBody(updatePost).expectedAppRevision, 0);
});

test('managed status errors stop before update without changing the receipt owner', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-status-denied-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let statusReads = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      statusReads += 1;
      if (statusReads === 1) {
        response.writeHead(403);
        response.end();
      } else {
        respondJson(response, { managedAppId: MANAGED_ID, appKey: 'wrong-app-key', revision: 7 });
      }
      return;
    }
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.equal(first.code, 0, first.stderr);
  const ownerKey = requests[0]!.headers['x-plaza-publish-key'];
  await writeFile(path.join(root, 'src', 'main.py'), 'print("STATUS_DENIED")\n');

  const update = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.notEqual(update.code, 0);
  assert.match(update.stderr, /HTTP 403/);
  const mismatchedStatus = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.notEqual(mismatchedStatus.code, 0);
  assert.match(mismatchedStatus.stderr, /managedAppId 或 appKey 不匹配/);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
  assert.equal(statusReads, 2);
  assert.equal(requests.at(-1)!.headers['x-plaza-publish-key'], ownerKey);
});

test('an uncertain managed update reuses its saved request revision and idempotency key', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-update-retry-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let postAttempt = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 7 });
      return;
    }
    postAttempt += 1;
    if (postAttempt === 2) {
      response.destroy();
      return;
    }
    respondJson(response, publicationResponse(portal.origin));
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.equal(first.code, 0, first.stderr);
  await writeFile(path.join(root, 'src', 'main.py'), 'print("RETRY_UPDATE")\n');

  const uncertain = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.notEqual(uncertain.code, 0);
  const updateRequest = requests.find((request) => request.method === 'POST' &&
    decodedBody(request).managedAppId === MANAGED_ID)!;
  const updateKey = updateRequest.headers['idempotency-key'];
  const firstOwner = requests.find((request) => request.method === 'POST')!.headers['x-plaza-publish-key'];
  assert.equal(updateRequest.headers['x-plaza-publish-key'], firstOwner);
  assert.equal(decodedBody(updateRequest).expectedAppRevision, 7);
  const beforeRetryCount = requests.length;

  const recovered = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const retryRequests = requests.slice(beforeRetryCount);
  assert.equal(retryRequests.length, 1, 'saved request revision avoids a second status lookup');
  assert.equal(retryRequests[0]!.method, 'POST');
  assert.equal(retryRequests[0]!.headers['idempotency-key'], updateKey);
  assert.equal(retryRequests[0]!.headers['x-plaza-publish-key'], firstOwner);
  assert.ok(retryRequests[0]!.body.equals(updateRequest.body));
});

test('changed files first resolve an uncertain request before starting a new managed update', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-pending-change-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  const requests: CapturedRequest[] = [];
  let postAttempt = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    requests.push(request);
    if (request.method === 'GET') {
      assert.equal(request.url, '/api/managed-apps/' + MANAGED_ID + '/status');
      respondJson(response, { managedAppId: MANAGED_ID, appKey: 'demo-assistant', appId: PUBLIC_ID, revision: 4 });
      return;
    }
    postAttempt += 1;
    if (postAttempt === 1) {
      response.destroy();
      return;
    }
    respondJson(response, publicationResponse(portal.origin, { revision: 2 }));
  });
  t.after(portal.close);
  const baseArgs = ['--origin', portal.origin, '--project', root, '--state-dir', stateDir];
  const first = await runCli(baseArgs);
  assert.notEqual(first.code, 0);
  const uncertainRequest = requests[0]!;
  const ownerKey = uncertainRequest.headers['x-plaza-publish-key'];
  const firstIdempotency = uncertainRequest.headers['idempotency-key'];

  await writeFile(path.join(root, 'src', 'main.py'), 'print("AFTER_UNCERTAIN_REQUEST")\n');
  const recovery = await runCli(baseArgs);
  assert.equal(recovery.code, 3);
  assert.match(recovery.stderr, /尚未上传当前内容/);
  assert.ok(requests[1]!.body.equals(uncertainRequest.body), 'uncertain request reuses the exact request body');
  assert.ok(requests[1]!.headers['idempotency-key'] === firstIdempotency, 'uncertain request reuses its idempotency key');
  assert.ok(requests[1]!.headers['x-plaza-publish-key'] === ownerKey, 'uncertain request reuses its owner key');

  const update = await runCli([...baseArgs, '--managed-app-id', MANAGED_ID]);
  assert.equal(update.code, 0, update.stderr);
  const get = requests.find((item) => item.method === 'GET');
  const postRequests = requests.filter((item) => item.method === 'POST');
  assert.equal(postRequests.length, 3);
  const updatePost = postRequests.at(-1)!;
  assert.ok(get);
  const updateBody = decodedBody(updatePost);
  assert.equal(updateBody.managedAppId, MANAGED_ID);
  assert.equal(updateBody.expectedAppRevision, 4);
  assert.ok(updatePost.headers['idempotency-key'] !== firstIdempotency, 'changed bundle gets a new idempotency key');
  assert.ok(updatePost.headers['x-plaza-publish-key'] === ownerKey, 'managed update keeps the owner key');
  const updatedSource = updateBody.files.find((file) => file.path === 'src/main.py');
  assert.ok(Buffer.from(updatedSource!.content, 'base64').toString('utf8') === 'print("AFTER_UNCERTAIN_REQUEST")\n', 'latest source was sent after recovery');
});

test('dry-run checks content without creating receipts or making HTTP requests', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-dryrun-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'should-not-exist');
  let requestCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, {});
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir, '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requestCount, 0);
  assert.ok(!result.stdout.includes('SOURCE_SENTINEL'));
  const summary = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(summary.dryRun, true);
  assert.equal(summary.fileCount, 5);
  assert.equal(typeof summary.totalBytes, 'number');
  assert.equal(typeof summary.digest, 'string');
  await assert.rejects(readFile(stateDir));
});

test('publication failure distinguishes uploaded source from failed catalog intake', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-failed-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    respondJson(response, publicationResponse(portal.origin, { status: 'failed', sourceUploaded: true }));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.status, 'failed');
  assert.equal(output.sourceUploaded, true);
  assert.equal(output.managedAppId, MANAGED_ID);
  assert.ok(!Object.hasOwn(output, 'ticket'));
  assert.match(result.stderr, /源文件已上传，广场收录失败/);
});

test('HTTP errors do not echo response bodies, request bodies, or owner keys', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-http-error-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(temporary, 'private-state');
  let capturedOwner = '';
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((request, response) => {
    capturedOwner = String(request.headers['x-plaza-publish-key']);
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'server-body-secret-sentinel' }));
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /HTTP 503/);
  for (const secret of [capturedOwner, 'server-body-secret-sentinel', 'SOURCE_SENTINEL']) {
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
  }
});

test('receipt state directory cannot be inside the project tree', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'plaza-publisher-state-boundary-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await makeProject(temporary);
  const stateDir = path.join(root, 'private-state');
  let requestCount = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    requestCount += 1;
    respondJson(response, {});
  });
  t.after(portal.close);
  const result = await runCli(['--origin', portal.origin, '--project', root, '--state-dir', stateDir]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /项目目录之外/);
  assert.equal(requestCount, 0);
  await assert.rejects(readFile(stateDir));
});
