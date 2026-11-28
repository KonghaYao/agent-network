import type { ActorStreamEvent } from './actor-stream';
import type { HistoryItem } from './chat';

/**
 * 房间 SSE 事件到查询失效集合的映射。
 *
 * 从 `useRoomChat` 抽出，保持纯函数：信封已带 `source` / `kind` /
 * `room_id` / `message_id` / `change`，这里不解析正文。
 */
export interface PendingRefresh {
  rooms: boolean;
  detail: boolean;
  history: boolean;
  files: boolean;
  /** 个人看板变化：只失效 `['focus']`，与房间窗口无关。 */
  focus: boolean;
  contacts: boolean;
  contactBadge: boolean;
  /** 当前房间内需要按锚点重读的消息（回执等旧窗口项）。 */
  messageIds: Set<string>;
}

export function emptyPendingRefresh(): PendingRefresh {
  return {
    rooms: false,
    detail: false,
    history: false,
    files: false,
    focus: false,
    contacts: false,
    contactBadge: false,
    messageIds: new Set(),
  };
}

/**
 * 把单个 stream item 映射为最小失效集合。
 *
 * - 当前房间的消息、回执、成员/生命周期变化才失效 history 与 detail；
 * - 其他房间只失效侧栏列表，不碰当前房间历史；
 * - 文件单独失效，避免 `['room', id]` 前缀把 history 一并命中；
 * - `room.read` 是本地 mark_read mutation 的回声，缓存已写回，不再重读；
 * - 撤回只重读受影响的已加载窗口，不整页重读。
 */
export function markPendingRefresh(
  pending: PendingRefresh,
  event: Extract<ActorStreamEvent, { type: 'event' }>,
  currentRoomId: string,
  humanTimeline: boolean,
): void {
  const { source, kind, roomId, messageId, change } = event;
  if (source === 'contact' || kind === 'contact') {
    pending.rooms = true;
    pending.contacts = true;
    pending.contactBadge = true;
    return;
  }
  // 服务端截断（20 条/1 KiB）或背压队列丢弃时，信封只带 `more`/`dropped`，
  // 不保证留下当前房间的定位字段。缺了哪条变更不可知，必须保守重读
  // 当前房间，否则无 delivery 的普通消息会一直停在旧窗口直到刷新。
  if (source === 'stream.gap' || kind === 'gap') {
    pending.rooms = true;
    pending.detail = true;
    pending.history = true;
    pending.focus = true;
    return;
  }
  // actor scope 的看板提示不带房间定位，必须在缺 roomId 前分流。
  if (source === 'focus.updated' || kind === 'focus') {
    pending.focus = true;
    return;
  }
  if (!roomId) {
    pending.rooms = true;
    return;
  }
  if (roomId !== currentRoomId) {
    pending.rooms = true;
    return;
  }
  if (source === 'room.file' || kind === 'file') {
    pending.files = true;
    return;
  }
  if (source === 'room.read' || kind === 'read') {
    return;
  }
  // 置顶只改变房间详情里的 pinned_messages：不重读历史，也不推进未读
  // 或滚动。必须先于通用 `kind === 'room'` 分支处理。
  if (source === 'room.pins') {
    pending.detail = true;
    return;
  }
  // 撤回只更新墓碑；调用方在确认消息位于已加载窗口后只重读这一页，
  // 不追加锚点请求，也不整页重读两次。
  if (change === 'recalled') {
    pending.detail = true;
    pending.rooms = true;
    return;
  }
  // 回执可能落在已加载但不在最新页的旧消息上；锚点重读权威结果，
  // 不能只靠 append 增量流把旧 delivery_states 留在窗口里。
  if (messageId && (kind === 'message' || kind === 'receipt')) {
    pending.messageIds.add(messageId);
  }
  if (source === 'room.presence' || kind === 'presence') {
    pending.detail = true;
    pending.rooms = true;
    if (humanTimeline) pending.history = true;
    return;
  }
  if (source === 'room.membership' || source === 'room.lifecycle' || kind === 'room') {
    // 成员代次/历史策略/归档会收紧可读边界：重新鉴权并清掉旧私有预览。
    pending.history = true;
    pending.detail = true;
    pending.rooms = true;
    return;
  }
  pending.history = true;
  pending.detail = true;
  pending.rooms = true;
}

/** 消息是否已经渲染在实时时间线缓存里。 */
export function historyItemVisible(
  items: HistoryItem[] | undefined,
  messageId: string,
): boolean {
  return Boolean(
    items?.some((item) => item.kind !== 'presence' && item.message_id === messageId),
  );
}
