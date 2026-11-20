import type { RefObject } from 'react';

import { ForwardDialog } from './ForwardDialog';
import type {
  HistoryMessage,
  RoomDetail,
  RoomMember,
  RoomView,
} from '../../lib/chat';
import { senderName } from '../../lib/chat';
import type { WebIdentity } from '../../lib/identity';
import type { LocateResult, SearchNavigationTarget } from '../search/message-search-types';
import { AgentReissueDialog } from '../overlays/AgentReissueDialog';
import { AnnouncementDialog } from '../overlays/AnnouncementDialog';
import { LeaveRoomDialog } from '../overlays/LeaveRoomDialog';
import { MembersDialog } from '../overlays/MembersDialog';
import { RenameAgentDialog } from '../overlays/RenameAgentDialog';
import { RenameRoomDialog } from '../overlays/RenameRoomDialog';
import { ReportDialog } from '../overlays/ReportDialog';
import type { RoomOverlay } from '../overlays/RoomMenu';
import { TransferDialog } from '../overlays/TransferDialog';
import { MessageSearchDialog } from '../tasks/MessageSearchDialog';
import { TaskTraceDialog } from '../tasks/TaskTraceDialog';
import type { TaskTraceTarget } from '../tasks/useRoomTaskController';
import type { ReissueState } from '../../hooks/useRoomMenuActions';

/**
 * 聊天页的对话框集合。
 *
 * 由 `ChatPage` 通过 `React.lazy` 在会话就绪后挂载一次；关闭弹窗只改变
 * `open`，不卸载本组件，保证 Radix `onCloseAutoFocus` 仍能回到触发按钮。
 * 同时把只被聊天页使用的四个弹窗移出入口 chunk。
 */
export function ChatDialogs({
  room,
  peer,
  identity,
  token,
  members,
  overlay,
  onOverlayChange,
  membersButtonRef,
  ownerTransfer,
  reissue,
  onReissueChange,
  renameAgentOpen,
  onRenameAgentOpenChange,
  onRenameAgentDone,
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
  onForwardSent,
}: {
  room: RoomView;
  peer: RoomMember | null;
  identity: WebIdentity;
  token: string;
  members: Map<string, RoomMember>;
  overlay: RoomOverlay | null;
  onOverlayChange: (overlay: RoomOverlay | null) => void;
  membersButtonRef: RefObject<HTMLButtonElement | null>;
  ownerTransfer: RoomDetail['owner_transfer'];
  reissue: ReissueState | null;
  onReissueChange: (value: ReissueState | null) => void;
  renameAgentOpen: boolean;
  onRenameAgentOpenChange: (open: boolean) => void;
  onRenameAgentDone: () => void;
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
  onForwardSent: (roomName: string) => void;
}) {
  return (
    <>
      <MembersDialog
        open={overlay === 'members'}
        onOpenChange={(open) => onOverlayChange(open ? 'members' : null)}
        room={room}
        members={Array.from(members.values())}
        ownerTransfer={ownerTransfer ?? null}
        identityId={identity.actor_id}
        token={token}
        returnFocusRef={membersButtonRef}
        memoryFallbackFocus={() => membersButtonRef.current}
      />
      <AnnouncementDialog
        open={overlay === 'announcement'}
        onOpenChange={(open) => onOverlayChange(open ? 'announcement' : null)}
        room={room}
        token={token}
      />
      <RenameRoomDialog
        open={overlay === 'rename'}
        onOpenChange={(open) => onOverlayChange(open ? 'rename' : null)}
        room={room}
        token={token}
      />
      {peer ? (
        <ReportDialog
          open={overlay === 'report'}
          onOpenChange={(open) => onOverlayChange(open ? 'report' : null)}
          targetId={peer.actor_id}
          targetName={peer.name}
          roomId={room.room_id}
          token={token}
        />
      ) : null}
      {peer?.kind === 'agent' ? (
        <TransferDialog
          open={overlay === 'transfer'}
          onOpenChange={(open) => onOverlayChange(open ? 'transfer' : null)}
          agentId={peer.actor_id}
          token={token}
        />
      ) : null}
      <LeaveRoomDialog
        open={overlay === 'leave'}
        onOpenChange={(open) => onOverlayChange(open ? 'leave' : null)}
        room={room}
        token={token}
      />
      <AgentReissueDialog
        open={reissue !== null}
        onOpenChange={(open) => {
          if (!open) onReissueChange(null);
        }}
        agentName={reissue?.name ?? peer?.name ?? 'Agent'}
        prompt={reissue?.prompt ?? ''}
      />
      {peer?.kind === 'agent' ? (
        <RenameAgentDialog
          open={renameAgentOpen}
          onOpenChange={onRenameAgentOpenChange}
          actorId={peer.actor_id}
          currentName={peer.name}
          token={token}
          onRenamed={onRenameAgentDone}
        />
      ) : null}
      <MessageSearchDialog
        open={searchOpen}
        onOpenChange={onSearchOpenChange}
        roomId={room.room_id}
        token={token}
        returnFocusRef={searchReturnFocusRef}
        onLocate={onLocateSearchResult}
        onOpenTask={(rootId, focusId) => {
          onSearchOpenChange(false);
          onOpenTrace(rootId, focusId);
        }}
      />
      <TaskTraceDialog
        open={taskTrace !== null}
        onOpenChange={(open) => {
          if (!open) onCloseTrace();
        }}
        roomId={room.room_id}
        rootId={taskTrace?.rootId ?? null}
        focusId={taskTrace?.focusId ?? null}
        token={token}
        onJump={onJumpToMessage}
      />
      {forwardItem ? (
        <ForwardDialog
          open
          onOpenChange={(open) => {
            if (!open) onForwardItemChange(null);
          }}
          item={forwardItem}
          senderLabel={senderName(
            forwardItem.sender_id,
            members,
            identity.name,
            identity.actor_id,
          )}
          sourceRoomId={room.room_id}
          token={token}
          onSent={onForwardSent}
        />
      ) : null}
    </>
  );
}
