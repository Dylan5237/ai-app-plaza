import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/domain/database.js';
import { startGitLabFixture } from './gitlab-fixture.js';
import type { Config } from '../../server/config.js';

export async function startHarness(count = 1, path = 'memory://', options: Pick<Config, 'previewAdmin'> = {}) {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const gitlab = await startGitLabFixture(count);
  const db = await openDatabase({ path });
  const origin = `http://127.0.0.1:${port}`;
  const config: Config = { host: '127.0.0.1', port, publicOrigin: origin, gitlabUrl: gitlab.url, secret: 'fixture-only-secret-for-repeatable-postgresql-tests', dataDir: '', local: true, audience: '所有能访问本门户的人', staticDir: resolve('dist'), rateLimit: false, ...options };
  const { app, service } = await createApp(config, db);
  await app.listen({ port, host: '127.0.0.1' });
  return { app, service, db, gitlab, origin, config, close: async () => { await app.close(); await db.close(); await gitlab.close(); } };
}
