import { LIMITS } from '../contracts/limits';
import { sha256Hex } from '../storage/db';
import type { MemoryAdapter } from './adapters/types';
import type { MemorySpaceRef } from './contracts';

function spaceKey(space: MemorySpaceRef): string {
  return `${space.space_id}:${space.ownership_epoch}:${space.backend_binding_epoch}`;
}

/** Only successful probes are retained. Durable ensure jobs keep their own operation keys. */
export class BackendSpaceCache {
  readonly #ready = new Set<string>();
  readonly #pending = new Map<string, Promise<boolean>>();
  #closed = false;

  constructor(
    private readonly adapter: Pick<MemoryAdapter, 'ensureSpace'>,
    private readonly capacity: number = LIMITS.memoryReadySpaceCacheEntries,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#ready.clear();
  }

  markReady(space: MemorySpaceRef): void {
    if (this.#closed) return;
    const key = spaceKey(space);
    this.#ready.delete(key);
    this.#ready.add(key);
    if (this.#ready.size > this.capacity) {
      const oldest = this.#ready.values().next();
      if (!oldest.done) this.#ready.delete(oldest.value);
    }
  }

  async ensure(space: MemorySpaceRef): Promise<boolean> {
    if (this.#closed) return false;
    const key = spaceKey(space);
    if (this.#ready.has(key)) return true;
    const existing = this.#pending.get(key);
    if (existing) return existing;
    const probe = this.#probe(space, key);
    this.#pending.set(key, probe);
    try {
      return await probe;
    } finally {
      this.#pending.delete(key);
    }
  }

  async #probe(space: MemorySpaceRef, key: string): Promise<boolean> {
    const payloadHash = await sha256Hex(`ensure-space|${key}`);
    if (this.#closed) return false;
    const result = await this.adapter.ensureSpace({
      space,
      operation_key: `ensure-space:${key}`,
      payload_sha256: payloadHash,
      deadline_at: null,
    });
    if (this.#closed || result.status !== 'ready') return false;
    this.markReady(space);
    return true;
  }
}
