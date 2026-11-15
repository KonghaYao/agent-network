import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ElementType, Ref } from 'react';

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

export interface RoomMenuItemsProps {
  room: RoomView;
  peerName: string | null;
  peerKind: 'human' | 'agent' | null;
  preference: RoomPreference;
  blocked: boolean;
  agent: RoomAgentMenuState | null;
  onOpen: (overlay: RoomOverlay) => void;
  onViewMemory: (() => void) | null;
  onTogglePreference: (field: keyof RoomPreference) => void;
  onArchive: () => void;
  onCopyPrompt: () => void;
  onToggleBlock: () => void;
  onDeleteFriend: () => void;
  onToggleAgentDisabled: () => void;
  onReissueToken: () => void;
  onDissolve: () => void;
}

/**
 * 会话菜单项：头部 DropdownMenu 与会话行 ContextMenu 共用同一份动作。
 *
 * `Item` / `Separator` 由调用方传入对应的 Radix 原语；`idPrefix` 让两个
 * 菜单入口使用不同的 DOM id，避免同时挂载时出现重复 id。菜单语义、危险项
 * 分组与文案完全一致。
 */
export function RoomMenuItems({
  Item,
  Separator,
  idPrefix = 'room-menu',
  room,
  peerName,
  peerKind,
  preference,
  blocked,
  agent,
  onOpen,
  onViewMemory,
  onTogglePreference,
  onArchive,
  onCopyPrompt,
  onToggleBlock,
  onDeleteFriend,
  onToggleAgentDisabled,
  onReissueToken,
  onDissolve,
}: RoomMenuItemsProps & {
  Item: ElementType;
  Separator: ElementType;
  idPrefix?: string;
}) {
  const group = room.kind === 'group';
  const direct = room.kind === 'direct';
  const canEdit = group && !room.read_only && room.capabilities?.edit_profile === true;
  const canAnnounce = group && room.capabilities?.manage_announcement === true;
  // 群主不能直接退群，但仍需入口读取预览并提示先转让或解散。
  const canLeave = group && !room.read_only;
  const canDissolve = group && room.can_dissolve === true && !room.read_only;
  const canReport = direct && peerName !== null;
  const canCopy = (direct && peerKind === 'agent') || group;
  const canManageAgent = direct && peerKind === 'agent' && agent?.canManage === true;
  const canTransfer = direct && peerKind === 'agent' && agent?.canTransfer === true;
  const canArchive = canManageAgent && agent?.canArchive === true;

  return (
    <>
      {canCopy ? (
        <Item
          id={`${idPrefix}-copy-prompt`}
          className="room-menu-item"
          onSelect={onCopyPrompt}
        >
          {group ? '复制群信息' : '复制 Agent 连接提示词'}
        </Item>
      ) : null}
      <Item
        id={`${idPrefix}-pin`}
        className="room-menu-item"
        onSelect={() => onTogglePreference('pinned')}
      >
        {preference.pinned ? '取消置顶' : '置顶聊天'}
      </Item>
      <Item
        id={`${idPrefix}-mute`}
        className="room-menu-item"
        onSelect={() => onTogglePreference('muted')}
      >
        {preference.muted ? '恢复消息提醒' : '消息免打扰'}
      </Item>
      {direct && peerKind === 'agent' && onViewMemory ? (
        <Item
          id={`${idPrefix}-memory`}
          className="room-menu-item"
          onSelect={onViewMemory}
        >
          查看 Agent 记忆
        </Item>
      ) : null}
      {group ? (
        <>
          <Separator className="room-menu-sep" />
          <Item
            id={`${idPrefix}-members`}
            className="room-menu-item"
            onSelect={() => onOpen('members')}
          >
            群成员
          </Item>
          <Item
            id={`${idPrefix}-announcement`}
            className="room-menu-item"
            onSelect={() => onOpen('announcement')}
          >
            {canAnnounce ? '群公告' : '查看群公告'}
          </Item>
          {canEdit ? (
            <Item
              id={`${idPrefix}-rename`}
              className="room-menu-item"
              onSelect={() => onOpen('rename')}
            >
              修改群名
            </Item>
          ) : null}
        </>
      ) : null}
      {canTransfer ? (
        <Item
          id={`${idPrefix}-transfer`}
          className="room-menu-item"
          onSelect={() => onOpen('transfer')}
        >
          交接管理权
        </Item>
      ) : null}
      {canManageAgent ? (
        <>
          <Item
            id={`${idPrefix}-toggle-disabled`}
            className="room-menu-item"
            onSelect={onToggleAgentDisabled}
          >
            {agent?.disabled ? '启用 Agent' : '停用 Agent'}
          </Item>
          <Item
            id={`${idPrefix}-reissue-token`}
            className="room-menu-item"
            onSelect={onReissueToken}
          >
            重置链接
          </Item>
        </>
      ) : null}
      {canArchive ? (
        <Item
          id={`${idPrefix}-archive`}
          className="room-menu-item"
          onSelect={onArchive}
        >
          归档
        </Item>
      ) : null}
      {canReport || direct ? (
        <>
          <Separator className="room-menu-sep" />
          {canReport ? (
            <Item
              id={`${idPrefix}-report`}
              className="room-menu-item"
              onSelect={() => onOpen('report')}
            >
              举报 {peerName}
            </Item>
          ) : null}
          {direct && peerName ? (
            <>
              <Item
                id={`${idPrefix}-block`}
                className="room-menu-item"
                onSelect={onToggleBlock}
              >
                {blocked ? '解除拉黑' : '拉黑'}
              </Item>
              <Item
                id={`${idPrefix}-delete-friend`}
                className="room-menu-item danger"
                onSelect={onDeleteFriend}
              >
                删除好友
              </Item>
            </>
          ) : null}
        </>
      ) : null}
      {canLeave || canDissolve ? (
        <>
          <Separator className="room-menu-sep" />
          {canDissolve ? (
            <Item
              id={`${idPrefix}-dissolve`}
              className="room-menu-item danger"
              onSelect={onDissolve}
            >
              解散群聊
            </Item>
          ) : null}
          {canLeave ? (
            <Item
              id={`${idPrefix}-leave-group`}
              className="room-menu-item danger"
              onSelect={() => onOpen('leave')}
            >
              退出群聊
            </Item>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * 聊天头部菜单：会话偏好、群管理、联系人安全与 Agent 管理。
 *
 * Radix 负责键盘、焦点返回与 portal 定位；入口按钮保留
 * `#room-menu-toggle`，菜单容器保留 `#room-menu`，危险操作沿用 legacy
 * 的 `room-menu-*` id，方便灰度和 E2E 对照。
 */
export function RoomMenu({
  toggleRef,
  ...items
}: RoomMenuItemsProps & {
  /** 弹窗关闭后需要把焦点还给菜单入口时传入。 */
  toggleRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          ref={toggleRef}
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
          <RoomMenuItems
            Item={DropdownMenuPrimitive.Item}
            Separator={DropdownMenuPrimitive.Separator}
            {...items}
          />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
