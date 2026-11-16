import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { queryKeys } from './query-keys';
import type { TaskListPageView } from '../features/tasks/types';

/**
 * Task 缓存的统一失效入口。
 *
 * 列表、摘要与已打开的 Trace 都由同一条通知链驱动；这里集中收口，
 * 避免页面、mutation 与 SSE 各自拼 query key。
 */

type TaskListCache = InfiniteData<TaskListPageView, string | null>;

const taskVersions = new Map<string, number>();
const taskListeners = new Map<string, Set<() => void>>();

/** 列表失效信号：让常驻列表从首页重建，而不是用旧游标重读所有页。 */
export function subscribeRoomTasks(roomId: string, listener: () => void): () => void {
  let listeners = taskListeners.get(roomId);
  if (!listeners) {
    listeners = new Set();
    taskListeners.set(roomId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = taskListeners.get(roomId);
    current?.delete(listener);
    if (current && current.size === 0) taskListeners.delete(roomId);
  };
}

export function roomTasksVersion(roomId: string): number {
  return taskVersions.get(roomId) ?? 0;
}

function notifyRoomTasks(roomId: string): void {
  taskVersions.set(roomId, roomTasksVersion(roomId) + 1);
  for (const listener of taskListeners.get(roomId) ?? []) listener();
}

function isTaskListCache(value: unknown): value is TaskListCache {
  if (!value || typeof value !== 'object') return false;
  const pages = (value as { pages?: unknown }).pages;
  return Array.isArray(pages);
}

/** 只读/只写能力或成员代次变化时，授权边界可能已经收紧。 */
export function taskAuthorizationKey(
  room:
    | {
        member_seq: string;
        policy_revision?: number;
        read_only: boolean;
      }
    | null,
): string {
  if (!room) return 'unknown';
  return `${room.member_seq}:${room.policy_revision ?? 0}:${room.read_only ? 'read-only' : 'writable'}`;
}

/** 通知后端状态可能有变：列表从首页重建，Trace 与摘要原位重读。 */
export function invalidateRoomTasks(
  client: QueryClient,
  roomId: string,
): Promise<unknown> {
  notifyRoomTasks(roomId);
  return Promise.all([
    // 无限查询的默认 refetch 会按旧 pageParams 重读所有页；Task 集合
    // revision 变化后这些游标可能已过期。列表由 useRoomTasks 收到信号后
    // 只重建首页，Trace 是普通查询，可以安全原位重读。
    client.invalidateQueries({
      queryKey: queryKeys.taskLists(roomId),
      refetchType: 'none',
    }),
    client.invalidateQueries({ queryKey: queryKeys.taskTraces(roomId) }),
    client.invalidateQueries({ queryKey: queryKeys.taskSummaries(roomId) }),
  ]);
}

/**
 * 成员代次、历史策略或归档变化后丢弃旧授权下的私有预览并重读。
 *
 * `resetQueries` 会清空当前数据并让活动查询立即重建；比单纯 remove 更
 * 适合“权限收紧后不保留跨代次内容”，也不会让已挂载的 dock 停在空数组。
 */
export function resetRoomTasks(client: QueryClient, roomId: string): Promise<unknown> {
  return Promise.all([
    client.resetQueries({ queryKey: queryKeys.roomTasks(roomId) }),
    client.resetQueries({ queryKey: queryKeys.taskSummaries(roomId) }),
  ]);
}

/**
 * 完成成功后先从本地列表移除该项，等待权威重读确认。
 *
 * 只删除明确成功的 root，不整页回写旧缓存；每页的 total_count 同步减一，
 * 折叠状态下的计数也不会短暂跳回旧值。
 */
export function removeTaskRootFromCache(
  client: QueryClient,
  roomId: string,
  rootId: string,
): void {
  client.setQueriesData<TaskListCache>(
    { queryKey: queryKeys.taskLists(roomId) },
    (current) => {
      if (!isTaskListCache(current)) return current;
      let removed = false;
      const pages = current.pages.map((page) => {
        const items = page.items.filter((item) => {
          if (item.root_message_id !== rootId) return true;
          removed = true;
          return false;
        });
        if (items.length === page.items.length) return page;
        return {
          ...page,
          items,
          total_count: Math.max(0, page.total_count - 1),
        };
      });
      if (!removed) return current;
      return { ...current, pages };
    },
  );
}
