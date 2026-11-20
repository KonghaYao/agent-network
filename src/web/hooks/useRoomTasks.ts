import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { LIMITS } from '../../contracts/limits';
import type { McpError } from '../lib/mcp-client';
import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { isUpdateWriteBlocked } from '../pwa/update-store';
import {
  invalidateRoomTasks,
  removeTaskRootFromCache,
  roomTasksVersion,
  subscribeRoomTasks,
} from '../lib/task-cache';
import type { TaskListPageView } from '../features/tasks/types';

const TASK_STATUS = 'open' as const;
type TaskListCache = InfiniteData<TaskListPageView, string | null>;

function failureMessage(error: unknown): string {
  return (error as McpError).message || '读取 Task 失败';
}

interface CompleteTaskInput {
  roomId: string;
  rootId: string;
  requestId: string;
}

export interface RoomTasksState {
  items: TaskListPageView['items'];
  totalCount: number | null;
  loading: boolean;
  error: string | null;
  refreshError: string | null;
  notice: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** `network_task_list` 翻页失败；列表本身仍保留上一页数据。 */
  loadMoreError: string | null;
  completingRootId: string | null;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
  complete: (input: CompleteTaskInput) => Promise<void>;
}

/**
 * 房间常驻 Task 列表：首页常驻，翻页与完成共用同一份缓存。
 *
 * query key 带 actor、授权快照与筛选，切房、切身份或权限收紧时会换成
 * 新键；旧键上的在途请求会被取消并清掉，迟到响应不能写回新房间。
 *
 * Task 集合 revision 会让 keyset 游标失效，因此列表失效不走默认的
 * “按旧 pageParams 重读所有页”，而是收到房间级信号后只重建第一页；
 * 已加载的后续页被丢弃，用户可再次“加载更多”。
 */
