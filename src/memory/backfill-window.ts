/**
 * 定时回填的窗口数学与 keyset 扫描。
 *
 * 窗口按整点对齐：`to = floor(now / W) * W`、`from = to - W`。扫描只读消息头
 * （rowid/message 定位与时间），正文按条读取；不依赖任何新索引或迁移。
 */
import type { D1Like } from '../storage/queries';

export interface BackfillWindow {
  from: number;
  to: number;
}

export interface MessageScanRow {
  rowid: number;
  message_id: string;
  room_id: string;
  sender_id: string;
  created_seq: number;
  created_at: number;
  body_bytes: number;
}

export interface BackfillRoomRow {
  room_id: string;
  kind: 'direct' | 'group';
  policy_revision: number;
  member_history_policy: 'full' | 'from_join';
  dissolved_at: number | null;
  archive_head_seq: number | null;
}

export interface BackfillMemberRow {
  actor_id: string;
  role: 'owner' | 'member';
  status: 'active' | 'left' | 'removed';
  joined_seq: number;
  joined_at: number;
  member_generation: number;
}

export interface BackfillFanoutRow {
  actor_id: string;
  member_generation: number;
  joined_seq: number;
  joined_at: number;
  space_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
  capture: 'none' | 'pending' | 'extracted' | 'excluded';
}

export interface BackfillWindowPlan {
  windows: BackfillWindow[];
  skippedWindows: number;
  currentTo: number;
}

export function createBackfillWindow(now: number, windowMs: number): BackfillWindow {
  const to = Math.floor(now / windowMs) * windowMs;
  return { from: to - windowMs, to };
}

/**
 * 从已提交水位推进到当前整点窗口。
 *
 * 无水位时只处理最近一个窗口；水位落后时按窗口顺序补偿，超过上限的旧窗口
 * 显式跳过（返回 `skippedWindows`），不静默假装已覆盖。
 */
export function planBackfillWindows(input: {
  watermark: number | null;
  now: number;
  windowMs: number;
  maxCatchupWindows: number;
}): BackfillWindowPlan {
  const current = createBackfillWindow(input.now, input.windowMs);
  const windowMs = input.windowMs;
  const maxCatchup = Math.max(1, input.maxCatchupWindows);
  if (input.watermark === null) {
    return { windows: [current], skippedWindows: 0, currentTo: current.to };
  }
  if (input.watermark >= current.to) {
    return { windows: [], skippedWindows: 0, currentTo: current.to };
  }
  const missed = Math.floor((current.to - input.watermark) / windowMs);
  const covered = Math.min(missed, maxCatchup);
  const start = current.to - covered * windowMs;
  const windows: BackfillWindow[] = [];
  for (let to = start + windowMs; to <= current.to; to += windowMs) {
    windows.push({ from: to - windowMs, to });
  }
  return {
    windows,
    skippedWindows: missed - covered,
    currentTo: current.to,
  };
}

export interface BackfillReplayPlan extends BackfillWindowPlan {
  /** 本轮未处理、可由下一轮继续的小时窗口数；0 表示已到达重放上界。 */
  remainingWindows: number;
}

/**
 * 一次性重放：从水位（或显式起点）按窗口**向前**推进，而不是只看最近 N 个窗口。
 *
 * 常规调度在落后超过 `maxCatchupWindows` 时只补最近 N 个窗口；如果一次性重放
 * 用大窗口直接把水位推到过去的粗边界，`watermark` 与最近 24h 之间的区间会被
 * 永久跳过。重放路径必须保持 1h 窗口并逐轮向前，直到 `until`。
 */
export function planBackfillReplayWindows(input: {
  watermark: number | null;
  from: number;
  until: number;
  windowMs: number;
  maxWindows: number;
}): BackfillReplayPlan {
  const windowMs = Math.max(1, input.windowMs);
  const maxWindows = Math.max(1, input.maxWindows);
  const alignedFrom = Math.floor(input.from / windowMs) * windowMs;
  const until = Math.floor(input.until / windowMs) * windowMs;
  const alignedWatermark =
    input.watermark === null ? alignedFrom : Math.floor(input.watermark / windowMs) * windowMs;
  const start = Math.max(alignedFrom, alignedWatermark);
  if (start >= until) {
    return { windows: [], skippedWindows: 0, currentTo: until, remainingWindows: 0 };
  }
  const total = Math.floor((until - start) / windowMs);
  const covered = Math.min(total, maxWindows);
  const windows: BackfillWindow[] = [];
  for (let index = 0; index < covered; index += 1) {
    const from = start + index * windowMs;
    windows.push({ from, to: from + windowMs });
  }
  return {
    windows,
    skippedWindows: 0,
    currentTo: until,
    remainingWindows: total - covered,
  };
}

