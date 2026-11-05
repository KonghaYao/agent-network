import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import {
  newId,
  nowMs,
  sha256Hex,
  stableStringify,
} from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';

/**
 * Agent 上下线持久化时间线。
 *
 * 只记录 direct 人类↔Agent 会话，不进入 messages、不推进 rooms.head_seq，
 * 也不写 inbox/outbox 的待办事件。状态转换全部串行化并通过 revision CAS
 * 收敛；SQLite 是唯一权威，hub 只在内存中做低延迟唤醒。
 *
 * 在线判定是“可用性”而不是“SSE 连接”：任意已认证 Agent 的 MCP 请求都会
 * 刷新 `last_seen_at`，最后一条连接关闭后以 `last_seen_at + TTL` 作为可用
 * 性过期点，再等待 grace 确认下线。消息/未读/待办语义完全不变。
 */

export interface AgentPresenceTimelineOptions {
  /** 最后连接断开后的宽限；测试可注入短值。 */
  graceMs?: number;
  /** 无连接时最近活动仍视为在线的窗口；测试可注入短值。 */
  activityTtlMs?: number;
  /** 在线状态下刷新 last_seen_at 的最小写库间隔；测试可注入短值。 */
  touchThrottleMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  /**
   * 查询 hub 是否仍有该 actor 的 SSE 连接。
   *
   * 连接存在时即使超过活动窗口也不能进入 pending；缺失时 sweep 不做
   * 无连接兜底（调用方未提供权威连接视图）。
   */
  hasConnection?: (actorId: string) => boolean;
  /**
   * 上下线事件与 outbox 在同一事务提交后触发。
   *
   * 只在该次转换确实写入房间事件时调用；实现必须自行处理异步失败，
   * 不能把通知通道的问题传回状态机。
   */
  onPresenceCommitted?: () => void;
}

interface PresenceStateRow {
  actor_id: string;
  revision: number;
  generation_id: string | null;
  phase: 'offline' | 'online' | 'pending_offline';
  online_at: number | null;
  last_seen_at: number | null;
  disconnect_observed_at: number | null;
  offline_due_at: number | null;
  time_basis: 'observed' | 'inferred';
  updated_at: number;
}

interface RoomRow {
  room_id: string;
}

type Transition = 'online' | 'offline';
type TimeBasis = 'observed' | 'inferred';

