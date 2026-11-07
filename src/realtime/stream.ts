import { LIMITS } from '../contracts/limits';
import { DELIVERY_REMINDER_EVENT, DELIVERY_REMINDER_SOURCE } from '../contracts/events';
import type { Env } from '../env';
import { utf8Bytes } from '../storage/db';
import type { ActorRow } from '../storage/rows';

/**
 * 统一 actor stream 的事件信封与 fan-out。
 *
 * outbox 仍是唯一的事件来源；本模块只把 `events` 行映射为可定位的
 * stream item，并按 active membership 解析 recipient。这里不写
 * per-actor outbox / events，也不引入新的可重放游标。
 */

export const STREAM_URI = 'agentnet://stream';
export const STREAM_EVENT_META_KEY = 'io.agent-network/event';
export const STREAM_VERSION = 1;
/** 为传输层的 more/dropped 合并预留的字节数，保证信封始终不超过 hintBytes。 */
const STREAM_FRAME_HEADROOM_BYTES = 64;

export type StreamAttention = 'action_required' | 'informational';

export interface StreamItem {
  event_id: string;
  seq: string;
  source: string;
  kind: string;
  attention: StreamAttention;
  room_id?: string;
  message_id?: string;
  delivery_id?: string;
  sender_id?: string;
  state?: string;
  attempt?: number;
  /** 提醒事件对应的最近一次 progress 更新时间。 */
  progress_at?: string;
  change?: string;
  subject_id?: string;
  changed_by?: string;
  /** 房间文件事件的 file_id 与 room_file_id。 */
  file_id?: string;
  ref_id?: string;
  /** Agent 上下线通知：仅用于当前房间刷新，不产生未读。 */
  presence_event_id?: string;
  transition?: string;
  pending_count?: number;
  inbox_head_seq?: string;
  created_at?: string;
}

export interface StreamFrame {
  v: number;
  actor_id: string;
  seq: string;
  attention: StreamAttention;
  items: StreamItem[];
  more: boolean;
  dropped: number;
}

export interface OutboxStreamRow {
  outbox_id: string;
  topic: string;
  event_seq: number;
  attempts: number;
  created_at: number;
  scope_kind: 'room' | 'inbox' | 'actor';
  scope_id: string;
  event_type: string;
  ref_id: string | null;
  metadata: string;
}

interface RoomMemberRow {
  actor_id: string;
  kind: 'human' | 'agent';
  status: 'active' | 'left' | 'removed';
  role: 'owner' | 'member';
  joined_seq: number;
}

