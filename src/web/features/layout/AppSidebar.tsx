import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useActorStream, type ActorStreamEvent } from '../../app/mcp/useActorStream';
import { LIMITS } from '../../../contracts/limits';
import { useRoomPreferences } from '../../hooks/useRoomPreferences';
import { useRooms } from '../../hooks/useRooms';
import { useWebSession } from '../../hooks/useWebSession';
import { filterRooms } from '../../lib/rooms';
import { queryKeys } from '../../lib/query-keys';
import { useRoomFilterStore } from '../../stores/ui';
import { ContactRequestsDialog } from '../overlays/ContactRequestsDialog';
import { GroupCreateDialog } from '../overlays/GroupCreateDialog';
import { Sidebar, type SidebarStatus } from '../sidebar/Sidebar';

export interface SidebarNotice {
  message: string;
  error: boolean;
}

interface AppSidebarProps {
  notice?: SidebarNotice | null;
  /**
   * 聊天页已有房间订阅；关闭这里的独立订阅，避免同一页面出现第二条
   * `subscriptions/listen`。聊天事件仍会失效会话列表（见 `useRoomChat`）。
   */
  live?: boolean;
  streamError?: string | null;
}

/**
 * 应用页左侧栏：会话列表、搜索/分类、好友申请与建群入口。
 *
 * Home 与桌面 Chat 共用同一份数据与弹窗；Chat 不需要第二条实时通道，
 * 因此通过 `live` 复用房间订阅的失效信号。
 */
export function AppSidebar({ notice = null, live = true, streamError = null }: AppSidebarProps) {
  const queryClient = useQueryClient();
  const session = useWebSession();
  const roomsState = useRooms();
  const [query, setQuery] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const filter = useRoomFilterStore((state) => state.filter);
  const changeFilter = useRoomFilterStore((state) => state.setFilter);
  const actorId = session.session?.identity.actor_id ?? null;
  const roomPreferences = useRoomPreferences(actorId);

  const streamRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamContactRef = useRef(false);
  useEffect(
    () => () => {
      if (streamRefreshTimerRef.current) clearTimeout(streamRefreshTimerRef.current);
    },
    [],
  );

  const stream = useActorStream({
    token: live ? (session.session?.token ?? null) : null,
    onEvent: useCallback(
      (event: ActorStreamEvent) => {
        // 首次 ack 由初始 rooms_list 覆盖；重连才补拉，避免搜索/分类期间
        // 迟到的刷新把“只过滤已加载会话”变成额外工具调用。
        if (event.type === 'ack' && !event.reconnect) return;
        if (event.type === 'event' && event.source === 'contact') {
          streamContactRef.current = true;
        }
        // 同一 300ms 窗口内的多 item 只刷新一次会话列表。
        if (streamRefreshTimerRef.current) return;
        streamRefreshTimerRef.current = setTimeout(() => {
          streamRefreshTimerRef.current = null;
          void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) });
          // 好友申请只随 contact 事件变化；普通消息不重复拉申请列表。
          if (!streamContactRef.current) return;
          streamContactRef.current = false;
          void queryClient.invalidateQueries({
            queryKey: queryKeys.contactRequests(actorId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.contactRequestBadge(actorId),
          });
        }, LIMITS.webRefreshDebounceMs);
      },
      [actorId, queryClient],
    ),
  });

  const changeContacts = useCallback((open: boolean) => {
    setContactsOpen(open);
    if (open) return;
    requestAnimationFrame(() => {
      document.getElementById('contact-requests')?.focus();
    });
  }, []);

  const rooms = useMemo(
    () => filterRooms(roomsState.rooms, filter, query, roomPreferences.preferences),
    [roomsState.rooms, filter, query, roomPreferences.preferences],
  );

  const status: SidebarStatus =
    session.status === 'loading'
      ? 'loading'
      : session.status === 'logged-out'
        ? 'logged-out'
        : session.status === 'credential-invalid'
          ? 'credential-invalid'
          : session.status === 'error' || (roomsState.error && rooms.length === 0)
            ? 'error'
            : 'ready';

  const retry = useCallback(() => {
    if (session.status === 'loading') return;
    if (session.status !== 'ready') {
      void queryClient.refetchQueries({ queryKey: queryKeys.session() });
      return;
    }
    void roomsState.refetch();
  }, [queryClient, roomsState, session.status]);

  return (
    <>
      <Sidebar
        me={session.session?.identity ?? null}
        rooms={rooms}
        status={status}
        error={session.error ?? roomsState.error}
        query={query}
        filter={filter}
        hasMore={roomsState.hasMore}
        loadingMore={roomsState.loadingMore}
        loadMoreError={roomsState.loadMoreError}
        streamError={live ? stream.error : streamError}
        preferences={roomPreferences.preferences}
        notice={notice}
        onQueryChange={setQuery}
        onFilterChange={changeFilter}
        onCreateGroup={() => setGroupOpen(true)}
        onOpenContacts={() => setContactsOpen(true)}
        onRetry={retry}
        onLoadMore={() => {
          void roomsState.loadMore();
        }}
      />
      <GroupCreateDialog open={groupOpen} onOpenChange={setGroupOpen} />
      <ContactRequestsDialog open={contactsOpen} onOpenChange={changeContacts} />
    </>
  );
}
