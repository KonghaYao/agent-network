import { Tooltip } from '../../app/lenso-tooltip';
import { Button, Menu, type MenuEntry } from '../../app/lenso-controls';
import { useState, type ElementType, type Ref } from 'react';

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
  /** 头部已有常驻群成员按钮；会话行仍在菜单里展示。 */
  membersInMenu?: boolean;
}

/** 头部 Menu 与会话行 ContextMenu 的唯一动作、条件、文案和 ID 映射。 */
export function buildRoomMenuEntries({
  room, peerName, peerKind, preference, blocked, agent, onOpen, onViewMemory,
  onTogglePreference, onArchive, onCopyPrompt, onToggleBlock, onDeleteFriend,
  onToggleAgentDisabled, onReissueToken, onDissolve, membersInMenu = true,
}: RoomMenuItemsProps, idPrefix = 'room-menu'): MenuEntry[] {
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
  const entries: MenuEntry[] = [];
  const action = (id: string, label: string, onSelect: () => void, danger = false) => {
    entries.push({ id: `${idPrefix}-${id}`, label, onSelect,
      className: `room-menu-item${danger ? ' danger' : ''}`,
      variant: danger ? 'danger' : 'default' });
  };
  const separator = (id: string) => entries.push({ id: `${idPrefix}-${id}`, separator: true });

  if (canCopy) action('copy-prompt', group ? '复制群信息' : '复制 Agent 连接提示词', onCopyPrompt);
  action('pin', preference.pinned ? '取消置顶' : '置顶聊天', () => onTogglePreference('pinned'));
  action('mute', preference.muted ? '恢复消息提醒' : '消息免打扰', () => onTogglePreference('muted'));
  if (direct && peerKind === 'agent' && onViewMemory) action('memory', '查看 Agent 记忆', onViewMemory);
  if (group) {
    separator('group-sep');
    if (membersInMenu) action('members', '群成员', () => onOpen('members'));
    action('announcement', canAnnounce ? '群公告' : '查看群公告', () => onOpen('announcement'));
    if (canEdit) action('rename', '修改群名', () => onOpen('rename'));
  }
  if (canTransfer) action('transfer', '交接管理权', () => onOpen('transfer'));
  if (canManageAgent) {
    action('toggle-disabled', agent?.disabled ? '启用 Agent' : '停用 Agent', onToggleAgentDisabled);
    action('reissue-token', '重置链接', onReissueToken);
  }
  if (canArchive) action('archive', '归档', onArchive);
  if (canReport || direct) {
    separator('contact-sep');
    if (canReport) action('report', `举报 ${peerName}`, () => onOpen('report'));
    if (direct && peerName) {
      action('block', blocked ? '解除拉黑' : '拉黑', onToggleBlock);
      action('delete-friend', '删除好友', onDeleteFriend, true);
    }
  }
  if (canLeave || canDissolve) {
    separator('leave-sep');
    if (canDissolve) action('dissolve', '解散群聊', onDissolve, true);
    if (canLeave) action('leave-group', '退出群聊', () => onOpen('leave'), true);
  }
  return entries;
}

/** 会话行继续消费相同映射，不复制头部的业务判断。 */
export function RoomMenuItems({
  Item, Separator, idPrefix = 'room-menu', ...props
}: RoomMenuItemsProps & { Item: ElementType; Separator: ElementType; idPrefix?: string }) {
  return <>{buildRoomMenuEntries(props, idPrefix).map((entry) => 'separator' in entry
    ? <Separator key={entry.id} id={entry.id} className="room-menu-sep" />
    : <Item key={entry.id} id={entry.id} className={entry.className}
        disabled={entry.disabled} onSelect={entry.onSelect}>{entry.label}</Item>)}</>;
}

/** 聊天头部菜单：选中先隐藏浮层，再执行动作或打开对话框。 */
export function RoomMenu({
  toggleRef, ...items
}: RoomMenuItemsProps & { toggleRef?: Ref<HTMLButtonElement> }) {
  const [open, setOpen] = useState(false);
  return <Menu id="room-menu" label="会话操作" className="room-menu spa-menu"
    open={open} onOpenChange={setOpen} align="end" sideOffset={6}
    fallbackAnchor instantCloseOnSelect
    items={buildRoomMenuEntries({ ...items, membersInMenu: false })}
    trigger={<Tooltip as={Button} ref={toggleRef} id="room-menu-toggle" className="icon-btn" type="button"
      aria-label="会话操作" hint="会话操作">···</Tooltip>} />;
}
