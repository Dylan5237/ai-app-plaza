import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/domain/database.js';
import { manifest } from './gitlab-fixture.js';
import { startManagedGitLabFixture, MANAGED_GITLAB_TOKEN } from './managed-gitlab-fixture.js';

export function bundle(version = '1.0.0', count = 0, change = '') {
  const value = { ...manifest(), projectVersion: version, docs: { readme: 'README.md', usage: 'docs/usage-1.md' } };
  const files = [
    { path: 'ai-app.json', text: JSON.stringify(value) },
    { path: 'README.md', text: '# 协议测试应用' },
    { path: 'docs/usage-1.md', text: '# 使用说明' },
    { path: 'docs/agent-1.md', text: '# Agent 接入说明' },
    ...Array.from({ length: count }, (_, i) => ({ path: `src/module-${i.toString().padStart(4, '0')}.ts`, text: `export const value = ${i};${i === 0 ? change : ''}` })),
  ];
  return { appKey: value.appKey, manifestPath: 'ai-app.json', files: files.map(file => ({ path: file.path, content: Buffer.from(file.text).toString('base64') })) };
}

export async function performanceHarness(delayMs = 0, factories = { createApp, openDatabase }) {
  const fixture = await startManagedGitLabFixture('main');
  fixture.state.delayMs = delayMs;
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const db = await factories.openDatabase({ path: 'memory://' });
  const { app, service, managed } = await factories.createApp({ host: '127.0.0.1', port, publicOrigin: origin,
    gitlabUrl: fixture.url, secret: 'performance-fixture-only-secret-at-least-32-bytes', audience: '协议测试',
    local: true, dataDir: '', staticDir: resolve('dist'), rateLimit: false,
    managedPublishing: { groupId: '63', groupPath: 'sky-efficiency-skills/ai-apps', token: MANAGED_GITLAB_TOKEN } }, db);
  await app.listen({ port, host: '127.0.0.1' });
  return { origin, fixture, db, app, service, managed: managed!,
    async submit(value: object, key = randomBytes(32).toString('base64url'), idempotency = randomUUID()) {
      const response = await fetch(`${origin}/api/managed-publications`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Plaza-Publish-Key': key, 'Idempotency-Key': idempotency }, body: JSON.stringify(value) });
      const result = await response.json() as any;
      return { response, result, key, idempotency };
    },
    async confirm(result: any) {
      const response = await fetch(`${origin}/api/publications/${result.id}/confirm`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${result.ticket}` }, body: JSON.stringify({ revision: result.revision, digest: result.digest }) });
      return response.json() as Promise<any>;
    },
    close: async () => { await app.close(); await db.close(); await fixture.close(); },
  };
}