export interface FanoutStats {
  streamActors: number;
  streamFrames: number;
  streamItems: number;
  streamDropped: number;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function baseItem(
  row: OutboxStreamRow,
  source: string,
  kind: string,
  attention: StreamAttention,
): StreamItem {
  return {
    event_id: String(row.event_seq),
    seq: String(row.event_seq),
    source,
    kind,
    attention,
    created_at: String(row.created_at),
  };
}

function withLocation(
  item: StreamItem,
  row: OutboxStreamRow,
  metadata: Record<string, unknown>,
): StreamItem {
  const roomId = stringField(metadata, 'room_id') ?? (row.scope_kind === 'room' ? row.scope_id : undefined);
  const messageId = stringField(metadata, 'message_id') ?? (row.event_type === 'message_created' ? row.ref_id ?? undefined : undefined);
  const senderId = stringField(metadata, 'sender_id');
  if (roomId) item.room_id = roomId;
  if (messageId) item.message_id = messageId;
  if (senderId) item.sender_id = senderId;
  return item;
}

function activeRecipients(
  members: RoomMemberRow[],
  eventSeq: number,
): RoomMemberRow[] {
  return members.filter((member) => member.status === 'active' && member.joined_seq <= eventSeq);
}

function addItem(
  target: Map<string, StreamItem[]>,
  actorId: string,
  item: StreamItem,
): void {
  const items = target.get(actorId);
  if (items) items.push(item);
  else target.set(actorId, [item]);
}

function deliverySource(eventType: string): {
  source: string;
  kind: string;
} {
  switch (eventType) {
    case 'delivery_claimed':
    case 'delivery_progress':
    case 'delivery_completed':
    case 'delivery_failed':
      return { source: 'delivery.updated', kind: 'receipt' };
    case 'delivery_cancelled':
      return { source: 'delivery.cancelled', kind: 'receipt' };
    case 'delivery_retried':
      return { source: 'delivery.retried', kind: 'task' };
    default:
      return { source: 'unknown', kind: 'raw' };
  }
}

function deliveryAttention(
  eventType: string,
  viewerId: string | undefined,
  senderId: string | undefined,
): StreamAttention {
  if (eventType === 'delivery_completed' || eventType === 'delivery_failed') {
    return viewerId !== undefined && viewerId === senderId
      ? 'action_required'
      : 'informational';
  }
  return 'informational';
}

function roomStreamItems(
  row: OutboxStreamRow,
  metadata: Record<string, unknown>,
  members: RoomMemberRow[],
): Array<{ actorId: string; item: StreamItem }> {
  const eventSeq = row.event_seq;
  const result: Array<{ actorId: string; item: StreamItem }> = [];

  switch (row.event_type) {
    case 'message_created': {
      const senderId = stringField(metadata, 'sender_id');
      for (const member of activeRecipients(members, eventSeq)) {
        if (member.actor_id === senderId) continue;
        const item = withLocation(
          baseItem(row, 'room.message', 'message', 'informational'),
          row,
          metadata,
        );
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    case 'delivery_claimed':
    case 'delivery_progress':
    case 'delivery_completed':
    case 'delivery_failed':
    case 'delivery_cancelled':
    case 'delivery_retried': {
      const { source, kind } = deliverySource(row.event_type);
      const operator = stringField(metadata, 'actor_id');
      const recipientId = stringField(metadata, 'recipient_id');
      const senderId = stringField(metadata, 'sender_id');
      const state = stringField(metadata, 'state');
      const attempt = numberField(metadata, 'attempt');
      for (const member of activeRecipients(members, eventSeq)) {
        if (member.actor_id === operator) continue;
        // cancelled/retried 的 recipient 由 inbox item 覆盖，避免重复。
        if (
          (row.event_type === 'delivery_cancelled' || row.event_type === 'delivery_retried') &&
          member.actor_id === recipientId
        ) {
          continue;
        }
        const item = withLocation(
          baseItem(
            row,
            source,
            kind,
            deliveryAttention(row.event_type, member.actor_id, senderId),
          ),
          row,
          metadata,
        );
        item.delivery_id = row.ref_id ?? stringField(metadata, 'delivery_id');
        if (state) item.state = state;
        if (attempt !== undefined) item.attempt = attempt;
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    case 'members_changed': {
      const add = stringArrayField(metadata, 'add');
      const remove = stringArrayField(metadata, 'remove');
      const changedBy = stringField(metadata, 'changed_by');
      const transferOwnerTo = stringField(metadata, 'transfer_owner_to');
      const seen = new Set<string>();
      for (const member of activeRecipients(members, eventSeq)) {
        const change = add.includes(member.actor_id)
          ? 'added'
          : transferOwnerTo === member.actor_id
            ? 'owner_changed'
            : 'members_updated';
        const item = withLocation(
          baseItem(row, 'room.membership', 'room', 'informational'),
          row,
          metadata,
        );
        item.change = change;
        if (change === 'added' || change === 'owner_changed') item.subject_id = member.actor_id;
        if (changedBy) item.changed_by = changedBy;
        result.push({ actorId: member.actor_id, item });
        seen.add(member.actor_id);
      }
      for (const actorId of remove) {
        if (seen.has(actorId)) continue;
        const item = withLocation(
          baseItem(row, 'room.membership', 'room', 'action_required'),
          row,
          metadata,
        );
        item.change = 'removed';
        item.subject_id = actorId;
        if (changedBy) item.changed_by = changedBy;
        result.push({ actorId, item });
      }
      return result;
    }
    case 'member_left': {
      const leaver = stringField(metadata, 'changed_by') ?? row.ref_id ?? undefined;
      for (const member of activeRecipients(members, eventSeq)) {
        if (member.actor_id === leaver) continue;
        const item = withLocation(
          baseItem(row, 'room.membership', 'room', 'informational'),
          row,
          metadata,
        );
        item.change = 'members_updated';
        if (leaver) item.changed_by = leaver;
        result.push({ actorId: member.actor_id, item });
      }
      if (leaver) {
        const item = withLocation(
          baseItem(row, 'room.membership', 'room', 'informational'),
          row,
          metadata,
        );
        item.change = 'left';
        item.subject_id = leaver;
        item.changed_by = leaver;
        result.push({ actorId: leaver, item });
      }
      return result;
    }
    case 'room_role_changed':
    case 'owner_transferred': {
      // 角色变更只刷新成员/能力视图；被撤销管理员本人收到 action_required。
      const target = stringField(metadata, 'target_actor_id')
        ?? stringField(metadata, 'new_owner_id')
        ?? row.ref_id
        ?? undefined;
      const changedBy = stringField(metadata, 'changed_by');
      const change = row.event_type === 'owner_transferred'
        ? 'owner_changed'
        : 'role_changed';
      for (const member of activeRecipients(members, eventSeq)) {
        const demotedSelf = change === 'role_changed' &&
          target === member.actor_id &&
          stringField(metadata, 'new_role') === 'member';
        const item = withLocation(
          baseItem(row, 'room.membership', 'room', demotedSelf ? 'action_required' : 'informational'),
          row,
          metadata,
        );
        item.change = change;
        if (target) item.subject_id = target;
        if (changedBy) item.changed_by = changedBy;
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    case 'room_policy_changed':
    case 'room_announcement_updated': {
      // 策略与公告变化只影响群管理视图；不推进 head、不产生未读。
      const change = row.event_type === 'room_policy_changed'
        ? 'policy_updated'
        : 'announcement_updated';
      const changedBy = stringField(metadata, 'changed_by');
      for (const member of activeRecipients(members, eventSeq)) {
        const item = withLocation(
          baseItem(row, 'room.membership', 'room', 'informational'),
          row,
          metadata,
        );
        item.change = change;
        if (changedBy) item.changed_by = changedBy;
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    case 'room_created': {
      for (const member of activeRecipients(members, eventSeq)) {
        result.push({
          actorId: member.actor_id,
          item: withLocation(
            baseItem(row, 'room.created', 'room', 'informational'),
            row,
            metadata,
          ),
        });
      }
      return result;
    }
    case 'room_file_added':
    case 'room_file_deleted': {
      // 文件事件只是让客户端刷新列表，不创建 delivery、不推进 head_seq。
      const fileId = stringField(metadata, 'file_id');
      for (const member of activeRecipients(members, eventSeq)) {
        const item = withLocation(
          baseItem(row, 'room.file', 'file', 'informational'),
          row,
          metadata,
        );
        if (fileId) item.file_id = fileId;
        if (row.ref_id) item.ref_id = row.ref_id;
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    case 'room_task_added':
    case 'room_task_claimed':
    case 'room_task_completed':
    case 'room_task_failed':
    case 'room_task_updated':
    case 'room_task_deleted': {
      // 任务只通知 active human 刷新视图；Agent 不收到任务提示，也不会被唤醒。
      const change = row.event_type.replace('room_task_', '');
      const changedBy = stringField(metadata, 'changed_by');
      const taskId = stringField(metadata, 'task_id') ?? row.ref_id ?? undefined;
      for (const member of activeRecipients(members, eventSeq)) {
        if (member.kind !== 'human') continue;
        const item = withLocation(
          baseItem(row, 'room.tasks', 'tasks', 'informational'),
          row,
          metadata,
        );
        item.change = change;
        if (taskId) item.ref_id = taskId;
        if (changedBy) item.changed_by = changedBy;
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    case 'agent_presence_changed': {
      // 只通知 active human；Agent 成员不可见，也不写 inbox/未读。
      const agentId = stringField(metadata, 'agent_id');
      const transition = stringField(metadata, 'transition');
      const presenceEventId = stringField(metadata, 'presence_event_id');
      for (const member of activeRecipients(members, eventSeq)) {
        if (member.kind !== 'human') continue;
        const item = withLocation(
          baseItem(row, 'room.presence', 'presence', 'informational'),
          row,
          metadata,
        );
        if (agentId) item.subject_id = agentId;
        if (transition) item.transition = transition;
        if (presenceEventId) item.presence_event_id = presenceEventId;
        result.push({ actorId: member.actor_id, item });
      }
      return result;
    }
    default: {
      for (const member of activeRecipients(members, eventSeq)) {
        result.push({
          actorId: member.actor_id,
          item: withLocation(
            baseItem(row, 'unknown', 'raw', 'informational'),
            row,
            metadata,
          ),
        });
      }
      return result;
    }
  }
}

function inboxStreamItem(
  row: OutboxStreamRow,
  metadata: Record<string, unknown>,
): StreamItem | null {
  switch (row.event_type) {
    case 'room_created':
    case 'room_members_changed':
    case 'room_left':
      // 对应 room scope 事件已覆盖；保留 inbox 事件用于 pending/sync，不重复推送。
      return null;
    case 'delivery_created': {
      const item = withLocation(
        baseItem(row, 'delivery.created', 'task', 'action_required'),
        row,
        metadata,
      );
      item.delivery_id = row.ref_id ?? undefined;
      return item;
    }
    case 'delivery_cancelled':
    case 'delivery_retried': {
      // 取消与重试仍需要提示 recipient（包括 recipient 自己 retry 自恢复）；
      // 房间事件已跳过 recipient，这里不会再产生重复。
      const { source, kind } = deliverySource(row.event_type);
      const item = withLocation(baseItem(row, source, kind, 'action_required'), row, metadata);
      item.delivery_id = row.ref_id ?? undefined;
      item.state = row.event_type === 'delivery_retried' ? 'pending' : 'cancelled';
      const attempt = numberField(metadata, 'attempt');
      if (attempt !== undefined) item.attempt = attempt;
      return item;
    }
    case DELIVERY_REMINDER_EVENT: {
      // 提醒不是新待办：只唤醒 recipient 去 report/complete/fail，不改变 pending。
      const item = withLocation(
        baseItem(row, DELIVERY_REMINDER_SOURCE, 'reminder', 'action_required'),
        row,
        metadata,
      );
      item.delivery_id = row.ref_id ?? stringField(metadata, 'delivery_id');
      item.state = 'claimed';
      const attempt = numberField(metadata, 'attempt');
      if (attempt !== undefined) item.attempt = attempt;
      const progressAt = numberField(metadata, 'progress_at');
      if (progressAt !== undefined) item.progress_at = String(progressAt);
      return item;
    }
    case 'room_read':
      return withLocation(baseItem(row, 'room.read', 'read', 'informational'), row, metadata);
    case 'profile_updated':
      return withLocation(
        baseItem(row, 'profile.updated', 'profile', 'informational'),
        row,
        metadata,
      );
    case 'contact_request_pending':
    case 'contact_request_review':
    case 'contact_request_accepted':
    case 'contact_request_rejected':
    case 'contact_request_cancelled':
    case 'contact_request_expired':
    case 'contact_relation_ended': {
      // 好友申请与关系变化只提示刷新，不是待办：不产生 delivery，
      // attention 必须保持 informational，避免唤醒 Agent 执行任务。
      const item = withLocation(baseItem(row, 'contact', 'contact', 'informational'), row, metadata);
      item.ref_id = row.ref_id ?? undefined;
      return item;
    }
    default:
      return withLocation(baseItem(row, 'unknown', 'raw', 'informational'), row, metadata);
  }
}

/** 构造 `session.login` 帧；login 工具与重连补发共用。 */
export function buildSessionLoginFrame(actor: ActorRow, at = Date.now()): StreamFrame {
  const attention: StreamAttention = actor.pending_count > 0 ? 'action_required' : 'informational';
  const item: StreamItem = {
    event_id: `login:${actor.actor_id}:${at}`,
    seq: String(actor.inbox_head_seq),
    source: 'session.login',
    kind: 'session',
    attention,
    pending_count: actor.pending_count,
    inbox_head_seq: String(actor.inbox_head_seq),
    created_at: String(at),
  };
  return {
    v: STREAM_VERSION,
    actor_id: actor.actor_id,
    seq: String(actor.inbox_head_seq),
    attention,
    items: [item],
    more: false,
    dropped: 0,
  };
}

/** 构造单 actor 的批量帧；批量上限与 1 KiB 信封限制都在这里截断。 */
export function buildStreamFrame(actorId: string, items: StreamItem[]): StreamFrame | null {
  const sorted = [...items].sort((a, b) => Number(a.seq) - Number(b.seq));
  const selected: StreamItem[] = [];
  let truncated = false;
  for (const item of sorted) {
    if (selected.length >= LIMITS.streamBatchMax) {
      truncated = true;
      break;
    }
    const candidate: StreamFrame = {
      v: STREAM_VERSION,
      actor_id: actorId,
      seq: item.seq,
      attention: 'informational',
      items: [...selected, item],
      more: false,
      dropped: 0,
    };
    if (utf8Bytes(JSON.stringify(candidate)) > LIMITS.hintBytes - STREAM_FRAME_HEADROOM_BYTES) {
      truncated = true;
      break;
    }
    selected.push(item);
  }
  if (selected.length === 0) return null;
  const last = selected.at(-1) as StreamItem;
  return {
    v: STREAM_VERSION,
    actor_id: actorId,
    seq: last.seq,
    attention: selected.some((item) => item.attention === 'action_required')
      ? 'action_required'
      : 'informational',
    items: selected,
    more: truncated,
    dropped: truncated ? sorted.length - selected.length : 0,
  };
}

/**
 * 按 actor 批量扇出本次 drain 的事件。
 *
 * recipient 完全来自 DB 的 membership；客户端不能指定。成员被移除后
 * 不再收到该房间的普通事件，但会收到一条 `change:"removed"`。
 */
export async function fanoutStreamItems(
  db: D1Database,
  env: Env,
  rows: OutboxStreamRow[],
): Promise<FanoutStats> {
  const actorItems = new Map<string, StreamItem[]>();
  const roomMembers = new Map<string, RoomMemberRow[]>();
  const ordered = [...rows].sort((a, b) => a.event_seq - b.event_seq);

  const membersOf = async (roomId: string): Promise<RoomMemberRow[]> => {
    const cached = roomMembers.get(roomId);
    if (cached) return cached;
    const result = await db
      .prepare(
        `SELECT m.actor_id, m.status, m.role, m.joined_seq, a.kind
           FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
          WHERE m.room_id = ?`,
      )
      .bind(roomId)
      .all<RoomMemberRow>();
    roomMembers.set(roomId, result.results);
    return result.results;
  };

  for (const row of ordered) {
    const metadata = parseMetadata(row.metadata);
    if (row.scope_kind === 'inbox') {
      const item = inboxStreamItem(row, metadata);
      if (item) addItem(actorItems, row.scope_id, item);
      continue;
    }
    if (row.scope_kind === 'actor') {
      addItem(
        actorItems,
        row.scope_id,
        withLocation(baseItem(row, 'unknown', 'raw', 'informational'), row, metadata),
      );
      continue;
    }
    const members = await membersOf(row.scope_id);
    for (const { actorId, item } of roomStreamItems(row, metadata, members)) {
      addItem(actorItems, actorId, item);
    }
  }

  let streamItems = 0;
  let streamDropped = 0;
  let streamFrames = 0;
  for (const [actorId, items] of actorItems) {
    const frame = buildStreamFrame(actorId, items);
    if (!frame) continue;
    env.NOTIFICATION_HUB.publishActor(actorId, JSON.stringify(frame));
    streamFrames += 1;
    streamItems += frame.items.length;
    streamDropped += frame.dropped;
  }

  return {
    streamActors: actorItems.size,
    streamFrames,
    streamItems,
    streamDropped,
  };
}
