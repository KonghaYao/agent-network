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
  my_role_revision?: number;
  my_last_read_seq: string;
  policy_revision?: number;
  policies?: {
    member_message: 'members' | 'owner_admin';
    member_invite: 'members' | 'owner_admin';
    member_history: 'from_join' | 'full';
    member_join: 'open' | 'approval';
    member_profile: 'members' | 'owner_admin';
    member_mention_all: 'members' | 'owner_admin';
  } | null;
  announcement: string;
  announcement_revision?: number;
  capabilities?: {
    edit_profile?: boolean;
    invite_members?: boolean;
    manage_announcement?: boolean;
    manage_policy?: boolean;
    approve_joins?: boolean;
    [key: string]: boolean | undefined;
  } | null;
  can_leave?: boolean;
  can_dissolve?: boolean;
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
  body: string;
  invoke: string[];
  invokeExplicit: boolean;
  mentions: string[];
  error: string | null;
}

const TIME_GAP = 5 * 60 * 1000;
const textEncoder = new TextEncoder();
const AUTO_MENTION_MAINTAINER = 'WeBots 维护员';
/** 与服务端正文 @ 解析同一边界：只把独立 token 当作已提及。 */
const MENTION_PREV_BLOCKED = /[\p{L}\p{N}_.%+\-]/u;
const MENTION_WORD = /[\p{L}\p{N}_]/u;
/** 成员显示名匹配只拦 ASCII 单词边界，中文与名字可直接相连。 */
const NAME_ASCII_WORD = /[A-Za-z0-9_]/;

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

/** 独立 `@名字` token：与服务端正文解析共用前后边界。 */
function mentionTokenAt(body: string, at: number, name: string): boolean {
  const start = at + 1;
  if (!body.startsWith(name, start)) return false;
  if (at > 0 && MENTION_PREV_BLOCKED.test(body.charAt(at - 1))) return false;
  const after = body.charAt(start + name.length);
  if (after && MENTION_WORD.test(after)) return false;
  return true;
}

function bodyHasMention(body: string, name: string): boolean {
  if (!name || !body.includes('@')) return false;
  const token = `@${name}`;
  let from = 0;
  while (from <= body.length - token.length) {
    const at = body.indexOf(token, from);
    if (at < 0) return false;
    if (mentionTokenAt(body, at, name)) return true;
    from = at + 1;
  }
  return false;
}

/** 正文已提到任何 active 成员时，不再追加自动 @。 */
function bodyHasAnyMention(body: string, members: Map<string, RoomMember>): boolean {
  if (!body.includes('@')) return false;
  for (const member of members.values()) {
    if (member.name && bodyHasMention(body, member.name)) return true;
  }
  return false;
}

function nameHitAt(body: string, start: number, name: string): boolean {
  const end = start + name.length;
  if (start > 0 && NAME_ASCII_WORD.test(body.charAt(start - 1))) return false;
  if (end < body.length && NAME_ASCII_WORD.test(body.charAt(end))) return false;
  return true;
}

/**
 * 正文优先的自动 @：唯一命中一个其他 active 成员时返回 `@名字`。
 *
 * `null` 表示正文没有命中成员，调用方回退到上一位发送者；空串表示重名
 * 或命中多个成员，无法唯一解析，此时不猜。名字最长优先并收集已覆盖区间，
 * 避免“WeBots 维护员”同时命中“WeBots”。
 */
function bodyMemberMention(
  body: string,
  members: Map<string, RoomMember>,
  identityId: string,
): string | null {
  const byName = new Map<string, RoomMember[]>();
  for (const member of members.values()) {
    if (!member.name) continue;
    const list = byName.get(member.name);
    if (list) list.push(member);
    else byName.set(member.name, [member]);
  }
  const hits: { start: number; end: number; members: RoomMember[] }[] = [];
  for (const [name, list] of byName) {
    let from = 0;
    while (from <= body.length - name.length) {
      const at = body.indexOf(name, from);
      if (at < 0) break;
      if (nameHitAt(body, at, name)) hits.push({ start: at, end: at + name.length, members: list });
      from = at + 1;
    }
  }
  if (hits.length === 0) return null;
  hits.sort(
    (left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start,
  );
  const claimed: { start: number; end: number }[] = [];
  const targets = new Map<string, string>();
  let ambiguous = false;
  for (const hit of hits) {
    if (claimed.some((range) => hit.start < range.end && range.start < hit.end)) continue;
    claimed.push({ start: hit.start, end: hit.end });
    // 同名多个成员时服务端无法唯一解析，不能生成自动 @。
    if (hit.members.length > 1) ambiguous = true;
    for (const member of hit.members) {
      if (member.actor_id === identityId) continue;
      targets.set(member.actor_id, member.name);
    }
  }
  if (ambiguous || targets.size > 1) return '';
  const name = targets.values().next().value;
  return name ? `@${name}` : null;
}

/** 上一位有效成员：只看最新一条消息；presence 与自己的消息都不追加。 */
function previousMemberMention(
  items: HistoryItem[],
  members: Map<string, RoomMember>,
  identityId: string,
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.kind === 'presence') continue;
    if (!item.sender_id || item.sender_id === identityId) return '';
    const member = members.get(item.sender_id);
    if (!member || !member.name) return '';
    let named = 0;
    for (const other of members.values()) {
      if (other.name === member.name) named += 1;
    }
    if (named !== 1) return '';
    return `@${member.name}`;
  }
  return '';
}

