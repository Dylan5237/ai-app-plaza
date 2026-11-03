import type { FuxiEntryPolicy } from '../../server/fuxi-entry.js';

const NONCE = /^[a-f0-9]{64}$/;
const nonce = (host: Window) => Array.from(host.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');

/** UI-owned launcher. It has no access to a credential, user identity, portal storage or popup. */
export function createPortalParentEntry(host: Window, policy: FuxiEntryPolicy,
  confirmPolicy: (policy: FuxiEntryPolicy) => Promise<boolean>,
  onReady: (ready: boolean) => void, onStatus: (code: string) => void) {
  let disposed = false, ready = false, active: string | undefined, checking: string | undefined;
  const hello = nonce(host), portalOrigin = policy.portal?.origin;
  const valid = Boolean(policy.enabled && policy.mode === 'portal-parent' && portalOrigin &&
    host.location.origin === policy.plazaOrigin && host.parent !== host);
  let attempts = 0;
  let timer: number | undefined;
  const send = (data: Record<string, unknown>) => {
    if (!disposed && valid) host.parent.postMessage({ version: 1, appId: policy.appId, entryId: policy.entryId, ...data }, portalOrigin!);
  };
  const receive = async (event: MessageEvent) => {
    if (disposed || !valid || !event.isTrusted || event.origin !== portalOrigin || event.source !== host.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.version !== 1 || data.appId !== policy.appId || data.entryId !== policy.entryId) return;
    if (data.type === 'fuxi:portal:ready' && data.requestId === hello) {
      ready = true; if (timer !== undefined) host.clearInterval(timer); onReady(true); return;
    }
    if (!active || data.requestId !== active) return;
    if (data.type === 'fuxi:portal:status' && ['POPUP_BLOCKED', 'POLICY_DISABLED', 'POLICY_UNAVAILABLE', 'REQUEST_EXPIRED', 'CREDENTIAL_MISSING', 'HANDOFF_FAILED'].includes(data.code)) {
      onStatus(data.code); active = undefined; return;
    }
    if (data.type !== 'fuxi:portal:policy-check' || checking || !NONCE.test(data.policyRequestId || '')) return;
    checking = data.policyRequestId;
    const requestId = active;
    let enabled = false;
    try { enabled = await confirmPolicy(policy); } catch {}
    if (disposed || active !== requestId) return;
    send({ type: 'fuxi:portal:policy-result', requestId, policyRequestId: checking, enabled: enabled === true });
  };
  host.addEventListener('message', receive);
  const discover = () => {
    if (++attempts > 30) { if (timer !== undefined) host.clearInterval(timer); return; }
    send({ type: 'fuxi:portal:hello', requestId: hello });
  };
  if (valid) { discover(); timer = host.setInterval(discover, 400); }
  return {
    launch(event: Event) {
      if (disposed || !ready || !valid || !event.isTrusted || !host.navigator.userActivation.isActive) return false;
      active = nonce(host); checking = undefined;
      send({ type: 'fuxi:portal:launch', requestId: active });
      return true;
    },
    dispose() {
      if (active) send({ type: 'fuxi:portal:cancel', requestId: active });
      disposed = true; ready = false; active = undefined;
      if (timer !== undefined) host.clearInterval(timer);
      host.removeEventListener('message', receive); onReady(false);
    },
  };
}