export async function readInstanceCaptureDefault(
  db: D1Like,
  instanceId: string,
): Promise<'enabled' | 'disabled' | null> {
  const row = await db
    .prepare('SELECT capture_default FROM memory_instances WHERE instance_id = ?')
    .bind(instanceId)
    .first<{ capture_default: 'enabled' | 'disabled' }>();
  return row?.capture_default ?? null;
}

export async function scanMessagePage(
  db: D1Like,
  input: { afterRowid: number; limit: number },
): Promise<MessageScanRow[]> {
  const result = await db
    .prepare(
      `SELECT rowid AS rowid, message_id, room_id, sender_id, created_seq, created_at, body_bytes
         FROM messages
        WHERE rowid > ?
        ORDER BY rowid
        LIMIT ?`,
    )
    .bind(input.afterRowid, input.limit)
    .all<MessageScanRow>();
  return result.results;
}

export async function readMessageBody(db: D1Like, messageId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT body FROM messages WHERE message_id = ?')
    .bind(messageId)
    .first<{ body: string }>();
  return row?.body ?? null;
}

export async function readBackfillRoom(
  db: D1Like,
  roomId: string,
): Promise<BackfillRoomRow | null> {
  return db
    .prepare(
      `SELECT room_id, kind, policy_revision, member_history_policy, dissolved_at, archive_head_seq
         FROM rooms WHERE room_id = ?`,
    )
    .bind(roomId)
    .first<BackfillRoomRow>();
}

export async function readRoomMember(
  db: D1Like,
  roomId: string,
  actorId: string,
): Promise<BackfillMemberRow | null> {
  return db
    .prepare(
      `SELECT actor_id, role, status, joined_seq, joined_at, member_generation
         FROM room_members WHERE room_id = ? AND actor_id = ?`,
    )
    .bind(roomId, actorId)
    .first<BackfillMemberRow>();
}

/**
 * 房间内 active Agent 成员 × active space 的扇出。
 *
 * 只枚举 capture 允许的 space；权限判定仍由 `authorizeSourceRead` 完成。
 */
export async function listBackfillFanout(
  db: D1Like,
  input: { roomId: string; instanceId: string },
): Promise<BackfillFanoutRow[]> {
  const result = await db
    .prepare(
      `SELECT rm.actor_id, rm.member_generation, rm.joined_seq, rm.joined_at,
              s.space_id, s.ownership_epoch, s.backend_binding_epoch, s.capture
         FROM room_members rm
         JOIN actors a ON a.actor_id = rm.actor_id
         JOIN memory_spaces s ON s.agent_actor_id = rm.actor_id
        WHERE rm.room_id = ?
          AND rm.status = 'active'
          AND a.kind = 'agent'
          AND a.disabled_at IS NULL
          AND s.instance_id = ?
          AND s.active = 1
          AND s.capture IN ('pending', 'extracted')
        ORDER BY rm.actor_id`,
    )
    .bind(input.roomId, input.instanceId)
    .all<BackfillFanoutRow>();
  return result.results;
}

/** 区分“没有可用 Agent”与“有 Agent 但未启用/排除记忆空间”。 */
export async function countBackfillCandidates(
  db: D1Like,
  input: { roomId: string; instanceId: string },
): Promise<{ agents: number; spaces: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*)
            FROM room_members rm
            JOIN actors a ON a.actor_id = rm.actor_id
           WHERE rm.room_id = ? AND rm.status = 'active'
             AND a.kind = 'agent' AND a.disabled_at IS NULL) AS agents,
         (SELECT COUNT(*)
            FROM room_members rm
            JOIN actors a ON a.actor_id = rm.actor_id
            JOIN memory_spaces s ON s.agent_actor_id = rm.actor_id
           WHERE rm.room_id = ? AND rm.status = 'active'
             AND a.kind = 'agent' AND a.disabled_at IS NULL
             AND s.instance_id = ? AND s.active = 1
             AND s.capture IN ('pending', 'extracted')) AS spaces`,
    )
    .bind(input.roomId, input.roomId, input.instanceId)
    .first<{ agents: number; spaces: number }>();
  return { agents: row?.agents ?? 0, spaces: row?.spaces ?? 0 };
}
