/**
 * 证据可读性重算与摘录。
 *
 * 证据只保存定位与用途；每次读取都按当前成员代次、历史边界、撤回状态与
 * delivery 详情权限重新取证。不可读时不返回 room_id / message_id / 摘录，
 * 调用方据此遮蔽卡面正文与来源计数。
 */

import type { FocusCounts, FocusEvidenceView } from '../../contracts/focus';
import { LIMITS } from '../../contracts/limits';
import type { RoomMemberRow, RoomRow } from '../../storage/rows';
import { historyBoundary, visibleMessage } from '../room-history';
import { truncateChars } from './helpers';
import type { FocusEvidenceRow } from './types';

/** D1 单条语句的绑定参数上限是 100；批量 IN 查询留出 owner 等固定参数余量。 */
const MAX_IN_IDS = 90;

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += MAX_IN_IDS) {
    result.push(items.slice(index, index + MAX_IN_IDS));
  }
  return result;
}

interface EvidenceMessageRow {
  message_id: string;
  room_id: string;
  body: string;
  body_bytes: number;
  created_seq: number;
}

interface EvidenceDeliveryRow {
  delivery_id: string;
  room_id: string;
  message_id: string;
}

export interface FocusEvidenceRead {
  readable: boolean;
  roomId?: string;
  messageId?: string;
  deliveryId?: string;
  excerpt?: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/**
 * 批量重算一页证据的可读性。
 *
 * 同一批只做 4 次 IN 查询；不逐条读房间/成员/消息，避免列表被证据数量放大。
 */
export async function resolveEvidenceReads(
  db: D1Database,
  owner: string,
  rows: FocusEvidenceRow[],
): Promise<Map<string, FocusEvidenceRead>> {
  const reads = new Map<string, FocusEvidenceRead>();
  if (rows.length === 0) return reads;

  const roomIds = [...new Set(rows.map((row) => row.room_id).filter((id): id is string => !!id))];
  const messageIds = [
    ...new Set(rows.map((row) => row.message_id).filter((id): id is string => !!id)),
  ];
  const deliveryIds = [
    ...new Set(rows.map((row) => row.delivery_id).filter((id): id is string => !!id)),
  ];

  const rooms = new Map<string, RoomRow>();
  for (const ids of chunks(roomIds)) {
    const result = await db
      .prepare(`SELECT * FROM rooms WHERE room_id IN (${placeholders(ids.length)})`)
      .bind(...ids)
      .all<RoomRow>();
    for (const room of result.results) rooms.set(room.room_id, room);
  }

  const members = new Map<string, RoomMemberRow>();
  for (const ids of chunks(roomIds)) {
    const result = await db
      .prepare(
        `SELECT * FROM room_members
          WHERE actor_id = ? AND room_id IN (${placeholders(ids.length)})`,
      )
      .bind(owner, ...ids)
      .all<RoomMemberRow>();
    for (const member of result.results) members.set(member.room_id, member);
  }

  const messages = new Map<string, EvidenceMessageRow>();
  for (const ids of chunks(messageIds)) {
    const result = await db
      .prepare(
        `SELECT message_id, room_id, body, body_bytes, created_seq
           FROM messages WHERE message_id IN (${placeholders(ids.length)})`,
      )
      .bind(...ids)
      .all<EvidenceMessageRow>();
    for (const message of result.results) messages.set(message.message_id, message);
  }

  const deliveries = new Map<string, EvidenceDeliveryRow>();
  for (const ids of chunks(deliveryIds)) {
    const result = await db
      .prepare(
        `SELECT delivery_id, room_id, message_id
           FROM deliveries WHERE delivery_id IN (${placeholders(ids.length)})`,
      )
      .bind(...ids)
      .all<EvidenceDeliveryRow>();
    for (const delivery of result.results) deliveries.set(delivery.delivery_id, delivery);
  }

  for (const row of rows) {
    const room = row.room_id ? rooms.get(row.room_id) : undefined;
    const member = row.room_id ? members.get(row.room_id) : undefined;
    if (!room || !member || member.status !== 'active') {
      reads.set(row.evidence_id, { readable: false });
      continue;
    }
    const message = row.message_id ? messages.get(row.message_id) : undefined;
    if (
      !message ||
      message.room_id !== room.room_id ||
      message.body_bytes <= 0 ||
      !visibleMessage(message, historyBoundary(room, member))
    ) {
      reads.set(row.evidence_id, { readable: false });
      continue;
    }
    if (row.source_kind === 'delivery') {
      const delivery = row.delivery_id ? deliveries.get(row.delivery_id) : undefined;
      // 卡主是人类、delivery 收件人是 Agent：可读性只由房间成员资格与消息可见性
      // 决定（林舟看回归 Agent 的交付即是核心样例），但仍要求 delivery 指向同一条
      // 消息，避免用过期的 delivery 定位到别的来源。
      if (!delivery || delivery.message_id !== message.message_id) {
        reads.set(row.evidence_id, { readable: false });
        continue;
      }
    }
    reads.set(row.evidence_id, {
      readable: true,
      roomId: room.room_id,
      messageId: message.message_id,
      ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
      excerpt: truncateChars(message.body, LIMITS.focusEvidenceExcerptChars),
    });
  }
  return reads;
}

/** 证据行 → 对外视图；不可读时只保留用途与 readable=false。 */
export function evidenceView(
  row: FocusEvidenceRow,
  read: FocusEvidenceRead | undefined,
): FocusEvidenceView {
  const readable = read?.readable === true;
  const view: FocusEvidenceView = {
    evidence_id: row.evidence_id,
    source_kind: row.source_kind,
    purpose: row.purpose,
    readable,
    occurred_at: String(row.occurred_at),
    revision: row.source_revision,
  };
  if (readable && read) {
    if (read.roomId) view.room_id = read.roomId;
    if (read.messageId) view.message_id = read.messageId;
    if (read.deliveryId) view.delivery_id = read.deliveryId;
    if (read.excerpt !== undefined) view.excerpt = read.excerpt;
  }
  return view;
}

interface CountableItemRow {
  item_id: string;
  column_key: 'needs_me' | 'tracking' | 'done';
  archived_at: number | null;
}

/**
 * 计数只包含「至少一条证据当前可读」的卡。
 *
 * 直接 COUNT 会把全部证据失权的隐藏卡也算进 needs_me/tracking/done，从而通过
 * 计数泄露已离开私群的事项数量；无证据卡同样不可见，因此也不计入。
 */
export async function focusVisibleCounts(
  db: D1Database,
  owner: string,
): Promise<FocusCounts> {
  const counts: FocusCounts = { needs_me: 0, tracking: 0, done: 0, archived: 0 };

  // 按 item 分页：每次只读取 ≤90 张卡与它们自己的证据，避免一次载入全部证据。
  let offset = 0;
  for (;;) {
    const page = await db
      .prepare(
        'SELECT item_id, column_key, archived_at FROM focus_items WHERE owner_actor_id = ? ORDER BY item_id LIMIT ? OFFSET ?',
      )
      .bind(owner, MAX_IN_IDS, offset)
      .all<CountableItemRow>();
    if (page.results.length === 0) break;
    const ids = page.results.map((item) => item.item_id);
    const evidence = await db
      .prepare(
        `SELECT * FROM focus_evidence
          WHERE owner_actor_id = ? AND item_id IN (${placeholders(ids.length)})`,
      )
      .bind(owner, ...ids)
      .all<FocusEvidenceRow>();
    const reads = await resolveEvidenceReads(db, owner, evidence.results);
    const visible = new Set<string>();
    for (const row of evidence.results) {
      if (reads.get(row.evidence_id)?.readable === true) visible.add(row.item_id);
    }
    for (const item of page.results) {
      if (!visible.has(item.item_id)) continue;
      if (item.archived_at !== null) counts.archived += 1;
      else counts[item.column_key] += 1;
    }
    offset += page.results.length;
    if (page.results.length < MAX_IN_IDS) break;
  }
  return counts;
}
