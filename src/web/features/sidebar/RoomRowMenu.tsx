import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useRoomMenuActions, type AgentManagementView } from '../../hooks/useRoomMenuActions';
import { useRoomPreferences } from '../../hooks/useRoomPreferences';
import { useWebSession } from '../../hooks/useWebSession';
import type { RoomDetail, RoomMember } from '../../lib/chat';
import { callTool } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import type { RoomSummary } from '../../lib/rooms';
import { AgentReissueDialog } from '../overlays/AgentReissueDialog';
import { AnnouncementDialog } from '../overlays/AnnouncementDialog';
import { LeaveRoomDialog } from '../overlays/LeaveRoomDialog';
import { MembersDialog } from '../overlays/MembersDialog';
import { RenameRoomDialog } from '../overlays/RenameRoomDialog';
import { ReportDialog } from '../overlays/ReportDialog';
import { RoomMenuItems, type RoomOverlay } from '../overlays/RoomMenu';
import { TransferDialog } from '../overlays/TransferDialog';
import { openAgentMemory } from '../memory/memory-store';

interface ContactBlockPage {
  items: {
    active: boolean;
    blocked_actor: { actor_id: string } | null;
  }[];
}

/** 用稳定 room id 找行，避免依赖 React ref 穿透 Link。 */
function findRowElement(roomId: string): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>('#room-list a[data-room-id]');
  for (const row of rows) {
    if (row.dataset.roomId === roomId) return row;
  }
  return null;
}

/**
 * 会话行右键 / 移动端长按菜单。
 *
 * 桌面右键与移动端长按 500ms 共用 Radix ContextMenu；菜单项复用
 * `RoomMenuItems` 与 `useRoomMenuActions`，与聊天头部保持同一套动作。
 * 会话详情按需读取 `network_room_get`，与 ChatPage 共用同一查询缓存；
 * 置顶/免打扰不等待详情，直接写共享偏好 store。
 */
