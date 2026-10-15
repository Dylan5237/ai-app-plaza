import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.match(four.stderr, /最多 3 个/);
  await writeFile(file, JSON.stringify({ ...source, tags: ['MCP', 'ｍｃｐ'] }));
  assert.equal((await runCli(args)).code, 2);
  await writeFile(file, JSON.stringify({ ...source, tags: ['😀'.repeat(32)] }));
  assert.equal((await runCli(args)).code, 0);
  await writeFile(file, JSON.stringify({ ...source, tags: ['😀'.repeat(33)] }));
  assert.equal((await runCli(args)).code, 2);
  assert.equal(requests, 0);
  await assert.rejects(access(state), { code: 'ENOENT' });
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
    status: 'preview_ready',
    revision: 1,
    appId: PUBLIC_ID,
    preview: { id: PUBLIC_ID },
    ticket: 'fixture-ticket-must-not-be-printed-alone',
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
    assert.ok(result.stderr.includes(item.path), 'reports the path for ' + item.path);
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
  ];
  let responseIndex = 0;
  let portal: Awaited<ReturnType<typeof createPortal>>;
  portal = await createPortal((_request, response) => {
    const url = previewUrls(portal.origin)[responseIndex++];
    respondJson(response, publicationResponse(portal.origin, { previewUrl: url }));
  });
  t.after(portal.close);

  const urls = previewUrls(portal.origin);
  for (let index = 0; index < urls.length; index += 1) {
    const result = await runCli([
      '--origin', portal.origin,
      '--project', root,
      '--state-dir', path.join(temporary, 'private-state-' + index),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.ok(!Object.hasOwn(output, 'previewUrl'), 'unsafe author preview link must be hidden');
  }
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
    assert.match(rejected.stderr, /HTTP 400/);
    assert.ok(!rejected.stderr.includes('response-message-secret-sentinel'));
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
