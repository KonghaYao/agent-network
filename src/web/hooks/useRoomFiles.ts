import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { LIMITS } from '../../contracts/limits';
import { currentIdentityEpoch } from '../lib/identity-epoch';
import { callTool, mcpError } from '../lib/mcp-client';
import {
  fileKey,
  type RoomFileItem,
  type RoomFilePage,
} from '../lib/files-ui';
import { queryKeys } from '../lib/query-keys';

const PAGE_LIMIT = 30;

export type RoomFileKind = 'all' | 'image' | 'document' | 'other';

export interface RoomFilesFilter {
  /** 文件名子串；空串表示不过滤。 */
  query: string;
  kind: RoomFileKind;
}

export const EMPTY_ROOM_FILES_FILTER: RoomFilesFilter = { query: '', kind: 'all' };

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
 * `query` 在输入停止 300ms 后才发请求；`kind` 立即生效。筛选条件进入
 * queryKey，切换时从第一页重新读取；SSE 仍按房间前缀失效全部筛选变体。
 *
 * SSE 只让 `roomFiles` 查询失效；没有可见的查询时 React Query 不会发请求。
 */
export function useRoomFiles(
  roomId: string,
  token: string | null,
  enabled: boolean,
  filter: RoomFilesFilter = EMPTY_ROOM_FILES_FILTER,
): RoomFilesState {
  const queryClient = useQueryClient();
  const rawQuery = filter.query.trim();
  const [query, setQuery] = useState(rawQuery);

  useEffect(() => {
    if (rawQuery === '') {
      setQuery('');
      return undefined;
    }
    const timer = window.setTimeout(
      () => setQuery(rawQuery),
      LIMITS.webMessageSearchDebounceMs,
    );
    return () => window.clearTimeout(timer);
  }, [rawQuery]);

  const kind = filter.kind;
  // 清空输入立即生效；输入中的新关键词仍等防抖，避免每敲一个字发请求。
  const effectiveQuery = rawQuery === '' ? '' : query;
  const queryKey = [...queryKeys.roomFiles(roomId), effectiveQuery, kind] as const;
  const queryResult = useInfiniteQuery({
    queryKey,
    enabled: Boolean(token && enabled),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const requestEpoch = currentIdentityEpoch();
      const page = await callTool<RoomFilePage>(
        'network_room_file_list',
        {
          room_id: roomId,
          limit: PAGE_LIMIT,
          ...(effectiveQuery ? { query: effectiveQuery } : {}),
          ...(kind === 'all' ? {} : { kind }),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { token: token ?? undefined, signal },
      );
      // 文件键不含 actor；切号后旧身份的分页响应不能填进新身份的列表。
      if (requestEpoch !== currentIdentityEpoch()) {
        throw mcpError('身份已变化，丢弃旧文件响应', 'STALE_CONTEXT');
      }
      return page;
    },
    getNextPageParam: (page) =>
      page.has_more && page.next_cursor ? page.next_cursor : undefined,
  });

  const items: RoomFileItem[] = [];
  const seen = new Set<string>();
  for (const page of queryResult.data?.pages ?? []) {
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
    if (!queryResult.hasNextPage || queryResult.isFetchingNextPage) return;
    await queryResult.fetchNextPage();
  }, [queryResult]);

  const failure = queryResult.error as { message?: string } | null;
  const moreFailure = queryResult.isFetchNextPageError
    ? (queryResult.error as { message?: string } | null)
    : null;

  return {
    items,
    loading: queryResult.isPending,
    error: failure?.message || null,
    hasMore: Boolean(queryResult.hasNextPage),
    loadingMore: queryResult.isFetchingNextPage,
    loadMoreError: moreFailure?.message || null,
    refresh,
    loadMore,
  };
}
