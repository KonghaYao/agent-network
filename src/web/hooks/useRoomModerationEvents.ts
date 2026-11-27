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

/** 服务端已提交撤回后，页面收敛搜索 anchor、回复与转发引用。 */
interface RoomModerationEventsOptions {
  room: RoomView | null;
  pinnedMessages: PinnedMessage[];
  identityId: string | null;
  token: string | null;
  onStatus: (message: string) => void;
  refreshModeration: (options: ModerationRefresh) => Promise<void>;
  replyMessageId: string | null;
  setReply: Dispatch<SetStateAction<ComposerReply | null>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setForwardItem: Dispatch<SetStateAction<HistoryMessage | null>>;
}

export interface RoomModerationEvents {
  /** 丢弃 anchor 窗口后递增，让 Timeline 复位滚动而不是滚底。 */
  scrollResetToken: number;
  /** 搜索定位控制器在 moderation 之后创建；撤回事件通过 ref 读取。 */
  searchNavRef: RefObject<ReturnType<typeof useChatSearchNavigation> | null>;
  onChatEvent: (event: ChatEvent) => void;
  moderation: RoomMessageModeration;
}

/**
 * 撤回事件的收敛入口：搜索 anchor 与本地引用。
 *
 * anchor 窗口不在 React Query 里，SSE 的 recalled 提示无法靠历史刷新收敛；
 * 收到事件时由搜索导航丢弃窗口并返回被撤回的消息。
 * 本地撤回走同一条路径，并额外清理回复与转发引用。
 */
export function useRoomModerationEvents({
  room,
  pinnedMessages,
  identityId,
  token,
  onStatus,
  refreshModeration,
  replyMessageId,
  setReply,
  setSearchOpen,
  setForwardItem,
}: RoomModerationEventsOptions): RoomModerationEvents {
  const [scrollResetToken, setScrollResetToken] = useState(0);
  const searchNavRef = useRef<ReturnType<typeof useChatSearchNavigation> | null>(null);

  const onChatEvent = useCallback(
    (event: ChatEvent) => {
      if (event.change !== 'recalled' || !event.messageId) return;
      if (!searchNavRef.current?.onRemoteRecall(event.messageId)) return;
      setScrollResetToken((value) => value + 1);
    },
    [],
  );

  const onRecalled = useCallback(
    (item: HistoryMessage) => {
      if (replyMessageId !== null && replyMessageId === item.message_id) setReply(null);
      setSearchOpen(false);
      setForwardItem((current) =>
        current?.message_id === item.message_id ? null : current,
      );
      // 本地撤回与远端事件走同一条 anchor 收敛路径。
      if (searchNavRef.current?.onRemoteRecall(item.message_id)) {
        setScrollResetToken((value) => value + 1);
      }
    },
    [replyMessageId, setForwardItem, setReply, setSearchOpen],
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
