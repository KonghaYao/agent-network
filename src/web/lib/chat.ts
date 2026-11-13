import { LIMITS } from '../../contracts/limits';

/**
 * Chat 页的只读数据模型与纯函数。
 *
 * 这里不发起请求：时间线合并、回执文案、时间胶囊、@ 目标解析都可以用
 * bun:test/Playwright 直接验证；HTTP 细节留在 `mcp-client` 与 hooks。
 */

export type ActorKind = 'human' | 'agent';

export interface MentionView {
  actor_id: string;
  kind: ActorKind;
  source: 'explicit' | 'text' | 'all';
}

export interface HistoryMessage {
  kind?: 'message';
  message_id: string;
  room_id: string;
  sender_id: string;
  created_seq: string;
  preview: string;
  body_bytes: number;
  created_at: string;
  reply_to: string | null;
  root_id: string | null;
  task_root_id: string | null;
  hop: number;
  delivery_states: Record<string, number>;
  mentions: MentionView[];
  delivery_claimed_at: string | null;
  delivery_updated_at: string | null;
  sender_kind: ActorKind | null;
}

export interface PresenceItem {
  kind: 'presence';
  presence_event_id: string;
  room_id: string;
  agent_id: string;
  transition: 'online' | 'offline';
  occurred_at: string;
  recorded_at: string;
  timeline_seq: string;
  time_basis: 'observed' | 'inferred';
}

export type HistoryItem = HistoryMessage | PresenceItem;

