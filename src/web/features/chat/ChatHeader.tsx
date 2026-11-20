import type { RefObject } from 'react';

import { Tooltip } from '../../app/lenso-tooltip';
import { Button, Toolbar } from '../../app/lenso-controls';
import { Link } from '../../app/router';
import { AnnouncementPopover } from '../overlays/AnnouncementPopover';
import { RoomMenu, type RoomOverlay } from '../overlays/RoomMenu';
import { AccountMenu } from '../sidebar/AccountMenu';
import type { RoomMember, RoomView } from '../../lib/chat';
import type { GroupColor } from '../../lib/group-colors';
import { groupColorStyle } from '../../lib/group-colors';
import type { WebIdentity } from '../../lib/identity';
import type { RoomPreference } from '../../lib/room-preferences';

export interface ChatHeaderProps {
  headerRef: RefObject<HTMLElement | null>;
  loading: boolean;
  title: string;
  subtitle: string;
  groupColor: GroupColor | null;
  room: RoomView | null;
  peer: RoomMember | null;
  identity: WebIdentity | null;
  mobile: boolean;
  filesVisible: boolean;
  monitorVisible: boolean;
  membersButtonRef: RefObject<HTMLButtonElement | null>;
  roomMenuToggleRef: RefObject<HTMLButtonElement | null>;
  preference: RoomPreference;
  blocked: boolean;
  agentManagement: {
    disabled: boolean;
    canTransfer: boolean;
    canManage: boolean;
  } | null;
  onRenameAgent: () => void;
  onSearch: () => void;
  onOpenMembers: () => void;
  onToggleMonitor: () => void;
  onToggleFiles: () => void;
  onTogglePreference: (field: keyof RoomPreference) => void;
  onArchive: () => void;
  onCopyPrompt: () => void;
  onToggleBlock: () => void;
  onDeleteFriend: () => void;
  onToggleAgentDisabled: () => void;
  onReissueToken: () => void;
  onDissolve: () => void;
  onViewMemory: (() => void) | null;
  onOpenOverlay: (overlay: RoomOverlay) => void;
}

/**
 * 聊天头部：保留 legacy DOM id/class 与操作顺序。
 *
 * 从 ChatPage 拆出只做结构收敛；群头部置顶区在 header 之外单独渲染，
 * 避免置顶变化重排标题与操作按钮。
 */
export function ChatHeader({
  headerRef,
  loading,
  title,
  subtitle,
  groupColor,
  room,
  peer,
  identity,
  mobile,
  filesVisible,
  monitorVisible,
  membersButtonRef,
  roomMenuToggleRef,
  preference,
  blocked,
  agentManagement,
  onRenameAgent,
  onSearch,
  onOpenMembers,
  onToggleMonitor,
  onToggleFiles,
  onTogglePreference,
  onArchive,
  onCopyPrompt,
  onToggleBlock,
  onDeleteFriend,
  onToggleAgentDisabled,
  onReissueToken,
  onDissolve,
  onViewMemory,
  onOpenOverlay,
}: ChatHeaderProps) {
  return (
    <header
      ref={headerRef}
      className={`chat-head${loading ? ' chat-head--loading' : ''}`}
      aria-busy={loading}
    >
      <Link className="back" id="back" to="/" aria-label="返回会话列表">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </Link>
      <div className={`chat-id${loading ? ' chat-id--loading' : ''}`}>
        <div className="title-row">
          {groupColor && !loading ? (
            <span
              className="group-color-dot"
              data-group-color={groupColor.index}
              style={groupColorStyle(groupColor)}
              aria-hidden="true"
            />
          ) : null}
          <h2 id="title">{title}</h2>
        </div>
        <p className="muted" id="subtitle" hidden={loading || !subtitle}>
          {subtitle}
        </p>
        {loading ? (
          <>
            <span className="chat-skeleton-line chat-skeleton-line--title" aria-hidden="true" />
            <span
              className="chat-skeleton-line chat-skeleton-line--subtitle"
              aria-hidden="true"
            />
          </>
        ) : null}
      </div>
      {loading ? (
        <div className="chat-head-actions chat-head-actions--skeleton" aria-hidden="true">
          <Toolbar style={{ display: 'contents' }}>
            {['search', 'monitor', 'files', 'account', 'menu'].map((part) => (
              <span key={part} className={`head-skeleton head-skeleton--${part}`} />
            ))}
          </Toolbar>
        </div>
      ) : room ? (
        <div className="chat-head-actions">
          <Toolbar aria-label="会话操作" style={{ display: 'contents' }}>
            {peer?.kind === 'agent' ? (
              <Button
                className="link-btn"
                variant="borderless"
                size="sm"
                id="rename"
                type="button"
                onClick={onRenameAgent}
              >
                改名
              </Button>
            ) : null}
            <Tooltip
              as={Button}
              className="link-btn"
              variant="borderless"
              size="sm"
              id="message-search-button"
              type="button"
              aria-label="搜索聊天记录"
              hint="搜索聊天记录"
              onClick={onSearch}
            >
              搜索
            </Tooltip>
            {room.kind === 'group' ? (
              <Button
                ref={membersButtonRef}
                className="link-btn"
                variant="borderless"
                size="sm"
                id="members-button"
                type="button"
                onClick={onOpenMembers}
              >
                群成员
              </Button>
            ) : null}
            <Tooltip
              as={Button}
              className={`monitor-toggle${monitorVisible ? ' active' : ''}`}
              variant="borderless"
              size="sm"
              id="monitor-toggle"
              type="button"
              aria-controls="monitor-pane"
              aria-expanded={monitorVisible}
              aria-label="打开网页监控"
              hint="网页监控"
              onClick={onToggleMonitor}
            >
              <span>网页</span>
            </Tooltip>
            <Button
              className={`files-toggle${filesVisible ? ' active' : ''}`}
              variant="borderless"
              size="sm"
              id="files-toggle"
              type="button"
              aria-controls="files-pane"
              aria-expanded={filesVisible}
              onClick={onToggleFiles}
            >
              文件
            </Button>
            {/* 桌面账号区在侧栏；移动端侧栏隐藏，才在聊天头部提供入口。 */}
            {identity && mobile ? <AccountMenu me={identity} /> : null}
            {room.announcement ? (
              <AnnouncementPopover
                roomId={room.room_id}
                announcement={room.announcement}
                canEdit={!room.read_only && room.capabilities?.manage_announcement === true}
                onEdit={() => onOpenOverlay('announcement')}
              />
            ) : null}
            <RoomMenu
              toggleRef={roomMenuToggleRef}
              room={room}
              peerName={peer?.name ?? null}
              peerKind={peer?.kind ?? null}
              preference={preference}
              blocked={blocked}
              agent={
                peer?.kind === 'agent'
                  ? {
                      canManage: agentManagement?.canManage === true,
                      disabled: agentManagement?.disabled === true,
                      canTransfer: agentManagement?.canTransfer === true,
                      canArchive: agentManagement?.canManage === true,
                    }
                  : null
              }
              onOpen={onOpenOverlay}
              onViewMemory={onViewMemory}
              onTogglePreference={onTogglePreference}
              onArchive={onArchive}
              onCopyPrompt={onCopyPrompt}
              onToggleBlock={onToggleBlock}
              onDeleteFriend={onDeleteFriend}
              onToggleAgentDisabled={onToggleAgentDisabled}
              onReissueToken={onReissueToken}
              onDissolve={onDissolve}
            />
          </Toolbar>
        </div>
      ) : null}
    </header>
  );
}