export function RoomRowMenu({
  room,
  onStatus,
  children,
}: {
  room: RoomSummary;
  onStatus?: (message: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [overlay, setOverlay] = useState<RoomOverlay | null>(null);
  const scrollRestoreRef = useRef<{ scroller: HTMLElement; top: number } | null>(null);
  const overlayRef = useRef<RoomOverlay | null>(null);
  const memoryOpenedRef = useRef(false);
  const session = useWebSession();
  const identity = session.session?.identity ?? null;
  const token = session.session?.token ?? null;
  const preferences = useRoomPreferences(identity?.actor_id ?? null);
  const queryClient = useQueryClient();

  const setStatus = useCallback(
    (message: string) => {
      onStatus?.(message);
    },
    [onStatus],
  );

  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        memoryOpenedRef.current = false;
        // 打开时记录侧栏位置；置顶会把行移到列表顶部，关闭后必须回到
        // 用户原来的位置，而不是被焦点带回顶部。
        const scroller = findRowElement(room.room_id)?.closest<HTMLElement>('.sidebar-list');
        scrollRestoreRef.current = scroller ? { scroller, top: scroller.scrollTop } : null;
      }
      setOpen(next);
    },
    [room.room_id],
  );

  // 关闭提交时立即恢复一次。layout effect 在 DOM 重排之后、绘制之前执行，
  // 比 rAF 更早且不会被随后的用户滚动覆盖。
  useLayoutEffect(() => {
    if (open) return;
    const pending = scrollRestoreRef.current;
    scrollRestoreRef.current = null;
    if (pending?.scroller.isConnected) pending.scroller.scrollTop = pending.top;
  }, [open]);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      // 阻止 Radix 默认的 trigger.focus()：行已被置顶重排，浏览器会把它
      // 滚动到可视区域顶部。手动聚焦时关闭滚动。
      event.preventDefault();
      // 记忆弹窗接管焦点，关闭菜单时不要抢回行焦点。
      if (memoryOpenedRef.current) {
        memoryOpenedRef.current = false;
        return;
      }
      // 覆盖层（如群成员对话框）接管焦点时不抢回行焦点。
      if (!overlayRef.current) {
        findRowElement(room.room_id)?.focus({ preventScroll: true });
      }
    },
    [room.room_id],
  );

  const detailQuery = useQuery({
    queryKey: queryKeys.room(room.room_id),
    enabled: open && Boolean(token),
    queryFn: ({ signal }) =>
      callTool<RoomDetail>(
        'network_room_get',
        { room_id: room.room_id },
        { token: token ?? undefined, signal },
      ),
    retry: false,
    staleTime: 10_000,
  });
  const detail = detailQuery.data ?? null;
  const roomView = detail?.room ?? null;
  const members = useMemo(
    () => new Map((detail?.members ?? []).map((member) => [member.actor_id, member])),
    [detail],
  );
  const peer = useMemo<RoomMember | null>(() => {
    if (!roomView || roomView.kind !== 'direct' || !identity) return null;
    for (const member of members.values()) {
      if (member.actor_id !== identity.actor_id) return member;
    }
    return null;
  }, [identity, members, roomView]);

  const management = useQuery({
    queryKey: queryKeys.agentManagement(peer?.actor_id ?? null),
    enabled: Boolean(open && token && roomView?.kind === 'direct' && peer?.kind === 'agent'),
    queryFn: ({ signal }) =>
      callTool<AgentManagementView>(
        'network_agent_management_get',
        { actor_id: peer?.actor_id ?? '' },
        { token: token ?? undefined, signal },
      ),
    retry: false,
    staleTime: 10_000,
  });

  const blocks = useQuery({
    queryKey: queryKeys.contactBlocks(identity?.actor_id ?? null),
    enabled: Boolean(open && token && roomView?.kind === 'direct' && peer),
    queryFn: ({ signal }) =>
      callTool<ContactBlockPage>(
        'network_contact_blocks_list',
        { limit: 100 },
        { token: token ?? undefined, signal },
      ),
    retry: false,
    staleTime: 10_000,
  });
  const blocked = Boolean(
    peer &&
      blocks.data?.items.some(
        (item) => item.active && item.blocked_actor?.actor_id === peer.actor_id,
      ),
  );

  const actions = useRoomMenuActions({
    room: roomView,
    roomId: room.room_id,
    peer,
    identity,
    token,
    members,
    management: management.data ?? null,
    blocked,
    preferences,
    queryClient,
    setStatus,
    closeOverlays: () => setOverlay(null),
  });

  const preference = preferences.preference(room.room_id);

  return (
    <ContextMenuPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          id="room-row-menu"
          className="room-menu spa-menu"
          aria-label="会话操作"
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          {roomView ? (
            <RoomMenuItems
              Item={ContextMenuPrimitive.Item}
              Separator={ContextMenuPrimitive.Separator}
              idPrefix="room-row-menu"
              room={roomView}
              peerName={peer?.name ?? null}
              peerKind={peer?.kind ?? null}
              preference={preference}
              blocked={blocked}
              agent={
                peer?.kind === 'agent'
                  ? {
                      canManage: actions.canManageAgent === true,
                      disabled: management.data?.disabled === true,
                      canTransfer:
                        management.data?.can_transfer === true ||
                        management.data?.pending_transfer?.can_accept === true ||
                        management.data?.pending_transfer?.can_cancel === true ||
                        roomView.peer_can_manage === true,
                      canArchive: actions.canManageAgent === true,
                    }
                  : null
              }
              onOpen={setOverlay}
              onViewMemory={
                peer?.kind === 'agent'
                  ? () => {
                      memoryOpenedRef.current = true;
                      openAgentMemory(
                        { actor_id: peer.actor_id, name: peer.name },
                        { returnFocus: () => findRowElement(room.room_id) },
                      );
                    }
                  : null
              }
              onTogglePreference={actions.onTogglePreference}
              onArchive={() => void actions.onArchive()}
              onCopyPrompt={() => void actions.onCopyPrompt()}
              onToggleBlock={() => void actions.onToggleBlock()}
              onDeleteFriend={() => void actions.onDeleteFriend()}
              onToggleAgentDisabled={() => void actions.onToggleAgentDisabled()}
              onReissueToken={() => void actions.onReissueToken()}
              onDissolve={() => void actions.onDissolve()}
            />
          ) : (
            <>
              <ContextMenuPrimitive.Item
                id="room-row-menu-pin"
                className="room-menu-item"
                onSelect={() => actions.onTogglePreference('pinned')}
              >
                {preference.pinned ? '取消置顶' : '置顶聊天'}
              </ContextMenuPrimitive.Item>
              <ContextMenuPrimitive.Item
                id="room-row-menu-mute"
                className="room-menu-item"
                onSelect={() => actions.onTogglePreference('muted')}
              >
                {preference.muted ? '恢复消息提醒' : '消息免打扰'}
              </ContextMenuPrimitive.Item>
              {detailQuery.isError ? (
                <ContextMenuPrimitive.Item
                  id="room-row-menu-retry"
                  className="room-menu-item"
                  onSelect={() => void detailQuery.refetch()}
                >
                  读取会话失败，点击重试
                </ContextMenuPrimitive.Item>
              ) : (
                <ContextMenuPrimitive.Item
                  id="room-row-menu-loading"
                  className="room-menu-item"
                  disabled
                >
                  正在读取会话…
                </ContextMenuPrimitive.Item>
              )}
            </>
          )}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
      {roomView && identity && token ? (
        <>
          <MembersDialog
            open={overlay === 'members'}
            onOpenChange={(next) => setOverlay(next ? 'members' : null)}
            room={roomView}
            members={Array.from(members.values())}
            ownerTransfer={detail?.owner_transfer ?? null}
            identityId={identity.actor_id}
            token={token}
            memoryFallbackFocus={() => findRowElement(room.room_id)}
          />
          <AnnouncementDialog
            open={overlay === 'announcement'}
            onOpenChange={(next) => setOverlay(next ? 'announcement' : null)}
            room={roomView}
            token={token}
          />
          <RenameRoomDialog
            open={overlay === 'rename'}
            onOpenChange={(next) => setOverlay(next ? 'rename' : null)}
            room={roomView}
            token={token}
          />
          {peer ? (
            <ReportDialog
              open={overlay === 'report'}
              onOpenChange={(next) => setOverlay(next ? 'report' : null)}
              targetId={peer.actor_id}
              targetName={peer.name}
              roomId={roomView.room_id}
              token={token}
            />
          ) : null}
          {peer?.kind === 'agent' ? (
            <TransferDialog
              open={overlay === 'transfer'}
              onOpenChange={(next) => setOverlay(next ? 'transfer' : null)}
              agentId={peer.actor_id}
              token={token}
            />
          ) : null}
          <LeaveRoomDialog
            open={overlay === 'leave'}
            onOpenChange={(next) => setOverlay(next ? 'leave' : null)}
            room={roomView}
            token={token}
          />
          <AgentReissueDialog
            open={actions.reissue !== null}
            onOpenChange={(next) => {
              if (!next) actions.setReissue(null);
            }}
            agentName={actions.reissue?.name ?? peer?.name ?? 'Agent'}
            prompt={actions.reissue?.prompt ?? ''}
          />
        </>
      ) : null}
    </ContextMenuPrimitive.Root>
  );
}
