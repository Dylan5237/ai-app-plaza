import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { Address6 } from 'ip-address';

type PublicOrigins = { publicOrigin: string; httpsOrigin?: string; trustedProxyIp?: string };
type IngressRequest = { headers: IncomingHttpHeaders; socket: { remoteAddress?: string }; ip: string;
  raw?: { socket: { remoteAddress?: string }; rawHeaders: string[] } };

export function parseTrustedProxyIp(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return;
  if (!isIP(value) || value.includes('%')) throw new Error('PLAZA_TRUSTED_PROXY_IP 必须是单一可信代理 IP，不接受域名、CIDR 或地址列表');
  return value;
}

function normalizedIp(value: string): string {
  if (isIP(value) !== 6) return value.toLowerCase();
  const address = new Address6(value);
  return address.isMapped4() ? address.to4().correctForm() : address.correctForm();
}

/** Trust only the configured socket peer; never interpret a forwarded chain. */
function proxyClientIp(config: PublicOrigins, request: IngressRequest): string | undefined {
  const remote = request.raw?.socket.remoteAddress;
  if (!config.trustedProxyIp || !remote || !isIP(remote) || remote.includes('%') ||
    normalizedIp(remote) !== normalizedIp(config.trustedProxyIp)) return;
  const client = request.headers['x-real-ip'];
  const count = request.raw!.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-real-ip').length;
  return count === 1 && typeof client === 'string' && !client.includes('%') && isIP(client) !== 0 ? client : undefined;
}

/** One optional HTTPS ingress, on the same literal host as the existing HTTP origin. */
export function parseHttpsOrigin(value: string | undefined, context: { local: boolean; publicOrigin: string }): string | undefined {
  if (value === undefined || value === '') return undefined;
  const invalid = () => new Error('PLAZA_HTTPS_ORIGIN 必须为同一固定私网 IP 的 HTTPS 独立入口，不得包含凭据、路径、查询或片段');
  let url: URL;
  let primary: URL;
  try { url = new URL(value); primary = new URL(context.publicOrigin); } catch { throw invalid(); }
  const literal = /^https:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\/?$/i.exec(value);
  const [first, second] = url.hostname.split('.').map(Number);
  const privateIp = isIP(url.hostname) === 4 &&
    (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
  if (!literal || literal[1] !== url.hostname || primary.protocol !== 'http:' || url.protocol !== 'https:' ||
    url.hostname !== primary.hostname || url.host === primary.host || url.username || url.password ||
    url.search || url.hash || !['', '/'].includes(url.pathname) ||
    (!privateIp && !(context.local && url.hostname === '127.0.0.1'))) throw invalid();
  return url.origin;
}

/** The gateway overwrites X-Real-IP and opens its backend connection from loopback. */
function httpsClientIp(config: PublicOrigins, request: IngressRequest): string | undefined {
  if (!config.httpsOrigin || request.headers.host !== new URL(config.httpsOrigin).host ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) return undefined;
  const client = request.headers['x-real-ip'];
  return typeof client === 'string' && !client.includes('%') && isIP(client) !== 0 ? client : undefined;
}

export function publicOriginForRequest(config: PublicOrigins, request: IngressRequest): string | undefined {
  if (request.headers.host === new URL(config.publicOrigin).host) return config.publicOrigin;
  return httpsClientIp(config, request) ? config.httpsOrigin : undefined;
}

/** Keep rate-limit's existing IPv4 / IPv4-mapped and IPv6 /64 bucket semantics. */
export function publicClientRateKey(config: PublicOrigins, request: IngressRequest): string {
  const ip = proxyClientIp(config, request) || httpsClientIp(config, request) || request.ip;
  if (isIP(ip) !== 6) return ip.toLowerCase();
  const address = new Address6(ip);
  return address.isMapped4() ? address.to4().correctForm() : new Address6(`${ip}/64`).startAddress().correctForm();
}
