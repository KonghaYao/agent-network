import { hasUnreadAttention, type RoomSummary } from './rooms';
import type { RoomPreferenceMap } from './room-preferences';

/**
 * 浏览器标签页提示的纯计算。
 *
 * 口径是“需要提醒的未读会话数”：与侧栏分类徽标一致，一个会话无论多少条
 * 消息只算 1，排除已免打扰、对端已归档与只读/解散会话。这里不读 DOM、
 * 不发起请求，标题与 favicon 文案都由同一份计数派生。
 */

/** 单字符上限；超过后显示 `9+`，避免 favicon 放不下。 */
export const BADGE_MAX = 9;

/**
 * 记录“用户已经看到”的水位：每个房间在聚焦时的 `head_seq`。
 *
 * 只存在内存里，不写服务端；`head_seq` 增长说明聚焦后又有新消息。
 */
export type UnreadFloors = Readonly<Record<string, number>>;

/** 0 不显示；1–9 原样；超过 9 显示 `9+`。 */
export function badgeLabel(count: number): string {
  if (!Number.isFinite(count)) return '';
  const rounded = Math.floor(count);
  if (rounded <= 0) return '';
  return rounded > BADGE_MAX ? `${BADGE_MAX}+` : String(rounded);
}

/** 有未读时 `(N) 原标题`；没有未读时恢复原标题。 */
export function titleWithBadge(baseTitle: string, count: number): string {
  const label = badgeLabel(count);
  return label ? `(${label}) ${baseTitle}` : baseTitle;
}

function headSeq(room: RoomSummary): number {
  const value = Number(room.head_seq);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 需要提醒的未读会话。
 *
 * 静音来自 `hasUnreadAttention`（本地 `muted` 偏好），因此被免打扰的
 * 会话即使有新消息也不会进入标题或 favicon。
 */
export function badgeRooms(
  rooms: readonly RoomSummary[],
  preferences: RoomPreferenceMap,
  floors: UnreadFloors = {},
): RoomSummary[] {
  return rooms.filter((room) => {
    if (room.peer_archived || room.read_only) return false;
    if (!hasUnreadAttention(room, preferences)) return false;
    return headSeq(room) > (floors[room.room_id] ?? 0);
  });
}

/** 未读会话数；一个会话只计一次。 */
export function badgeCount(
  rooms: readonly RoomSummary[],
  preferences: RoomPreferenceMap,
  floors: UnreadFloors = {},
): number {
  return badgeRooms(rooms, preferences, floors).length;
}

/**
 * 聚焦时把当前 `head_seq` 记为已看到的水位。
 *
 * 水位只增不减，返回同一引用时调用方可以跳过状态更新，避免额外渲染。
 */
export function acknowledgeRooms(
  rooms: readonly RoomSummary[],
  floors: UnreadFloors,
): UnreadFloors {
  let next: Record<string, number> | null = null;
  for (const room of rooms) {
    const head = headSeq(room);
    const current = next?.[room.room_id] ?? floors[room.room_id] ?? 0;
    if (head <= current) continue;
    next ??= { ...floors };
    next[room.room_id] = head;
  }
  return next ?? floors;
}
