import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import type { RoomView } from '../../lib/chat';

export type RoomOverlay =
  | 'members'
  | 'announcement'
  | 'rename'
  | 'report'
  | 'leave'
  | 'transfer';

/**
 * 聊天头部菜单：群成员/公告/改名/举报/退群。
 *
 * Radix 负责键盘、焦点返回与 portal 定位；入口按钮仍保留
 * `#room-menu-toggle`，菜单容器保留 `#room-menu` 供 DOM 断言使用。
 */
export function RoomMenu({
  room,
  peerName,
  onOpen,
}: {
  room: RoomView;
  peerName: string | null;
  onOpen: (overlay: RoomOverlay) => void;
}) {
  const group = room.kind === 'group';
  const canEdit = group && !room.read_only && room.capabilities?.edit_profile === true;
  const canAnnounce = group && room.capabilities?.manage_announcement === true;
  const canLeave = group && room.can_leave !== false;
  const canReport = !group && peerName !== null;
  const canTransfer = !group && room.peer_can_manage === true;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          id="room-menu-toggle"
          className="icon-btn"
          type="button"
          aria-label="会话操作"
          title="会话操作"
        >
          ···
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          id="room-menu"
          className="room-menu spa-menu"
          aria-label="会话操作"
          sideOffset={6}
          align="end"
        >
          {group ? (
            <>
              <DropdownMenuPrimitive.Item
                id="room-menu-members"
                className="room-menu-item"
                onSelect={() => onOpen('members')}
              >
                群成员
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                id="room-menu-announcement"
                className="room-menu-item"
                onSelect={() => onOpen('announcement')}
              >
                {canAnnounce ? '群公告' : '查看群公告'}
              </DropdownMenuPrimitive.Item>
              {canEdit ? (
                <DropdownMenuPrimitive.Item
                  id="room-menu-rename"
                  className="room-menu-item"
                  onSelect={() => onOpen('rename')}
                >
                  修改群名
                </DropdownMenuPrimitive.Item>
              ) : null}
            </>
          ) : null}
          {canReport ? (
            <DropdownMenuPrimitive.Item
              id="room-menu-report"
              className="room-menu-item"
              onSelect={() => onOpen('report')}
            >
              举报 {peerName}
            </DropdownMenuPrimitive.Item>
          ) : null}
          {canTransfer ? (
            <DropdownMenuPrimitive.Item
              id="room-menu-transfer"
              className="room-menu-item"
              onSelect={() => onOpen('transfer')}
            >
              交接管理权
            </DropdownMenuPrimitive.Item>
          ) : null}
          {canLeave ? (
            <>
              <DropdownMenuPrimitive.Separator className="room-menu-sep" />
              <DropdownMenuPrimitive.Item
                id="room-menu-leave-group"
                className="room-menu-item danger"
                onSelect={() => onOpen('leave')}
              >
                退出群聊
              </DropdownMenuPrimitive.Item>
            </>
          ) : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
