export function isPortalToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function requestPortalCredential(host: Window, portalOrigin: string, signal: AbortSignal, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const failure = () => new Error('未取得本次天宫凭证，请从天宫专用测试页重新打开入口。');
    let portal: Window | null;
    try {
      const url = new URL(portalOrigin);
      if (url.origin !== portalOrigin || !['http:', 'https:'].includes(url.protocol)) throw failure();
      portal = host.opener;
      if (!portal || portal.closed || signal.aborted) throw failure();
    } catch { reject(failure()); return; }
    // getRandomValues works in the explicitly supported HTTP intranet context;
    // randomUUID would require a secure context in browsers.
    let requestId: string;
    try { requestId = Array.from(host.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }
    catch { reject(failure()); return; }
    let active = true;
    let timer: number | undefined;
    const cleanup = () => {
      active = false;
      host.removeEventListener('message', receive);
      signal.removeEventListener('abort', abort);
      if (timer !== undefined) host.clearTimeout(timer);
    };
    const abort = () => { if (!active) return; cleanup(); reject(failure()); };
    const receive = (event: MessageEvent) => {
      if (!active || event.origin !== portalOrigin || event.source !== portal) return;
      const data = event.data;
      if (!data || data.type !== 'plaza:tiangong:credential-result' || data.requestId !== requestId) return;
      cleanup();
      if (data.error || !isPortalToken(data.token)) reject(failure());
      else resolve(data.token);
    };
    host.addEventListener('message', receive);
    signal.addEventListener('abort', abort, { once: true });
    timer = host.setTimeout(abort, timeoutMs);
    try { portal!.postMessage({ type: 'plaza:tiangong:credential-request', requestId, purpose: 'fuxi-test' }, portalOrigin); }
    catch { abort(); }
  });
}
