import { isIP } from 'node:net';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { DomainError } from './errors.js';
import { parseStrictJson } from './manifest.js';

export interface TiangongConfig {
  userinfoUrl: string;
  successCode: string;
  tokenStorageKey: string;
  allowedUserTypes: string[];
  sessionHours: number;
  identityAdmins: string[];
}

export interface PortalIdentity {
  subject: string;
  tenantId: string | null;
  name: string;
  account?: string;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export function tiangongConfig(env: NodeJS.ProcessEnv): TiangongConfig | undefined {
  if (!env.TIANGONG_AUTH_ENABLED || env.TIANGONG_AUTH_ENABLED === 'false') return;
  const invalid = () => new Error('天宫身份配置无效：请核对 TIANGONG_AUTH_ENABLED、固定查询地址、成功码、凭证键名及管理员用户 ID');
  if (env.TIANGONG_AUTH_ENABLED !== 'true') throw invalid();
  let url: URL;
  try { url = new URL(env.TIANGONG_USERINFO_URL!); } catch { throw invalid(); }
  const rawHost = env.TIANGONG_USERINFO_URL?.match(/^http:\/\/([^/?#]+)/i)?.[1]?.split(':')[0];
  const [first, second] = url.hostname.split('.').map(Number);
  const privateIp = isIP(url.hostname) === 4 && (first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const transport = url.protocol === 'https:' || url.protocol === 'http:' && (loopback || env.TIANGONG_ALLOW_INTRANET_HTTP === 'true' && privateIp && rawHost === url.hostname);
  const successCode = env.TIANGONG_SUCCESS_CODE;
  const tokenStorageKey = env.TIANGONG_TOKEN_STORAGE_KEY;
  const allowedUserTypes = (env.TIANGONG_ALLOWED_USER_TYPES || '03,04').split(',').map(value => value.trim());
  const sessionHours = Number(env.TIANGONG_WEB_SESSION_HOURS || 8);
  const identityAdmins = (env.PLAZA_IDENTITY_ADMIN_SUBJECTS || '').split(',').filter(Boolean);
  if (!transport || url.username || url.password || url.search || url.hash ||
    !successCode || successCode.length > 32 || !tokenStorageKey || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tokenStorageKey) ||
    allowedUserTypes.some(type => !/^[A-Za-z0-9_-]{1,16}$/.test(type)) ||
    !Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24 || identityAdmins.some(id => !validId(id))) throw invalid();
  return { userinfoUrl: url.href, successCode, tokenStorageKey, allowedUserTypes, sessionHours, identityAdmins: [...new Set(identityAdmins)] };
}

/** Match Fuxi's verified portal contract; preserve the original long integer IDs. */
export function parsePortalIdentity(text: string, config: TiangongConfig): PortalIdentity {
  const denied = () => new DomainError(401, 'PORTAL_IDENTITY_INVALID', '天宫身份无效、已停用或不属于允许的用户类型，请重新登录天宫。');
  let body: any;
  try { body = parseStrictJson(text); } catch { throw denied(); }
  const tree = parseTree(text)!;
  const id = (key: string) => {
    const node = findNodeAtLocation(tree, ['data', key]);
    const value = node?.type === 'number' ? text.slice(node.offset, node.offset + node.length) : body.data?.[key];
    return validId(value) ? value : undefined;
  };
  const data = body?.data;
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body.success !== undefined && body.success !== true) ||
    String(body.code) !== config.successCode || !data || typeof data !== 'object' || Array.isArray(data)) throw denied();
  const subject = id('userId');
  const tenantId = data.tenantId === null ? null : id('tenantId');
  const type = data.userTypeCode ?? data.userType;
  if (!subject || tenantId === undefined || data.enabled !== true ||
    (data.userTypeCode !== undefined && data.userType !== undefined && String(data.userTypeCode) !== String(data.userType)) ||
    !config.allowedUserTypes.includes(String(type)) ||
    [data.isAnonymous, data.anonymous, data.mockLogin].some(value => value !== undefined && typeof value !== 'boolean') ||
    (data.isAnonymous !== false && data.anonymous !== false) || data.isAnonymous === true || data.anonymous === true || data.mockLogin === true) throw denied();
  const suppliedName = data.userName === undefined ? data.nickname : data.userName;
  const name = suppliedName === undefined ? '天宫用户' : suppliedName;
  if (data.userName !== undefined && data.nickname !== undefined && data.userName !== data.nickname ||
    typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) ||
    data.account !== undefined && (typeof data.account !== 'string' || !data.account || data.account.length > 64 || /[\x00-\x1f\x7f]/.test(data.account))) throw denied();
  return { subject, tenantId, name: name.trim(), ...(data.account ? { account: data.account } : {}) };
}

export async function verifyPortalIdentity(token: string, config: TiangongConfig): Promise<PortalIdentity> {
  if (!token || token.length > 8192 || token.trim() !== token || /[\x00-\x1f\x7f]/.test(token)) {
    throw new DomainError(401, 'PORTAL_TOKEN_REQUIRED', '未检测到有效天宫登录状态，请先登录天宫。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(config.userinfoUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), redirect: 'manual', signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new DomainError(401, 'PORTAL_IDENTITY_INVALID', '天宫登录状态已失效，请重新登录天宫。');
    if (response.status !== 200 || !response.body) throw new Error('Portal unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) { controller.abort(); throw new Error('Portal response too large'); }
      chunks.push(chunk);
    }
    return parsePortalIdentity(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), config);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(503, 'IDENTITY_UNAVAILABLE', '暂时无法核验天宫身份，请稍后重试。');
  } finally { clearTimeout(timer); }
}
