import { DomainError } from './errors.js';
import type { Database, Queryable } from './database.js';
import type { Config } from '../config.js';
import { appendBusinessFact } from './analytics-journal.js';
import { accessRecord, requireAppAction } from './app-access.js';
import { randomUUID } from 'node:crypto';

export type AppLifecycleStatus = 'published' | 'offline' | 'deleted';
export type AppLifecycleAction = 'offline' | 'online' | 'delete' | 'restore';

export interface AppLifecycle {
  status: AppLifecycleStatus;
  revision: number;
  updatedAt?: string;
}

export interface AppLifecycleChange {
  appId: string;
  appRevision: number;
  lifecycle: AppLifecycle;
}

export const ALL_APP_LIFECYCLE_STATUSES: readonly AppLifecycleStatus[] = ['published', 'offline', 'deleted'];

interface LockedCatalogApp {
  app_revision: number;
  lifecycle_status: AppLifecycleStatus;
  lifecycle_revision: number;
  lifecycle_row_exists: boolean;
}

interface LifecycleInput {
  appId: string;
  audience: string;
  action: AppLifecycleAction;
  expectedAppRevision: number;
  expectedLifecycleRevision: number;
  analytics?: Config['analytics'];
  viewerId?: string;
  requireIdentity?: boolean;
}

const badRequest = (message: string) => new DomainError(400, 'VALIDATION_FAILED', message);
const conflict = (code: string, message: string) => new DomainError(409, code, message);

export async function changeAppLifecycle(db: Database, input: LifecycleInput): Promise<AppLifecycleChange> {
  if (!/^[0-9a-f-]{36}$/i.test(input.appId)) throw badRequest('应用 ID 格式无效。');
  if (!['offline', 'online', 'delete', 'restore'].includes(input.action)) throw badRequest('action 必须是 offline、online、delete 或 restore。');
  if (!Number.isSafeInteger(input.expectedAppRevision) || input.expectedAppRevision < 1) {
    throw badRequest('expectedAppRevision 必须是正整数。');
  }
  if (!Number.isSafeInteger(input.expectedLifecycleRevision) || input.expectedLifecycleRevision < 1) {
    throw badRequest('expectedLifecycleRevision 必须是正整数。');
  }

  return db.transaction(async (tx: Queryable) => {
    const result = await tx.query<LockedCatalogApp>(
      `SELECT a.revision AS app_revision,
              COALESCE(l.status, 'published') AS lifecycle_status,
              COALESCE(l.revision, 1) AS lifecycle_revision,
              (l.app_id IS NOT NULL) AS lifecycle_row_exists
         FROM catalog_apps a
         JOIN published_snapshots s ON s.id = a.current_snapshot_id AND s.audience = $2
         LEFT JOIN catalog_app_lifecycle l ON l.app_id = a.id
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [input.appId, input.audience],
    );
    const app = result.rows[0];
    if (!app) throw new DomainError(404, 'APP_NOT_FOUND', '应用不存在。');
    if (input.requireIdentity || await accessRecord(tx, input.appId)) await requireAppAction(tx, input.appId, input.viewerId);
    if (app.app_revision !== input.expectedAppRevision) {
      throw conflict('APP_REVISION_CONFLICT', '应用来源修订已变化，请重新读取后台详情后操作。');
    }
    if (app.lifecycle_revision !== input.expectedLifecycleRevision) {
      throw conflict('LIFECYCLE_REVISION_CONFLICT', '应用状态已变化，请重新读取后台详情后操作。');
    }

    const nextStatus = nextLifecycleStatus(input.action, app.lifecycle_status);
    const now = new Date();
    const nextRevision = app.lifecycle_revision + 1;
    if (app.lifecycle_row_exists) {
      const updated = await tx.query<{ app_id: string }>(
        `UPDATE catalog_app_lifecycle
            SET status = $3, revision = $4, updated_at = $5
          WHERE app_id = $1 AND revision = $2
          RETURNING app_id`,
        [input.appId, input.expectedLifecycleRevision, nextStatus, nextRevision, now],
      );
      if (updated.rowCount !== 1) {
        throw conflict('LIFECYCLE_REVISION_CONFLICT', '应用状态已变化，请重新读取后台详情后操作。');
      }
    } else {
      const inserted = await tx.query<{ app_id: string }>(
        `INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (app_id) DO NOTHING
         RETURNING app_id`,
        [input.appId, nextStatus, nextRevision, now],
      );
      if (inserted.rowCount !== 1) {
        throw conflict('LIFECYCLE_REVISION_CONFLICT', '应用状态已变化，请重新读取后台详情后操作。');
      }
    }
    await appendBusinessFact(tx, 'catalog_app_lifecycle', input.appId, input.analytics, 'app_lifecycle_changed', {
      appId: input.appId, action: input.action, fromStatus: app.lifecycle_status, toStatus: nextStatus,
      lifecycleRevision: nextRevision, appRevision: app.app_revision,
    });
    if (input.viewerId) await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,before_value,after_value)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`, [randomUUID(), input.viewerId, input.appId, `lifecycle_${input.action}`,
      JSON.stringify({ expectedAppRevision: input.expectedAppRevision, expectedLifecycleRevision: input.expectedLifecycleRevision }),
      JSON.stringify({ status: app.lifecycle_status }), JSON.stringify({ status: nextStatus, revision: nextRevision })]);
    return {
      appId: input.appId,
      appRevision: app.app_revision,
      lifecycle: { status: nextStatus, revision: nextRevision, updatedAt: now.toISOString() },
    };
  });
}

function nextLifecycleStatus(action: AppLifecycleAction, current: AppLifecycleStatus): AppLifecycleStatus {
  if (action === 'offline' && current === 'published') return 'offline';
  if (action === 'online' && current === 'offline') return 'published';
  if (action === 'delete' && current !== 'deleted') return 'deleted';
  if (action === 'restore' && current === 'deleted') return 'offline';
  throw conflict('LIFECYCLE_TRANSITION_CONFLICT', `当前应用状态为 ${current}，不能执行 ${action}。`);
}
