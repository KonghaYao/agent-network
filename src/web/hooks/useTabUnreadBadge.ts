import { useEffect, useMemo, useRef, useState } from 'react';

import { applyFaviconBadge, resetFavicon } from '../lib/favicon';
import { acknowledgeRooms, badgeCount, titleWithBadge, type UnreadFloors } from '../lib/tab-badge';
import { useRoomPreferences } from './useRoomPreferences';
import { useRooms } from './useRooms';
import { useWebSession } from './useWebSession';

/**
 * 浏览器标签页提示：标题未读前缀 + favicon 红点。
 *
 * 数据源是现有的 `network_rooms_list`（React Query 缓存）与本地免打扰偏好：
 * 首页由 `AppSidebar` 的 `agentnet://stream` 失效列表，聊天页由
 * `useRoomChat` 的房间事件失效列表，本 hook 不建立新订阅、不轮询、不写服务端。
 *
 * 聚焦语义：标签页从隐藏/失焦回到可见且窗口聚焦时，把当时的 `head_seq`
 * 记为已看到水位，标题与图标立即恢复；之后的新消息会再次提升 `head_seq`
 * 并重新提示。整个过程不改变服务端已读位置（已读仍由聊天页滚动触发
 * `network_room_mark_read`）。
 */

function focusedNow(): boolean {
  if (typeof document === 'undefined') return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

export function useTabUnreadBadge(baseTitle: string, enabled = true): number {
  const session = useWebSession();
  const roomsState = useRooms(enabled);
  const actorId = session.session?.identity.actor_id ?? null;
  const preferences = useRoomPreferences(actorId);
  const [floors, setFloors] = useState<UnreadFloors>({});

  const roomsRef = useRef(roomsState.rooms);
  roomsRef.current = roomsState.rooms;

  // 换身份后旧水位没有意义，直接丢弃。
  useEffect(() => {
    setFloors({});
  }, [actorId]);

  // 事件驱动而不是渲染边沿：同一任务内先 blur 再 focus 时，React 可能
  // 合并状态更新，只有在处理函数里记录前后值才能可靠识别“重新聚焦”。
  useEffect(() => {
    let focused = focusedNow();
    let attentive = document.visibilityState === 'visible' && focused;
    const update = () => {
      const next = document.visibilityState === 'visible' && focused;
      if (next === attentive) return;
      attentive = next;
      if (!next) return;
      setFloors((current) => acknowledgeRooms(roomsRef.current, current));
    };
    const onFocus = () => {
      focused = true;
      update();
    };
    const onBlur = () => {
      focused = false;
      update();
    };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const count = useMemo(
    () => badgeCount(roomsState.rooms, preferences.preferences, floors),
    [roomsState.rooms, preferences.preferences, floors],
  );

  useEffect(() => {
    document.title = titleWithBadge(baseTitle, count);
  }, [baseTitle, count]);

  useEffect(() => {
    applyFaviconBadge(document, count);
  }, [count]);

  useEffect(() => () => resetFavicon(document), []);

  return count;
}
