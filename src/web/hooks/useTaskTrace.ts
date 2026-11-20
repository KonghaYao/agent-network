import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { McpError } from '../lib/mcp-client';
import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import type {
  TaskSummariesPageView,
  TaskTraceItemView,
  TaskTracePageView,
  TaskTraceSummaryView,
} from '../features/tasks/types';

const PAGE = 50;

export interface TaskTraceData {
  items: TaskTraceItemView[];
  summary: TaskTraceSummaryView | null;
  nextCursor: string | null;
  prevCursor: string | null;
  hasBefore: boolean;
  hasAfter: boolean;
  count: number;
  focusMessageId: string | null;
  status: 'open' | 'completed';
  completedAt: string | null;
  completedBy: string | null;
}

export interface TaskTraceState {
  items: TaskTraceItemView[];
  summary: TaskTraceSummaryView | null;
  hasBefore: boolean;
  hasAfter: boolean;
  count: number;
  busy: boolean;
  status: string;
  error: string | null;
  loadOlder: () => Promise<void>;
  loadNewer: () => Promise<void>;
  refresh: () => Promise<void>;
}

function failureMessage(error: unknown): string {
  return (error as McpError).message || '读取 Task 明细失败';
}

function toTraceData(
  page: TaskTracePageView,
  summary: TaskTraceSummaryView | null,
): TaskTraceData {
  return {
    items: page.items ?? [],
    summary,
    nextCursor: page.next_cursor ?? null,
    prevCursor: page.prev_cursor ?? null,
    hasBefore: page.has_more_before === true && Boolean(page.prev_cursor),
    hasAfter: page.has_more_after === true && Boolean(page.next_cursor),
    count: page.message_count ?? 0,
    focusMessageId: page.focus_message_id ?? null,
    status: page.status,
    completedAt: page.completed_at ?? null,
    completedBy: page.completed_by ?? null,
  };
}

function mergePage(
  current: TaskTraceData,
  page: TaskTracePageView,
  mode: 'before' | 'after',
): TaskTraceData {
  const seen = new Set(current.items.map((item) => item.message_id));
  const incoming = (page.items ?? []).filter((item) => !seen.has(item.message_id));
  return {
    ...current,
    items: mode === 'before' ? [...incoming, ...current.items] : [...current.items, ...incoming],
    nextCursor: page.next_cursor ?? null,
    prevCursor: page.prev_cursor ?? null,
    hasBefore: page.has_more_before === true && Boolean(page.prev_cursor),
    hasAfter: page.has_more_after === true && Boolean(page.next_cursor),
    count: page.message_count ?? current.count,
    status: page.status,
    completedAt: page.completed_at ?? current.completedAt,
    completedBy: page.completed_by ?? current.completedBy,
  };
}

interface PageInput {
  key: readonly unknown[];
  roomId: string;
  rootId: string;
  cursor: string;
  mode: 'before' | 'after';
  token: string;
}

/**
 * Task Trace 的双向分页读取。
 *
 * 初始页（可带 focus_message_id）是 React Query 查询，`task.updated`、房间
 * 消息/撤回与成员变化会使其失效并原位重读；更早/更晚页按 cursor 合并回同一
 * 缓存。查询键绑定 room + root + focus，切换房间或根不会串数据。
 */
export function useTaskTrace({
  open,
  roomId,
  rootId,
  focusId,
  token,
}: {
  open: boolean;
  roomId: string;
  rootId: string | null;
  focusId: string | null;
  token: string | null;
}): TaskTraceState {
  const queryClient = useQueryClient();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const traceKey = useMemo(
    () => queryKeys.taskTrace(roomId, rootId, focusId),
    [roomId, rootId, focusId],
  );
  const keyString = JSON.stringify(traceKey);
  const keyRef = useRef({ string: keyString, key: traceKey as readonly unknown[] });

  const query = useQuery<TaskTraceData>({
    queryKey: traceKey,
    enabled: Boolean(open && token && rootId),
    retry: false,
    queryFn: async ({ signal }) => {
      const base = {
        room_id: roomId,
        root_message_id: rootId ?? '',
        limit: PAGE,
      };
      const traceArgs = focusId
        ? { ...base, focus_message_id: focusId }
        : base;
      const [page, summaries] = await Promise.all([
        callTool<TaskTracePageView>('network_task_trace', traceArgs, {
          token: token ?? undefined,
          signal,
        }),
        callTool<TaskSummariesPageView>(
          'network_task_summaries',
          { room_id: roomId, root_message_ids: [rootId ?? ''] },
          { token: token ?? undefined, signal },
        ),
      ]);
      const summary =
        summaries.items.find((entry) => entry.root_message_id === rootId) ?? null;
      return toTraceData(page, summary);
    },
  });

  useEffect(() => {
    if (keyRef.current.string === keyString) return;
    const previous = keyRef.current.key;
    keyRef.current = { string: keyString, key: traceKey as readonly unknown[] };
    void queryClient.cancelQueries({ queryKey: previous, exact: true });
  }, [keyString, traceKey, queryClient]);

  useEffect(
    () => () => {
      void queryClient.cancelQueries({ queryKey: traceKey, exact: true });
    },
    [keyString, traceKey, queryClient],
  );

  const pageMutation = useMutation({
    mutationFn: async (input: PageInput) => {
      const page = await callTool<TaskTracePageView>(
        'network_task_trace',
        {
          room_id: input.roomId,
          root_message_id: input.rootId,
          limit: PAGE,
          cursor: input.cursor,
        },
        { token: input.token },
      );
      return { page, mode: input.mode };
    },
    onSuccess: ({ page, mode }, input) => {
      // 身份切换后旧 token 的分页响应不能并入新身份的 Trace 缓存。
      if (input.token !== tokenRef.current) return;
      queryClient.setQueryData<TaskTraceData>(input.key, (current) =>
        current ? mergePage(current, page, mode) : current,
      );
    },
  });

  const loadOlder = useCallback(async () => {
    const data = query.data;
    if (!data?.prevCursor || pageMutation.isPending || !token || !rootId) return;
    await pageMutation
      .mutateAsync({
        key: traceKey,
        roomId,
        rootId,
        cursor: data.prevCursor,
        mode: 'before',
        token,
      })
      .catch(() => undefined);
  }, [pageMutation, query.data, roomId, rootId, token, traceKey]);

  const loadNewer = useCallback(async () => {
    const data = query.data;
    if (!data?.nextCursor || pageMutation.isPending || !token || !rootId) return;
    await pageMutation
      .mutateAsync({
        key: traceKey,
        roomId,
        rootId,
        cursor: data.nextCursor,
        mode: 'after',
        token,
      })
      .catch(() => undefined);
  }, [pageMutation, query.data, roomId, rootId, token, traceKey]);

  const refresh = useCallback(async () => {
    pageMutation.reset();
    await query.refetch();
  }, [pageMutation, query]);

  const errorSource = query.error ?? pageMutation.error;
  const error = errorSource ? failureMessage(errorSource) : null;
  const status = error
    ? error
    : query.isLoading
      ? '正在加载…'
      : query.isFetching || pageMutation.isPending
        ? '正在刷新…'
        : '';

  return {
    items: query.data?.items ?? [],
    summary: query.data?.summary ?? null,
    hasBefore: query.data?.hasBefore ?? false,
    hasAfter: query.data?.hasAfter ?? false,
    count: query.data?.count ?? 0,
    busy: query.isFetching || pageMutation.isPending,
    status,
    error,
    loadOlder,
    loadNewer,
    refresh,
  };
}
