import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';
import { requireAdministrator } from './platform-access.js';

export type ShareScope = 'all' | 'members' | 'groups' | 'self';
export interface AppAccess {
  app_id: string; owner_id: string; scope: ShareScope;
  member_ids: string[]; group_ids: string[]; maintainer_ids: string[]; revision: number;
}
export type AccessAction = 'maintain' | 'share';
const missing = () => new DomainError(404, 'APP_NOT_FOUND', '应用不存在或当前不可访问。');
const conflict = () => new DomainError(409, 'ACCESS_REVISION_CONFLICT', '归属或权限已变化，请重新读取后核对。');

/** Fixed aliases/placeholder expressions are supplied by server code, never request text. */
export function appAccessPredicate(viewer = 'NULL::uuid', management = false, alias = 'a'): string {
  const maintenance = `(p.owner_id=${viewer} OR ${viewer}=ANY(p.maintainer_ids))`;
  if (management) return `EXISTS(SELECT 1 FROM plaza_app_access p WHERE p.app_id=${alias}.id AND ${maintenance})`;
  return `(NOT EXISTS(SELECT 1 FROM plaza_app_access p WHERE p.app_id=${alias}.id)
    OR EXISTS(SELECT 1 FROM plaza_app_access p WHERE p.app_id=${alias}.id AND (
      p.scope='all' OR p.owner_id=${viewer}
      OR p.scope='members' AND ${viewer}=ANY(p.member_ids)
      OR p.scope='groups' AND EXISTS(SELECT 1 FROM plaza_groups g
        JOIN plaza_group_members gm ON gm.group_id=g.id
        WHERE g.enabled=true AND g.id=ANY(p.group_ids) AND gm.user_id=${viewer}))))`;
}

export async function publicCatalogAppIds(db: Queryable, audience: string): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT a.id FROM catalog_apps a
    JOIN published_snapshots s ON s.id=a.current_snapshot_id
    LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id
    WHERE s.audience=$1 AND COALESCE(l.status,'published')='published' AND ${appAccessPredicate()}`, [audience])).rows.map(row => row.id);
}

export async function accessRecord(db: Queryable, appId: string): Promise<AppAccess | undefined> {
  return (await db.query<AppAccess>('SELECT * FROM plaza_app_access WHERE app_id=$1', [appId])).rows[0];
}

export async function requireAppAction(db: Queryable, appId: string, userId: string | undefined, action: AccessAction = 'maintain') {
  if (!userId) throw new DomainError(401, 'LOGIN_REQUIRED', '请使用天宫身份登录后操作。');
  const access = await accessRecord(db, appId);
  if (!access || access.owner_id !== userId && (action === 'share' || !access.maintainer_ids.includes(userId))) throw missing();
  return access;
}

export async function initializePrivateApplication(tx: Queryable, appId: string, ownerId: string) {
  await tx.query("INSERT INTO plaza_app_access(app_id,owner_id,scope) VALUES($1,$2,'self')", [appId, ownerId]);
  await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,after_value)
    VALUES($1,$2,$3,'application_created','{}'::jsonb,$4::jsonb)`,
  [randomUUID(), ownerId, appId, JSON.stringify({ ownerId, scope: 'self' })]);
}

async function existingUser(tx: Queryable, id: string) {
  if (!(await tx.query("SELECT id FROM plaza_identities WHERE id=$1 AND source='tiangong'", [id])).rows.length) {
    throw new DomainError(400, 'MEMBER_INVALID', '请选择已经核验并登记的广场用户。');
  }
}
const unique = (values: string[]) => [...new Set(values)].sort();

