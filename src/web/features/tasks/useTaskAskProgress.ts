import { useCallback, useEffect, useState } from 'react';

import type { HistoryItem, RoomMember, RoomView } from '../../lib/chat';
import type { WebIdentity } from '../../lib/identity';
import type { ComposerDraftRequest, ComposerReply } from '../chat/Composer';
import {
  buildTaskAskDraft,
  canAskTaskProgress,
  resolveTaskAskPlan,
  taskAskSelections,
  taskAskTargets,
} from './task-ask';
import type { TaskListItemView } from './types';

/**
 * Task dock「询问进度」的页面接线：引用根消息、写入草稿请求、只读保护。
 *
 * 不调用工具、不改变 Task 状态；目标解析全部来自已加载历史与列表项。
 */
export function useTaskAskProgress({
  roomId,
  room,
  items,
  members,
  identity,
  setReply,
}: {
  roomId: string;
  room: RoomView | null;
  items: HistoryItem[];
  members: Map<string, RoomMember>;
  identity: WebIdentity | null;
  setReply: (reply: ComposerReply | null) => void;
}) {
  const [draftRequest, setDraftRequest] = useState<ComposerDraftRequest | null>(null);

  useEffect(() => {
    setDraftRequest(null);
  }, [roomId]);

  const taskAskPlan = useCallback(
    (item: TaskListItemView) =>
      resolveTaskAskPlan({
        item,
        items,
        members,
        selfId: identity?.actor_id ?? null,
      }),
    [identity?.actor_id, items, members],
  );

  const canAskTask = useCallback(
    (item: TaskListItemView) => canAskTaskProgress(taskAskPlan(item)),
    [taskAskPlan],
  );

  const onAskTaskProgress = useCallback(
    (item: TaskListItemView) => {
      if (!room || room.read_only || !identity) return;
      const targets = taskAskTargets(taskAskPlan(item));
      if (targets.length === 0) return;
      const rootSender =
        item.root_sender_id === identity.actor_id
          ? '我'
          : members.get(item.root_sender_id)?.name ??
            item.root_sender_name ??
            item.root_sender_id;
      setReply({
        messageId: item.root_message_id,
        label: `${rootSender}：${item.preview.slice(0, 120)}`,
        mention: null,
      });
      setDraftRequest({
        text: buildTaskAskDraft(targets),
        selections: taskAskSelections(targets),
      });
      // Composer 的草稿 effect 会把光标移到末尾；这里先保证焦点进入输入框。
      document.getElementById('body')?.focus();
    },
    [identity, members, room, setReply, taskAskPlan],
  );

  const clearDraftRequest = useCallback(() => setDraftRequest(null), []);

  return { draftRequest, canAskTask, onAskTaskProgress, clearDraftRequest };
}
