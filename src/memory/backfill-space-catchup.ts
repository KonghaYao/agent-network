/**
 * 空间首次创建后的历史补扫。
 *
 * 候选是 active 且没有 `space_catchup_done=1` 的空间；每个空间独立 rowid
 * 游标，从 0 开始，不受全局窗口水位影响。单轮最多处理
 * `memorySpaceCatchupSpaces` 个空间、每空间 `memorySpaceCatchupMessages`
 * 条消息；预算耗尽不写 done，下一轮从游标继续。
 *
 * 逐条写入复用 `MemoryBackfill` 的消息处理（授权、幂等、experience 去重），
 * 本模块只负责候选发现、游标推进与单轮预算。
 */
import { LIMITS } from '../contracts/limits';
import {
  listSpaceCatchupCandidates,
  scanSpaceVisibleMessagePage,
  type BackfillWindow,
  type MessageScanRow,
  type SpaceCatchupCandidate,
} from './backfill-window';
import {
  classifyError,
  emptySpaceCatchup,
  type MemoryBackfillCreated,
  type MemoryBackfillSkips,
  type MemorySpaceCatchupRun,
} from './backfill-shared';
import { advanceMemoryCursor, MEMORY_CURSOR_KINDS, readMemoryCursor } from './jobs';

/** 空间 catch-up 固定窗口：requestId/payloadHash 只随消息与空间集合变化。 */
const SPACE_CATCHUP_WINDOW: BackfillWindow = { from: 0, to: 0 };

export type SpaceCatchupMessageWriter = (
  row: MessageScanRow,
  window: BackfillWindow,
  skips: MemoryBackfillSkips,
  onlySpaceId: string,
) => Promise<MemoryBackfillCreated & { pairs: number }>;

export interface SpaceCatchupRunnerOptions {
  db: D1Database;
  instanceId: string;
  pageSize: number;
  now: () => number;
  log: (message: string, detail: Record<string, unknown>) => void;
  writeMessage: SpaceCatchupMessageWriter;
}

export class SpaceCatchupRunner {
  readonly #db: D1Database;
  readonly #instanceId: string;
  readonly #pageSize: number;
  readonly #now: () => number;
  readonly #log: SpaceCatchupRunnerOptions['log'];
  readonly #writeMessage: SpaceCatchupMessageWriter;

  constructor(options: SpaceCatchupRunnerOptions) {
    this.#db = options.db;
    this.#instanceId = options.instanceId;
    this.#pageSize = options.pageSize;
    this.#now = options.now;
    this.#log = options.log;
    this.#writeMessage = options.writeMessage;
  }

  /**
   * 单轮有界补扫。`now` 是整轮回填的时间快照，写入游标沿用同一时间。
   */
  async run(now: number): Promise<MemorySpaceCatchupRun> {
    const result = emptySpaceCatchup(true);
    const candidates = await listSpaceCatchupCandidates(this.#db, {
      instanceId: this.#instanceId,
      limit: LIMITS.memorySpaceCatchupSpaces,
    });
    result.selected = candidates.length;
    for (const candidate of candidates) {
      try {
        const completed = await this.#catchupSpace(candidate, now, result);
        if (completed) result.completed += 1;
      } catch (error) {
        result.errors += 1;
        this.#log('memory-backfill space catchup failed', {
          space_id: candidate.space_id,
          agent_id: candidate.agent_actor_id,
          error: classifyError(error),
        });
      }
    }
    return result;
  }

  /** 返回 true 表示该空间已扫到末尾并写入 done 游标。 */
  async #catchupSpace(
    candidate: SpaceCatchupCandidate,
    now: number,
    result: MemorySpaceCatchupRun,
  ): Promise<boolean> {
    const budget = Math.max(1, LIMITS.memorySpaceCatchupMessages);
    const stored = await readMemoryCursor(this.#db, {
      scopeKind: 'space',
      scopeId: candidate.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupRowid,
    });
    let after = Math.max(0, stored ?? 0);
    let scanned = 0;
    let completed = false;

    while (scanned < budget) {
      const limit = Math.min(this.#pageSize, budget - scanned);
      const rows = await scanSpaceVisibleMessagePage(this.#db, {
        agentId: candidate.agent_actor_id,
        afterRowid: after,
        limit,
      });
      if (rows.length === 0) {
        completed = true;
        break;
      }
      let interrupted = false;
      for (const row of rows) {
        const changedBefore = result.skips.space_capture_changed;
        try {
          const message = await this.#writeMessage(
            row,
            SPACE_CATCHUP_WINDOW,
            result.skips,
            candidate.space_id,
          );
          result.pairs += message.pairs;
          result.created.representations += message.representations;
          result.created.receipts += message.receipts;
          result.created.intents += message.intents;
          result.created.jobs += message.jobs;
          result.created.experiences += message.experiences;
          result.scanned += 1;
          scanned += 1;
          // 空间在扫描期间被排除/停用：本条消息没有写入任何东西，也不能越过
          // 它推进游标，更不能写 done，否则重新启用后会永久漏掉这段历史。
          if (result.skips.space_capture_changed > changedBefore) {
            interrupted = true;
            break;
          }
          after = row.rowid;
        } catch (error) {
          result.errors += 1;
          this.#log('memory-backfill space message failed', {
            space_id: candidate.space_id,
            agent_id: candidate.agent_actor_id,
            message_id: row.message_id,
            room_id: row.room_id,
            error: classifyError(error),
          });
          interrupted = true;
          break;
        }
      }
      if (after > (stored ?? 0)) {
        await advanceMemoryCursor(this.#db, {
          scopeKind: 'space',
          scopeId: candidate.space_id,
          cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupRowid,
          value: after,
          now,
        });
      }
      if (interrupted) break;
    }

    this.#log('memory-backfill space catchup', {
      space_id: candidate.space_id,
      agent_id: candidate.agent_actor_id,
      scanned,
      completed,
      cursor: after,
    });
    if (!completed) return false;
    await advanceMemoryCursor(this.#db, {
      scopeKind: 'space',
      scopeId: candidate.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
      value: 1,
      now,
    });
    return true;
  }
}
