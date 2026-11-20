import { useQueryClient } from '@tanstack/react-query';
import { Component, lazy, Suspense, type ReactNode, type RefObject } from 'react';

import type {
  HistoryMessage,
  RoomDetail,
  RoomMember,
  RoomView,
} from '../../lib/chat';
import type { WebIdentity } from '../../lib/identity';
import type { LocateResult, SearchNavigationTarget } from '../search/message-search-types';
import { queryKeys } from '../../lib/query-keys';
import type { RoomOverlay } from '../overlays/RoomMenu';
import type { TaskTraceTarget } from '../tasks/useRoomTaskController';

const ChatDialogs = lazy(() =>
  import('./ChatDialogs').then((module) => ({ default: module.ChatDialogs })),
);

/** chunk 加载失败时保持聊天可用；关闭弹窗不会卸载该边界。 */
class ChatDialogsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface ChatDialogsMountProps {
  room: RoomView;
  peer: RoomMember | null;
  identity: WebIdentity;
  token: string;
  members: Map<string, RoomMember>;
  overlay: RoomOverlay | null;
  onOverlayChange: (overlay: RoomOverlay | null) => void;
  membersButtonRef: RefObject<HTMLButtonElement | null>;
  ownerTransfer: RoomDetail['owner_transfer'];
  roomActions: {
    reissue: { name: string; prompt: string } | null;
    setReissue: (value: { name: string; prompt: string } | null) => void;
    renameAgentOpen: boolean;
    setRenameAgentOpen: (open: boolean) => void;
  };
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  searchReturnFocusRef: RefObject<HTMLElement | null>;
  onLocateSearchResult: (target: SearchNavigationTarget) => Promise<LocateResult>;
  onOpenTrace: (rootId: string, focusId: string | null) => void;
  taskTrace: TaskTraceTarget | null;
  onCloseTrace: () => void;
  onJumpToMessage: (messageId: string) => void;
  forwardItem: HistoryMessage | null;
  onForwardItemChange: (item: HistoryMessage | null) => void;
  invalidateTasks: () => void;
  setStatus: (message: string) => void;
}

/**
 * 聊天对话框的懒加载宿主。
 *
 * 会话就绪后挂载一次并保持，弹窗开关只改变 `open`；因此 Radix 关闭时的
 * `onCloseAutoFocus` 仍能回到触发按钮。chunk 失败由边界降级为空。
 */
export function ChatDialogsMount({
  room,
  peer,
  identity,
  token,
  members,
  overlay,
  onOverlayChange,
  membersButtonRef,
  ownerTransfer,
  roomActions,
  searchOpen,
  onSearchOpenChange,
  searchReturnFocusRef,
  onLocateSearchResult,
  onOpenTrace,
  taskTrace,
  onCloseTrace,
  onJumpToMessage,
  forwardItem,
  onForwardItemChange,
  invalidateTasks,
  setStatus,
}: ChatDialogsMountProps) {
  const queryClient = useQueryClient();

  return (
    <ChatDialogsBoundary>
      <Suspense fallback={null}>
        <ChatDialogs
          room={room}
          peer={peer}
          identity={identity}
          token={token}
          members={members}
          overlay={overlay}
          onOverlayChange={onOverlayChange}
          membersButtonRef={membersButtonRef}
          ownerTransfer={ownerTransfer}
          reissue={roomActions.reissue}
          onReissueChange={roomActions.setReissue}
          renameAgentOpen={roomActions.renameAgentOpen}
          onRenameAgentOpenChange={roomActions.setRenameAgentOpen}
          onRenameAgentDone={() => {
            setStatus('已更新 Agent 名称');
            invalidateTasks();
            void queryClient.invalidateQueries({
              queryKey: queryKeys.room(room.room_id),
            });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.rooms(identity.actor_id),
            });
          }}
          searchOpen={searchOpen}
          onSearchOpenChange={onSearchOpenChange}
          searchReturnFocusRef={searchReturnFocusRef}
          onLocateSearchResult={onLocateSearchResult}
          onOpenTrace={onOpenTrace}
          taskTrace={taskTrace}
          onCloseTrace={onCloseTrace}
          onJumpToMessage={onJumpToMessage}
          forwardItem={forwardItem}
          onForwardItemChange={onForwardItemChange}
          onForwardSent={(roomName) => {
            setStatus(`已转发给 ${roomName}`);
            void queryClient.invalidateQueries({
              queryKey: queryKeys.rooms(identity.actor_id),
            });
          }}
        />
      </Suspense>
    </ChatDialogsBoundary>
  );
}
