import { useCallback, useEffect, useState } from 'react';

import {
  EMPTY_PREFERENCE,
  readRoomPreferences,
  ROOM_PREFERENCES_PREFIX,
  toggleRoomPreference,
  writeRoomPreferences,
  type RoomPreference,
  type RoomPreferenceMap,
} from '../lib/room-preferences';

export interface RoomPreferencesState {
  preferences: RoomPreferenceMap;
  preference: (roomId: string) => RoomPreference;
  toggle: (roomId: string, field: keyof RoomPreference) => boolean;
}

/**
 * 当前身份的本地会话偏好。
 *
 * `storage` 事件只在其他标签页触发；当前页通过状态立即重排列表。
 * 写入失败时仍返回新状态，让本次切换可用，并由调用方提示未持久化。
 */
export function useRoomPreferences(actorId: string | null): RoomPreferencesState {
  const [preferences, setPreferences] = useState<RoomPreferenceMap>(() =>
    readRoomPreferences(actorId),
  );

  useEffect(() => {
    setPreferences(readRoomPreferences(actorId));
  }, [actorId]);

  useEffect(() => {
    if (!actorId) return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ROOM_PREFERENCES_PREFIX + actorId) return;
      setPreferences(readRoomPreferences(actorId));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [actorId]);

  const preference = useCallback(
    (roomId: string) => preferences[roomId] ?? EMPTY_PREFERENCE,
    [preferences],
  );

  const toggle = useCallback(
    (roomId: string, field: keyof RoomPreference) => {
      const next = toggleRoomPreference(preferences, roomId, field);
      const saved = writeRoomPreferences(actorId, next);
      setPreferences(next);
      return saved;
    },
    [actorId, preferences],
  );

  return { preferences, preference, toggle };
}
