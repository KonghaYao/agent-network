import { useCallback, useEffect, useSyncExternalStore } from 'react';

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
 * 同一标签页内 Sidebar 与 Chat 共用模块级快照：任意一处切换后同步通知
 * 所有订阅者，侧栏无需刷新即可重排、更新标签与未读点。存储格式仍是
 * legacy 的 `agent-network-room-preferences-v1:<actor_id>`，因此刷新与
 * 跨标签页 `storage` 事件继续兼容。
 *
 * 写入失败时仍发布新快照，让本次切换可用，并由调用方提示未持久化。
 */
const EMPTY_PREFERENCES: RoomPreferenceMap = {};
const snapshots = new Map<string, RoomPreferenceMap>();
const listeners = new Set<() => void>();

function actorKey(actorId: string | null): string {
  return actorId ?? '';
}

function snapshotFor(actorId: string | null): RoomPreferenceMap {
  const key = actorKey(actorId);
  const cached = snapshots.get(key);
  if (cached) return cached;
  const loaded = readRoomPreferences(actorId);
  snapshots.set(key, loaded);
  return loaded;
}

function publish(actorId: string | null, next: RoomPreferenceMap): void {
  snapshots.set(actorKey(actorId), next);
  for (const listener of listeners) listener();
}

function samePreferences(left: RoomPreferenceMap, right: RoomPreferenceMap): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    return a?.pinned === b?.pinned && a?.muted === b?.muted;
  });
}

/** 只在其他标签页或遗留页面确实改写了存储时发布，普通挂载不额外渲染。 */
function refreshFromStorage(actorId: string | null): void {
  const next = readRoomPreferences(actorId);
  if (samePreferences(snapshotFor(actorId), next)) return;
  publish(actorId, next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRoomPreferences(actorId: string | null): RoomPreferencesState {
  const preferences = useSyncExternalStore(
    subscribe,
    () => snapshotFor(actorId),
    () => EMPTY_PREFERENCES,
  );

  useEffect(() => {
    if (!actorId) return undefined;
    const key = ROOM_PREFERENCES_PREFIX + actorId;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      refreshFromStorage(actorId);
    };
    window.addEventListener('storage', onStorage);
    // 身份切换后重新读取，避免复用该身份此前遗留的进程内快照。
    refreshFromStorage(actorId);
    return () => window.removeEventListener('storage', onStorage);
  }, [actorId]);

  const preference = useCallback(
    (roomId: string) => preferences[roomId] ?? EMPTY_PREFERENCE,
    [preferences],
  );

  const toggle = useCallback(
    (roomId: string, field: keyof RoomPreference) => {
      const next = toggleRoomPreference(snapshotFor(actorId), roomId, field);
      const saved = writeRoomPreferences(actorId, next);
      publish(actorId, next);
      return saved;
    },
    [actorId],
  );

  return { preferences, preference, toggle };
}
