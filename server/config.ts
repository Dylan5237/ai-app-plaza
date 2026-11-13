import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { parseHttpsOrigin, parseTrustedProxyIp } from './public-origins.js';
import { tiangongConfig, type TiangongConfig } from './domain/tiangong-identity.js';
import type { SmartSearchAiConfig } from './domain/smart-search-ai.js';

export interface Config {
  host: string; port: number; publicOrigin: string; gitlabUrl: string;
  secret: string; databaseUrl?: string; dataDir: string; local: boolean;
  audience: string; staticDir: string; rateLimit: boolean;
  managedPublishing?: { groupId: string; groupPath: string; token: string };
  previewAdmin?: { trustedProxyIp?: string };
  localManagement?: boolean;
  intranetManagement?: true;
  httpsOrigin?: string;
  tiangong?: TiangongConfig;
  publicBasePath?: string;
  trustedProxyIp?: string;
  analytics?: { environment: 'production' | 'test' | 'local'; siteInstanceId: string };
  analyticsRetention?: { environment: 'production' | 'test' | 'local'; siteInstanceId: string };
  smartSearchAi?: SmartSearchAiConfig;
}

function origin(value: string, name: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${name} 必须是无凭据、无路径的 HTTP(S) 地址`);
  }
  return url.origin;
}

function isRfc1918IPv4Literal(hostname: string, originValue: string) {
  const match = /^https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\/?$/i.exec(originValue);
  if (!match || match[1] !== hostname || isIP(hostname) !== 4) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

export function assertLocalManagementConfig(config: Pick<Config, 'local' | 'host' | 'port' | 'publicOrigin' | 'localManagement'>) {
  if (!config.localManagement) return;
  let url: URL;
  try { url = new URL(config.publicOrigin); }
  catch { throw new Error('PLAZA_LOCAL_MANAGEMENT 仅允许本地回环配置'); }
  if (process.env.NODE_ENV === 'production' || config.local !== true || config.host !== '127.0.0.1' ||
    url.hostname !== '127.0.0.1' || effectivePort(url) !== config.port) {
    throw new Error('PLAZA_LOCAL_MANAGEMENT 仅允许 PLAZA_LOCAL=1 且 HOST/PUBLIC_ORIGIN 均为 127.0.0.1、端口一致的本地环境');
  }
}

type ManagementConfig = Pick<Config, 'local' | 'host' | 'port' | 'publicOrigin' | 'localManagement' | 'intranetManagement'>;

export function managementEnabled(config: Pick<Config, 'localManagement' | 'intranetManagement' | 'tiangong'>): boolean {
  return config.localManagement === true || config.intranetManagement === true || !!config.tiangong;
}

export function managementMode(config: Pick<Config, 'localManagement' | 'intranetManagement' | 'tiangong'>): 'local' | 'intranet' | 'identity' | 'disabled' {
  if (config.localManagement === true) return 'local';
  if (config.intranetManagement === true) return 'intranet';
  if (config.tiangong) return 'identity';
  return 'disabled';
}

export function assertManagementConfig(config: ManagementConfig) {
  if (config.localManagement === true && config.intranetManagement === true) {
    throw new Error('PLAZA_LOCAL_MANAGEMENT 与 PLAZA_INTRANET_MANAGEMENT 不能同时启用');
  }
  assertLocalManagementConfig(config);
  if (!config.intranetManagement) return;

  let url: URL;
  try { url = new URL(config.publicOrigin); }
  catch { throw new Error('PLAZA_INTRANET_MANAGEMENT 仅允许 RFC1918 私网 IPv4 PUBLIC_ORIGIN'); }
  if (config.local !== false || !isRfc1918IPv4Literal(url.hostname, config.publicOrigin) || effectivePort(url) !== config.port) {
    throw new Error('PLAZA_INTRANET_MANAGEMENT 仅允许非本地模式、RFC1918 私网 IPv4 PUBLIC_ORIGIN 且 PUBLIC_ORIGIN 端口与 PORT 一致');
  }
}

export async function loadConfig(env = process.env): Promise<Config> {
  const local = env.PLAZA_LOCAL === '1';
  if (local && env.NODE_ENV === 'production') throw new Error('生产环境不能启用 PLAZA_LOCAL');
  if (env.PLAZA_LOCAL_MANAGEMENT !== undefined && env.PLAZA_LOCAL_MANAGEMENT !== '' && env.PLAZA_LOCAL_MANAGEMENT !== '1') {
    throw new Error('PLAZA_LOCAL_MANAGEMENT 仅接受显式值 1');
  }
  if (env.PLAZA_INTRANET_MANAGEMENT !== undefined && env.PLAZA_INTRANET_MANAGEMENT !== '' && env.PLAZA_INTRANET_MANAGEMENT !== '1') {
    throw new Error('PLAZA_INTRANET_MANAGEMENT 仅接受显式值 1');
  }
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const host = env.HOST || '127.0.0.1';
  if (local && host !== '127.0.0.1') throw new Error('本地验证模式只绑定 127.0.0.1');
  const publicOriginValue = env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const publicOrigin = origin(publicOriginValue, 'PUBLIC_ORIGIN');
  const publicOriginUrl = new URL(publicOrigin);
  if (!local && publicOriginUrl.protocol !== 'https:' && !(env.ALLOW_INSECURE_PORTAL === '1' && publicOriginUrl.protocol === 'http:' && isRfc1918IPv4Literal(publicOriginUrl.hostname, publicOriginValue))) {
    throw new Error('非本地运行需要 HTTPS PUBLIC_ORIGIN；仅可通过 ALLOW_INSECURE_PORTAL=1 为 RFC1918 私网 IPv4 开启 HTTP 内网试用');
  }
  const httpsOrigin = parseHttpsOrigin(env.PLAZA_HTTPS_ORIGIN, { local, publicOrigin });
  const clientProxyIp = parseTrustedProxyIp(env.PLAZA_TRUSTED_PROXY_IP);
  if (env.PLAZA_LOCAL_MANAGEMENT === '1') {
    assertLocalManagementConfig({ local, host, port, publicOrigin, localManagement: true });
  }
  if (!env.GITLAB_URL) throw new Error('请配置 GITLAB_URL；门户不会自动使用 Mock 数据');
  const gitlabUrl = origin(env.GITLAB_URL, 'GITLAB_URL');
  if (new URL(gitlabUrl).protocol !== 'https:' && !local && env.ALLOW_INSECURE_GITLAB !== '1') {
    throw new Error('HTTP GitLab 需显式设置 ALLOW_INSECURE_GITLAB=1 并限制可信网络');
  }
  if (!local && !env.DATABASE_URL) throw new Error('非本地运行需要 DATABASE_URL');
  const dataDir = resolve(env.PLAZA_DATA_DIR || 'artifacts/plaza-local');
  let secret = env.PLAZA_SECRET || '';
  if (local && !secret) {
    await mkdir(dataDir, { recursive: true });
    const secretPath = resolve(dataDir, '.key');
    try { secret = await readFile(secretPath, 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const generated = randomBytes(32).toString('hex');
      try { await writeFile(secretPath, generated, { flag: 'wx', mode: 0o600 }); secret = generated; }
      catch (writeError: any) { if (writeError.code !== 'EEXIST') throw writeError; secret = await readFile(secretPath, 'utf8'); }
    }
  }
  if (secret.length < 32) throw new Error('PLAZA_SECRET 至少 32 字符，应由安全随机数生成器生成');
  let managedPublishing: Config['managedPublishing'];
  const managedKeys = [env.PLAZA_MANAGED_GROUP_ID, env.PLAZA_MANAGED_GROUP_PATH, env.PLAZA_MANAGED_GITLAB_TOKEN];
  if (managedKeys.some(Boolean)) {
    if (!managedKeys.every(Boolean)) throw new Error('托管发布需同时配置固定群组 ID、路径和服务端 GitLab 授权');
    if (!/^[1-9]\d{0,19}$/.test(env.PLAZA_MANAGED_GROUP_ID!)) throw new Error('PLAZA_MANAGED_GROUP_ID 必须是数字群组 ID');
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(env.PLAZA_MANAGED_GROUP_PATH!)) throw new Error('PLAZA_MANAGED_GROUP_PATH 必须是固定群组路径');
    const managedToken = env.PLAZA_MANAGED_GITLAB_TOKEN!;
    if (managedToken.length > 8192 || /[\r\n\u0000]/.test(managedToken)) throw new Error('托管 GitLab 授权格式无效');
    managedPublishing = { groupId: env.PLAZA_MANAGED_GROUP_ID!, groupPath: env.PLAZA_MANAGED_GROUP_PATH!, token: managedToken };
  }
  const trustedProxyIp = env.PLAZA_PREVIEW_ADMIN_PROXY_IP;
  if (trustedProxyIp && (!isIP(trustedProxyIp) || trustedProxyIp.includes('%'))) {
    throw new Error('PLAZA_PREVIEW_ADMIN_PROXY_IP 必须是单一可信代理 IP');
  }
  const previewAdmin = trustedProxyIp ? { trustedProxyIp } : undefined;
  const tiangong = tiangongConfig(env);
  const publicBasePath = env.PLAZA_PUBLIC_BASE_PATH || '';
  if (publicBasePath && !/^\/[a-zA-Z0-9_-]+$/.test(publicBasePath)) throw new Error('PLAZA_PUBLIC_BASE_PATH 必须是单层固定路径，例如 /plaza');
  if (tiangong && (env.PLAZA_LOCAL_MANAGEMENT === '1' || env.PLAZA_INTRANET_MANAGEMENT === '1' || previewAdmin)) {
    throw new Error('天宫身份模式不能同时启用旧的无身份管理入口');
  }
  if (tiangong && httpsOrigin) throw new Error('天宫身份模式需以门户同源地址作为唯一 PUBLIC_ORIGIN，不同时启用 PLAZA_HTTPS_ORIGIN');
  const analyticsEnabled = env.PLAZA_ANALYTICS_ENABLED === '1';
  let smartSearchAi: SmartSearchAiConfig | undefined;
  const aiValues = [env.PLAZA_SMART_SEARCH_BASE_URL, env.PLAZA_SMART_SEARCH_MODEL, env.PLAZA_SMART_SEARCH_API_KEY];
  if (aiValues.some(Boolean)) {
    if (!aiValues.every(Boolean)) throw new Error('智能检索需同时配置 PLAZA_SMART_SEARCH_BASE_URL、PLAZA_SMART_SEARCH_MODEL 与 PLAZA_SMART_SEARCH_API_KEY');
    let aiUrl: URL;
    try { aiUrl = new URL(env.PLAZA_SMART_SEARCH_BASE_URL!); }
    catch { throw new Error('PLAZA_SMART_SEARCH_BASE_URL 必须是 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(aiUrl.protocol) || aiUrl.search || aiUrl.hash) throw new Error('PLAZA_SMART_SEARCH_BASE_URL 必须是无查询参数的 HTTP(S) 地址');
    if (env.PLAZA_SMART_SEARCH_API_KEY!.length > 8192 || /[\r\n\u0000]/.test(env.PLAZA_SMART_SEARCH_API_KEY!)) throw new Error('PLAZA_SMART_SEARCH_API_KEY 格式无效');
    const timeoutMs = Number(env.PLAZA_SMART_SEARCH_TIMEOUT_MS || 8000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('PLAZA_SMART_SEARCH_TIMEOUT_MS 必须是 1000 到 30000 的整数');
    smartSearchAi = { baseUrl: env.PLAZA_SMART_SEARCH_BASE_URL!.replace(/\/+$/, ''), model: env.PLAZA_SMART_SEARCH_MODEL!, apiKey: env.PLAZA_SMART_SEARCH_API_KEY!, timeoutMs };
  }
  const analyticsEnvironment = env.PLAZA_ANALYTICS_ENVIRONMENT || (local ? 'local' : 'production');
  const analyticsSite = env.PLAZA_ANALYTICS_SITE_ID || 'plaza';
  if (!['production', 'test', 'local'].includes(analyticsEnvironment) || !/^[a-zA-Z0-9_-]{1,64}$/.test(analyticsSite)) {
    throw new Error('埋点环境或站点标识配置无效');
  }
  const config: Config = { host, port, publicOrigin, gitlabUrl, secret, databaseUrl: env.DATABASE_URL,
    dataDir, local, audience: '所有能访问本门户的人', staticDir: resolve('dist'), rateLimit: true,
    ...(managedPublishing ? { managedPublishing } : {}), ...(previewAdmin ? { previewAdmin } : {}),
    ...(httpsOrigin ? { httpsOrigin } : {}),
    ...(clientProxyIp ? { trustedProxyIp: clientProxyIp } : {}),
    ...(tiangong ? { tiangong } : {}), ...(publicBasePath ? { publicBasePath } : {}),
    analyticsRetention: { environment: analyticsEnvironment as 'production' | 'test' | 'local', siteInstanceId: analyticsSite },
    ...(analyticsEnabled ? { analytics: { environment: analyticsEnvironment as 'production' | 'test' | 'local', siteInstanceId: analyticsSite } } : {}),
    ...(env.PLAZA_LOCAL_MANAGEMENT === '1' ? { localManagement: true } : {}),
    ...(env.PLAZA_INTRANET_MANAGEMENT === '1' ? { intranetManagement: true } : {}),
    ...(smartSearchAi ? { smartSearchAi } : {}) };
  assertManagementConfig(config);
  return config;
}
