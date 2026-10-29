import type { FuxiEntryPolicy } from '../../server/fuxi-entry.js';

const STATUS_CODES = new Set(['STORAGE_DENIED', 'REQUEST_EXPIRED', 'POPUP_BLOCKED', 'POLICY_UNAVAILABLE',
  'POLICY_DISABLED', 'CREDENTIAL_MISSING', 'HANDOFF_FAILED']);

/** Respond only to the currently mounted portal frame, after a fresh policy read. */
export function createFuxiWidgetResponder(
  host: Window,
  policy: FuxiEntryPolicy,
  frameWindow: () => Window | null,
  confirmPolicy: (policy: FuxiEntryPolicy) => Promise<boolean>,
  onStatus: (code: string) => void = () => {},
) {
  let disposed = false;
  const seen = new Map<string, number>();
  const receive = async (event: MessageEvent) => {
    const frame = frameWindow();
    const widget = policy.widget;
    if (disposed || !event.isTrusted || !policy.enabled || policy.mode !== 'portal-widget' ||
      !widget || !policy.fuxiOrigin || host.location.origin !== policy.plazaOrigin ||
      !frame || event.source !== frame || event.origin !== widget.portalOrigin) return;
    const data = event.data;
    if (data && typeof data === 'object' && data.type === 'fuxi:widget:status') {
      if (typeof data.code === 'string' && STATUS_CODES.has(data.code)) onStatus(data.code);
      return;
    }
    if (!data || typeof data !== 'object' || data.type !== 'fuxi:widget:policy-request' ||
      data.appId !== policy.appId || data.entryId !== policy.entryId ||
      typeof data.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(data.requestId)) return;
    const now = Date.now();
    for (const [id, time] of seen) if (now - time > 120_000) seen.delete(id);
    if (seen.has(data.requestId) || seen.size >= 64) return;
    seen.set(data.requestId, now);

    let enabled = false;
    try { enabled = await confirmPolicy(policy); } catch { /* respond disabled */ }
    if (disposed || frameWindow() !== frame || host.location.origin !== policy.plazaOrigin) return;
    try {
      frame.postMessage({ type: 'fuxi:widget:policy-result', requestId: data.requestId,
        enabled: enabled === true, appId: policy.appId, entryId: policy.entryId,
        portalOrigin: widget.portalOrigin, fuxiOrigin: policy.fuxiOrigin }, widget.portalOrigin);
    } catch { /* no token is held here; portal times out safely */ }
  };
  host.addEventListener('message', receive);
  return { dispose() { disposed = true; seen.clear(); host.removeEventListener('message', receive); } };
}
