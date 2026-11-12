import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';

export async function platformCapabilities(db: Queryable, userId?: string) {
  const role = userId ? (await db.query('SELECT role FROM plaza_platform_roles WHERE user_id=$1', [userId])).rows[0]?.role : undefined;
  return { administrator: role === 'administrator' || role === 'super_administrator', superAdministrator: role === 'super_administrator' };
}

export async function requireAdministrator(db: Queryable, userId: string, superOnly = false) {
  const capabilities = await platformCapabilities(db, userId);
  if (!capabilities.administrator || superOnly && !capabilities.superAdministrator) {
    throw new DomainError(403, 'ADMINISTRATOR_REQUIRED', superOnly ? '此操作需要超级管理员权限。' : '此页面仅对广场管理员开放。');
  }
  return capabilities;
}

/** Only a server-verified account can consume the explicitly configured bootstrap. */
export async function bindSuperAdministrator(tx: Queryable, row: { id: string; subject: string }, account: string | undefined, configuredAccount?: string) {
  if (!configuredAccount || account !== configuredAccount) return;
  const inserted = await tx.query(`INSERT INTO plaza_bootstrap_bindings(purpose,source,subject,account,user_id)
    VALUES('super_administrator','tiangong',$1,$2,$3) ON CONFLICT(purpose) DO NOTHING RETURNING purpose`, [row.subject, account, row.id]);
  const binding = (await tx.query("SELECT * FROM plaza_bootstrap_bindings WHERE purpose='super_administrator' FOR UPDATE")).rows[0];
  if (binding?.source !== 'tiangong' || binding.subject !== row.subject || binding.user_id !== row.id || binding.account !== account) {
    throw new DomainError(409, 'BOOTSTRAP_IDENTITY_CONFLICT', '指定管理员账号与既有关联冲突，需要核查稳定身份，未自动转移权限。');
  }
  if (inserted.rowCount) {
    await tx.query(`INSERT INTO plaza_platform_roles(user_id,role) VALUES($1,'super_administrator')
      ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,revision=plaza_platform_roles.revision+1`, [row.id]);
    await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,after_value)
      VALUES($1,$2,$3,'super_administrator_bound','{}'::jsonb,$4::jsonb)`, [randomUUID(), row.id, row.id, JSON.stringify({ role: 'super_administrator' })]);
  }
}

export async function administratorUsers(db: Queryable, actorId: string) {
  await requireAdministrator(db, actorId, true);
  return (await db.query(`SELECT i.id,i.name,i.account,COALESCE(r.role,'member') AS role,COALESCE(r.revision,0) AS revision
    FROM plaza_identities i LEFT JOIN plaza_platform_roles r ON r.user_id=i.id WHERE i.source='tiangong' ORDER BY i.name,i.id`)).rows;
}

export async function setAdministrator(db: Database, actorId: string, input: { userId: string; role: 'member' | 'administrator' | 'super_administrator'; revision: number; requestId: string }) {
  return db.transaction(async tx => {
    // All role writers lock the same existing super-administrator set before counting it.
    await tx.query("SELECT user_id FROM plaza_platform_roles WHERE role='super_administrator' ORDER BY user_id FOR UPDATE");
    await requireAdministrator(tx, actorId, true);
    const recovered = (await tx.query('SELECT * FROM plaza_access_operations WHERE id=$1', [input.requestId])).rows[0];
    if (recovered) {
      if (recovered.actor_id !== actorId || recovered.action !== 'platform_role_changed' || !isDeepStrictEqual(recovered.request_value, input)) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', '操作请求已用于其他变更，请刷新核对。');
      return { recovered: true };
    }
    if (!(await tx.query("SELECT id FROM plaza_identities WHERE id=$1 AND source='tiangong'", [input.userId])).rows.length) throw new DomainError(400, 'MEMBER_INVALID', '请选择已经核验的广场用户。');
    const before = (await tx.query('SELECT * FROM plaza_platform_roles WHERE user_id=$1 FOR UPDATE', [input.userId])).rows[0];
    if ((before?.revision ?? 0) !== input.revision) throw new DomainError(409, 'REVISION_CONFLICT', '管理员配置已变化，请刷新核对。');
    if ((before?.role ?? 'member') === input.role) throw new DomainError(409, 'NO_CHANGE', '管理员配置没有变化。');
    if (before?.role === 'super_administrator' && input.role !== 'super_administrator' && Number((await tx.query("SELECT count(*) AS n FROM plaza_platform_roles WHERE role='super_administrator'")).rows[0].n) <= 1) {
      throw new DomainError(409, 'LAST_SUPER_ADMINISTRATOR', '请先安排另一位超级管理员，不能撤销最后一人的权限。');
    }
    await tx.query(`INSERT INTO plaza_platform_roles(user_id,role,revision) VALUES($1,$2,1)
      ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,revision=plaza_platform_roles.revision+1`, [input.userId, input.role]);
    await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,before_value,after_value)
      VALUES($1,$2,$3,'platform_role_changed',$4::jsonb,$5::jsonb,$6::jsonb)`,
    [input.requestId, actorId, input.userId, JSON.stringify(input), JSON.stringify(before ?? null), JSON.stringify({ role: input.role })]);
    return { saved: true };
  });
}
