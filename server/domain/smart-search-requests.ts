import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';
import { requireAdministrator } from './platform-access.js';

// Demand signals from smart-search empty results: the submitter volunteers this text,
// so unlike search queries it may be stored and shown to administrators.
function cleanDescription(value: unknown): string {
  return (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export async function createSmartSearchRequest(db: Queryable, input: { description: unknown; submittedBy?: string }) {
  const description = cleanDescription(input.description);
  if (!description || description.length > 200) throw new DomainError(400, 'REQUEST_INVALID', '需求描述必须是 1 到 200 个字符的文本。');
  const id = randomUUID();
  await db.query('INSERT INTO plaza_smart_search_requests(id, description, submitted_by) VALUES($1,$2,$3)', [id, description, input.submittedBy ?? null]);
  return { id };
}

export async function listSmartSearchRequests(db: Queryable, actorId: string) {
  await requireAdministrator(db, actorId);
  return (await db.query(`SELECT r.id, r.description, r.status, r.created_at, i.name AS submitter
    FROM plaza_smart_search_requests r LEFT JOIN plaza_identities i ON i.id = r.submitted_by
    ORDER BY r.status='open' DESC, r.created_at DESC LIMIT 200`)).rows
    .map(row => ({ id: row.id, description: row.description, status: row.status, createdAt: new Date(row.created_at).toISOString(), submitter: row.submitter ?? null }));
}

export async function setSmartSearchRequestStatus(db: Database, actorId: string, input: { requestId: string; id: string; status: 'open' | 'done' }) {
  return db.transaction(async tx => {
    await requireAdministrator(tx, actorId);
    const recovered = (await tx.query('SELECT * FROM plaza_access_operations WHERE id=$1', [input.requestId])).rows[0];
    if (recovered) {
      if (recovered.actor_id !== actorId || recovered.action !== 'smart_search_request_updated' || !isDeepStrictEqual(recovered.request_value, input)) {
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', '操作请求已用于其他变更，请刷新核对。');
      }
      return { recovered: true };
    }
    const before = (await tx.query('SELECT status FROM plaza_smart_search_requests WHERE id=$1 FOR UPDATE', [input.id])).rows[0];
    if (!before) throw new DomainError(404, 'REQUEST_NOT_FOUND', '需求登记不存在。');
    if (before.status !== input.status) {
      await tx.query('UPDATE plaza_smart_search_requests SET status=$2, handled_by=$3, handled_at=now() WHERE id=$1', [input.id, input.status, actorId]);
    }
    await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,before_value,after_value)
      VALUES($1,$2,$3,'smart_search_request_updated',$4::jsonb,$5::jsonb,$6::jsonb)`,
      [input.requestId, actorId, input.id, JSON.stringify(input), JSON.stringify(before), JSON.stringify({ status: input.status })]);
    return { saved: true };
  });
}
