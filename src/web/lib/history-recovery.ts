import { LIMITS } from '../../contracts/limits';
import { mergeTimelineItems, type HistoryItem } from './chat';

/**
 * 历史补洞：从旧窗口的 resume cursor 追到最新快照。
 *
 * 预算只控制“每批最多读多少页”，不是追平依据。每批结束都会通过
 * `onBatch` 报告已连续覆盖的游标，然后让出主线程继续下一批；失败时保留
 * 最后成功游标，下一轮从这里重试。游标停滞、越界或授权代次变化统一
 * 返回 `stale`，由调用方丢弃旧窗口并从最新授权快照重建。
 */

export interface CatchUpAuthorization {
  member_generation?: string;
  history_from_seq?: string;
  policy_revision?: string | number;
}

export interface CatchUpPage {
  items: HistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
  resumeCursor: string | null;
  snapshot: string | null;
  authorization?: CatchUpAuthorization | null;
}

export interface CatchUpBatch {
  pages: number;
  coveredCursor: string;
  coveredSeq: string | null;
  caughtUp: boolean;
}

export interface CatchUpFailure {
  kind: 'network' | 'stale' | 'aborted';
  message: string;
}

export interface CatchUpResult {
  items: HistoryItem[];
  caughtUp: boolean;
  pages: number;
  batches: number;
  coveredCursor: string;
  coveredSeq: string | null;
  snapshot: string | null;
  failure: CatchUpFailure | null;
}

export interface CatchUpOptions {
  initialItems: HistoryItem[];
  resumeCursor: string;
  targetSnapshot: string;
  fetchPage: (cursor: string) => Promise<CatchUpPage>;
  /** 首次请求使用的授权快照；后续页不一致即授权代次变化。 */
  expectedAuthorization?: string | null;
  /** 授权快照的规范化键；未提供时不比较。 */
  authorizationKey: (authorization: CatchUpAuthorization | null | undefined) => string | null;
  pageBudget?: number;
  maxPages?: number;
  signal?: AbortSignal;
  yieldToMain?: () => Promise<void>;
  onBatch?: (batch: CatchUpBatch) => void;
}

function itemSeq(item: HistoryItem): number {
  const value = Number(item.kind === 'presence' ? item.timeline_seq : item.created_seq);
  return Number.isFinite(value) ? value : 0;
}

function maxSeq(items: HistoryItem[], fallback: number): number {
  let max = fallback;
  for (const item of items) {
    const seq = itemSeq(item);
    if (seq > max) max = seq;
  }
  return max;
}

function stableCursor(page: CatchUpPage, previous: string): string {
  return page.nextCursor ?? page.resumeCursor ?? previous;
}

function abortError(signal: AbortSignal | undefined): CatchUpFailure | null {
  return signal?.aborted ? { kind: 'aborted', message: '恢复已取消' } : null;
}

export async function catchUpGap(options: CatchUpOptions): Promise<CatchUpResult> {
  const pageBudget = Math.max(1, options.pageBudget ?? LIMITS.historyCatchUpBatchPages);
  const maxPages = Math.max(pageBudget, options.maxPages ?? LIMITS.historyCatchUpMaxPages);
  const yieldToMain =
    options.yieldToMain ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  let target: number;
  try {
    target = Number(BigInt(options.targetSnapshot));
  } catch {
    return {
      items: options.initialItems,
      caughtUp: false,
      pages: 0,
      batches: 0,
      coveredCursor: options.resumeCursor,
      coveredSeq: null,
      snapshot: null,
      failure: { kind: 'stale', message: '最新快照无效' },
    };
  }

  let merged = options.initialItems.slice();
  let cursor = options.resumeCursor;
  let coveredSeq: string | null = null;
  let coveredNumber = -1;
  let pages = 0;
  let batches = 0;
  let expectedAuthorization = options.expectedAuthorization ?? null;

  const stale = (message: string): CatchUpResult => ({
    items: merged,
    caughtUp: false,
    pages,
    batches,
    coveredCursor: cursor,
    coveredSeq,
    snapshot: String(target),
    failure: { kind: 'stale', message },
  });

  for (;;) {
    let caughtUpInBatch = false;
    const batchStartPages = pages;
    for (let index = 0; index < pageBudget; index += 1) {
      if (options.signal?.aborted) {
        return {
          items: merged,
          caughtUp: false,
          pages,
          batches,
          coveredCursor: cursor,
          coveredSeq,
          snapshot: String(target),
          failure: abortError(options.signal),
        };
      }
      if (pages >= maxPages) {
        return stale(`补读超过 ${maxPages} 页仍未追平`);
      }
      let page: CatchUpPage;
      try {
        page = await options.fetchPage(cursor);
      } catch (error) {
        if (options.signal?.aborted) {
          return {
            items: merged,
            caughtUp: false,
            pages,
            batches,
            coveredCursor: cursor,
            coveredSeq,
            snapshot: String(target),
            failure: abortError(options.signal),
          };
        }
        const code = (error as { code?: string }).code;
        if (code === 'CURSOR_EXPIRED' || code === 'INVALID_ARGUMENT') {
          return stale((error as { message?: string }).message || '历史游标已失效');
        }
        return {
          items: merged,
          caughtUp: false,
          pages,
          batches,
          coveredCursor: cursor,
          coveredSeq,
          snapshot: String(target),
          failure: {
            kind: 'network',
            message: (error as { message?: string }).message || '补读历史失败',
          },
        };
      }
      if (options.signal?.aborted) {
        return {
          items: merged,
          caughtUp: false,
          pages,
          batches,
          coveredCursor: cursor,
          coveredSeq,
          snapshot: String(target),
          failure: abortError(options.signal),
        };
      }
      pages += 1;
      const key = options.authorizationKey(page.authorization);
      if (key !== null) {
        if (expectedAuthorization === null) expectedAuthorization = key;
        else if (key !== expectedAuthorization) {
          return stale('成员代次或历史边界已变化');
        }
      }
      merged = mergeTimelineItems(merged, page.items);
      const pageMax = maxSeq(page.items, coveredNumber);
      if (page.items.length > 0 && pageMax <= coveredNumber) {
        return stale('历史游标没有前进');
      }
      coveredNumber = pageMax;
      const lastItem = page.items[page.items.length - 1];
      if (lastItem) coveredSeq = String(itemSeq(lastItem));
      const next = stableCursor(page, cursor);
      if (next === cursor) return stale('历史游标停滞');
      cursor = next;
      const reached = pageMax >= target;
      if (reached || !page.hasMore) {
        caughtUpInBatch = true;
        break;
      }
    }

    batches += 1;
    options.onBatch?.({
      pages: pages - batchStartPages,
      coveredCursor: cursor,
      coveredSeq,
      caughtUp: caughtUpInBatch,
    });
    if (caughtUpInBatch) {
      return {
        items: merged,
        caughtUp: true,
        pages,
        batches,
        coveredCursor: cursor,
        coveredSeq,
        snapshot: String(target),
        failure: null,
      };
    }
    await yieldToMain();
  }
}
