import type { FuxiEntryPolicy } from '../../server/fuxi-entry.js';
import { isPortalToken } from './tiangong-credential.js';

export function entryPolicy(policies: FuxiEntryPolicy[] | null, appId?: string, entryId?: string): FuxiEntryPolicy | undefined {
  return policies?.find(policy => policy.appId === appId && policy.entryId === entryId);
}

export function sameEntryPolicy(left: FuxiEntryPolicy, right?: FuxiEntryPolicy): boolean {
  return Boolean(right?.enabled && left.appId === right.appId && left.entryId === right.entryId &&
    left.plazaOrigin === right.plazaOrigin && left.fuxiOrigin === right.fuxiOrigin &&
    left.credential?.storage === right.credential?.storage && left.credential?.key === right.credential?.key);
}

export function createFuxiLauncher(host: Window, onError: (message: string) => void, options: {
  timeoutMs?: number;
  confirmPolicy?: (policy: FuxiEntryPolicy) => Promise<boolean>;
  getCredential?: (signal: AbortSignal) => Promise<string>;
} = {}) {
  let cancelActive: (() => void) | undefined;
  const fail = (message: string) => onError(message);
  return {
    launch(policy: FuxiEntryPolicy) {
      cancelActive?.();
      if (!policy.enabled) return fail('伏羲身份接入暂未启用，请联系广场维护者。');
      if (!policy.fuxiOrigin || host.location.origin !== policy.plazaOrigin ||
        (!options.getCredential && (!policy.credential || !['localStorage', 'sessionStorage'].includes(policy.credential.storage)))) {
        return fail('当前页面没有可用的天宫身份接入配置。');
      }
      // Only read the configured existing key in this origin after a click.
      // Never read user JSON, parent storage or URL tokens, or persist a token.
      let token: string | null = null;
      if (!options.getCredential) {
        try { token = host[policy.credential!.storage].getItem(policy.credential!.key); } catch { /* fixed error below */ }
      }
      if (!options.getCredential && !isPortalToken(token)) {
        token = null;
        return fail('当前页面未取得天宫登录凭证，请从已登录的天宫入口进入。');
      }
      let target: URL;
      try {
        target = new URL(policy.fuxiOrigin);
        if (!['http:', 'https:'].includes(target.protocol) || target.origin !== policy.fuxiOrigin) throw new Error();
      } catch {
        token = null;
        return fail('伏羲入口配置无效，请联系广场维护者。');
      }
      let popup: Window | null = null;
      let timeout: number | undefined;
      let closedPoll: number | undefined;
      let active = true;
      let receiving = false;
      const controller = new AbortController();
      const cleanup = (close = false) => {
        active = false;
        controller.abort();
        token = null;
        host.removeEventListener('message', receive);
        if (timeout !== undefined) host.clearTimeout(timeout);
        if (closedPoll !== undefined) host.clearInterval(closedPoll);
        if (cancelActive === cancel) cancelActive = undefined;
        if (close) { try { popup?.close(); } catch { /* fixed diagnostics */ } }
      };
      const cancel = () => cleanup(true);
      const receive = async (event: MessageEvent) => {
        if (!active || receiving || !popup || event.source !== popup || event.origin !== target.origin) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== 'fuxi:tiangong:ready' ||
          typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId)) return;
        receiving = true;
        // Recheck the server switch before each handoff, including pages that
        // were already open when the operator disabled/reconfigured the entry.
        if (options.confirmPolicy) {
          let confirmed = false;
          try { confirmed = await options.confirmPolicy(policy); } catch { /* fail closed */ }
          if (!active) return;
          if (!confirmed) {
            cleanup(true);
            return fail('伏羲入口配置已停用或发生变化，请刷新广场后重试。');
          }
        }
        if (options.getCredential) {
          try { token = await options.getCredential(controller.signal); }
          catch {
            if (!active) return;
            cleanup(true);
            return fail('未取得本次天宫凭证，请从天宫专用测试页重新打开入口。');
          }
          if (!active) return;
          let confirmed = true;
          try { if (options.confirmPolicy) confirmed = await options.confirmPolicy(policy); } catch { confirmed = false; }
          if (!active) return;
          if (!confirmed || !isPortalToken(token)) {
            cleanup(true);
            return fail('伏羲测试接入已停用或凭证不可用，请重新打开入口。');
          }
        }
        const credential = token;
        // Remove listener before sending: duplicates/reentrancy cannot transfer twice.
        cleanup();
        if (!credential) return;
        try {
          popup.postMessage({ type: 'fuxi:tiangong:login', requestId: data.requestId, token: credential }, target.origin);
        } catch {
          cleanup(true);
          fail('伏羲身份交接未完成，请从广场重新进入。');
        }
      };
      host.addEventListener('message', receive);
      try { popup = host.open(`${target.origin}/auth/tiangong`, '_blank'); } catch { /* fixed error below */ }
      if (!popup) {
        cleanup();
        return fail('浏览器阻止了伏羲页面，请允许此页面打开新窗口后重试。');
      }
      cancelActive = cancel;
      timeout = host.setTimeout(() => {
        cleanup(true);
        fail('伏羲身份接入等待超时，请从广场重新进入。');
      }, options.timeoutMs ?? 15_000);
      closedPoll = host.setInterval(() => {
        if (popup?.closed) {
          cleanup();
          fail('伏羲页面已关闭，本次身份接入已取消。');
        }
      }, 300);
    },
    dispose() { cancelActive?.(); },
  };
}
