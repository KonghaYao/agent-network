/**
 * Task Focus Watch 中心。
 *
 * 单行 `focus_scan_state` 是唯一的已提交事件游标；一次扫描读取固定批大小，
 * 候选插入与游标推进在同一 batch 提交。只有完全没有开启中绑定时才把游标
 * 直接推到当前最大 event_seq（避免空扫历史）。provisioning 绑定只入队候选，
 * 不派模型；active 后才由 `ensureJobs` 组批。
 */

import { LIMITS } from '../contracts/limits';
import { historyBoundary, visibleMessage } from '../domain/room-history';
import type { RoomMemberRow, RoomRow } from '../storage/rows';
import { nowMs } from '../storage/db';
import type { Env } from '../env';
import type { FocusCandidateRow } from '../domain/focus/types';
import { ensureJobs } from './jobs';

const WATCH_EVENT_TYPES = [
  'message_created',
  'delivery_claimed',
  'delivery_progress',
  'delivery_completed',
  'delivery_failed',
] as const;

const WATCH_EVENT_SQL = WATCH_EVENT_TYPES.map((type) => `'${type}'`).join(', ');
const ENABLED_BINDING_SQL = "status IN ('provisioning', 'active')";

/** D1 语句的绑定参数上限是 100；IN 查询留出固定参数余量。 */
const MAX_IN_IDS = 90;

interface ScanEventRow {
  event_seq: number;
  scope_id: string;
  event_type: string;
  ref_id: string | null;
  metadata: string;
}

interface ScanMessageRow {
  message_id: string;
  room_id: string;
  created_seq: number;
  body_bytes: number;
}

export interface FocusScanResult {
  cursor: number;
  candidates: number;
  more: boolean;
}

const runningScans = new WeakMap<Env, Promise<FocusScanResult>>();

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += MAX_IN_IDS) {
    result.push(items.slice(index, index + MAX_IN_IDS));
  }
  return result;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function readMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * outbox 唤醒入口：异步、单飞、失败只记固定分类。
 *
 * 调用点在 `drainOutbox` 取得 claimed 之后、`fanoutStreamItems` 之前；唤醒
 * 失败不影响本次 outbox 发布，下一次唤醒或 60s 维护会补扫。
 */
export function wakeFocusWatch(
  env: Env,
  claimed: ReadonlyArray<{ event_type?: string }>,
): void {
  if (claimed.length === 0) return;
  void scanFocusEvents(env).catch(() => {
    console.error('agent-network focus watch failed: scan_unavailable');
  });
}

/** 同一 Env 上单飞；重复唤醒复用进行中的扫描。 */
export function scanFocusEvents(env: Env): Promise<FocusScanResult> {
  const active = runningScans.get(env);
  if (active) return active;
  const run = runScan(env).finally(() => {
    if (runningScans.get(env) === run) runningScans.delete(env);
  });
  runningScans.set(env, run);
  return run;
}

async function advanceWithoutBindings(env: Env): Promise<FocusScanResult> {
  const at = nowMs();
  await env.DB.prepare(
    `UPDATE focus_scan_state
        SET event_seq = (SELECT COALESCE(MAX(event_seq), 0) FROM events), last_scan_at = ?
      WHERE id = 1`,
  )
    .bind(at)
    .run();
  const row = await env.DB.prepare('SELECT event_seq FROM focus_scan_state WHERE id = 1')
    .first<{ event_seq: number }>();
  return { cursor: row?.event_seq ?? 0, candidates: 0, more: false };
}

