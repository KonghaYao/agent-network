import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { ActorStreamEvent } from '../app/mcp/useActorStream';
import type { ComposerReply } from '../features/chat/Composer';
import type { useChatSearchNavigation } from '../features/search/useChatSearchNavigation';
import type { HistoryMessage, PinnedMessage, RoomView } from '../lib/chat';
import type { ModerationRefresh } from './useRoomChat';
import {
  useRoomMessageModeration,
  type RoomMessageModeration,
} from './useRoomMessageModeration';

type ChatEvent = Extract<ActorStreamEvent, { type: 'event' }>;

/** 服务端已提交撤回后，页面按消息是否带 Task 标记收敛 anchor 与 Task 列表。 */
interface RoomModerationEventsOptions {
  room: RoomView | null;
  pinnedMessages: PinnedMessage[];
  identityId: string | null;
  token: string | null;
  onStatus: (message: string) => void;
  refreshModeration: (options: ModerationRefresh) => Promise<void>;
  taskTraceRootId: string | null;
  onCloseTrace: () => void;
  replyMessageId: string | null;
  setReply: Dispatch<SetStateAction<ComposerReply | null>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setForwardItem: Dispatch<SetStateAction<HistoryMessage | null>>;
  invalidateTasks: () => void;
}

export interface RoomModerationEvents {
  /** 丢弃 anchor 窗口后递增，让 Timeline 复位滚动而不是滚底。 */
  scrollResetToken: number;
  /** 搜索定位控制器在 Task 控制器之后创建；撤回事件通过 ref 读取。 */
  searchNavRef: RefObject<ReturnType<typeof useChatSearchNavigation> | null>;
  onChatEvent: (event: ChatEvent) => void;
  moderation: RoomMessageModeration;
}

/**
 * 撤回事件的收敛入口：搜索 anchor 与 Task Dock。
 *
 * anchor 窗口不在 React Query 里，SSE 的 recalled 提示无法靠历史刷新收敛；
 * 收到事件时由搜索导航丢弃窗口并返回被撤回的消息。只有该消息带
 * `task_root_id` 时才重读 Task 列表，普通 anchor 消息撤回保持零请求。
 * 本地撤回走同一条路径，并额外清理回复、转发与 Trace 引用。
 */
export function useRoomModerationEvents({
  room,
  pinnedMessages,
  identityId,
  token,
  onStatus,
  refreshModeration,
  taskTraceRootId,
  onCloseTrace,
  replyMessageId,
  setReply,
  setSearchOpen,
  setForwardItem,
  invalidateTasks,
}: RoomModerationEventsOptions): RoomModerationEvents {
  const [scrollResetToken, setScrollResetToken] = useState(0);
  const searchNavRef = useRef<ReturnType<typeof useChatSearchNavigation> | null>(null);

  const onChatEvent = useCallback(
    (event: ChatEvent) => {
      if (event.change !== 'recalled' || !event.messageId) return;
      const discarded = searchNavRef.current?.onRemoteRecall(event.messageId) ?? null;
      if (!discarded) return;
      setScrollResetToken((value) => value + 1);
      // 服务端 preview 已变成墓碑；带 Task 标记时必须让 Dock 重读权威列表。
      if (discarded.task_root_id) invalidateTasks();
    },
    [invalidateTasks],
  );

  const onRecalled = useCallback(
    (item: HistoryMessage) => {
      if (taskTraceRootId !== null && taskTraceRootId === item.message_id) onCloseTrace();
      if (replyMessageId !== null && replyMessageId === item.message_id) setReply(null);
      setSearchOpen(false);
      setForwardItem((current) =>
        current?.message_id === item.message_id ? null : current,
      );
      // 本地撤回与远端事件走同一条 anchor 收敛路径。
      if (searchNavRef.current?.onRemoteRecall(item.message_id)) {
        setScrollResetToken((value) => value + 1);
      }
      // 普通消息撤回不触碰 Task 列表；只有带 Task 标记的消息才可能改变任务。
      if (item.task_root_id) invalidateTasks();
    },
    [
      invalidateTasks,
      onCloseTrace,
      replyMessageId,
      setForwardItem,
      setReply,
      setSearchOpen,
      taskTraceRootId,
    ],
  );

  const moderation = useRoomMessageModeration({
    room,
    pinnedMessages,
    identityId,
    token,
    onStatus,
    onRecalled,
    refreshModeration,
  });

  return { scrollResetToken, searchNavRef, onChatEvent, moderation };
}
