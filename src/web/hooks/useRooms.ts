import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { summarizeRoom, type RoomSummary, type RoomsPage } from '../lib/rooms';
import { useWebSession } from './useWebSession';

const PAGE_SIZE = 50;

function mergeRooms(current: RoomSummary[], incoming: RoomSummary[]): RoomSummary[] {
  const seen = new Set(current.map((room) => room.room_id));
  const merged = current.slice();
  for (const room of incoming) {
    if (seen.has(room.room_id)) continue;
    seen.add(room.room_id);
    merged.push(room);
  }
  return merged;
}

export interface RoomsState {
  rooms: RoomSummary[];
  /** 服务端指定顺序下的全部已加载会话；过滤/排序由页面完成。 */
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
  refetch: () => Promise<unknown>;
  loadMore: () => Promise<unknown>;
}

/**
 * 会话列表：游标分页的只读 server state。
 *
 * 后台刷新（SSE ack 或新事件）调用 `refetch`，React Query 会重读所有已
 * 加载页；这比旧实现只替换第一页更简单，也不会丢失用户翻过的页。
 */
export function useRooms(): RoomsState {
  const { session } = useWebSession();
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;

  const query = useInfiniteQuery({
    queryKey: queryKeys.rooms(actorId),
    enabled: Boolean(token),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      callTool<RoomsPage>(
        'network_rooms_list',
        pageParam ? { limit: PAGE_SIZE, cursor: pageParam } : { limit: PAGE_SIZE },
        { token: token ?? undefined, signal },
      ),
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
  });

  const rooms = useMemo(() => {
    const pages = query.data?.pages ?? [];
    let merged: RoomSummary[] = [];
    for (const page of pages) {
      merged = mergeRooms(merged, page.items.map(summarizeRoom));
    }
    return merged;
  }, [query.data]);

  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const failure = query.error as { message?: string } | null;

  return {
    rooms,
    hasMore: Boolean(lastPage?.has_more && lastPage.next_cursor),
    loadingMore: query.isFetchingNextPage,
    error: query.data ? null : failure?.message || '读取会话失败',
    loadMoreError:
      query.isFetchNextPageError && failure?.message
        ? failure.message
        : null,
    refetch: () => query.refetch(),
    loadMore: () => query.fetchNextPage(),
  };
}
