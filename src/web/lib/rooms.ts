import { formatDisplayTime } from './display-format';
import { roomPreference, type RoomPreferenceMap } from './room-preferences';

/**
 * 会话列表的纯展示模型：只在已加载的 `network_rooms_list` 数据上过滤、排序，
 * 不发起请求、不读写服务端状态。
 */

export type RoomFilter = 'friend' | 'agent' | 'group';

export type ActorKind = 'human' | 'agent';

export interface RawRoomPeer {
  actor_id: string;
  name: string;
  kind: ActorKind;
  online: boolean | null;
  avatar_url?: string | null;
}

export interface RawRoom {
  room_id: string;
  kind: 'direct' | 'group';
  title: string;
  head_seq: string;
  my_last_read_seq: string;
  updated_at: string;
  status?: 'active' | 'dissolved';
  read_only?: boolean;
  dissolved_at?: string | null;
  peer_archived?: boolean;
  last_message: { preview: string; created_at: string } | null;
  peer?: RawRoomPeer | null;
}

export interface RoomsPage {
  items: RawRoom[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface RoomSummary {
  room_id: string;
  kind: 'direct' | 'group';
  name: string;
  peer_kind: ActorKind | null;
  /** direct 对端 actor_id；归档浮层籍此批量读取管理摘要。 */
  peer_actor_id: string | null;
  peer_online: boolean | null;
  /** direct 对端头像；群聊与旧服务端为 null。 */
  peer_avatar_url?: string | null;
  head_seq: string;
  my_last_read_seq: string;
  last_message: { preview: string; created_at: string } | null;
  updated_at: string;
  read_only: boolean;
  peer_archived: boolean;
}

/** direct 优先使用 peer 名称；群聊回退到“群聊”。 */
export function summarizeRoom(entry: RawRoom): RoomSummary {
  const peer = entry.kind === 'direct' && entry.peer ? entry.peer : null;
  const name =
    entry.kind === 'direct'
      ? peer && peer.name
        ? peer.name
        : '单聊'
      : entry.title || '群聊';
  const peerKind = entry.kind === 'direct' ? (peer?.kind ?? null) : null;
  return {
    room_id: entry.room_id,
    kind: entry.kind,
    name,
    peer_kind: peerKind,
    peer_actor_id: peer?.actor_id ?? null,
    peer_online: peerKind === 'agent' ? (peer?.online ?? null) : null,
    peer_avatar_url: peer?.avatar_url ?? null,
    head_seq: entry.head_seq,
    my_last_read_seq: entry.my_last_read_seq,
    last_message: entry.last_message,
    updated_at: entry.updated_at,
    read_only: Boolean(entry.read_only),
    peer_archived: entry.peer_archived === true,
  };
}

/** 补读时房间可能跨页移动；按服务端顺序保留每个房间的第一条。 */
export function summarizeRoomPages(pages: readonly RoomsPage[]): RoomSummary[] {
  const rooms: RoomSummary[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.room_id)) continue;
      seen.add(item.room_id);
      rooms.push(summarizeRoom(item));
    }
  }
  return rooms;
}

export function isUnread(room: RoomSummary): boolean {
  return Number(room.my_last_read_seq) < Number(room.head_seq);
}

/** 免打扰只把红点降级为灰点，不改变未读水位或服务端已读位置。 */
export function hasUnreadAttention(room: RoomSummary, preferences: RoomPreferenceMap): boolean {
  return isUnread(room) && !roomPreference(preferences, room.room_id).muted;
}

/** 归档 Agent、解散/只读会话不进入默认列表；与 legacy 首页一致。 */
function isDefaultVisible(room: RoomSummary): boolean {
  return !room.peer_archived && !room.read_only;
}

export function matchesFilter(room: RoomSummary, filter: RoomFilter): boolean {
  if (!isDefaultVisible(room)) return false;
  if (filter === 'group') return room.kind === 'group';
  if (room.kind !== 'direct') return false;
  const isAgent = room.peer_kind === 'agent';
  return filter === 'agent' ? isAgent : !isAgent;
}

function messageTime(room: RoomSummary): number {
  return room.last_message ? Number(room.last_message.created_at) || 0 : 0;
}

