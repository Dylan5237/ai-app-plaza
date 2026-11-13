import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { openDatabase } from '../server/domain/database.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';
import { receiptDirectorySnapshot, runPublisherCli, writeSafetyProject } from './helpers/managed-publish-safety-flow.js';

async function startMountedPortal(basePath: string, temporary: string) {
  const requests: Array<{ method: string; path: string }> = [];
  let backendPort = 0;
  // Match a path-preserving proxy_pass without a URI suffix. A mounted entry
  // rejects root API paths so Fastify's legacy root routes cannot hide a lost prefix.
  const entry = createServer((request, response) => {
    const requestPath = request.url || '/';
    requests.push({ method: request.method || '', path: requestPath });
    if (basePath && !requestPath.startsWith(`${basePath}/`)) {
      response.writeHead(404).end();
      return;
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1', port: backendPort,
      method: request.method, path: requestPath, headers: request.headers,
    }, result => {
      response.writeHead(result.statusCode || 502, result.headers);
      result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502).end(); });
    request.pipe(upstream);
  });
  entry.listen(0, '127.0.0.1');
  await once(entry, 'listening');
  const port = (entry.address() as AddressInfo).port;
  const publicOrigin = `http://127.0.0.1:${port}`;
  const db = await openDatabase({ path: 'memory://' });
  const gitlab = await startManagedGitLabFixture();
  const config: Config = {
    host: '127.0.0.1', port, publicOrigin, publicBasePath: basePath,
    gitlabUrl: gitlab.url, secret: 'publisher-prefix-test-secret-with-at-least-32-bytes',
    dataDir: path.join(temporary, 'portal-data'), local: true,
    audience: '所有能访问本门户的人', staticDir: path.join(temporary, 'static'), rateLimit: false,
    managedPublishing: { groupId: '63', groupPath: 'sky-efficiency-skills/ai-apps', token: MANAGED_GITLAB_TOKEN },
  };
  const { app } = await createApp(config, db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  backendPort = (app.server.address() as AddressInfo).port;
  return {
    origin: publicOrigin + basePath, requests, db, gitlab,
    close: async () => {
      entry.closeAllConnections();
      await new Promise<void>((resolve, reject) => entry.close(error => error ? reject(error) : resolve()));
      await app.close();
      await db.close();
      await gitlab.close();
    },
  };
}

