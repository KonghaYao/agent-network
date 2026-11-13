import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import type { RoomView } from '../../lib/chat';
import type { RoomPreference } from '../../lib/room-preferences';

export type RoomOverlay =
  | 'members'
  | 'announcement'
  | 'rename'
  | 'report'
  | 'leave'
  | 'transfer';

export interface RoomAgentMenuState {
  canManage: boolean;
  disabled: boolean;
  canTransfer: boolean;
  canArchive: boolean;
}

/**
 * 聊天头部菜单：会话偏好、群管理、联系人安全与 Agent 管理。
 *
 * Radix 负责键盘、焦点返回与 portal 定位；入口按钮保留
 * `#room-menu-toggle`，菜单容器保留 `#room-menu`，危险操作沿用 legacy
 * 的 `room-menu-*` id，方便灰度和 E2E 对照。
 */
export function RoomMenu({
  room,
  peerName,
  peerKind,
  preference,
  blocked,
  agent,
  onOpen,
  onTogglePreference,
  onArchive,
  onCopyPrompt,
  onToggleBlock,
  onDeleteFriend,
  onToggleAgentDisabled,
  onReissueToken,
  onDissolve,
}: {
  room: RoomView;
  peerName: string | null;
  peerKind: 'human' | 'agent' | null;
  preference: RoomPreference;
  blocked: boolean;
  agent: RoomAgentMenuState | null;
  onOpen: (overlay: RoomOverlay) => void;
  onTogglePreference: (field: keyof RoomPreference) => void;
  onArchive: () => void;
  onCopyPrompt: () => void;
  onToggleBlock: () => void;
  onDeleteFriend: () => void;
  onToggleAgentDisabled: () => void;
  onReissueToken: () => void;
  onDissolve: () => void;
}) {
  const group = room.kind === 'group';
  const direct = room.kind === 'direct';
  const canEdit = group && !room.read_only && room.capabilities?.edit_profile === true;
  const canAnnounce = group && room.capabilities?.manage_announcement === true;
  const canLeave = group && room.can_leave !== false;
  const canDissolve = group && room.can_dissolve === true && !room.read_only;
  const canReport = direct && peerName !== null;
  const canCopy = (direct && peerKind === 'agent') || group;
  const canManageAgent = direct && peerKind === 'agent' && agent?.canManage === true;
  const canTransfer = direct && peerKind === 'agent' && agent?.canTransfer === true;
  const canArchive = canManageAgent && agent?.canArchive === true;

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
          {canCopy ? (
            <DropdownMenuPrimitive.Item
              id="room-menu-copy-prompt"
              className="room-menu-item"
              onSelect={onCopyPrompt}
            >
              {group ? '复制群信息' : '复制 Agent 连接提示词'}
            </DropdownMenuPrimitive.Item>
          ) : null}
          <DropdownMenuPrimitive.Item
            id="room-menu-pin"
            className="room-menu-item"
            onSelect={() => onTogglePreference('pinned')}
          >
            {preference.pinned ? '取消置顶' : '置顶聊天'}
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            id="room-menu-mute"
            className="room-menu-item"
            onSelect={() => onTogglePreference('muted')}
          >
            {preference.muted ? '恢复消息提醒' : '消息免打扰'}
          </DropdownMenuPrimitive.Item>
          {group ? (
            <>
              <DropdownMenuPrimitive.Separator className="room-menu-sep" />
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
          {canTransfer ? (
            <DropdownMenuPrimitive.Item
              id="room-menu-transfer"
              className="room-menu-item"
              onSelect={() => onOpen('transfer')}
            >
              交接管理权
            </DropdownMenuPrimitive.Item>
          ) : null}
          {canManageAgent ? (
            <>
              <DropdownMenuPrimitive.Item
                id="room-menu-toggle-disabled"
                className="room-menu-item"
                onSelect={onToggleAgentDisabled}
              >
                {agent?.disabled ? '启用 Agent' : '停用 Agent'}
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                id="room-menu-reissue-token"
                className="room-menu-item"
                onSelect={onReissueToken}
              >
                重置链接
              </DropdownMenuPrimitive.Item>
            </>
          ) : null}
          {canArchive ? (
            <DropdownMenuPrimitive.Item
              id="room-menu-archive"
              className="room-menu-item"
              onSelect={onArchive}
            >
              归档
            </DropdownMenuPrimitive.Item>
          ) : null}
          {canReport || direct ? (
            <>
              <DropdownMenuPrimitive.Separator className="room-menu-sep" />
              {canReport ? (
                <DropdownMenuPrimitive.Item
                  id="room-menu-report"
                  className="room-menu-item"
                  onSelect={() => onOpen('report')}
                >
                  举报 {peerName}
                </DropdownMenuPrimitive.Item>
              ) : null}
              {direct && peerName ? (
                <>
                  <DropdownMenuPrimitive.Item
                    id="room-menu-block"
                    className="room-menu-item"
                    onSelect={onToggleBlock}
                  >
                    {blocked ? '解除拉黑' : '拉黑'}
                  </DropdownMenuPrimitive.Item>
                  <DropdownMenuPrimitive.Item
                    id="room-menu-delete-friend"
                    className="room-menu-item danger"
                    onSelect={onDeleteFriend}
                  >
                    删除好友
                  </DropdownMenuPrimitive.Item>
                </>
              ) : null}
            </>
          ) : null}
          {canLeave || canDissolve ? (
            <>
              <DropdownMenuPrimitive.Separator className="room-menu-sep" />
              {canDissolve ? (
                <DropdownMenuPrimitive.Item
                  id="room-menu-dissolve"
                  className="room-menu-item danger"
                  onSelect={onDissolve}
                >
                  解散群聊
                </DropdownMenuPrimitive.Item>
              ) : null}
              {canLeave ? (
                <DropdownMenuPrimitive.Item
                  id="room-menu-leave-group"
                  className="room-menu-item danger"
                  onSelect={() => onOpen('leave')}
                >
                  退出群聊
                </DropdownMenuPrimitive.Item>
              ) : null}
            </>
          ) : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
