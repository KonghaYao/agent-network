/**
 * 只读 insight 的有界 TTL 缓存与 single-flight。
 *
 * 只缓存归一化后的 DTO，不缓存 Hindsight 原始响应；失败不写入缓存。
 * 缓存键由调用方构造，权限检查必须发生在读取缓存之前。
 */
export interface InsightCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface CacheEntry {
  expires_at: number;
  value: unknown;
}

export class InsightCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(options: InsightCacheOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = Math.max(1, options.maxEntries);
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    options: { refresh?: boolean; ttlMs?: number } = {},
  ): Promise<T> {
    const now = this.#now();
    if (!options.refresh) {
      const entry = this.#entries.get(key);
      if (entry && entry.expires_at > now) return entry.value as T;
      if (entry) this.#entries.delete(key);
    }

    const inflight = this.#inflight.get(key);
    if (inflight) return inflight as Promise<T>;

    let promise: Promise<T>;
    promise = loader()
      .then((value) => {
        this.#store(key, value, options.ttlMs ?? this.#ttlMs);
        return value;
      })
      .finally(() => {
        if (this.#inflight.get(key) === promise) this.#inflight.delete(key);
      });
    this.#inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.#entries.clear();
    this.#inflight.clear();
  }

  #store(key: string, value: unknown, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, { expires_at: this.#now() + ttlMs, value });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