for (const basePath of ['', '/plaza']) {
  test(`downloaded publisher keeps ${basePath || 'root'} routing through preflight, upload, receipt and update`, async t => {
    const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const temporary = await mkdtemp(path.join(artifacts, 'publisher-prefix-'));
    const portal = await startMountedPortal(basePath, temporary);
    t.after(async () => { await portal.close(); await rm(temporary, { recursive: true, force: true }); });
    const root = await writeSafetyProject(temporary, 'publisher-prefix-test');
    const stateDir = path.join(temporary, 'private-state');

    const contractResponse = await fetch(`${portal.origin}/api/publish-contract`);
    assert.equal(contractResponse.status, 200);
    const contract = await contractResponse.json() as { submitUrl: string; managed: {
      publisherUrl: string; publisherSha256: string; validationUrl: string; receiptUrl: string;
    } };
    assert.equal(contract.submitUrl, `${portal.origin}/api/managed-publications`);
    assert.equal(contract.managed.validationUrl, `${portal.origin}/api/managed-publications/validate`);
    assert.equal(contract.managed.receiptUrl, `${portal.origin}/api/managed-publications/receipt`);
    assert.equal(contract.managed.publisherUrl, `${portal.origin}/api/publisher-cli.py`);
    assert.equal((await fetch(`${portal.origin}/api/tags`)).status, 200);
    const scriptResponse = await fetch(contract.managed.publisherUrl);
    assert.equal(scriptResponse.status, 200);
    const script = await scriptResponse.text();
    const scriptHash = createHash('sha256').update(script, 'utf8').digest('hex');
    assert.equal(scriptHash, contract.managed.publisherSha256);
    assert.equal(scriptHash, scriptResponse.headers.get('x-content-sha256'));
    const cliPath = path.join(temporary, 'downloaded-publisher.py');
    await writeFile(cliPath, script, 'utf8');
    const args = ['--origin', `${portal.origin}/`, '--project', root, '--state-dir', stateDir];

    const validated = basePath
      ? await runPublisherCli(fileURLToPath(new URL('../scripts/check-publisher-ingress.py', import.meta.url)), ['--origin', portal.origin])
      : await runPublisherCli(cliPath, [...args, '--validate']);
    assert.equal(validated.code, 0, validated.stderr || validated.stdout);
    const validation = JSON.parse(validated.stdout);
    assert.equal(validation.status, 'validated');
    if (basePath) {
      assert.equal(validation.fileCount, 15);
      assert.ok(validation.totalBytes > 84_749);
    }
    assert.equal((await receiptDirectorySnapshot(stateDir)).exists, false);
    assert.equal(portal.gitlab.state.writes.length, 0);
    for (const table of ['managed_app_bindings', 'managed_publish_operations', 'publications']) {
      assert.equal((await portal.db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0]?.count, 0);
    }

    const published = await runPublisherCli(cliPath, args);
    assert.equal(published.code, 0, published.stderr || published.stdout);
    const first = JSON.parse(published.stdout);
    assert.equal(first.status, 'preview_ready');
    assert.equal(first.handoffState, 'complete');
    assert.equal(first.sourceUploaded, true);
    assert.equal(new URL(first.previewUrl).pathname, `${basePath}/`);
    assert.ok(first.previewUrl.startsWith(`${portal.origin}/#publish=`));

    const recovered = await runPublisherCli(cliPath, [...args, '--recover']);
    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    assert.equal(JSON.parse(recovered.stdout).previewUrl, first.previewUrl);
    const beforeStatus = portal.requests.length;
    const status = await runPublisherCli(cliPath, [...args, '--status']);
    assert.equal(status.code, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).previewUrl, first.previewUrl);
    assert.equal(portal.requests.length, beforeStatus, 'local receipt status makes no HTTP request');

    const manifestPath = path.join(root, 'ai-app.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, projectVersion: '1.0.1' }));
    const update = await runPublisherCli(cliPath, [...args, '--managed-app-id', first.managedAppId]);
    assert.equal(update.code, 0, update.stderr || update.stdout);
    const second = JSON.parse(update.stdout);
    assert.equal(second.status, 'preview_ready');
    assert.equal(second.managedAppId, first.managedAppId);
    assert.notEqual(second.publicationId, first.publicationId);
    assert.ok(second.previewUrl.startsWith(`${portal.origin}/#publish=`));
    const recoveredUpdate = await runPublisherCli(cliPath, [...args, '--recover']);
    assert.equal(recoveredUpdate.code, 0, recoveredUpdate.stderr || recoveredUpdate.stdout);
    assert.equal(JSON.parse(recoveredUpdate.stdout).previewUrl, second.previewUrl);
    assert.equal(portal.gitlab.state.projects.size, 1);
    assert.equal(portal.gitlab.state.projects.get(100)!.commits.size, 2);

    assert.deepEqual(portal.requests.filter(request => request.method === 'POST').map(request => request.path), [
      `${basePath}/api/managed-publications/validate`,
      `${basePath}/api/managed-publications`,
      `${basePath}/api/managed-publications`,
    ]);
    assert.equal(portal.requests.filter(request => request.path === `${basePath}/api/managed-publications/receipt`).length, 2);
    assert.ok(portal.requests.some(request => request.path === `${basePath}/api/managed-apps/${first.managedAppId}/status`));
    if (basePath) assert.ok(portal.requests.every(request => request.path.startsWith(`${basePath}/`)));
  });
}
