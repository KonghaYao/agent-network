import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import type { HistoryMessage, RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { invalidateRoomTasks } from '../../lib/task-cache';

export interface TaskTraceTarget {
  rootId: string;
  focusId: string | null;
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

/**
 * Task 相关的页面级状态：Trace 目标、mark/unmark 与统一失效入口。
 *
 * 从 ChatPage 抽出后，页面只负责把 Timeline 与 dock 接上，不再持有 Task
 * 读写细节。mark/unmark 成功后主动失效，不依赖 SSE 回声。
 */
export function useRoomTaskController({
  roomId,
  room,
  token,
  onStatus,
}: {
  roomId: string;
  room: RoomView | null;
  token: string | null;
  onStatus: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [trace, setTrace] = useState<TaskTraceTarget | null>(null);

  useEffect(() => {
    setTrace(null);
  }, [roomId]);

  const openTrace = useCallback((rootId: string, focusId: string | null) => {
    setTrace({ rootId, focusId });
  }, []);

  const closeTrace = useCallback(() => {
    setTrace(null);
  }, []);

  const invalidateTasks = useCallback(() => {
    if (!roomId) return;
    void invalidateRoomTasks(queryClient, roomId);
  }, [queryClient, roomId]);

  const onToggleTask = useCallback(
    async (item: HistoryMessage) => {
      if (!token || !room || room.read_only) return;
      const mark = item.task_root_id !== item.message_id;
      try {
        await callTool(
          mark ? 'network_task_mark' : 'network_task_unmark',
          {
            request_id: newRequestId('web_task_mark'),
            room_id: room.room_id,
            message_id: item.message_id,
          },
          { token },
        );
        onStatus(mark ? '已标记为 Task' : '已取消 Task 标记');
        if (!mark) {
          setTrace((current) =>
            current?.rootId === item.message_id ? null : current,
          );
        }
        // 房间前缀覆盖 history/detail/summary；显式任务入口保证 dock 与 Trace
        // 不依赖这两个查询是否也被其他组件观察。
        invalidateTasks();
        await queryClient.invalidateQueries({
          queryKey: queryKeys.room(room.room_id),
        });
      } catch (error) {
        onStatus(`${mark ? '标记失败' : '取消标记失败'}：${failureText(error)}`);
      }
    },
    [invalidateTasks, onStatus, queryClient, room, token],
  );

  return {
    trace,
    openTrace,
    closeTrace,
    onToggleTask,
    invalidateTasks,
  };
}
