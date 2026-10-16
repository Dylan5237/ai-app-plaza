import { DomainError } from './errors.js';

/** Only capacity is shared. Authorization and response data never enter this pool. */
export class GitLabConcurrency {
  private active = 0;
  private readonly waiting: Array<{ signal: AbortSignal; start: () => void; abort: () => void }> = [];

  constructor(private readonly maximum: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.maximum) {
      if (this.waiting.length >= 80) throw new DomainError(503, 'SOURCE_UNAVAILABLE', 'GitLab 请求繁忙，请保留本次记录后重试。');
      await new Promise<void>((resolve, reject) => {
        const entry = {
          signal,
          start: () => { signal.removeEventListener('abort', entry.abort); resolve(); },
          abort: () => {
            const index = this.waiting.indexOf(entry);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(signal.reason);
          },
        };
        this.waiting.push(entry);
        signal.addEventListener('abort', entry.abort, { once: true });
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await work(); }
    finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) { this.active++; next.start(); }
    }
  }
}

const pools = new Map<string, GitLabConcurrency>();
export function gitlabConcurrency(base: URL): GitLabConcurrency {
  const key = base.href;
  let pool = pools.get(key);
  if (!pool) { pool = new GitLabConcurrency(6); pools.set(key, pool); }
  return pool;
}
