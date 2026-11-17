import { useCallback, useEffect, useRef, useState } from 'react';

import type { HistoryItem, RoomMember, RoomView } from '../../lib/chat';
import type { WebIdentity } from '../../lib/identity';
import { readFullMessage } from '../../lib/message-body';
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
 * 默认只使用已加载历史与列表项；当根消息预览无法定位全部 mention 时，
 * 用现有 `network_message_read` 读取一次正文后按正文顺序重排。读取失败
 * 或正文仍不可用时退回服务端 mentions 顺序。不改变 Task 状态，也不轮询。
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
  const askSequence = useRef(0);

  useEffect(() => {
    askSequence.current += 1;
    setDraftRequest(null);
  }, [roomId]);

  const taskAskPlan = useCallback(
    (item: TaskListItemView, rootText?: string | null) =>
      resolveTaskAskPlan({
        item,
        items,
        members,
        selfId: identity?.actor_id ?? null,
        rootText,
      }),
    [identity?.actor_id, items, members],
  );

  const canAskTask = useCallback(
    (item: TaskListItemView) => canAskTaskProgress(taskAskPlan(item)),
    [taskAskPlan],
  );

  const onAskTaskProgress = useCallback(
    async (item: TaskListItemView) => {
      if (!room || room.read_only || !identity) return;
      let plan = taskAskPlan(item);
      if (taskAskTargets(plan).length === 0) return;
      const sequence = ++askSequence.current;

      if (plan.needsRootBody) {
        try {
          const body = await readFullMessage(item.root_message_id);
          if (sequence !== askSequence.current) return;
          plan = taskAskPlan(item, body);
        } catch {
          if (sequence !== askSequence.current) return;
          // 正文读取失败时仍引用根消息，但按服务端 mentions 顺序兜底。
          plan = taskAskPlan(item, null);
        }
      }
      if (sequence !== askSequence.current) return;

      const targets = taskAskTargets(plan);
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
