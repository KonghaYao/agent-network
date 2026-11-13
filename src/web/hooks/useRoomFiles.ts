import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { callTool } from '../lib/mcp-client';
import {
  fileKey,
  type RoomFileItem,
  type RoomFilePage,
} from '../lib/files-ui';
import { queryKeys } from '../lib/query-keys';

const PAGE_LIMIT = 30;

export interface RoomFilesState {
  items: RoomFileItem[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * 房间文件列表：只在面板可见时启用，翻页用 cursor，不轮询。
 *
 * SSE 只让 `roomFiles` 查询失效；没有可见的查询时 React Query 不会发请求。
 */
export function useRoomFiles(
  roomId: string,
  token: string | null,
  enabled: boolean,
): RoomFilesState {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: queryKeys.roomFiles(roomId),
    enabled: Boolean(token && enabled),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      callTool<RoomFilePage>(
        'network_room_file_list',
        {
          room_id: roomId,
          limit: PAGE_LIMIT,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { token: token ?? undefined, signal },
      ),
    getNextPageParam: (page) =>
      page.has_more && page.next_cursor ? page.next_cursor : undefined,
  });

  const items: RoomFileItem[] = [];
  const seen = new Set<string>();
  for (const page of query.data?.pages ?? []) {
    for (const item of page.items ?? []) {
      const key = fileKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.roomFiles(roomId) });
  }, [queryClient, roomId]);

  const loadMore = useCallback(async () => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    await query.fetchNextPage();
  }, [query]);

  const failure = query.error as { message?: string } | null;
  const moreFailure = query.isFetchNextPageError
    ? (query.error as { message?: string } | null)
    : null;

  return {
    items,
    loading: query.isPending,
    error: failure?.message || null,
    hasMore: Boolean(query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    loadMoreError: moreFailure?.message || null,
    refresh,
    loadMore,
  };
}
