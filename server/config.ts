import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export interface Config {
  host: string; port: number; publicOrigin: string; gitlabUrl: string;
  secret: string; databaseUrl?: string; dataDir: string; local: boolean;
  audience: string; staticDir: string; rateLimit: boolean;
  managedPublishing?: { groupId: string; groupPath: string; token: string };
}

function origin(value: string, name: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error(`${name} 必须是无凭据、无路径的 HTTP(S) 地址`);
  }
  return url.origin;
}

function isRfc1918IPv4(hostname: string, originValue: string) {
  const match = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\/?$/i.exec(originValue);
  if (!match || match[1] !== hostname || isIP(hostname) !== 4) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export async function loadConfig(env = process.env): Promise<Config> {
  const local = env.PLAZA_LOCAL === '1';
  if (local && env.NODE_ENV === 'production') throw new Error('生产环境不能启用 PLAZA_LOCAL');
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const host = env.HOST || '127.0.0.1';
  if (local && host !== '127.0.0.1') throw new Error('本地验证模式只绑定 127.0.0.1');
  const publicOriginValue = env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const publicOrigin = origin(publicOriginValue, 'PUBLIC_ORIGIN');
  const publicOriginUrl = new URL(publicOrigin);
  if (!local && publicOriginUrl.protocol !== 'https:' && !(env.ALLOW_INSECURE_PORTAL === '1' && isRfc1918IPv4(publicOriginUrl.hostname, publicOriginValue))) {
    throw new Error('非本地运行需要 HTTPS PUBLIC_ORIGIN；仅可通过 ALLOW_INSECURE_PORTAL=1 为 RFC1918 私网 IPv4 开启 HTTP 内网试用');
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
  return { host, port, publicOrigin, gitlabUrl, secret, databaseUrl: env.DATABASE_URL,
    dataDir, local, audience: '所有能访问本门户的人', staticDir: resolve('dist'), rateLimit: true, ...(managedPublishing ? { managedPublishing } : {}) };
}
