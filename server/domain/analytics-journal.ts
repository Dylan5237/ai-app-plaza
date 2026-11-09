import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Queryable } from './database.js';

/** Stored on the business row in the same transaction; no credentials or content. */
export async function appendBusinessFact(tx: Queryable, table: 'publications' | 'managed_publish_operations' | 'catalog_app_lifecycle', id: string,
  settings: Config['analytics'], eventName: string, fields: Record<string, string | number | null>) {
  if (!settings) return;
  const key = table === 'catalog_app_lifecycle' ? 'app_id' : 'id';
  const fact = { eventId: randomUUID(), eventName, schemaVersion: 1, origin: 'server', occurredAt: new Date().toISOString(),
    environment: settings.environment, siteInstanceId: settings.siteInstanceId, ...fields };
  // A telemetry failure must not abort an otherwise valid business transition.
  await tx.query('SAVEPOINT plaza_analytics_fact');
  try {
    await tx.query(`UPDATE ${table} SET analytics_journal=analytics_journal || $2::jsonb WHERE ${key}=$1`, [id, JSON.stringify([fact])]);
    await tx.query('RELEASE SAVEPOINT plaza_analytics_fact');
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT plaza_analytics_fact');
    await tx.query('RELEASE SAVEPOINT plaza_analytics_fact');
    console.error('业务统计记录未写入，本次操作继续');
  }
}
