import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { Address6 } from 'ip-address';

type PublicOrigins = { publicOrigin: string; httpsOrigin?: string };
type IngressRequest = { headers: IncomingHttpHeaders; socket: { remoteAddress?: string }; ip: string };

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
  const ip = httpsClientIp(config, request) || request.ip;
  if (isIP(ip) !== 6) return ip.toLowerCase();
  const address = new Address6(ip);
  return address.isMapped4() ? address.to4().correctForm() : new Address6(`${ip}/64`).startAddress().correctForm();
}
