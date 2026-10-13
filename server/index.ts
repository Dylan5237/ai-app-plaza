import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './domain/database.js';
import { createApp } from './app.js';

let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await app?.close(); } finally { await db?.close(); }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
try {
  const config = await loadConfig();
  db = await openDatabase(config.databaseUrl ? { url: config.databaseUrl } : { path: resolve(config.dataDir, 'postgres') });
  ({ app } = await createApp(config, db));
  await app.listen({ host: config.host, port: config.port });
  console.log(`AI应用广场已启动：${config.publicOrigin}（${config.local ? '本地验证' : '配置环境'}，无需登录）`);
} catch {
  await stop().catch(() => undefined);
  console.error('服务启动失败，请检查端口、数据库与部署配置');
  process.exitCode = 1;
}
