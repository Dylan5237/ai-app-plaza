import { isDeepStrictEqual } from 'node:util';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';
import { requireAdministrator } from './platform-access.js';
import { DEFAULT_SMART_SEARCH_PROMPT, sanitizeSmartSearchPrompt } from './smart-search-ai.js';

export const SMART_SEARCH_PROMPT_LIMIT = 6000;

async function promptRow(db: Queryable) {
  return (await db.query("SELECT template, updated_at, updated_by FROM plaza_smart_search_prompt WHERE purpose='default'")).rows[0];
}

/** The prompt actually sent to the model: the super-administrator override or the default. */
export async function effectiveSmartSearchPrompt(db: Queryable): Promise<string> {
  const row = await promptRow(db);
  return row?.template ?? DEFAULT_SMART_SEARCH_PROMPT;
}

export async function smartSearchPromptView(db: Queryable, actorId: string) {
  await requireAdministrator(db, actorId, true);
  const row = await promptRow(db);
  return {
    defaultPrompt: DEFAULT_SMART_SEARCH_PROMPT,
    template: row?.template ?? null,
    limit: SMART_SEARCH_PROMPT_LIMIT,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function setSmartSearchPrompt(db: Database, actorId: string, input: { requestId: string; template: string | null }) {
  if (input.template !== null) {
    const cleaned = sanitizeSmartSearchPrompt(input.template).trim();
    if (!cleaned) throw new DomainError(400, 'PROMPT_INVALID', '提示词不能为空。');
    if (cleaned.length > SMART_SEARCH_PROMPT_LIMIT) throw new DomainError(400, 'PROMPT_INVALID', `提示词不能超过 ${SMART_SEARCH_PROMPT_LIMIT} 个字符。`);
    input = { ...input, template: cleaned };
  }
  return db.transaction(async tx => {
    await requireAdministrator(tx, actorId, true);
    const recovered = (await tx.query('SELECT * FROM plaza_access_operations WHERE id=$1', [input.requestId])).rows[0];
    if (recovered) {
      if (recovered.actor_id !== actorId || recovered.action !== 'smart_search_prompt_changed' || !isDeepStrictEqual(recovered.request_value, input)) {
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', '操作请求已用于其他变更，请刷新核对。');
      }
      return { recovered: true };
    }
    const before = await promptRow(tx);
    if (input.template === null) await tx.query("DELETE FROM plaza_smart_search_prompt WHERE purpose='default'");
    else await tx.query(`INSERT INTO plaza_smart_search_prompt(purpose,template,updated_at,updated_by) VALUES('default',$1,now(),$2)
      ON CONFLICT(purpose) DO UPDATE SET template=EXCLUDED.template, updated_at=now(), updated_by=EXCLUDED.updated_by`, [input.template, actorId]);
    await tx.query(`INSERT INTO plaza_access_operations(id,actor_id,resource_id,action,request_value,before_value,after_value)
      VALUES($1,$2,$3,'smart_search_prompt_changed',$4::jsonb,$5::jsonb,$6::jsonb)`,
      [input.requestId, actorId, actorId, JSON.stringify(input), JSON.stringify(before ? { template: before.template } : null), JSON.stringify({ template: input.template })]);
    return { saved: true };
  });
}