export function sortRooms(
  rooms: RoomSummary[],
  preferences: RoomPreferenceMap = {},
): RoomSummary[] {
  return rooms.slice().sort((left, right) => {
    const pinned =
      Number(roomPreference(preferences, right.room_id).pinned) -
      Number(roomPreference(preferences, left.room_id).pinned);
    if (pinned !== 0) return pinned;
    const byMessage = messageTime(right) - messageTime(left);
    if (byMessage !== 0) return byMessage;
    return (Number(right.updated_at) || 0) - (Number(left.updated_at) || 0);
  });
}

/** 总览搜索只匹配已加载名称与最后消息预览；不发起额外工具调用。 */
export function filterRooms(
  rooms: RoomSummary[],
  filter: RoomFilter,
  query: string,
  preferences: RoomPreferenceMap = {},
): RoomSummary[] {
  const normalized = query.trim().toLowerCase();
  const byFilter = rooms.filter((room) => matchesFilter(room, filter));
  const matched = normalized
    ? byFilter.filter((room) => {
        if (room.name.toLowerCase().includes(normalized)) return true;
        const preview = room.last_message?.preview ?? '';
        return preview.toLowerCase().includes(normalized);
      })
    : byFilter;
  return sortRooms(matched, preferences);
}

export function roomFilterEmptyMessage(
  filter: RoomFilter,
  loggedOut = false,
  credentialInvalid = false,
): string {
  if (loggedOut) {
    return '已退出登录。点击「创建新身份并继续」，或打开 Agent 分享链接。';
  }
  if (credentialInvalid) {
    return '当前凭据已失效或已被撤销；本机不会自动创建替代身份。请用另一台已登录设备生成配对码后打开 /pair。';
  }
  if (filter === 'group') return '还没有群聊。';
  if (filter === 'agent') return '还没有 Agent 会话。打开 Agent 分享链接即可开始。';
  return '还没有好友会话。通过好友申请或好友链接添加后即可开始。';
}

/**
 * 会话列表时间：保持 compact 口径（今天时:分、昨天、更早日期）。
 * 未知时间返回空串；detail 口径由 `formatDisplayTime` 统一提供。
 */
export function relativeTime(value: string | null | undefined): string {
  return formatDisplayTime(value, { mode: 'compact' }).display;
}

const AVATAR_COLORS = ['#5b8def', '#e8a33d', '#6aa84f', '#d96459', '#8e7cc3', '#3d9a9a'];

export function avatarColor(name: string): string {
  const chars = Array.from(name || '?');
  let hash = 0;
  for (const char of chars) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function firstChar(name: string): string {
  const chars = Array.from(String(name || '单聊').trim());
  return chars.length > 0 ? chars[0]! : '聊';
}

export interface GroupAvatarLabel {
  /** 瓦片里显示的文字：1–2 个汉字、1–2 个大写字母或兜底字符。 */
  text: string;
  /** 字数；样式按 1 字/2 字切换字号。 */
  length: 1 | 2;
  /** 文字类别；拉丁字母用更宽的字距，避免两个大写字母挤在一起。 */
  script: 'han' | 'latin' | 'other';
}

const HAN_RUN = /\p{Script=Han}+/u;
const HAN_PREFIX = /^\p{Script=Han}{1,2}/u;
const LATIN = /[A-Za-z]/gu;

/**
 * 群聊头像文字：中文取前 2 个汉字，英文/混合取前 2 个大写字母。
 *
 * 规则固定、不依赖随机数：同一群名在任何设备上得到同一标签。空名称
 * 回退到“群聊”；实在没有汉字或拉丁字母时取前 2 个字符。
 */
export function groupAvatarLabel(name: string): GroupAvatarLabel {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { text: '群聊', length: 2, script: 'han' };

  const hanPrefix = HAN_PREFIX.exec(trimmed);
  if (hanPrefix) {
    const text = hanPrefix[0];
    return { text, length: text.length as 1 | 2, script: 'han' };
  }

  const letters = (trimmed.match(LATIN) ?? []).slice(0, 2).join('').toUpperCase();
  if (letters) {
    return { text: letters, length: letters.length as 1 | 2, script: 'latin' };
  }

  // 被标点/数字包住的中文名（如「读书会」）取第一段汉字的前 2 个。
  const hanRun = trimmed.match(HAN_RUN)?.[0];
  if (hanRun) {
    const text = Array.from(hanRun).slice(0, 2).join('');
    return { text, length: text.length as 1 | 2, script: 'han' };
  }

  const chars = Array.from(trimmed).slice(0, 2);
  return { text: chars.join(''), length: chars.length as 1 | 2, script: 'other' };
}