export function useRoomTasks({
  roomId,
  token,
  actorId,
  authorizationKey,
  enabled,
}: {
  roomId: string;
  token: string | null;
  actorId: string | null;
  authorizationKey: string;
  enabled: boolean;
}): RoomTasksState {
  const queryClient = useQueryClient();
  const listKey = useMemo(
    () => queryKeys.taskList(roomId, actorId, TASK_STATUS, authorizationKey),
    [roomId, actorId, authorizationKey],
  );
  const keyString = JSON.stringify(listKey);
  const keyRef = useRef({ string: keyString, key: listKey as readonly unknown[] });
  const identityRef = useRef({ token, actorId });
  identityRef.current = { token, actorId };
  const rebuildControllerRef = useRef<AbortController | null>(null);
  const rebuildSequenceRef = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: listKey,
    enabled: Boolean(token && roomId && enabled),
    initialPageParam: null as string | null,
    retry: false,
    // 列表只在无缓存时自动读首页；后续刷新由房间级信号重建首页。
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ pageParam, signal }) => {
      const args: Record<string, unknown> = {
        room_id: roomId,
        status: TASK_STATUS,
        limit: LIMITS.taskListPageDefault,
      };
      if (pageParam) args.cursor = pageParam;
      return callTool<TaskListPageView>('network_task_list', args, {
        token: token ?? undefined,
        signal,
      });
    },
    getNextPageParam: (last) =>
      last.has_more && last.next_cursor ? last.next_cursor : undefined,
  });

  /**
   * 从首页重建列表：不把旧 cursor 后页混进新的 Task 集合 revision。
   * 旧数据保留到新首页到达，避免计数区域闪成加载态。
   */
  const rebuildFirstPage = useCallback(async (): Promise<boolean> => {
    if (!enabled || !token) return false;
    rebuildControllerRef.current?.abort();
    const controller = new AbortController();
    rebuildControllerRef.current = controller;
    const sequence = rebuildSequenceRef.current + 1;
    rebuildSequenceRef.current = sequence;
    try {
      await queryClient.cancelQueries({ queryKey: listKey, exact: true });
      const page = await callTool<TaskListPageView>(
        'network_task_list',
        {
          room_id: roomId,
          status: TASK_STATUS,
          limit: LIMITS.taskListPageDefault,
        },
        { token, signal: controller.signal },
      );
      if (controller.signal.aborted || sequence !== rebuildSequenceRef.current) {
        return false;
      }
      queryClient.setQueryData<TaskListCache>(listKey, {
        pages: [page],
        pageParams: [null],
      });
      setRebuildError(null);
      return true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== rebuildSequenceRef.current) {
        return false;
      }
      setRebuildError(failureMessage(error));
      return false;
    } finally {
      if (rebuildControllerRef.current === controller) {
        rebuildControllerRef.current = null;
      }
    }
  }, [enabled, listKey, queryClient, roomId, token]);

  const subscribeRevision = useCallback(
    (listener: () => void) => subscribeRoomTasks(roomId, listener),
    [roomId],
  );
  const readRevision = useCallback(() => roomTasksVersion(roomId), [roomId]);
  const revision = useSyncExternalStore(subscribeRevision, readRevision, () => 0);

  // 房间/身份/授权变化：取消旧键与手动重建；旧私有预览不跨键保留。
  useEffect(() => {
    if (keyRef.current.string === keyString) return;
    const previous = keyRef.current.key;
    keyRef.current = { string: keyString, key: listKey as readonly unknown[] };
    rebuildControllerRef.current?.abort();
    rebuildSequenceRef.current += 1;
    void queryClient.cancelQueries({ queryKey: previous, exact: true });
    queryClient.removeQueries({ queryKey: previous, exact: true });
  }, [keyString, listKey, queryClient]);

  useEffect(
    () => () => {
      rebuildControllerRef.current?.abort();
      rebuildSequenceRef.current += 1;
      void queryClient.cancelQueries({ queryKey: listKey, exact: true });
    },
    [keyString, listKey, queryClient],
  );

  // 复用缓存重新进入房间时主动补一次首页；首次无数据仍由查询自身读取。
  const hasDataRef = useRef(Boolean(query.data));
  hasDataRef.current = Boolean(query.data);
  useEffect(() => {
    if (!hasDataRef.current) return;
    void rebuildFirstPage();
  }, [keyString, rebuildFirstPage]);

  // 房间级失效信号：只重建第一页，不重读旧 cursor 后页。
  const revisionRef = useRef({ key: keyString, version: revision });
  useEffect(() => {
    if (revisionRef.current.key !== keyString) {
      revisionRef.current = { key: keyString, version: revision };
      return;
    }
    if (revision === revisionRef.current.version) return;
    revisionRef.current.version = revision;
    void rebuildFirstPage();
  }, [keyString, rebuildFirstPage, revision]);

  const completeMutation = useMutation({
    mutationFn: async (input: CompleteTaskInput) => {
      if (!token) throw new Error('浏览器身份尚未初始化');
      if (isUpdateWriteBlocked()) {
        throw new Error('当前页面与服务器版本不兼容，请先更新后再完成 Task');
      }
      const result = await callTool(
        'network_task_complete',
        {
          request_id: input.requestId,
          room_id: input.roomId,
          root_message_id: input.rootId,
        },
        { token },
      );
      return { result, token, actorId };
    },
    onSuccess: async (response, input) => {
      // 旧身份的完成回执不能在切号后改写新身份的 Task 缓存。
      const current = identityRef.current;
      if (
        !current.token ||
        current.token !== response.token ||
        current.actorId !== response.actorId
      ) {
        return;
      }
      // 先取消旧请求，避免完成前的在途响应把已完成的 root 加回来。
      await queryClient.cancelQueries({
        queryKey: queryKeys.taskLists(input.roomId),
      });
      removeTaskRootFromCache(queryClient, input.roomId, input.rootId);
      await invalidateRoomTasks(queryClient, input.roomId);
    },
  });

  const items = useMemo(() => {
    const seen = new Set<string>();
    const flattened: TaskListPageView['items'] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.root_message_id)) continue;
        seen.add(item.root_message_id);
        flattened.push(item);
      }
    }
    return flattened;
  }, [query.data]);

  const totalCount = query.data?.pages[0]?.total_count ?? null;
  const loadMore = useCallback(async () => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    setNotice(null);
    try {
      // TanStack Query 默认把查询错误解析为结果；只有显式 throwOnError 才能
      // 在调用点区分 CURSOR_EXPIRED 与普通失败。
      await query.fetchNextPage({ throwOnError: true });
    } catch (error) {
      const failure = error as McpError;
      if (failure.code === 'ABORTED') return;
      if (failure.code === 'CURSOR_EXPIRED') {
        // 集合 revision 已变：回首页一次，不循环重试旧游标。
        const rebuilt = await rebuildFirstPage();
        if (rebuilt) setNotice('Task 列表已更新，已重新加载首页');
        return;
      }
      // 列表保留已加载页；错误与重试由 dock 底部的 loadMoreError 呈现。
    }
  }, [query, rebuildFirstPage]);

  const retry = useCallback(async () => {
    setNotice(null);
    setRebuildError(null);
    if (query.data) {
      await rebuildFirstPage();
      return;
    }
    await query.refetch();
  }, [query, rebuildFirstPage]);

  const complete = useCallback(
    async (input: CompleteTaskInput) => {
      await completeMutation.mutateAsync(input);
    },
    [completeMutation],
  );

  return {
    items,
    totalCount,
    loading: query.isLoading && !query.data,
    error: !query.data && query.isError ? failureMessage(query.error) : null,
    refreshError:
      rebuildError ??
      (query.data && query.isError && !query.isFetchNextPageError
        ? failureMessage(query.error)
        : null),
    notice,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMoreError: query.isFetchNextPageError ? failureMessage(query.error) : null,
    completingRootId: completeMutation.isPending
      ? completeMutation.variables?.rootId ?? null
      : null,
    loadMore,
    retry,
    complete,
  };
}