/** 附件兜底：群里恰有一个精确的 `WeBots 维护员` Agent 时才追加。 */
function maintainerMention(members: Map<string, RoomMember>, identityId: string): string {
  let target: RoomMember | null = null;
  for (const member of members.values()) {
    if (member.kind !== 'agent' || member.name !== AUTO_MENTION_MAINTAINER) continue;
    // 重名 Agent 会让服务端无法唯一解析；发送者本人也不作为目标。
    if (target) return '';
    target = member;
  }
  if (!target || target.actor_id === identityId) return '';
  return `@${AUTO_MENTION_MAINTAINER}`;
}

/**
 * 发送计划。
 *
 * - 只信选择器保存的 actor_id：Agent 进 invoke，人类进 mentions；
 * - 人类群聊没有存活选择器目标时不传 invoke（`invokeExplicit = false`），
 *   把正文唯一精确成员的兜底解析留给服务端；有目标时显式发送，包含空列表；
 * - Agent 身份始终显式发送 invoke（无目标时为空数组），避免服务端把省略
 *   invoke 的 Agent 群消息按发送者/正文猜测并自动 @ 上一位成员；
 * - 人类群聊在正文与选择器都没有有效 @ 时恢复 legacy 自动 @：正文优先
 *   命中唯一其他成员，其次最新一条消息的发送者，附件再兜底维护员；
 * - direct 自动唤醒对端 Agent（人类对端不派活），不做文本自动 @。
 */
export function buildSendPlan(input: {
  room: RoomView | null;
  members: Map<string, RoomMember>;
  identityId: string;
  identityKind: ActorKind;
  body: string;
  selections: MentionSelection[];
  items?: HistoryItem[];
  hasAttachments?: boolean;
}): SendPlan {
  const {
    room,
    members,
    identityId,
    identityKind,
    body,
    selections,
    items = [],
    hasAttachments = false,
  } = input;
  if (!room) {
    return { body, invoke: [], invokeExplicit: false, mentions: [], error: '房间尚未加载' };
  }
  if (room.kind === 'direct') {
    const targets: string[] = [];
    for (const member of members.values()) {
      if (member.actor_id === identityId) continue;
      if (member.kind === 'agent') targets.push(member.actor_id);
    }
    return {
      body,
      invoke: targets,
      // Agent 身份始终显式携带 invoke（可为空），关闭服务端按发送者猜测。
      invokeExplicit: identityKind === 'agent' || targets.length > 0,
      mentions: [],
      error: null,
    };
  }

  const invoke: string[] = [];
  const mentions: string[] = [];
  let resolved = 0;
  for (const selection of selections) {
    const member = members.get(selection.actor_id);
    if (!member) {
      return {
        body,
        invoke: [],
        invokeExplicit: false,
        mentions: [],
        error: '所选成员已不在房间，请重新选择',
      };
    }
    if (!body.includes(`@${member.name}`)) continue;
    resolved += 1;
    if (member.kind === 'agent') invoke.push(member.actor_id);
    else mentions.push(member.actor_id);
  }
  const failed = (error: string): SendPlan => ({
    body,
    invoke: [],
    invokeExplicit: false,
    mentions: [],
    error,
  });
  if (invoke.length > LIMITS.invokeMax) {
    return failed(`一次最多 @ ${LIMITS.invokeMax} 个 Agent，请减少目标后重试`);
  }
  if (mentions.length > LIMITS.invokeMax) {
    return failed(`一次最多提醒 ${LIMITS.invokeMax} 个成员，请减少目标后重试`);
  }

  let outgoing = body;
  if (identityKind === 'human' && resolved === 0 && !bodyHasAnyMention(body, members)) {
    let autoMention = bodyMemberMention(body, members, identityId);
    if (autoMention === null) {
      autoMention = previousMemberMention(items, members, identityId);
      if (!autoMention && hasAttachments) autoMention = maintainerMention(members, identityId);
    }
    if (autoMention && !bodyHasMention(body, autoMention.slice(1))) {
      const candidate = `${body}\n${autoMention}`;
      if (messageBodyBytes(candidate) <= LIMITS.messageBodyBytes) outgoing = candidate;
    }
  }
  // Agent 身份必须显式发送 invoke：省略会让服务端自动 @ 上一位成员并
  // 追加 text 提及；前端只传选择器解析出的目标，不参与正文猜测。
  return {
    body: outgoing,
    invoke,
    invokeExplicit: identityKind === 'agent' || resolved > 0,
    mentions,
    error: null,
  };
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
