/**
 * 回填统计类型与共享辅助。
 *
 * 单独成模块以避免 `backfill.ts` 与空间 catch-up 模块互相依赖；这里只放
 * 无副作用的计数结构和错误分类，不持有数据库或运行时状态。
 */
export interface MemoryBackfillCreated {
  representations: number;
  receipts: number;
  intents: number;
  jobs: number;
  experiences: number;
}

export interface MemoryBackfillSkips {
  empty_body: number;
  out_of_window: number;
  source_inactive: number;
  source_missing: number;
  no_agent: number;
  no_space: number;
  capture_off: number;
  denied: number;
  already: number;
  /** 空间 catch-up 期间空间被排除/停用/成员变化，按空间过滤后没有扇出。 */
  space_capture_changed: number;
}

export interface MemorySpaceCatchupRun {
  enabled: boolean;
  selected: number;
  completed: number;
  scanned: number;
  pairs: number;
  created: MemoryBackfillCreated;
  skips: MemoryBackfillSkips;
  errors: number;
}

export function emptyCreated(): MemoryBackfillCreated {
  return { representations: 0, receipts: 0, intents: 0, jobs: 0, experiences: 0 };
}

export function emptySkips(): MemoryBackfillSkips {
  return {
    empty_body: 0,
    out_of_window: 0,
    source_inactive: 0,
    source_missing: 0,
    no_agent: 0,
    no_space: 0,
    capture_off: 0,
    denied: 0,
    already: 0,
    space_capture_changed: 0,
  };
}

export function emptySpaceCatchup(enabled: boolean): MemorySpaceCatchupRun {
  return {
    enabled,
    selected: 0,
    completed: 0,
    scanned: 0,
    pairs: 0,
    created: emptyCreated(),
    skips: emptySkips(),
    errors: 0,
  };
}

export function classifyError(error: unknown): string {
  if (error instanceof Error) {
    const text = error.message;
    if (text.includes('UNIQUE') || text.includes('FOREIGN KEY')) return 'constraint';
    if (text.includes('SQLITE')) return 'sqlite';
    return error.name;
  }
  return 'unknown';
}