async function runScan(env: Env): Promise<FocusScanResult> {
  const db = env.DB;
  const state = await db
    .prepare('SELECT event_seq FROM focus_scan_state WHERE id = 1')
    .first<{ event_seq: number }>();
  let cursor = state?.event_seq ?? 0;

  const bindings = await db
    .prepare(`SELECT owner_actor_id FROM focus_bindings WHERE ${ENABLED_BINDING_SQL}`)
    .all<{ owner_actor_id: string }>();
  if (bindings.results.length === 0) return advanceWithoutBindings(env);

  const owners = bindings.results.map((row) => row.owner_actor_id);
  const ownerSet = new Set(owners);
  let candidateCount = 0;
  let more = false;

  for (let round = 0; round < LIMITS.focusScanBatchesMax; round += 1) {
    const events = await db
      .prepare(
        `SELECT event_seq, scope_id, event_type, ref_id, metadata
           FROM events
          WHERE scope_kind = 'room' AND event_type IN (${WATCH_EVENT_SQL})
            AND event_seq > ?
          ORDER BY event_seq
          LIMIT ?`,
      )
      .bind(cursor, LIMITS.focusScanBatchMax + 1)
      .all<ScanEventRow>();
    more = events.results.length > LIMITS.focusScanBatchMax;
    const batch = events.results.slice(0, LIMITS.focusScanBatchMax);
    if (batch.length === 0) break;

    const roomIds = [...new Set(batch.map((event) => event.scope_id))];
    const messageIds = new Set<string>();
    for (const event of batch) {
      const metadata = readMetadata(event.metadata);
      const messageId =
        stringField(metadata, 'message_id') ??
        (event.event_type === 'message_created' ? event.ref_id : null);
      if (messageId) messageIds.add(messageId);
    }

    const rooms = new Map<string, RoomRow>();
    for (const ids of chunks(roomIds)) {
      const rows = await db
        .prepare(`SELECT * FROM rooms WHERE room_id IN (${placeholders(ids.length)})`)
        .bind(...ids)
        .all<RoomRow>();
      for (const room of rows.results) rooms.set(room.room_id, room);
    }

    const members = new Map<string, RoomMemberRow>();
    for (const ids of chunks(roomIds)) {
      for (const ownerChunk of chunks(owners)) {
        const rows = await db
          .prepare(
            `SELECT * FROM room_members
              WHERE status = 'active'
                AND room_id IN (${placeholders(ids.length)})
                AND actor_id IN (${placeholders(ownerChunk.length)})`,
          )
          .bind(...ids, ...ownerChunk)
          .all<RoomMemberRow>();
        for (const member of rows.results) {
          members.set(`${member.room_id}|${member.actor_id}`, member);
        }
      }
    }

    const messages = new Map<string, ScanMessageRow>();
    const messageList = [...messageIds];
    for (const ids of chunks(messageList)) {
      const rows = await db
        .prepare(
          `SELECT message_id, room_id, created_seq, body_bytes
             FROM messages WHERE message_id IN (${placeholders(ids.length)})`,
        )
        .bind(...ids)
        .all<ScanMessageRow>();
      for (const message of rows.results) messages.set(message.message_id, message);
    }

    const statements: D1PreparedStatement[] = [];
    const at = nowMs();
    const bindingRows = await db
      .prepare(
        `SELECT owner_actor_id, event_from_seq FROM focus_bindings WHERE ${ENABLED_BINDING_SQL}`,
      )
      .all<{ owner_actor_id: string; event_from_seq: number }>();
    for (const binding of bindingRows.results) {
      if (!ownerSet.has(binding.owner_actor_id)) continue;
      for (const event of batch) {
        if (event.event_seq <= binding.event_from_seq) continue;
        const room = rooms.get(event.scope_id);
        if (!room) continue;
        const member = members.get(`${room.room_id}|${binding.owner_actor_id}`);
        if (!member || member.status !== 'active') continue;
        const metadata = readMetadata(event.metadata);
        const messageId =
          stringField(metadata, 'message_id') ??
          (event.event_type === 'message_created' ? event.ref_id : null);
        if (!messageId) continue;
        const message = messages.get(messageId);
        if (!message || message.room_id !== room.room_id || message.body_bytes <= 0) continue;
        if (!visibleMessage(message, historyBoundary(room, member))) continue;

        const isMessage = event.event_type === 'message_created';
        const deliveryId = isMessage
          ? null
          : (stringField(metadata, 'delivery_id') ?? event.ref_id);
        if (!isMessage && !deliveryId) continue;
        const sourceKey = isMessage ? `message:${message.message_id}` : `delivery:${deliveryId}`;
        const candidate: FocusCandidateRow['source_kind'] = isMessage ? 'message' : 'delivery';
        statements.push(
          db
            .prepare(
              `INSERT INTO focus_candidates
                 (candidate_id, owner_actor_id, job_id, source_kind, event_seq, room_id,
                  message_id, delivery_id, source_key, reason, state, decision,
                  created_at, updated_at)
               VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
               ON CONFLICT(owner_actor_id, event_seq, source_key) DO NOTHING`,
            )
            .bind(
              crypto.randomUUID().replace(/^/u, 'fcand_'),
              binding.owner_actor_id,
              candidate,
              event.event_seq,
              room.room_id,
              message.message_id,
              deliveryId,
              sourceKey,
              isMessage ? 'room_message' : 'delivery_update',
              at,
              at,
            ),
        );
      }
    }

    const lastEvent = batch.at(-1);
    if (!lastEvent) break;
    const nextCursor = lastEvent.event_seq;
    statements.push(
      db
        .prepare(
          `UPDATE focus_scan_state SET event_seq = ?, last_scan_at = ?
            WHERE id = 1 AND event_seq = ?`,
        )
        .bind(nextCursor, at, cursor),
    );
    await db.batch(statements);
    candidateCount += statements.length - 1;
    cursor = nextCursor;
    if (!more) break;
  }

  if (bindings.results.length > 0) await ensureJobs(env);
  return { cursor, candidates: candidateCount, more };
}