export interface HistoryPage {
  items: HistoryMessage[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  head_seq: string;
  timeline_items?: HistoryItem[];
  timeline_next_cursor?: string | null;
  timeline_has_more?: boolean;
  timeline_snapshot?: string;
  timeline_resume_cursor?: string;
}

export interface RoomMember {
  actor_id: string;
  kind: ActorKind;
  name: string;
  agent_session_id: string | null;
  role: 'owner' | 'admin' | 'member';
  role_revision?: number;
  online: boolean | null;
  /** 服务端按调用者角色计算的成员操作；旧响应缺失时按不可操作处理。 */
  actions?: {
    can_remove: boolean;
    can_set_admin: boolean;
    can_revoke_admin: boolean;
    can_transfer_owner: boolean;
  } | null;
}

export interface RoomView {
  room_id: string;
  kind: 'direct' | 'group';
  owner_id: string | null;
  title: string;
  head_seq: string;
  member_seq: string;
  member_count: number;
  my_role: 'owner' | 'admin' | 'member';
  my_last_read_seq: string;
  announcement: string;
  announcement_revision?: number;
  capabilities?: {
    edit_profile?: boolean;
    invite_members?: boolean;
    manage_announcement?: boolean;
    [key: string]: boolean | undefined;
  } | null;
  can_leave?: boolean;
  /** direct 对端 Agent 的查看者管理权限；群聊不返回。 */
  peer_can_manage?: boolean;
  status: 'active' | 'dissolved';
  read_only: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoomDetail {
  room: RoomView;
  members: RoomMember[];
  owner_transfer?: OwnerTransferView | null;
}

/** 群主转让提议；`can_*` 由服务端按调用者身份计算。 */
export interface OwnerTransferView {
  transfer_id: string;
  room_id: string;
  from_owner_id: string;
  from_owner_name: string;
  to_actor_id: string;
  to_actor_name: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  version: number;
  expires_at: string;
  created_at: string;
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

export interface HistoryFetch {
  detail: RoomDetail;
  page: HistoryPage;
}

export interface SendResult {
  message: HistoryMessage;
  delivery_ids: string[];
}

export interface SendStatusItem {
  client_message_id: string;
  found: boolean;
  message_id: string | null;
  room_id: string | null;
  created_seq: string | null;
  delivery_ids: string[];
  body_bytes: number | null;
  created_at: string | null;
  recalled?: boolean;
}

export interface MentionSelection {
  actor_id: string;
  name: string;
  kind: ActorKind;
}

export interface SendPlan {
  invoke: string[];
  mentions: string[];
  error: string | null;
}

const TIME_GAP = 5 * 60 * 1000;
const textEncoder = new TextEncoder();

export function historyItemKey(item: HistoryItem): string {
  return item.kind === 'presence'
    ? `presence:${item.presence_event_id}`
    : `message:${item.message_id}`;
}

export function timelineTimestamp(item: HistoryItem): number {
  return Number(item.kind === 'presence' ? item.occurred_at : item.created_at) || 0;
}

export function timelineCommitSeq(item: HistoryItem): number {
  return Number(item.kind === 'presence' ? item.timeline_seq : item.created_seq) || 0;
}

/**
 * 合并时间线：稳定 key 去重，同一消息以最新响应为准；按服务端时间与
 * commit seq 排序，跨页/实时刷新不会出现重复或倒序。
 */
export function mergeTimelineItems(
  base: HistoryItem[],
  incoming: HistoryItem[],
): HistoryItem[] {
  const indexes = new Map<string, number>();
  const merged: HistoryItem[] = [];
  for (const item of base) {
    const key = historyItemKey(item);
    if (indexes.has(key)) continue;
    indexes.set(key, merged.length);
    merged.push(item);
  }
  for (const item of incoming) {
    const key = historyItemKey(item);
    const existing = indexes.get(key);
    if (existing !== undefined) {
      merged[existing] = item;
      continue;
    }
    indexes.set(key, merged.length);
    merged.push(item);
  }
  merged.sort((left, right) => {
    const byTime = timelineTimestamp(left) - timelineTimestamp(right);
    if (byTime !== 0) return byTime;
    return timelineCommitSeq(left) - timelineCommitSeq(right);
  });
  return merged;
}

export function reverseChronological(page: HistoryPage, humanTimeline: boolean): HistoryItem[] {
  const items = humanTimeline ? (page.timeline_items ?? []) : page.items;
  return items.slice().reverse();
}

export function nextOlderCursor(page: HistoryPage, humanTimeline: boolean): string | null {
  return humanTimeline
    ? page.timeline_has_more
      ? (page.timeline_next_cursor ?? null)
      : null
    : page.has_more
      ? page.next_cursor
      : null;
}

export function messageTime(value: string | number | null | undefined): number {
  return Number(value) || 0;
}

export function clockTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** 气泡时间胶囊：今天只显示时分，更早带日期。 */
export function chatTime(value: string | number | null | undefined): string {
  const ms = messageTime(value);
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const clock = clockTime(date);
  if (date.toDateString() === now.toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === now.getFullYear()) return `${day} ${clock}`;
  return `${date.getFullYear()}年${day} ${clock}`;
}

export function fullTime(value: string | number | null | undefined): string {
  const ms = messageTime(value);
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isAgentMessage(
  item: HistoryMessage,
  members: Map<string, RoomMember>,
): boolean {
  if (item.sender_kind === 'agent') return true;
  if (item.sender_kind === 'human') return false;
  return members.get(item.sender_id)?.kind === 'agent';
}

export function senderName(
  senderId: string,
  members: Map<string, RoomMember>,
  identityName: string | null,
  identityId: string | null,
): string {
  if (identityId && senderId === identityId) return '我';
  return members.get(senderId)?.name ?? senderId;
}

const DELIVERY_STATES = ['pending', 'claimed', 'completed', 'failed', 'cancelled'] as const;

export function deliveryTotal(states: Record<string, number>): number {
  let total = 0;
  for (const state of DELIVERY_STATES) total += Number(states[state] ?? 0);
  return total;
}

/** 只有收件人数恰好等于房间内其他 Agent 数时才列出名字，避免猜测。 */
export function receiptRecipients(
  states: Record<string, number>,
  members: Map<string, RoomMember>,
  identityId: string | null,
): string {
  const total = deliveryTotal(states);
  if (total === 0) return '';
  const agents: string[] = [];
  for (const member of members.values()) {
    if (member.kind !== 'agent' || !member.name) continue;
    if (identityId && member.actor_id === identityId) continue;
    agents.push(member.name);
  }
  if (agents.length === 1 && total === 1) return `${agents[0]} `;
  if (agents.length > 1 && agents.length === total) return `${agents.join('、')} · `;
  return '';
}

export function receiptStatus(states: Record<string, number>, named: boolean): string {
  const pending = Number(states.pending ?? 0);
  const claimed = Number(states.claimed ?? 0);
  const completed = Number(states.completed ?? 0);
  const failed = Number(states.failed ?? 0);
  const cancelled = Number(states.cancelled ?? 0);
  const total = pending + claimed + completed + failed + cancelled;
  if (total === 0) return '已发送';
  if (total === 1) {
    if (pending === 1) return '已送达';
    if (claimed === 1) return named ? '已接收' : 'Agent 已接收';
    if (completed === 1) return '已处理';
    if (failed === 1) return '发送失败';
    return '已取消';
  }
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending}/${total} 已送达`);
  if (claimed > 0) parts.push(`${claimed}/${total} 已接收`);
  if (completed > 0) parts.push(`${completed} 已处理`);
  if (failed > 0) parts.push(`${failed} 发送失败`);
  if (cancelled > 0) parts.push(`${cancelled} 已取消`);
  return parts.join(' · ');
}

export function claimStale(item: HistoryMessage, now = Date.now()): boolean {
  if (!Number(item.delivery_states.claimed ?? 0)) return false;
  const last = messageTime(item.delivery_updated_at ?? item.delivery_claimed_at);
  return last > 0 && now - last >= LIMITS.claimedStaleMs;
}

export function receiptText(
  item: HistoryMessage,
  members: Map<string, RoomMember>,
  identityId: string | null,
  now = Date.now(),
): string {
  const names = receiptRecipients(item.delivery_states, members, identityId);
  let text = names + receiptStatus(item.delivery_states, names.length > 0);
  const time = chatTime(item.delivery_updated_at ?? item.delivery_claimed_at ?? item.created_at);
  if (time) text += ` · ${time}`;
  if (claimStale(item, now)) text += ' · 处理中未更新';
  return text;
}

/** 已知成员名按最长优先，Markdown/纯文本 @ 高亮共用同一份列表。 */
export function mentionNames(
  members: Map<string, RoomMember>,
  identityName: string | null,
): string[] {
  const names = new Set<string>();
  for (const member of members.values()) {
    if (member.name) names.add(member.name);
  }
  if (identityName) names.add(identityName);
  return [...names].sort((left, right) => right.length - left.length);
}

/**
 * 群聊发送计划：只信选择器保存的 actor_id。
 *
 * - Agent 目标进入 invoke，人类进入 mentions；
 * - 选择器目标必须仍在正文里、且仍是 active 成员；
 * - 没有任何 @ 时显式发送 `invoke: []`，阻止服务端再从正文猜测目标；
 * - direct 自动唤醒对端 Agent（人类对端不派活）。
 */
export function buildSendPlan(input: {
  room: RoomView | null;
  members: Map<string, RoomMember>;
  identityId: string;
  body: string;
  selections: MentionSelection[];
}): SendPlan {
  const { room, members, identityId, body, selections } = input;
  if (!room) return { invoke: [], mentions: [], error: '房间尚未加载' };
  if (room.kind === 'direct') {
    const targets: string[] = [];
    for (const member of members.values()) {
      if (member.actor_id === identityId) continue;
      if (member.kind === 'agent') targets.push(member.actor_id);
    }
    return { invoke: targets, mentions: [], error: null };
  }

  const invoke: string[] = [];
  const mentions: string[] = [];
  for (const selection of selections) {
    const member = members.get(selection.actor_id);
    if (!member) return { invoke: [], mentions: [], error: '所选成员已不在房间，请重新选择' };
    if (!body.includes(`@${member.name}`)) continue;
    if (member.kind === 'agent') invoke.push(member.actor_id);
    else mentions.push(member.actor_id);
  }
  if (invoke.length > LIMITS.invokeMax) {
    return {
      invoke: [],
      mentions: [],
      error: `一次最多 @ ${LIMITS.invokeMax} 个 Agent，请减少目标后重试`,
    };
  }
  if (mentions.length > LIMITS.invokeMax) {
    return {
      invoke: [],
      mentions: [],
      error: `一次最多提醒 ${LIMITS.invokeMax} 个成员，请减少目标后重试`,
    };
  }
  return { invoke, mentions, error: null };
}

/** 正文 + 附件公开链接；每行一个 URL，与 legacy 发送格式一致。 */
export function composeMessageBody(text: string, urls: string[]): string {
  const parts: string[] = [];
  const trimmed = text.trim();
  if (trimmed) parts.push(trimmed);
  for (const url of urls) if (url) parts.push(url);
  return parts.join('\n');
}

export function messageBodyBytes(body: string): number {
  return textEncoder.encode(body).length;
}

export function isBase64Block(text: string): boolean {
  const clean = text.replace(/\s+/gu, '');
  if (clean.length < LIMITS.webBase64CollapseChars) return false;
  if (!/[A-Za-z]/u.test(clean) || !/[0-9]/u.test(clean)) return false;
  let allowed = 0;
  for (const char of text) {
    if ('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='.includes(char)) {
      allowed += 1;
    }
  }
  return text.length > 0 && allowed / text.length >= 0.95;
}

export function base64CleanLength(text: string): number {
  return text.replace(/\s+/gu, '').length;
}

export function base64SizeLabel(text: string): string {
  const kb = base64CleanLength(text) / 1024;
  const value = kb >= 10 ? String(Math.round(kb)) : (Math.round(kb * 10) / 10).toFixed(1);
  return `base64 内容 · 约 ${value} KB`;
}

/** 把正文切成普通文本与连续 base64 块，避免把整个长正文塞进一个折叠区。 */
export function splitBase64Segments(text: string): { text: string; base64: boolean }[] {
  const lines = text.split('\n');
  const segments: { text: string; base64: boolean }[] = [];
  let buffer: string[] = [];
  let base64 = false;
  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer.join('\n'), base64 });
    buffer = [];
  };
  for (const line of lines) {
    const candidate = isBase64Block(line);
    if (candidate !== base64 && buffer.length > 0) flush();
    base64 = candidate;
    buffer.push(line);
  }
  flush();
  return segments;
}
