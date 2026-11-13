import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyPane } from '../app/AppShell';
import { useActorStream } from '../app/mcp/useActorStream';
import { SplitLayout } from '../features/layout/SplitLayout';
import { ContactRequestsDialog } from '../features/overlays/ContactRequestsDialog';
import { GroupCreateDialog } from '../features/overlays/GroupCreateDialog';
import { Sidebar, type SidebarStatus } from '../features/sidebar/Sidebar';
import { useRoomPreferences } from '../hooks/useRoomPreferences';
import { useRooms } from '../hooks/useRooms';
import { useWebSession } from '../hooks/useWebSession';
import {
  friendLinkFailure,
  friendLinkReason,
  previewFriendLink,
  redeemFriendLink,
  takeFriendLinkToken,
} from '../lib/friend-link';
import { filterRooms } from '../lib/rooms';
import { queryKeys } from '../lib/query-keys';
import { useRoomFilterStore } from '../stores/ui';

/**
 * Home：会话列表、搜索、分类与空状态。
 *
 * 只读 `network_me` / `network_rooms_list`；服务端状态由 React Query 持有，
 * SSE 只失效列表查询。筛选是 UI 偏好，存 zustand 并继续写回 legacy key。
 */
export function HomePage() {
  const queryClient = useQueryClient();
  const session = useWebSession();
  const roomsState = useRooms();
  const [query, setQuery] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const filter = useRoomFilterStore((state) => state.filter);
  const changeFilter = useRoomFilterStore((state) => state.setFilter);
  const roomPreferences = useRoomPreferences(session.session?.identity.actor_id ?? null);
  const friendToken = useRef<string | null>(null);
  const friendRead = useRef(false);
  const [friendNotice, setFriendNotice] = useState<{ message: string; error: boolean } | null>(
    null,
  );

  const token = session.session?.token ?? null;
  const actorId = session.session?.identity.actor_id ?? null;

  const stream = useActorStream({
    token,
    onEvent: useCallback((source: string) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) });
      // 好友申请只随 contact 事件变化；普通消息不重复拉申请列表。
      if (source !== 'contact') return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.contactRequests(actorId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.contactRequestBadge(actorId),
      });
    }, [actorId, queryClient]),
  });

  const changeContacts = useCallback((open: boolean) => {
    setContactsOpen(open);
    if (open) return;
    requestAnimationFrame(() => {
      document.getElementById('contact-requests')?.focus();
    });
  }, []);

  useEffect(() => {
    if (friendRead.current) return;
    friendRead.current = true;
    friendToken.current = takeFriendLinkToken();
  }, []);

  useEffect(() => {
    if (!friendToken.current) return;
    if (session.status === 'logged-out' || session.status === 'credential-invalid') {
      setFriendNotice({
        message: '好友链接需要可用的浏览器身份；请先创建身份或完成设备配对后重新打开链接。',
        error: true,
      });
      friendToken.current = null;
      return;
    }
    const token = session.session?.token;
    const identity = session.session?.identity;
    if (session.status !== 'ready' || !token || !identity) return;
    const pending = friendToken.current;
    friendToken.current = null;
    void (async () => {
      try {
        const preview = await previewFriendLink(pending, token);
        if (!preview.valid) {
          setFriendNotice({ message: friendLinkReason(preview.reason), error: true });
          return;
        }
        const result = await redeemFriendLink(pending, token);
        const ownerName = result.owner?.name ?? preview.owner?.name ?? '对方';
        setFriendNotice({
          message: result.already_friends
            ? `已是好友：${ownerName}`
            : `已添加好友：${ownerName}`,
          error: false,
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.contacts(identity.actor_id) }),
        ]);
      } catch (failure) {
        setFriendNotice({ message: `添加好友失败：${friendLinkFailure(failure)}`, error: true });
      }
    })();
  }, [queryClient, session.session, session.status]);

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

  const empty: { title?: string; hint?: string } =
    session.status === 'logged-out'
      ? {
          title: '已退出登录',
          hint: '打开 Agent 分享链接，或使用已有连接提示词即可继续。',
        }
      : session.status === 'credential-invalid'
        ? {
            title: '凭据已失效',
            hint: '请用另一台已登录设备生成配对码后打开 /pair。',
          }
        : {};

  return (
    <>
      <SplitLayout
        sidebar={
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
            streamError={stream.error}
            preferences={roomPreferences.preferences}
            notice={friendNotice}
            onQueryChange={setQuery}
            onFilterChange={changeFilter}
            onCreateGroup={() => setGroupOpen(true)}
            onOpenContacts={() => setContactsOpen(true)}
            onRetry={retry}
            onLoadMore={() => {
              void roomsState.loadMore();
            }}
          />
        }
        main={<EmptyPane title={empty.title} hint={empty.hint} />}
      />
      <GroupCreateDialog open={groupOpen} onOpenChange={setGroupOpen} />
      <ContactRequestsDialog open={contactsOpen} onOpenChange={changeContacts} />
    </>
  );
}
