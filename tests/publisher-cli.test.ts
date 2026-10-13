import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

function runCli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-u', cliPath, ...args], {
      env: { ...process.env, PYTHONUTF8: '1' },
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
    status: 'preview_ready',
    revision: 1,
    appId: PUBLIC_ID,
    preview: { id: PUBLIC_ID },
    ticket: 'fixture-ticket-must-not-be-printed-alone',
    previewUrl: origin + '/preview?ticket=fixture-ticket-must-not-be-printed-alone',
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
  assert.ok(authorPreview?.origin === portal.origin && authorPreview.pathname === '/preview' &&
    authorPreview.searchParams.has('ticket'), 'author preview URL is present');
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
  assert.ok(!first.stdout.includes(firstKey));
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
      assert.equal(request.url, '/api/apps/' + PUBLIC_ID);
      respondJson(response, { id: PUBLIC_ID, revision: 7 });
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
  const updateBody = decodedBody(updatePost);
  assert.equal(updateBody.managedAppId, MANAGED_ID);
  assert.equal(updateBody.expectedAppRevision, 7);
  assert.ok(updatePost.headers['x-plaza-publish-key'] === firstOwner, 'update keeps the owner key');
  assert.ok(updatePost.headers['idempotency-key'] !== firstIdempotency, 'changed bundle gets a new idempotency key');
  const updatedSource = updateBody.files.find((file) => file.path === 'src/main.py');
  assert.ok(Buffer.from(updatedSource!.content, 'base64').toString('utf8') === 'print("UPDATED_SOURCE_SENTINEL")\n', 'updated source was sent');
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
      respondJson(response, { id: PUBLIC_ID, revision: 4 });
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
