// Deploy these two static assets only to the approved portal origin. No query
// string, Manifest field or global state message can override these targets.
export const portalTestDefaults = Object.freeze({
  portalOrigin: 'https://192.168.5.143:17090',
  plazaOrigin: 'http://192.168.2.145:16090',
  credentialKey: 'sky-token',
  ttlMs: 120_000,
});

// Configuration injection is for the isolated local fixture. The deployed page
// always boots with portalTestDefaults, never with URL or browser-state data.
export function createPortalTestBridge(host, config = portalTestDefaults) {
  const button = host.document.getElementById('open-test');
  const status = host.document.getElementById('status');
  const show = text => { if (status) status.textContent = text; };
  let valid = false;
  try {
    valid = host.location.origin === config.portalOrigin && new URL(config.portalOrigin).origin === config.portalOrigin &&
      new URL(config.plazaOrigin).origin === config.plazaOrigin && ['http:', 'https:'].includes(new URL(config.plazaOrigin).protocol) &&
      ['http:', 'https:'].includes(new URL(config.portalOrigin).protocol);
  } catch { /* fixed diagnostic below */ }
  if (!button || !valid) {
    if (button) button.disabled = true;
    show('此测试页必须由已确认的天宫来源提供，请从天宫入口访问。');
    return { dispose() {} };
  }
  let grant;
  let expiry;
  const clearGrant = () => { grant = undefined; if (expiry !== undefined) host.clearTimeout(expiry); expiry = undefined; };
  const open = () => {
    clearGrant();
    let child;
    try { child = host.open(`${config.plazaOrigin}/integration/fuxi-test`, '_blank'); } catch { /* fixed diagnostic below */ }
    if (!child) { show('浏览器阻止了新窗口，请允许测试页打开窗口后重试。'); return; }
    grant = { child, expiresAt: Date.now() + config.ttlMs };
    expiry = host.setTimeout(() => { clearGrant(); show('本次测试授权已过期，请重新打开广场测试入口。'); }, config.ttlMs);
    show('已打开广场测试页；仅在该页点击进入伏羲时交接一次凭证。');
  };
  const receive = event => {
    if (!grant || Date.now() >= grant.expiresAt || event.origin !== config.plazaOrigin || event.source !== grant.child) return;
    const data = event.data;
    if (!data || data.type !== 'plaza:tiangong:credential-request' || data.purpose !== 'fuxi-test' ||
      typeof data.requestId !== 'string' || !/^[0-9a-f]{64}$/.test(data.requestId)) return;
    const child = grant.child;
    try { if (child.closed) { clearGrant(); return; } } catch { clearGrant(); return; }
    // Consume before reading: errors and replay never cause another read/send.
    clearGrant();
    let token = null;
    try { token = host.localStorage.getItem(config.credentialKey); } catch { /* no exception text or token in UI */ }
    const validToken = typeof token === 'string' && token.length > 0 && token.length <= 8192 &&
      token.trim() === token && !/[\u0000-\u001f\u007f]/.test(token);
    try {
      child.postMessage({ type: 'plaza:tiangong:credential-result', requestId: data.requestId,
        ...(validToken ? { token } : { error: 'NO_PORTAL_CREDENTIAL' }) }, config.plazaOrigin);
      show(validToken ? '已交接一次凭证，请在伏羲测试页查看验证结果。' : '未取得天宫登录凭证，请正常登录后重新打开测试入口。');
    } catch { show('本次交接未完成，请重新打开广场测试入口。'); }
    finally { token = null; }
  };
  const dispose = () => {
    clearGrant();
    button.removeEventListener('click', open);
    host.removeEventListener('message', receive);
    host.removeEventListener('pagehide', dispose);
  };
  button.disabled = false;
  button.addEventListener('click', open);
  host.addEventListener('message', receive);
  host.addEventListener('pagehide', dispose);
  show('请确认已登录天宫，再打开广场测试入口。');
  return { dispose };
}

if (typeof window !== 'undefined') createPortalTestBridge(window);
