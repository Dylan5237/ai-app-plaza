export const STARTUP_READINESS_TIMEOUT_MS = 30_000;

const PROBE_TIMEOUT_MS = 500;
const POLL_INTERVAL_MS = 100;

export type StartupReadinessProbe = {
  httpStatus: number;
  body: unknown;
};

export type StartupReadinessHealth = {
  status: 'ok';
  mode: 'local';
  loginRequired: false;
};

type StartupReadinessDiagnostic =
  | { httpStatus: number; healthStatus: unknown; mode: unknown; loginRequired: unknown }
  | { error: string; code?: string };

export type StartupReadinessOutcome =
  | { ready: true; health: StartupReadinessHealth; elapsedMs: number }
  | {
      ready: false;
      reason: 'early-exit' | 'deadline';
      elapsedMs: number;
      childRunning: boolean;
      ownStartupMarker: boolean;
      lastProbe?: StartupReadinessDiagnostic;
    };

export type WaitForStartupReadinessOptions = {
  origin: string;
  isChildRunning: () => boolean;
  hasOwnStartupMarker: () => boolean;
  timeoutMs?: number;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  probe?: (timeoutMs: number) => Promise<StartupReadinessProbe>;
};

async function probeHealth(origin: string, timeoutMs: number): Promise<StartupReadinessProbe> {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { httpStatus: response.status, body };
}

function healthRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

export async function waitForStartupReadiness(options: WaitForStartupReadinessOptions): Promise<StartupReadinessOutcome> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? STARTUP_READINESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Startup readiness timeout must be positive.');

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let lastProbe: StartupReadinessDiagnostic | undefined;

  const finish = (reason: 'early-exit' | 'deadline'): StartupReadinessOutcome => ({
    ready: false,
    reason,
    elapsedMs: now() - startedAt,
    childRunning: options.isChildRunning(),
    ownStartupMarker: options.hasOwnStartupMarker(),
    ...(lastProbe ? { lastProbe } : {}),
  });

  while (true) {
    if (!options.isChildRunning()) return finish('early-exit');
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return finish('deadline');
    const probeTimeoutMs = Math.min(PROBE_TIMEOUT_MS, Math.floor(remainingMs));
    if (probeTimeoutMs <= 0) return finish('deadline');

    try {
      const probe = options.probe ?? (milliseconds => probeHealth(options.origin, milliseconds));
      const result = await probe(probeTimeoutMs);
      const body = healthRecord(result.body);
      lastProbe = {
        httpStatus: result.httpStatus,
        healthStatus: body.status,
        mode: body.mode,
        loginRequired: body.loginRequired,
      };

      const completedAt = now();
      const childRunning = options.isChildRunning();
      const ownStartupMarker = options.hasOwnStartupMarker();
      if (!childRunning) return finish('early-exit');
      if (completedAt >= deadline) return finish('deadline');

      if (ownStartupMarker && result.httpStatus === 200 && body.status === 'ok' &&
          body.mode === 'local' && body.loginRequired === false) {
        return {
          ready: true,
          health: { status: 'ok', mode: 'local', loginRequired: false },
          elapsedMs: completedAt - startedAt,
        };
      }
    } catch (error) {
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
      lastProbe = {
        error: error instanceof Error ? error.name : 'unknown',
        ...(cause?.code ? { code: cause.code } : {}),
      };
    }

    const afterProbeMs = deadline - now();
    if (afterProbeMs <= 0) return finish('deadline');
    await pause(Math.max(0, Math.min(POLL_INTERVAL_MS, afterProbeMs)));
  }
}
