/**
 * 会话级本地偏好：置顶与免打扰只存在当前浏览器，不写服务端。
 *
 * 存储格式与 legacy 完全一致：按 actor 隔离的
 * `agent-network-room-preferences-v1:<actor_id>`，值为 `{ room_id: { pinned, muted } }`。
 * 偏好不是已读水位，也不影响未读计数；免打扰只抑制列表红点。
 */

export interface RoomPreference {
  pinned: boolean;
  muted: boolean;
}

export type RoomPreferenceMap = Record<string, RoomPreference>;

export const ROOM_PREFERENCES_PREFIX = 'agent-network-room-preferences-v1:';
const ROOM_ID = /^rm_[a-zA-Z0-9_-]+$/;

export const EMPTY_PREFERENCE: RoomPreference = { pinned: false, muted: false };

export function roomPreference(
  preferences: RoomPreferenceMap,
  roomId: string,
): RoomPreference {
  return preferences[roomId] ?? EMPTY_PREFERENCE;
}

function sanitize(value: unknown): RoomPreferenceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: RoomPreferenceMap = {};
  for (const [roomId, entry] of Object.entries(value)) {
    if (!ROOM_ID.test(roomId) || !entry || typeof entry !== 'object') continue;
    const record = entry as Partial<RoomPreference>;
    const preference = {
      pinned: record.pinned === true,
      muted: record.muted === true,
    };
    if (preference.pinned || preference.muted) result[roomId] = preference;
  }
  return result;
}

export function readRoomPreferences(actorId: string | null): RoomPreferenceMap {
  if (!actorId) return {};
  try {
    const raw = localStorage.getItem(ROOM_PREFERENCES_PREFIX + actorId);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** 写入失败只影响跨刷新记忆，不阻塞当前会话内切换。 */
export function writeRoomPreferences(
  actorId: string | null,
  preferences: RoomPreferenceMap,
): boolean {
  if (!actorId) return false;
  try {
    localStorage.setItem(ROOM_PREFERENCES_PREFIX + actorId, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function toggleRoomPreference(
  preferences: RoomPreferenceMap,
  roomId: string,
  field: keyof RoomPreference,
): RoomPreferenceMap {
  const previous = roomPreference(preferences, roomId);
  const nextPreference = { ...previous, [field]: !previous[field] };
  const next = { ...preferences, [roomId]: nextPreference };
  if (!nextPreference.pinned && !nextPreference.muted) delete next[roomId];
  return next;
}
