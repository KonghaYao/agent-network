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
  peer_online: boolean | null;
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
    peer_online: peerKind === 'agent' ? (peer?.online ?? null) : null,
    head_seq: entry.head_seq,
    my_last_read_seq: entry.my_last_read_seq,
    last_message: entry.last_message,
    updated_at: entry.updated_at,
    read_only: Boolean(entry.read_only),
    peer_archived: entry.peer_archived === true,
  };
}

export function isUnread(room: RoomSummary): boolean {
  return Number(room.my_last_read_seq) < Number(room.head_seq);
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

export function sortRooms(rooms: RoomSummary[]): RoomSummary[] {
  return rooms.slice().sort((left, right) => {
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
  return sortRooms(matched);
}

export function roomFilterEmptyMessage(
  filter: RoomFilter,
  loggedOut = false,
  credentialInvalid = false,
): string {
  if (loggedOut) {
    return '已退出登录。本机登录凭据与已保存的 Agent 连接提示词已清除；打开 Agent 分享链接或使用已有连接提示词即可继续。';
  }
  if (credentialInvalid) {
    return '当前凭据已失效或已被撤销；本机不会自动创建替代身份。请用另一台已登录设备生成配对码后打开 /pair。';
  }
  if (filter === 'group') return '还没有群聊。';
  if (filter === 'agent') return '还没有 Agent 会话。打开 Agent 分享链接即可开始。';
  return '还没有好友会话。通过好友申请或好友链接添加后即可开始。';
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 会话列表时间：今天显示时:分，昨天显示“昨天”，更早显示日期。 */
export function relativeTime(value: string | null | undefined): string {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms)) return '';
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  if (date.getFullYear() === now.getFullYear()) return monthDay;
  return `${date.getFullYear()}/${monthDay}`;
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

/** 群聊 2×2 首字色块；颜色顺序固定，刷新时不会跳色。 */
export function groupAvatarCells(name: string): { char: string; color: string }[] {
  const chars = Array.from(String(name || '群聊').trim()).filter((char) => char.trim().length > 0);
  const effective = chars.length > 0 ? chars : ['群'];
  return Array.from({ length: 4 }, (_, index) => ({
    char: effective[index % effective.length]!,
    color: AVATAR_COLORS[index % AVATAR_COLORS.length]!,
  }));
}