export function createAppAccessService(db: Database, audience: string) {
  async function lock(tx: Queryable, appId: string) {
    const row = (await tx.query(`SELECT a.revision FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
      WHERE a.id=$1 AND s.audience=$2 FOR UPDATE OF a`, [appId, audience])).rows[0];
    if (!row) throw missing();
    return row;
  }
  async function replay(tx: Queryable, actorId: string, resourceId: string, action: string, input: { requestId: string }) {
    const row = (await tx.query('SELECT * FROM plaza_access_operations WHERE id=$1', [input.requestId])).rows[0];
    if (!row) return false;
    if (row.actor_id !== actorId || row.resource_id !== resourceId || row.action !== action || !isDeepStrictEqual(row.request_value, input)) {
      throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', '该操作请求已用于其他变更，请先回读结果。');
    }
    return true;
  }
  async function audit(tx: Queryable, actorId: string, resourceId: string, action: string, input: { requestId: string }, before: unknown, after: unknown) {
    await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,before_value,after_value)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
    [input.requestId, actorId, resourceId, action, JSON.stringify(input), JSON.stringify(before), JSON.stringify(after)]);
  }
  async function settings(actorId: string, appId: string) {
    const access = await requireAppAction(db, appId, actorId);
    const people = (await db.query("SELECT id,name,account FROM plaza_identities WHERE id=ANY($1::uuid[]) ORDER BY name,id", [unique([access.owner_id, ...access.maintainer_ids, ...access.member_ids])])).rows;
    const groups = (await db.query('SELECT id,name,enabled FROM plaza_groups WHERE id=ANY($1::uuid[]) ORDER BY name,id', [access.group_ids])).rows;
    return { ...access, people, groups, canShare: access.owner_id === actorId, canMaintain: true };
  }
  async function candidates(actorId: string, appId?: string) {
    if (appId) await requireAppAction(db, appId, actorId, 'share');
    else await requireAdministrator(db, actorId);
    return {
      users: (await db.query("SELECT id,name,account FROM plaza_identities WHERE source='tiangong' ORDER BY name,id")).rows,
      groups: (await db.query('SELECT id,name FROM plaza_groups WHERE enabled=true ORDER BY name,id')).rows,
    };
  }
  async function governance(actorId: string) {
    await requireAdministrator(db, actorId);
    return (await db.query(`SELECT a.id,a.revision,s.manifest->>'name' AS name,s.version,p.owner_id,
      i.name AS owner_name,COALESCE(l.status,'published') AS status
      FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
      LEFT JOIN plaza_app_access p ON p.app_id=a.id LEFT JOIN plaza_identities i ON i.id=p.owner_id
      LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id WHERE s.audience=$1 ORDER BY a.updated_at DESC,a.id`, [audience])).rows;
  }
  async function adopt(actorId: string, appId: string, input: { ownerId: string; expectedAppRevision: number; requestId: string }) {
    return db.transaction(async tx => {
      const app = await lock(tx, appId);
      await requireAdministrator(tx, actorId);
      if (await replay(tx, actorId, appId, 'owner_assigned', input)) return { recovered: true };
      if (await accessRecord(tx, appId)) throw new DomainError(409, 'OWNER_ALREADY_ASSIGNED', '应用已有负责人，请使用负责人交接。');
      if (app.revision !== input.expectedAppRevision) throw conflict();
      await existingUser(tx, input.ownerId);
      // Existing audience remains public; legacy credentials are not silently bound to a new person.
      await tx.query("INSERT INTO plaza_app_access(app_id,owner_id,scope) VALUES($1,$2,'all')", [appId, input.ownerId]);
      await audit(tx, actorId, appId, 'owner_assigned', input, null, { ownerId: input.ownerId, scope: 'all' });
      return { saved: true };
    });
  }
  async function update(actorId: string, appId: string, input: { revision: number; requestId: string; scope?: ShareScope; memberIds?: string[]; groupIds?: string[]; maintainerIds?: string[] }) {
    return db.transaction(async tx => {
      await lock(tx, appId);
      const before = await requireAppAction(tx, appId, actorId, 'share');
      const action = input.scope ? 'sharing_changed' : 'maintainers_changed';
      if (await replay(tx, actorId, appId, action, input)) return { recovered: true };
      if (before.revision !== input.revision) throw conflict();
      const after = { scope: input.scope ?? before.scope,
        memberIds: input.scope ? unique(input.memberIds ?? []) : before.member_ids,
        groupIds: input.scope ? unique(input.groupIds ?? []) : before.group_ids,
        maintainerIds: input.maintainerIds ? unique(input.maintainerIds).filter(id => id !== before.owner_id) : before.maintainer_ids };
      if (after.scope === 'members' ? !after.memberIds.length : after.memberIds.length > 0) throw new DomainError(400, 'AUDIENCE_INVALID', '指定成员时至少选择一人，其他范围不包含成员清单。');
      if (after.scope === 'groups' ? !after.groupIds.length : after.groupIds.length > 0) throw new DomainError(400, 'AUDIENCE_INVALID', '指定小组时至少选择一组，其他范围不包含小组清单。');
      for (const id of unique([...after.memberIds, ...after.maintainerIds])) await existingUser(tx, id);
      if (input.scope && after.groupIds.length && (await tx.query('SELECT id FROM plaza_groups WHERE enabled=true AND id=ANY($1::uuid[])', [after.groupIds])).rows.length !== after.groupIds.length) throw new DomainError(400, 'GROUP_INVALID', '请选择仍启用的小组。');
      if (isDeepStrictEqual(after, { scope: before.scope, memberIds: before.member_ids, groupIds: before.group_ids, maintainerIds: before.maintainer_ids })) throw new DomainError(409, 'NO_CHANGE', '配置没有变化。');
      await tx.query(`UPDATE plaza_app_access SET scope=$2,member_ids=$3,group_ids=$4,maintainer_ids=$5,revision=revision+1 WHERE app_id=$1`,
        [appId, after.scope, after.memberIds, after.groupIds, after.maintainerIds]);
      await audit(tx, actorId, appId, action, input, before, after);
      return { saved: true };
    });
  }
  async function requestTransfer(actorId: string, appId: string, input: { receiverId: string; revision: number; requestId: string }) {
    return db.transaction(async tx => {
      await lock(tx, appId);
      const access = await requireAppAction(tx, appId, actorId, 'share');
      if (await replay(tx, actorId, appId, 'transfer_requested', input)) return { recovered: true };
      if (access.revision !== input.revision) throw conflict();
      if (input.receiverId === actorId) throw new DomainError(400, 'RECEIVER_INVALID', '请选择另一位接收人。');
      await existingUser(tx, input.receiverId);
      await tx.query("UPDATE plaza_app_transfers SET status='cancelled' WHERE app_id=$1 AND status='pending'", [appId]);
      await tx.query('INSERT INTO plaza_app_transfers(id,app_id,owner_id,receiver_id,access_revision) VALUES($1,$2,$3,$4,$5)', [input.requestId, appId, actorId, input.receiverId, access.revision]);
      await audit(tx, actorId, appId, 'transfer_requested', input, { ownerId: actorId }, { receiverId: input.receiverId });
      return { saved: true };
    });
  }
  async function transfers(actorId: string) {
    return (await db.query(`SELECT t.id,t.app_id,t.status,t.owner_id,t.receiver_id,t.access_revision,
      s.manifest->>'name' AS name,i.name AS owner_name,r.name AS receiver_name
      FROM plaza_app_transfers t JOIN catalog_apps a ON a.id=t.app_id
      JOIN published_snapshots s ON s.id=a.current_snapshot_id
      JOIN plaza_identities i ON i.id=t.owner_id JOIN plaza_identities r ON r.id=t.receiver_id
      WHERE t.status='pending' AND (t.owner_id=$1 OR t.receiver_id=$1) ORDER BY t.created_at DESC,t.id`, [actorId])).rows;
  }
  async function decideTransfer(actorId: string, transferId: string, input: { action: 'accept' | 'decline' | 'cancel'; requestId: string }) {
    return db.transaction(async tx => {
      const first = (await tx.query('SELECT app_id FROM plaza_app_transfers WHERE id=$1', [transferId])).rows[0];
      if (!first) throw missing();
      await lock(tx, first.app_id);
      const transfer = (await tx.query('SELECT * FROM plaza_app_transfers WHERE id=$1 FOR UPDATE', [transferId])).rows[0]!;
      if ((input.action === 'cancel' ? transfer.owner_id : transfer.receiver_id) !== actorId) throw missing();
      if (await replay(tx, actorId, transferId, `transfer_${input.action}`, input)) return { recovered: true };
      if (transfer.status !== 'pending') throw conflict();
      const access = await accessRecord(tx, first.app_id);
      if (!access || access.owner_id !== transfer.owner_id || access.revision !== transfer.access_revision) throw conflict();
      if (input.action === 'accept') {
        await tx.query('UPDATE plaza_app_access SET owner_id=$2,maintainer_ids=array_remove(maintainer_ids,$2::uuid),revision=revision+1 WHERE app_id=$1', [first.app_id, actorId]);
      }
      await tx.query('UPDATE plaza_app_transfers SET status=$2 WHERE id=$1', [transferId, { accept: 'accepted', decline: 'declined', cancel: 'cancelled' }[input.action]]);
      await audit(tx, actorId, transferId, `transfer_${input.action}`, input, { ownerId: access.owner_id }, { ownerId: input.action === 'accept' ? actorId : access.owner_id });
      return { saved: true };
    });
  }
  return { settings, candidates, governance, adopt, update, requestTransfer, transfers, decideTransfer };
}
