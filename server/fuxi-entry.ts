import { isIP } from 'node:net';

export interface FuxiEntryPolicy {
  appId: string;
  entryId: string;
  plazaOrigin: string;
  enabled: boolean;
  fuxiOrigin?: string;
  credential?: { storage: 'localStorage' | 'sessionStorage'; key: string };
}

// Deployment configuration, never an author's Manifest, selects recipients.
export function loadFuxiEntryPolicy(
  env: NodeJS.ProcessEnv,
  context: { local: boolean; publicOrigin: string },
): FuxiEntryPolicy | undefined {
  const names = ['ENABLED', 'APP_ID', 'ENTRY_ID', 'ORIGIN', 'CREDENTIAL_STORAGE', 'CREDENTIAL_KEY', 'ALLOW_INTRANET_HTTP'];
  if (!names.some(name => Boolean(env[`PLAZA_FUXI_${name}`]))) return undefined;
  const invalid = () => new Error('伏羲入口配置无效，请核对固定应用、入口、来源及既有凭证存储配置');
  if (env.PLAZA_FUXI_ENABLED && !['0', '1'].includes(env.PLAZA_FUXI_ENABLED)) throw invalid();
  if (env.PLAZA_FUXI_ALLOW_INTRANET_HTTP && !['0', '1'].includes(env.PLAZA_FUXI_ALLOW_INTRANET_HTTP)) throw invalid();
  const appId = env.PLAZA_FUXI_APP_ID || '';
  const entryId = env.PLAZA_FUXI_ENTRY_ID || '';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(appId) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(entryId)) throw invalid();
  const policy: FuxiEntryPolicy = { appId: appId.toLowerCase(), entryId, plazaOrigin: context.publicOrigin, enabled: env.PLAZA_FUXI_ENABLED === '1' };
  // Retain the binding on rollback, blocking new handoffs without bypassing it.
  if (!policy.enabled) return policy;
  let url: URL;
  const value = env.PLAZA_FUXI_ORIGIN || '';
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin || url.username || url.password) throw invalid();
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (loopback && !context.local) throw invalid();
  const octets = url.hostname.split('.').map(Number);
  const privateIpv4 = isIP(url.hostname) === 4 && (octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (url.protocol === 'http:' && !(context.local && loopback) &&
    !(env.PLAZA_FUXI_ALLOW_INTRANET_HTTP === '1' && privateIpv4)) throw invalid();
  const storage = env.PLAZA_FUXI_CREDENTIAL_STORAGE;
  const key = env.PLAZA_FUXI_CREDENTIAL_KEY || '';
  if (!['localStorage', 'sessionStorage'].includes(storage || '') || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw invalid();
  return { ...policy, fuxiOrigin: url.origin, credential: { storage: storage as 'localStorage' | 'sessionStorage', key } };
}
