import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { LIMITS } from '../../contracts/limits';
import { useActorStream } from '../app/mcp/useActorStream';
import {
  mergeTimelineItems,
  nextOlderCursor,
  reverseChronological,
  type HistoryItem,
  type HistoryPage,
  type RoomDetail,
} from '../lib/chat';
import type { WebSession } from '../lib/identity';
import { callTool, type McpError } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import type { RoomsPage } from '../lib/rooms';
import { useWebSession } from './useWebSession';

/**
 * 房间会话状态：metadata、成员、历史、实时刷新与已读。
 *
 * 服务端状态由 React Query 持有：
 * - `network_room_get` 与 `network_history_list` 是只读查询；
 * - SSE 只触发失效，查询重读后才更新页面；
 * - 翻页与已读是 mutation，成功后写回对应缓存。
 *
 * 历史合并规则保持 4B-2 的语义：按 timeline 补读、稳定 key 去重、刷新时
 * 不丢已加载的旧页。
 */

export interface RoomChatState {
  status: 'loading' | 'ready' | 'error';
  session: WebSession | null;
  detail: RoomDetail | null;
  items: HistoryItem[];
  error: string | null;
  refreshError: string | null;
  olderError: string | null;
  olderLoading: boolean;
  olderEnded: boolean;
  hasOlder: boolean;
}

interface HistoryCache {
  items: HistoryItem[];
  nextOlder: string | null;
  olderEnded: boolean;
  olderLoaded: boolean;
  resumeCursor: string | null;
}

function failureMessage(error: unknown): string {
  const failure = error as McpError;
  return failure.message || '读取会话失败';
}

function fatalError(error: unknown): boolean {
  if (!error) return false;
  const failure = error as McpError;
  return failure.code === 'CREDENTIAL_INVALID' || failure.code === 'LOGGED_OUT';
}

function historyArgs(roomId: string, humanTimeline: boolean, cursor?: string | null) {
  const args: Record<string, unknown> = {
    room_id: roomId,
    direction: 'before',
    limit: LIMITS.historyPageDefault,
  };
  if (cursor) args.cursor = cursor;
  if (humanTimeline) args.view = 'timeline';
  return args;
}

/**
 * 最新页与已加载页之间可能隔着多页消息。按 `timeline_resume_cursor` 补读，
 * 直到追到本轮 snapshot，避免离线/后台标签页一次收到大量事件时漏消息。
 */
async function catchUpTimeline(
  token: string,
  roomId: string,
  snapshot: string,
  resumeCursor: string,
  latest: HistoryItem[],
  signal: AbortSignal,
): Promise<HistoryItem[]> {
  let target: bigint;
  try {
    target = BigInt(snapshot);
  } catch {
    return latest;
  }
  let merged = latest.slice();
  let cursor = resumeCursor;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await callTool<HistoryPage>(
      'network_history_list',
      { room_id: roomId, view: 'timeline', direction: 'after', cursor, limit: LIMITS.historyPageMax },
      { token, signal },
    );
    const items = page.timeline_items ?? [];
    merged = mergeTimelineItems(merged, items);
    const last = items[items.length - 1];
    const reached =
      last !== undefined &&
      BigInt(last.kind === 'presence' ? last.timeline_seq : last.created_seq) >= target;
    if (!page.timeline_has_more || reached) return merged;
    if (!page.timeline_next_cursor || page.timeline_next_cursor === cursor) return merged;
    cursor = page.timeline_next_cursor;
  }
  return merged;
}

