import { appAccessPredicate } from './app-access.js';
import { IDENTITY_SCHEMA } from './identity-schema.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';
import { verifyPortalIdentity, type TiangongConfig } from './tiangong-identity.js';
import { bindSuperAdministrator, platformCapabilities } from './platform-access.js';

export interface IdentityUser {
  id: string;
  subject: string;
  name: string;
  account: string | null;
  identityAdmin: boolean;
  administrator: boolean;
  superAdministrator: boolean;
}
interface GroupRecord {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
  created_at: Date | string;
}
export interface IdentityGroup extends GroupRecord { members: string[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const PROVIDER = 'tiangong';
const missing = () => new DomainError(401, 'LOGIN_REQUIRED', '请使用天宫身份登录。');

/** Only application identity and opaque credential hashes are persisted, never portal tokens. */
export async function createIdentityService(db: Database, config: TiangongConfig) {
  for (const statement of IDENTITY_SCHEMA) await db.query(statement);

  async function user(row: any, queryable: Queryable = db): Promise<IdentityUser> {
    const capabilities = await platformCapabilities(queryable, row.id);
    return { id: row.id, subject: row.subject, name: row.name, account: row.account,
      identityAdmin: config.identityAdmins.includes(row.subject) || capabilities.superAdministrator, ...capabilities };
  }
  async function cleanup(queryable: Queryable = db) {
    await queryable.query('DELETE FROM plaza_login_requests WHERE expires_at <= now()');
    await queryable.query('DELETE FROM plaza_sessions WHERE expires_at <= now()');
  }
  async function challenge(clientHash = 'internal') {
    const requestId = random(), browserSecret = random();
    await db.transaction(async tx => {
      // Serialize capacity checks across processes/instances, not only this Node runtime.
      await tx.query('LOCK TABLE plaza_login_requests IN SHARE ROW EXCLUSIVE MODE');
      await cleanup(tx);
      const counts = (await tx.query<{ total: number | string; client: number | string }>(
        'SELECT count(*) AS total, count(*) FILTER (WHERE client_hash=$1) AS client FROM plaza_login_requests', [clientHash])).rows[0]!;
      if (Number(counts.client) >= 20) throw new DomainError(429, 'LOGIN_RATE_LIMITED', '当前访问端的待登录请求较多，请等待两分钟后重试。');
      if (Number(counts.total) >= 1000) throw new DomainError(429, 'LOGIN_BUSY', '登录请求较多，请稍后重试。');
      await tx.query(`INSERT INTO plaza_login_requests(id_hash,browser_hash,expires_at,client_hash)
        VALUES($1,$2,now()+interval '120 seconds',$3)`, [hash(requestId), hash(browserSecret), clientHash]);
    });
    return { requestId, browserSecret };
  }
  async function sessionUser(session?: string) {
    if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session)) return;
    return (await db.query(`SELECT i.* FROM plaza_sessions s JOIN plaza_identities i ON i.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND i.source=$2`, [hash(session), PROVIDER])).rows[0];
  }
  async function login(input: { requestId: string; browserSecret: string; token: string; session?: string; switchAccount: boolean }) {
    // A request can be used only by its bound browser and only once, even if upstream fails.
    const consumed = await db.query(`DELETE FROM plaza_login_requests WHERE id_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING id_hash`,
      [hash(input.requestId), hash(input.browserSecret)]);
    if (!consumed.rowCount) throw new DomainError(409, 'LOGIN_REQUEST_EXPIRED', '本次登录请求已失效，请重新发起登录。');
    const portal = await verifyPortalIdentity(input.token, config);
    const previous = await sessionUser(input.session);
    if (previous && previous.subject !== portal.subject && !input.switchAccount) {
      throw new DomainError(409, 'ACCOUNT_SWITCH_REQUIRED', '天宫当前账号与广场会话不同，请确认后切换账号。');
    }
    const credential = random();
    const account = await db.transaction(async tx => {
      const row = (await tx.query(`INSERT INTO plaza_identities(id,source,subject,name,account,tenant_id,verified_at)
        VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(source,subject) DO UPDATE SET
        name=EXCLUDED.name, account=EXCLUDED.account, tenant_id=EXCLUDED.tenant_id, verified_at=now() RETURNING *`,
      [randomUUID(), PROVIDER, portal.subject, portal.name, portal.account ?? null, portal.tenantId])).rows[0];
      if (input.session) await tx.query('DELETE FROM plaza_sessions WHERE token_hash=$1', [hash(input.session)]);
      await tx.query('INSERT INTO plaza_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3*interval \'1 hour\')',
        [hash(credential), row.id, config.sessionHours]);
      await bindSuperAdministrator(tx, row as { id: string; subject: string }, portal.account, config.superAdminAccount);
      return user(row, tx);
    });
    return { user: account, credential };
  }
  async function authenticate(session?: string, portalToken?: string): Promise<IdentityUser> {
    const row = await sessionUser(session);
    if (!row) throw missing();
    if (!portalToken) throw new DomainError(401, 'PORTAL_TOKEN_REQUIRED', '请从已登录天宫的同源入口访问。');
    // Every protected read/write revalidates portal state. An expired/disabled identity cannot reuse a cached role.
    const portal = await verifyPortalIdentity(portalToken, config);
    if (!await sessionUser(session)) throw missing();
    if (portal.subject !== row.subject) throw new DomainError(409, 'ACCOUNT_SWITCH_REQUIRED', '天宫当前账号已变化，请确认切换广场账号。');
    return db.transaction(async tx => {
      const updated = (await tx.query('UPDATE plaza_identities SET name=$2,account=$3,tenant_id=$4,verified_at=now() WHERE id=$1 RETURNING *',
        [row.id, portal.name, portal.account ?? null, portal.tenantId])).rows[0];
      await bindSuperAdministrator(tx, updated as { id: string; subject: string }, portal.account, config.superAdminAccount);
      return user(updated, tx);
    });
  }
  async function logout(session?: string) {
    if (session) await db.query('DELETE FROM plaza_sessions WHERE token_hash=$1', [hash(session)]);
  }
  function requireIdentityAdmin(actor: IdentityUser) {
    if (!actor.identityAdmin) throw new DomainError(403, 'IDENTITY_ADMIN_REQUIRED', '当前身份没有成员与小组管理权限。');
  }
  async function members(tx: Queryable, groupId: string): Promise<string[]> {
    return (await tx.query<{ user_id: string }>('SELECT user_id FROM plaza_group_members WHERE group_id=$1 ORDER BY user_id', [groupId])).rows.map(row => row.user_id);
  }
  async function groups(actor: IdentityUser) {
    requireIdentityAdmin(actor);
    return (await db.query<IdentityGroup>(`SELECT g.*, COALESCE(jsonb_agg(m.user_id ORDER BY m.user_id) FILTER(WHERE m.user_id IS NOT NULL),'[]'::jsonb) AS members
      FROM plaza_groups g LEFT JOIN plaza_group_members m ON m.group_id=g.id GROUP BY g.id ORDER BY g.created_at,g.id`)).rows;
  }
  async function users(actor: IdentityUser) {
    requireIdentityAdmin(actor);
    return (await db.query('SELECT id,subject,name,account,verified_at FROM plaza_identities WHERE source=$1 ORDER BY name,id', [PROVIDER])).rows;
  }
  async function favoriteIds(actor: IdentityUser): Promise<string[]> {
    return (await db.query<{ app_id: string }>('SELECT app_id FROM plaza_favorites WHERE user_id=$1 ORDER BY created_at DESC,app_id', [actor.id])).rows.map(row => row.app_id);
  }
  async function favorites(actor: IdentityUser, options: { page: number; pageSize: number }) {
    const total = Number((await db.query('SELECT count(*) AS n FROM plaza_favorites WHERE user_id=$1', [actor.id])).rows[0].n);
    const items = (await db.query<{ app_id: string }>('SELECT app_id FROM plaza_favorites WHERE user_id=$1 ORDER BY created_at DESC,app_id LIMIT $2 OFFSET $3',
      [actor.id, options.pageSize, (options.page - 1) * options.pageSize])).rows;
    return { items, total, ...options };
  }
  async function saveFavorite(actor: IdentityUser, appId: string, saved: boolean, audience: string) {
    if (!saved) { await db.query('DELETE FROM plaza_favorites WHERE user_id=$1 AND app_id=$2', [actor.id, appId]); return; }
    const result = await db.query(`INSERT INTO plaza_favorites(user_id,app_id)
      SELECT $1,a.id FROM catalog_apps a JOIN published_snapshots s ON s.id=a.current_snapshot_id
      LEFT JOIN catalog_app_lifecycle l ON l.app_id=a.id
      WHERE a.id=$2 AND s.audience=$3 AND COALESCE(l.status,'published')='published' AND ${appAccessPredicate('$1::uuid')}
      ON CONFLICT(user_id,app_id) DO UPDATE SET created_at=plaza_favorites.created_at RETURNING app_id`, [actor.id, appId, audience]);
    if (!result.rowCount) throw new DomainError(404, 'APP_NOT_FOUND', '此应用当前不可访问，未保存收藏。');
  }
  async function saveGroup(actor: IdentityUser, input: { id?: string; requestId?: string; name: string; enabled: boolean; members: string[]; revision?: number }): Promise<IdentityGroup> {
    requireIdentityAdmin(actor);
    return db.transaction(async tx => {
      const id = input.id || input.requestId!;
      const before = (await tx.query<GroupRecord>('SELECT * FROM plaza_groups WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (input.id && !before) throw new DomainError(404, 'GROUP_NOT_FOUND', '未找到该小组。');
      const memberIds = [...new Set(input.members)].sort();
      const afterValue = { name: input.name, enabled: input.enabled, members: memberIds };
      const recovered = async () => {
        const operation = (await tx.query("SELECT actor_id,after_value FROM plaza_identity_operations WHERE group_id=$1 AND action='group_created'", [id])).rows[0];
        if (!operation || operation.actor_id !== actor.id || operation.after_value.name !== input.name || operation.after_value.enabled !== input.enabled ||
          JSON.stringify(operation.after_value.members) !== JSON.stringify(memberIds)) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', '本次创建请求已处理且内容不同，请先刷新核对小组。');
        return { ...(await tx.query<GroupRecord>('SELECT * FROM plaza_groups WHERE id=$1', [id])).rows[0]!, members: await members(tx, id) };
      };
      if (!input.id && before) return recovered();
      if (memberIds.length) {
        const found = await tx.query('SELECT id FROM plaza_identities WHERE source=$1 AND id=ANY($2::uuid[])', [PROVIDER, memberIds]);
        if (found.rows.length !== memberIds.length) throw new DomainError(400, 'MEMBER_INVALID', '成员必须是已通过天宫核验并登记的广场用户。');
      }
      const beforeValue = before ? { name: before.name, enabled: before.enabled, members: await members(tx, id) } : null;
      if (beforeValue && JSON.stringify(beforeValue) === JSON.stringify(afterValue)) return { ...before, members: memberIds };
      if (before && before.revision !== input.revision) throw new DomainError(409, 'REVISION_CONFLICT', '小组已被修改，请重新读取后核对。');
      const row = before ? (await tx.query<GroupRecord>('UPDATE plaza_groups SET name=$2,enabled=$3,revision=revision+1 WHERE id=$1 RETURNING *', [id, input.name, input.enabled])).rows[0] :
        (await tx.query<GroupRecord>('INSERT INTO plaza_groups(id,name,enabled) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING *', [id, input.name, input.enabled])).rows[0];
      if (!row) return recovered();
      await tx.query('DELETE FROM plaza_group_members WHERE group_id=$1', [id]);
      for (const member of memberIds) await tx.query('INSERT INTO plaza_group_members(group_id,user_id) VALUES($1,$2)', [id, member]);
      await tx.query('INSERT INTO plaza_identity_operations(id,actor_id,group_id,action,before_value,after_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
        [randomUUID(), actor.id, id, before ? 'group_updated' : 'group_created', JSON.stringify(beforeValue), JSON.stringify(afterValue)]);
      return { ...row, members: memberIds };
    });
  }
  return { challenge, login, authenticate, logout, groups, users, saveGroup, favoriteIds, favorites, saveFavorite, cleanup };
}

export type IdentityService = Awaited<ReturnType<typeof createIdentityService>>;