function businessCode(error: unknown): string | null {
  return error instanceof BusinessError ? error.code : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export class AgentPresenceTimeline {
  readonly #db: D1Database;
  readonly #graceMs: number;
  readonly #activityTtlMs: number;
  readonly #touchThrottleMs: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #hasConnection: ((actorId: string) => boolean) | undefined;
  readonly #onPresenceCommitted: (() => void) | undefined;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(db: D1Database, options: AgentPresenceTimelineOptions = {}) {
    this.#db = db;
    this.#graceMs = options.graceMs ?? LIMITS.agentPresenceGraceMs;
    this.#activityTtlMs = options.activityTtlMs ?? LIMITS.agentPresenceActivityTtlMs;
    this.#touchThrottleMs = options.touchThrottleMs ?? LIMITS.agentPresenceTouchThrottleMs;
    this.#now = options.now ?? nowMs;
    this.#hasConnection = options.hasConnection;
    this.#onPresenceCommitted = options.onPresenceCommitted;
    this.#onError =
      options.onError ??
      ((error) => console.error('agent-network presence transition failed', errorText(error)));
  }

  /** login 工具在 hub 标记在线后等待本次写入；失败不改变 login 结果。 */
  async recordLogin(actorId: string, at = this.#now()): Promise<void> {
    await this.#serialized(actorId, () => this.#startOnline(actorId, at, true)).catch((error) =>
      this.#onError(error),
    );
  }

  /**
   * 任意已认证 Agent 的 MCP 请求触碰在线状态。
   *
   * 写库失败由调用方吞掉（presence 是旁路，不能影响业务响应）。offline 的
   * 上线转换与 pending 的取消/确认不做节流；只有 online 状态下的 last_seen
   * 刷新按 `touchThrottleMs` 合并，避免每个请求都写 SQLite。
   */
  async touch(actorId: string, at = this.#now()): Promise<void> {
    await this.#serialized(actorId, () => this.#recordActivity(actorId, at));
  }

  /** 新连接建立时由 hub 触发；只有显式 login 过的 Agent 才会写历史。 */
  connectionOpened(actorId: string, at = this.#now()): void {
    void this.#serialized(actorId, () => this.#startOnline(actorId, at, true)).catch((error) =>
      this.#onError(error),
    );
  }

  /** 最后一条连接断开时由 hub 触发；只持久化 pending，不立即写下线。 */
  connectionClosed(actorId: string, at = this.#now()): void {
    void this.#serialized(actorId, () => this.#observeDisconnect(actorId, at)).catch((error) =>
      this.#onError(error),
    );
  }

  /** 启动扫描：崩溃遗留的 online 转为 pending，并标记为 inferred。 */
  async recover(): Promise<number> {
    let recovered = 0;
    // 分批处理，避免单进程大量 Agent 时只恢复前 50 个。
    for (let round = 0; round < 100; round += 1) {
      const rows = await this.#db
        .prepare("SELECT actor_id FROM agent_presence_state WHERE phase = 'online' LIMIT ?")
        .bind(LIMITS.agentPresenceSweepBatch)
        .all<{ actor_id: string }>();
      if (rows.results.length === 0) break;
      const before = recovered;
      for (const row of rows.results) {
        try {
          await this.#serialized(row.actor_id, () => this.#markRecoveredPending(row.actor_id));
          recovered += 1;
        } catch (error) {
          this.#onError(error);
        }
      }
      if (recovered === before) break;
      if (rows.results.length < LIMITS.agentPresenceSweepBatch) break;
    }
    await this.sweep();
    return recovered;
  }

  /** 确认已过 grace 的 pending；返回本次确认数量。 */
  async sweep(): Promise<number> {
    const at = this.#now();
    const rows = await this.#db
      .prepare(
        "SELECT actor_id FROM agent_presence_state WHERE phase = 'pending_offline' AND offline_due_at IS NOT NULL AND offline_due_at <= ? ORDER BY offline_due_at ASC LIMIT ?",
      )
      .bind(at, LIMITS.agentPresenceSweepBatch)
      .all<{ actor_id: string }>();
    let confirmed = 0;
    for (const row of rows.results) {
      try {
        await this.#serialized(row.actor_id, () => this.#confirmDueOffline(row.actor_id));
        confirmed += 1;
      } catch (error) {
        this.#onError(error);
      }
    }
    await this.#markIdleOnlinePending(at);
    return confirmed;
  }

  /**
   * 兜底扫描：online 但活动窗口已过、且 hub 已无连接的行。
   *
   * 只在注入 hasConnection 时执行；连接仍存在时永不下线。进入 pending 的
   * occurred_at/offline_due_at 都以 `last_seen_at + TTL` 为可用性过期点，
   * 因此确认后的展示时间仍是“最后活动 + TTL”，与 sweep 周期无关。
   */
  async #markIdleOnlinePending(at: number): Promise<void> {
    if (!this.#hasConnection) return;
    const rows = await this.#db
      .prepare(
        `SELECT actor_id FROM agent_presence_state
          WHERE phase = 'online'
            AND last_seen_at IS NOT NULL
            AND last_seen_at + ? <= ?
          ORDER BY last_seen_at ASC LIMIT ?`,
      )
      .bind(this.#activityTtlMs, at, LIMITS.agentPresenceSweepBatch)
      .all<{ actor_id: string }>();
    for (const row of rows.results) {
      if (this.#hasConnection(row.actor_id)) continue;
      try {
        await this.#serialized(row.actor_id, () => this.#markStalePending(row.actor_id, at));
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** room_get 的在线快照：online 与 pending 都表示仍可用；offline/缺失为 false。 */
  async phaseOf(actorId: string): Promise<'offline' | 'online' | 'pending_offline' | null> {
    const state = await this.#getState(actorId);
    return state?.phase ?? null;
  }

  /** 正常 shutdown 前等待已排队的 disconnect 写入落库。 */
  async flush(): Promise<void> {
    for (let round = 0; round < 8 && this.#queues.size > 0; round += 1) {
      await Promise.all([...this.#queues.values()].map((task) => task.catch(() => undefined)));
    }
  }

  #serialized(actorId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(actorId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#queues.set(actorId, next);
    void next
      .finally(() => {
        if (this.#queues.get(actorId) === next) this.#queues.delete(actorId);
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * 请求触碰：offline/pending 必须立即判断转换；online 只按节流刷新
   * last_seen_at。节流写只是普通时间戳更新，不参与幂等业务写入。
   */
  async #recordActivity(actorId: string, at: number): Promise<void> {
    const state = await this.#getState(actorId);
    if (state?.phase === 'online') {
      const last = state.last_seen_at;
      if (last !== null && at >= last && at - last < this.#touchThrottleMs) return;
      await this.#db
        .prepare(
          `UPDATE agent_presence_state
              SET last_seen_at = ?, updated_at = ?
            WHERE actor_id = ? AND phase = 'online'`,
        )
        .bind(at, at, actorId)
        .run();
      return;
    }
    await this.#startOnline(actorId, at, false);
  }

  async #startOnline(actorId: string, at: number, requireConnection: boolean): Promise<void> {
    // login/连接事件与最后连接关闭可能交错：写入前以 hub 当前连接为准。
    // 请求触碰本身就是可用性证据，不做该复查。
    if (requireConnection && this.#hasConnection && !this.#hasConnection(actorId)) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.#getState(actorId);
      if (state?.phase === 'online') return;
      if (state?.phase === 'pending_offline' && state.generation_id) {
        const due = state.offline_due_at ?? at;
        if (at < due) {
          try {
            await this.#resume(actorId, state, at);
            return;
          } catch (error) {
            if (businessCode(error) !== 'CONFLICT') throw error;
            continue;
          }
        }
        try {
          await this.#confirmOffline(actorId, state, at);
          continue;
        } catch (error) {
          if (businessCode(error) !== 'CONFLICT') throw error;
          continue;
        }
      }
      try {
        await this.#writeOnline(actorId, state, at);
        return;
      } catch (error) {
        if (businessCode(error) !== 'CONFLICT') throw error;
      }
    }
    throw new BusinessError('CONFLICT', '在线状态持续变化，稍后重试');
  }

  async #writeOnline(actorId: string, state: PresenceStateRow | null, at: number): Promise<void> {
    const generationId = newId('gen');
    const rooms = await this.#eligibleRooms(actorId);
    const requestId = `presence:${generationId}:online`;
    const payload = { actorId, generationId, transition: 'online', onlineAt: at, rooms };
    const stateStatement =
      state === null
        ? this.#db
            .prepare(
              `INSERT INTO agent_presence_state
                 (actor_id, revision, generation_id, phase, online_at, last_seen_at,
                  disconnect_observed_at, offline_due_at, time_basis, updated_at)
               VALUES (?, 1, ?, 'online', ?, ?, NULL, NULL, 'observed', ?)`,
            )
            .bind(actorId, generationId, at, at, at)
        : this.#db
            .prepare(
              `UPDATE agent_presence_state
                  SET revision = revision + 1,
                      generation_id = ?,
                      phase = 'online',
                      online_at = ?,
                      last_seen_at = ?,
                      disconnect_observed_at = NULL,
                      offline_due_at = NULL,
                      time_basis = 'observed',
                      updated_at = ?
                WHERE actor_id = ? AND revision = ? AND phase = 'offline'`,
            )
            .bind(generationId, at, at, at, actorId, state.revision);
    const guard =
      state === null
        ? this.#db
            .prepare(
              guardSql(
                'presenceStale',
                'EXISTS (SELECT 1 FROM agent_presence_state WHERE actor_id = ?)',
              ),
            )
            .bind(actorId)
        : this.#db
            .prepare(
              guardSql(
                'presenceStale',
                `NOT EXISTS (
                   SELECT 1 FROM agent_presence_state
                    WHERE actor_id = ? AND revision = ? AND phase = 'offline'
                 )`,
              ),
            )
            .bind(actorId, state.revision);
    await this.#run(
      actorId,
      requestId,
      payload,
      () => [
        guard,
        stateStatement,
        ...this.#transitionStatements(actorId, generationId, 'online', at, at, 'observed', rooms),
      ],
      at,
    );
    if (rooms.length > 0) this.#notifyCommitted();
  }

  async #resume(actorId: string, state: PresenceStateRow, at: number): Promise<void> {
    const generationId = state.generation_id as string;
    const requestId = `presence:${generationId}:resume:${state.revision}`;
    const payload = { actorId, generationId, revision: state.revision, phase: 'online' };
    await this.#run(actorId, requestId, payload, () => [
      this.#db
        .prepare(
          guardSql(
            'presenceStale',
            `NOT EXISTS (
               SELECT 1 FROM agent_presence_state
                WHERE actor_id = ? AND revision = ? AND phase = 'pending_offline'
             )`,
          ),
        )
        .bind(actorId, state.revision),
      this.#db
        .prepare(
          `UPDATE agent_presence_state
              SET revision = revision + 1,
                  phase = 'online',
                  last_seen_at = ?,
                  disconnect_observed_at = NULL,
                  offline_due_at = NULL,
                  time_basis = 'observed',
                  updated_at = ?
            WHERE actor_id = ? AND revision = ? AND phase = 'pending_offline'`,
        )
        .bind(at, at, actorId, state.revision),
      this.#db
        .prepare('DELETE FROM presence_pending_rooms WHERE generation_id = ?')
        .bind(generationId),
    ], at);
  }

  async #observeDisconnect(actorId: string, at: number): Promise<void> {
    // 队列里可能已经排着新连接；仍有连接就不进入 pending。
    if (this.#hasConnection?.(actorId)) return;
    const state = await this.#getState(actorId);
    if (!state || state.phase !== 'online' || !state.generation_id) return;
    // 连接关闭本身不刷新 last_seen：可用性过期点取“最后活动 + TTL”与
    // 断连时刻的较大者，确保轮询中的 Agent 不会因一次 SSE 抖动被误判离线。
    const observedAt = Math.max(at, this.#activityExpiry(state));
    await this.#enterPending(
      actorId,
      state,
      at,
      observedAt,
      observedAt + this.#graceMs,
      'inferred',
      'disconnect',
    );
  }

  async #markRecoveredPending(actorId: string): Promise<void> {
    const state = await this.#getState(actorId);
    if (!state || state.phase !== 'online' || !state.generation_id) return;
    const at = this.#now();
    const observedAt = this.#activityExpiry(state);
    await this.#enterPending(
      actorId,
      state,
      at,
      observedAt,
      observedAt + this.#graceMs,
      'inferred',
      'recover',
    );
  }

  async #markStalePending(actorId: string, at: number): Promise<void> {
    // 排队期间可能已有新连接；仍以 hub 当前状态为准。
    if (this.#hasConnection?.(actorId)) return;
    const state = await this.#getState(actorId);
    if (!state || state.phase !== 'online' || !state.generation_id) return;
    const observedAt = this.#activityExpiry(state);
    if (observedAt > at) return;
    await this.#enterPending(
      actorId,
      state,
      at,
      observedAt,
      observedAt + this.#graceMs,
      'inferred',
      'stale',
    );
  }

  /** 最近活动 + TTL；last_seen 缺失时回退到上线/更新时间，不伪造新心跳。 */
  #activityExpiry(state: PresenceStateRow): number {
    const last = state.last_seen_at ?? state.online_at ?? state.updated_at;
    return last + this.#activityTtlMs;
  }

  /** online → pending 的唯一写入点；observedAt 同时是确认后的 occurred_at。 */
  async #enterPending(
    actorId: string,
    state: PresenceStateRow,
    at: number,
    observedAt: number,
    dueAt: number,
    timeBasis: TimeBasis,
    reason: 'disconnect' | 'recover' | 'stale',
  ): Promise<void> {
    if (!state.generation_id) return;
    const generationId = state.generation_id;
    const rooms = await this.#eligibleRooms(actorId);
    const requestId = `presence:${generationId}:${reason}:${state.revision}`;
    const payload = {
      actorId,
      generationId,
      revision: state.revision,
      observedAt,
      dueAt,
      timeBasis,
      rooms,
    };
    await this.#run(actorId, requestId, payload, () => [
      this.#db
        .prepare(
          guardSql(
            'presenceStale',
            `NOT EXISTS (
               SELECT 1 FROM agent_presence_state
                WHERE actor_id = ? AND revision = ? AND phase = 'online'
             )`,
          ),
        )
        .bind(actorId, state.revision),
      this.#db
        .prepare(
          `UPDATE agent_presence_state
              SET revision = revision + 1,
                  phase = 'pending_offline',
                  disconnect_observed_at = ?,
                  offline_due_at = ?,
                  time_basis = ?,
                  updated_at = ?
            WHERE actor_id = ? AND revision = ? AND phase = 'online'`,
        )
        .bind(observedAt, dueAt, timeBasis, at, actorId, state.revision),
      ...rooms.map((room) =>
        this.#db
          .prepare(
            `INSERT INTO presence_pending_rooms (generation_id, room_id) VALUES (?, ?)`,
          )
          .bind(generationId, room.room_id),
      ),
    ], at);
  }

  async #confirmDueOffline(actorId: string): Promise<void> {
    const state = await this.#getState(actorId);
    if (!state || state.phase !== 'pending_offline' || !state.generation_id) return;
    const at = this.#now();
    if (state.offline_due_at !== null && state.offline_due_at > at) return;
    await this.#confirmOffline(actorId, state, at);
  }

  async #confirmOffline(actorId: string, state: PresenceStateRow, at: number): Promise<void> {
    if (!state.generation_id) return;
    const generationId = state.generation_id;
    const occurredAt = state.disconnect_observed_at ?? at;
    const timeBasis = state.time_basis;
    const rooms = await this.#pendingEligibleRooms(generationId, actorId);
    const requestId = `presence:${generationId}:offline`;
    const payload = { actorId, generationId, transition: 'offline', occurredAt, timeBasis, rooms };
    await this.#run(actorId, requestId, payload, () => [
      this.#db
        .prepare(
          guardSql(
            'presenceStale',
            `NOT EXISTS (
               SELECT 1 FROM agent_presence_state
                WHERE actor_id = ? AND revision = ? AND phase = 'pending_offline'
             )`,
          ),
        )
        .bind(actorId, state.revision),
      this.#db
        .prepare(
          `UPDATE agent_presence_state
              SET revision = revision + 1,
                  phase = 'offline',
                  disconnect_observed_at = NULL,
                  offline_due_at = NULL,
                  time_basis = 'observed',
                  updated_at = ?
            WHERE actor_id = ? AND revision = ? AND phase = 'pending_offline'`,
        )
        .bind(at, actorId, state.revision),
      ...this.#transitionStatements(
        actorId,
        generationId,
        'offline',
        occurredAt,
        at,
        timeBasis,
        rooms,
      ),
      this.#db
        .prepare('DELETE FROM presence_pending_rooms WHERE generation_id = ?')
        .bind(generationId),
    ], at);
    if (rooms.length > 0) this.#notifyCommitted();
  }

  /**
   * 同事务写入每个 direct 房间的 presence 行、房间通知事件与 outbox。
   * events 只用于通知与 timeline_seq；不更新 rooms.head_seq / last_message_id。
   */
  #transitionStatements(
    agentId: string,
    generationId: string,
    transition: Transition,
    occurredAt: number,
    recordedAt: number,
    timeBasis: TimeBasis,
    rooms: RoomRow[],
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    for (const room of rooms) {
      const presenceEventId = newId('pev');
      const eventKey = `presence:${generationId}:${transition}:${room.room_id}`;
      statements.push(
        eventStatement(
          this.#db,
          {
            eventKey,
            scopeKind: 'room',
            scopeId: room.room_id,
            eventType: 'agent_presence_changed',
            refId: presenceEventId,
            metadata: {
              agent_id: agentId,
              presence_event_id: presenceEventId,
              generation_id: generationId,
              transition,
              occurred_at: occurredAt,
              recorded_at: recordedAt,
              time_basis: timeBasis,
            },
          },
          recordedAt,
        ),
        this.#db
          .prepare(
            `INSERT INTO room_presence_events
               (presence_event_id, room_id, agent_id, generation_id, transition,
                occurred_at, recorded_at, timeline_seq, time_basis)
             VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT event_seq FROM events WHERE event_key = ?), ?)`,
          )
          .bind(
            presenceEventId,
            room.room_id,
            agentId,
            generationId,
            transition,
            occurredAt,
            recordedAt,
            eventKey,
            timeBasis,
          ),
        outboxStatement(this.#db, { topic: roomTopic(room.room_id), eventKey }, recordedAt),
      );
    }
    return statements;
  }

  async #eligibleRooms(agentId: string): Promise<RoomRow[]> {
    const rows = await this.#db
      .prepare(
        `SELECT r.room_id
           FROM rooms r
           JOIN room_members am
             ON am.room_id = r.room_id AND am.actor_id = ? AND am.status = 'active'
           JOIN actors aa ON aa.actor_id = am.actor_id AND aa.kind = 'agent'
          WHERE r.kind = 'direct'
            AND EXISTS (
              SELECT 1
                FROM room_members hm JOIN actors ha ON ha.actor_id = hm.actor_id
               WHERE hm.room_id = r.room_id
                 AND hm.actor_id <> ?
                 AND hm.status = 'active'
                 AND ha.kind = 'human'
            )
          ORDER BY r.room_id`,
      )
      .bind(agentId, agentId)
      .all<RoomRow>();
    return rows.results;
  }

  async #pendingEligibleRooms(generationId: string, agentId: string): Promise<RoomRow[]> {
    const rows = await this.#db
      .prepare(
        `SELECT p.room_id
           FROM presence_pending_rooms p
           JOIN rooms r ON r.room_id = p.room_id AND r.kind = 'direct'
           JOIN room_members am
             ON am.room_id = p.room_id AND am.actor_id = ? AND am.status = 'active'
           JOIN actors aa ON aa.actor_id = am.actor_id AND aa.kind = 'agent'
          WHERE p.generation_id = ?
            AND EXISTS (
              SELECT 1
                FROM room_members hm JOIN actors ha ON ha.actor_id = hm.actor_id
               WHERE hm.room_id = p.room_id
                 AND hm.actor_id <> ?
                 AND hm.status = 'active'
                 AND ha.kind = 'human'
            )
          ORDER BY p.room_id`,
      )
      .bind(agentId, generationId, agentId)
      .all<RoomRow>();
    return rows.results;
  }

  async #getState(actorId: string): Promise<PresenceStateRow | null> {
    return this.#db
      .prepare('SELECT * FROM agent_presence_state WHERE actor_id = ?')
      .bind(actorId)
      .first<PresenceStateRow>();
  }

  /** 通知通道是旁路：失败只记录，不能回滚或阻塞已经提交的状态转换。 */
  #notifyCommitted(): void {
    if (!this.#onPresenceCommitted) return;
    try {
      this.#onPresenceCommitted();
    } catch (error) {
      this.#onError(error);
    }
  }

  /** 所有状态转换统一经过 runIdempotent；batch 首条固定为 operations。 */
  async #run(
    actorId: string,
    requestId: string,
    payload: Record<string, unknown>,
    build: (resultJson: string) => D1PreparedStatement[],
    at: number,
  ): Promise<void> {
    const payloadHash = await sha256Hex(stableStringify(payload));
    await runIdempotent(this.#db, {
      actorId,
      requestId,
      payloadHash,
      result: { ok: true },
      build: (resultJson) => [
        operationsStatement(this.#db, actorId, requestId, payloadHash, resultJson, at),
        ...build(resultJson),
      ],
    });
  }
}