export function useRoomChat(roomId: string) {
  const queryClient = useQueryClient();
  const sessionState = useWebSession();
  const session = sessionState.session;
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;
  const humanTimeline = session?.identity.kind === 'human';
  const detailKey = queryKeys.room(roomId);
  const historyKey = queryKeys.history(roomId, humanTimeline);

  const detailQuery = useQuery({
    queryKey: detailKey,
    enabled: Boolean(token),
    queryFn: ({ signal }) =>
      callTool<RoomDetail>('network_room_get', { room_id: roomId }, { token: token ?? undefined, signal }),
  });

  const historyQuery = useQuery({
    queryKey: historyKey,
    enabled: Boolean(token),
    queryFn: async ({ client, signal, queryKey }) => {
      const previous = client.getQueryData<HistoryCache>(queryKey) ?? null;
      const page = await callTool<HistoryPage>(
        'network_history_list',
        historyArgs(roomId, humanTimeline),
        { token: token ?? undefined, signal },
      );
      let incoming = reverseChronological(page, humanTimeline);
      if (
        humanTimeline &&
        page.timeline_resume_cursor &&
        previous?.resumeCursor &&
        page.timeline_resume_cursor !== previous.resumeCursor &&
        page.timeline_snapshot
      ) {
        incoming = await catchUpTimeline(
          token ?? '',
          roomId,
          page.timeline_snapshot,
          previous.resumeCursor,
          incoming,
          signal,
        );
      }
      const items = previous ? mergeTimelineItems(previous.items, incoming) : incoming;
      let nextOlder: string | null;
      let olderEnded: boolean;
      if (previous) {
        nextOlder = previous.olderLoaded
          ? previous.nextOlder
          : nextOlderCursor(page, humanTimeline);
        olderEnded = previous.olderLoaded ? previous.olderEnded : nextOlder === null;
      } else {
        nextOlder = nextOlderCursor(page, humanTimeline);
        olderEnded = nextOlder === null;
      }
      return {
        items,
        nextOlder,
        olderEnded,
        olderLoaded: previous?.olderLoaded ?? false,
        resumeCursor: page.timeline_resume_cursor ?? previous?.resumeCursor ?? null,
      } satisfies HistoryCache;
    },
  });

  const older = useMutation({
    mutationFn: async () => {
      const state = queryClient.getQueryData<HistoryCache>(historyKey);
      const cursor = state?.nextOlder ?? null;
      if (!cursor) throw new Error('已经到最早的消息了');
      const page = await callTool<HistoryPage>(
        'network_history_list',
        historyArgs(roomId, humanTimeline, cursor),
        { token: token ?? undefined },
      );
      return { page, cursor };
    },
    onSuccess: ({ page, cursor }) => {
      queryClient.setQueryData<HistoryCache>(historyKey, (previous) => {
        if (!previous) return previous;
        const incoming = reverseChronological(page, humanTimeline);
        const merged = mergeTimelineItems(previous.items, incoming);
        const next = nextOlderCursor(page, humanTimeline);
        const nextOlder = next && next !== cursor ? next : null;
        return {
          ...previous,
          items: merged,
          nextOlder,
          olderLoaded: true,
          olderEnded: nextOlder === null,
        };
      });
    },
  });

  const lastMarkedRef = useRef<string | null>(null);
  const markReadMutation = useMutation({
    mutationFn: (throughSeq: string) =>
      callTool(
        'network_room_mark_read',
        { room_id: roomId, through_seq: throughSeq },
        { token: token ?? undefined },
      ),
    onSuccess: (_result, throughSeq) => {
      queryClient.setQueryData<RoomDetail>(detailKey, (previous) =>
        previous
          ? { ...previous, room: { ...previous.room, my_last_read_seq: throughSeq } }
          : previous,
      );
      const actorId = session?.identity.actor_id ?? null;
      queryClient.setQueryData<InfiniteData<RoomsPage, string | null>>(
        queryKeys.rooms(actorId),
        (previous) =>
          previous
            ? {
                ...previous,
                pages: previous.pages.map((page) => ({
                  ...page,
                  items: page.items.map((room) =>
                    room.room_id === roomId
                      ? { ...room, my_last_read_seq: throughSeq }
                      : room,
                  ),
                })),
              }
            : previous,
      );
    },
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) {
      await queryClient.refetchQueries({ queryKey: queryKeys.session() });
      return;
    }
    await Promise.all([detailQuery.refetch(), historyQuery.refetch()]);
  }, [detailQuery, historyQuery, queryClient, token]);

  const load = useCallback(async (): Promise<void> => {
    if (!token) {
      await queryClient.refetchQueries({ queryKey: queryKeys.session() });
      return;
    }
    await refresh();
  }, [queryClient, refresh, token]);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contactRefreshRef = useRef(false);
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  /**
   * SSE 只给“某处变了”的提示；300ms 合并后让查询自己重读权威状态。
   * 桌面聊天页的侧栏与 Home 共用 `useRooms`，同一事件也要失效会话列表；
   * contact 事件额外刷新好友申请角标，避免第二条 subscriptions/listen。
   */
  const scheduleRefresh = useCallback(
    (source: string) => {
      if (!token) return;
      if (source === 'contact') contactRefreshRef.current = true;
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void queryClient.invalidateQueries({ queryKey: detailKey });
        void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) });
        // 文件面板可见时才存在活动查询；不可见时仅标脏，不额外发请求。
        void queryClient.invalidateQueries({ queryKey: queryKeys.roomFiles(roomId) });
        if (contactRefreshRef.current) {
          contactRefreshRef.current = false;
          void queryClient.invalidateQueries({
            queryKey: queryKeys.contactRequests(actorId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.contactRequestBadge(actorId),
          });
        }
      }, LIMITS.webRefreshDebounceMs);
    },
    [actorId, detailKey, queryClient, roomId, token],
  );

  const stream = useActorStream({ token, onEvent: scheduleRefresh });

  const loadOlder = useCallback(async (): Promise<void> => {
    if (older.isPending) return;
    await older.mutateAsync().catch(() => undefined);
  }, [older]);

  const markRead = useCallback(
    async (throughSeq: string): Promise<void> => {
      if (!token || !throughSeq) return;
      if (lastMarkedRef.current === throughSeq) return;
      lastMarkedRef.current = throughSeq;
      await markReadMutation.mutateAsync(throughSeq).catch(() => {
        lastMarkedRef.current = null;
      });
    },
    [markReadMutation, token],
  );

  const detail = detailQuery.data ?? null;
  const history = historyQuery.data ?? null;
  const fatal =
    sessionState.status === 'logged-out' ||
    sessionState.status === 'credential-invalid' ||
    fatalError(detailQuery.error) ||
    fatalError(historyQuery.error);
  const initialError =
    sessionState.status === 'error' ||
    sessionState.status === 'credential-invalid' ||
    sessionState.status === 'logged-out'
      ? sessionState.error
      : (!detail || !history) && (detailQuery.error || historyQuery.error)
        ? failureMessage(detailQuery.error ?? historyQuery.error)
        : null;
  const ready = Boolean(detail && history);
  const status: RoomChatState['status'] =
    fatal || (initialError && !ready) ? 'error' : ready ? 'ready' : 'loading';

  const refreshErrorSource =
    ready && !fatal ? (detailQuery.error ?? historyQuery.error) : null;

  return {
    status,
    session,
    detail,
    items: history?.items ?? [],
    error: initialError,
    refreshError: refreshErrorSource && !fatal ? failureMessage(refreshErrorSource) : null,
    streamError: stream.error,
    olderError: older.error ? `加载更早失败：${failureMessage(older.error)}` : null,
    olderLoading: older.isPending,
    olderEnded: history?.olderEnded ?? false,
    hasOlder: Boolean(history?.nextOlder),
    load,
    refresh,
    loadOlder,
    markRead,
  } satisfies RoomChatState & {
    streamError: string | null;
    load: () => Promise<void>;
    refresh: () => Promise<void>;
    loadOlder: () => Promise<void>;
    markRead: (throughSeq: string) => Promise<void>;
  };
}
