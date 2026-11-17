import { Button } from '../app/lenso-controls';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';

import { AppShell } from '../app/AppShell';
import { Link } from '../app/router';
import { Composer, type ComposerReply, type ComposerSendInput } from '../features/chat/Composer';
import { ForwardDialog } from '../features/chat/ForwardDialog';
import { Timeline } from '../features/chat/Timeline';
import { AppSidebar } from '../features/layout/AppSidebar';
import { AgentReissueDialog } from '../features/overlays/AgentReissueDialog';
import { AnnouncementDialog } from '../features/overlays/AnnouncementDialog';
import { AnnouncementPopover } from '../features/overlays/AnnouncementPopover';
import { confirmDialog } from '../features/overlays/confirm';
import { LeaveRoomDialog } from '../features/overlays/LeaveRoomDialog';
import { MembersDialog } from '../features/overlays/MembersDialog';
import { RenameAgentDialog } from '../features/overlays/RenameAgentDialog';
import { RenameRoomDialog } from '../features/overlays/RenameRoomDialog';
import { ReportDialog } from '../features/overlays/ReportDialog';
import { RoomMenu, type RoomOverlay } from '../features/overlays/RoomMenu';
import { TransferDialog } from '../features/overlays/TransferDialog';
import { MessageSearchDialog } from '../features/tasks/MessageSearchDialog';
import { RoomTaskDock } from '../features/tasks/RoomTaskDock';
import { TaskTraceDialog } from '../features/tasks/TaskTraceDialog';
import { useRoomTaskController } from '../features/tasks/useRoomTaskController';
import { useTaskAskProgress } from '../features/tasks/useTaskAskProgress';
import { AccountMenu } from '../features/sidebar/AccountMenu';
import { openAgentMemory } from '../features/memory/memory-store';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useRoomChat } from '../hooks/useRoomChat';
import { useRoomFiles } from '../hooks/useRoomFiles';
import { useRoomMonitor } from '../hooks/useRoomMonitor';
import { useRoomPreferences } from '../hooks/useRoomPreferences';
import { useRoomMenuActions, type AgentManagementView } from '../hooks/useRoomMenuActions';
import { useSendQueue } from '../hooks/useSendQueue';
import {
  buildSendPlan,
  composeMessageBody,
  mentionNames,
  resolveReplyAgentTarget,
  senderName,
  type HistoryMessage,
} from '../lib/chat';
import { groupColorFor, groupColorStyle } from '../lib/group-colors';
import { callTool, type McpError } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { newRequestId } from '../lib/request-id';

const FilesPane = lazy(() =>
  import('../features/panels/FilesPane').then((module) => ({ default: module.FilesPane })),
);
const MonitorPane = lazy(() =>
  import('../features/panels/MonitorPane').then((module) => ({ default: module.MonitorPane })),
);

/**
 * 文件栏 chunk 到达前的同宽骨架。
 *
 * `FilesPane` 是 lazy chunk，若 Suspense 用 `fallback={null}`，聊天区会先
 * 占满宽度，chunk 到达后再被 360px 文件栏挤窄。这里复用最终文件栏的根
 * class 与加载骨架，使首帧就按最终宽度布局；chunk 到达后只替换内容。
 * 骨架不占用 `#files-pane` id：Suspense 切换时 React 会短暂保留旧占位
 * DOM，两个同名 id 会破坏 `getElementById` 与测试的 strict 定位。
 */
function FilesPaneFallback() {
  return (
    <aside className="files-pane" aria-label="房间文件" aria-busy="true">
      <header className="files-head">
        <h2>文件</h2>
      </header>
      <ul className="files-list" aria-label="文件列表">
        {Array.from({ length: 3 }, (_, index) => (
          <li className="file-skeleton" aria-hidden="true" key={index}>
            <span className="skeleton-avatar" />
            <span className="file-skeleton-lines">
              <span />
              <span />
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const FILES_OPEN_KEY = 'agent-network-files-open';
const MONITOR_OPEN_KEY = 'agent-network-monitor-open';

function readPreference(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === '1';
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // 隐私模式只影响记忆，不影响本次开关。
  }
}

interface ChatPageProps {
  roomId: string;
}

interface ContactBlockPage {
  items: {
    active: boolean;
    blocked_actor: { actor_id: string } | null;
  }[];
}

function onlineLabel(online: boolean | null): string {
  if (online === true) return '在线';
  if (online === false) return '离线';
  return '未知';
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

/**
 * React Chat 页：`/c/:room_id` 固定由 React 渲染（4B-6 已删除 legacy 壳）。
 *
 * 保留 legacy 的 DOM id/class（`composer`、`messages`、`title`、`subtitle`、
 * `status` 等），复用同一 MCP 工具与 localStorage key。发送意图在服务端
 * 确认前持久化，SSE 只作为刷新提示，不直接把通知正文写进页面。
 */
export function ChatPage({ roomId }: ChatPageProps) {
  const chat = useRoomChat(roomId);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [reply, setReply] = useState<ComposerReply | null>(null);
  const [forcePinToken, setForcePinToken] = useState(0);
  const [overlay, setOverlay] = useState<RoomOverlay | null>(null);
  const [filesDesktopOpen, setFilesDesktopOpen] = useState(() =>
    readPreference(FILES_OPEN_KEY, true),
  );
  const [monitorDesktopOpen, setMonitorDesktopOpen] = useState(() =>
    readPreference(MONITOR_OPEN_KEY, false),
  );
  const [overlayPane, setOverlayPane] = useState<'files' | 'monitor' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [forwardItem, setForwardItem] = useState<HistoryMessage | null>(null);
  // 群成员弹窗从搜索右侧的常驻入口打开；关闭时必须显式回到该按钮。
  const membersButtonRef = useRef<HTMLButtonElement>(null);
  // 会话菜单项打开的弹窗（记忆、公告等）关闭后回到菜单入口。
  const roomMenuToggleRef = useRef<HTMLButtonElement>(null);
  // 聊天区 dropzone 不持有上传状态；Composer 挂载后把 addFiles 注册到这里。
  const fileDropRef = useRef<((files: File[]) => void) | null>(null);
  const registerFileDrop = useCallback((handler: ((files: File[]) => void) | null) => {
    fileDropRef.current = handler;
  }, []);
  const desktop = useMediaQuery('(min-width: 1200px)');
  const tablet = useMediaQuery('(min-width: 760px) and (max-width: 1199px)');
  const mobile = useIsMobile();

  const identity = chat.session?.identity ?? null;
  const token = chat.session?.token ?? null;
  const roomPreferences = useRoomPreferences(identity?.actor_id ?? null);
  const room = chat.detail?.room ?? null;
  const members = useMemo(
    () => new Map((chat.detail?.members ?? []).map((member) => [member.actor_id, member])),
    [chat.detail],
  );
  const mentions = useMemo(
    () => mentionNames(members, identity?.name ?? null),
    [members, identity?.name],
  );

  const {
    trace: taskTrace,
    openTrace,
    closeTrace,
    onToggleTask,
    invalidateTasks,
  } = useRoomTaskController({ roomId, room, token, onStatus: setStatus });

  const refresh = chat.refresh;
  const queue = useSendQueue({
    actorId: identity?.actor_id ?? null,
    token,
    roomId,
    onCommitted: useCallback(() => {
      void refresh();
      // 本人发送不保证收到 room.message 回声；提交成功即主动失效 Task 列表。
      invalidateTasks();
    }, [invalidateTasks, refresh]),
  });

  useEffect(() => {
    setReply(null);
    setStatus('');
    setOverlay(null);
    setSearchOpen(false);
    setForwardItem(null);
    roomActions.setRenameAgentOpen(false);
  }, [roomId]);

  useEffect(() => {
    const known = new Set<string>();
    for (const item of chat.items) {
      if (item.kind !== 'presence') known.add(item.message_id);
    }
    queue.prune(known);
  }, [chat.items, queue.prune]);


  const peer = useMemo(() => {
    if (!room || room.kind !== 'direct' || !identity) return null;
    for (const member of members.values()) {
      if (member.actor_id !== identity.actor_id) return member;
    }
    return null;
  }, [room, identity, members]);

  const management = useQuery({
    queryKey: queryKeys.agentManagement(peer?.actor_id ?? null),
    enabled: Boolean(token && room?.kind === 'direct' && peer?.kind === 'agent'),
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
    enabled: Boolean(token && room?.kind === 'direct' && peer),
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
  const title = !room
    ? '会话'
    : room.kind === 'direct'
      ? peer?.name ?? '单聊'
      : room.title || '群聊';
  const subtitle = !room
    ? '正在加载…'
    : room.kind === 'group'
      ? `群聊 · ${chat.detail?.members.length ?? room.member_count} 人`
      : peer?.kind === 'agent'
        ? onlineLabel(peer.online)
        : '';
  // 群聊头部色标与会话列表群头像瓦片共用 room_id 派生色；直聊不渲染。
  const groupColor = room?.kind === 'group' ? groupColorFor(room.room_id) : null;

  const onQuote = useCallback(
    (item: HistoryMessage) => {
      // 群聊人类回复时预解析自动 @：被回复 Agent 优先，否则沿线程找最上面的
      // 非自己 Agent；直聊、Agent 身份与找不到目标的线程保持原样。
      const target =
        room?.kind === 'group' && identity?.kind === 'human'
          ? resolveReplyAgentTarget({
              items: chat.items,
              messageId: item.message_id,
              members,
              identityId: identity.actor_id,
            })
          : null;
      setReply({
        messageId: item.message_id,
        label: `${senderName(item.sender_id, members, identity?.name ?? null, identity?.actor_id ?? null)}：${item.preview.slice(0, 120)}`,
        mention: target
          ? { actor_id: target.actor_id, name: target.name, kind: 'agent' }
          : null,
      });
      document.getElementById('body')?.focus();
    },
    [chat.items, identity, members, room?.kind],
  );

  const onStatus = useCallback((message: string) => {
    setStatus(message);
  }, []);

  const { draftRequest, canAskTask, onAskTaskProgress, clearDraftRequest } =
    useTaskAskProgress({ roomId, room, items: chat.items, members, identity, setReply });

  const roomActions = useRoomMenuActions({
    room,
    peer,
    identity,
    token,
    members,
    management: management.data ?? null,
    blocked,
    preferences: roomPreferences,
    queryClient,
    setStatus,
    closeOverlays: () => setOverlay(null),
  });

  const onRecall = useCallback(
    async (item: HistoryMessage) => {
      if (!token || !room) return;
      const confirmed = await confirmDialog({
        title: '撤回消息',
        message: '撤回这条消息？仅支持两分钟内的普通消息，已触发的 Agent 工作需单独取消。',
        confirmText: '撤回',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await callTool(
          'network_message_recall',
          { request_id: newRequestId('web_recall'), message_id: item.message_id },
          { token },
        );
        setStatus('消息已撤回');
        if (taskTrace?.rootId === item.message_id) closeTrace();
        if (reply?.messageId === item.message_id) setReply(null);
        setSearchOpen(false);
        setForwardItem((current) =>
          current?.message_id === item.message_id ? null : current,
        );
        invalidateTasks();
        await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
      } catch (error) {
        setStatus(`撤回失败：${failureText(error)}`);
      }
    },
    [closeTrace, invalidateTasks, queryClient, reply, room, taskTrace, token],
  );

  const onJumpToMessage = useCallback((messageId: string) => {
    for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
      if (node.dataset.messageId !== messageId) continue;
      node.scrollIntoView({ block: 'center' });
      return;
    }
  }, []);

  const onSend = useCallback(
    async (input: ComposerSendInput) => {
      if (!room || !identity) return { ok: false, error: '房间尚未加载' };
      const body = composeMessageBody(input.text, input.urls);
      const plan = buildSendPlan({
        room,
        members,
        identityId: identity.actor_id,
        identityKind: identity.kind,
        body,
        selections: input.selections,
        items: chat.items,
        hasAttachments: input.urls.length > 0,
        hasReply: Boolean(reply?.messageId),
      });
      if (plan.error) {
        setStatus(plan.error);
        return { ok: false, error: plan.error };
      }
      const outcome = await queue.send({
        body: plan.body,
        invoke: plan.invoke,
        mentions: plan.mentions,
        // 人类无存活选择器目标时省略 invoke，恢复服务端按正文唯一成员解析；
        // 有目标或发送者是 Agent 时显式发送（可能为空 []），阻止服务端猜测。
        invokeExplicit: plan.invokeExplicit,
        replyTo: reply?.messageId ?? null,
      });
      if (outcome.ok) {
        setReply(null);
        setStatus('');
        setForcePinToken((value) => value + 1);
        await refresh();
      } else {
        setStatus(outcome.error || '发送失败');
      }
      return outcome;
    },
    [room, identity, members, chat.items, queue, reply, refresh],
  );

  const onRetryOutbox = useCallback(
    async (clientMessageId: string) => {
      const outcome = await queue.retry(clientMessageId);
      if (outcome.ok) {
        setStatus('');
        setForcePinToken((value) => value + 1);
        await refresh();
      } else {
        setStatus(outcome.error || '重试失败');
      }
    },
    [queue, refresh],
  );

  const shownStatus = status || chat.refreshError || chat.streamError || '';
  const ready = chat.status === 'ready' && Boolean(room && identity && token);
  const dropEnabled = ready && room !== null && !room.read_only;
  const onDropFiles = useCallback(
    (files: File[]) => {
      if (!dropEnabled) return;
      fileDropRef.current?.(files);
    },
    [dropEnabled],
  );
  // 单一 dropzone 覆盖整个聊天区：Composer 只在 dropEnabled 时注册上传回调，
  // 只读归档没有 Composer，drop 仍被 preventDefault 吞掉但不会上传。
  const { getRootProps, isDragActive } = useDropzone({
    noClick: true,
    noKeyboard: true,
    // Composer 自己处理粘贴；根节点不挂 onPaste，避免同一文件被粘贴和 drop 各传一次。
    noPaste: true,
    multiple: true,
    onDrop: onDropFiles,
  });
  // 首载骨架与静态输入区：错误态让位给错误页，避免骨架长期占位。
  const loadingShell = !ready && chat.status !== 'error';
  const filesRequested = desktop ? filesDesktopOpen : overlayPane === 'files';
  const filesVisible = ready && filesRequested;
  // 房间读取失败时不再显示骨架，避免错误页被永久占位；就绪前仍按最终宽度占位。
  const filesShellVisible = filesRequested && chat.status !== 'error';
  const monitorVisible =
    ready && (desktop ? monitorDesktopOpen : overlayPane === 'monitor');
  const files = useRoomFiles(roomId, token, filesVisible);
  const monitor = useRoomMonitor(roomId, token, monitorVisible);

  useEffect(() => {
    setOverlayPane(null);
    setOverlay(null);
  }, [roomId]);

  useEffect(() => {
    const body = document.body;
    body.classList.toggle('files-drawer-open', tablet && filesVisible);
    body.classList.toggle('monitor-drawer-open', tablet && monitorVisible);
    body.classList.toggle('files-page-open', mobile && filesVisible);
    body.classList.toggle('monitor-page-open', mobile && monitorVisible);
    return () => {
      body.classList.remove(
        'files-drawer-open',
        'monitor-drawer-open',
        'files-page-open',
        'monitor-page-open',
      );
    };
  }, [filesVisible, mobile, monitorVisible, tablet]);

  useEffect(() => {
    if (!overlayPane) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const toggle =
        overlayPane === 'files'
          ? document.getElementById('files-toggle')
          : document.getElementById('monitor-toggle');
      setOverlayPane(null);
      toggle?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [overlayPane]);

  useEffect(() => {
    if (!mobile) return;
    if (filesVisible) document.getElementById('files-close')?.focus();
    else if (monitorVisible) document.getElementById('monitor-close')?.focus();
  }, [filesVisible, mobile, monitorVisible]);

  const toggleFiles = useCallback(() => {
    if (!ready) return;
    if (desktop) {
      setMonitorDesktopOpen(false);
      writePreference(MONITOR_OPEN_KEY, false);
      setFilesDesktopOpen((open) => {
        const next = !open;
        writePreference(FILES_OPEN_KEY, next);
        return next;
      });
      return;
    }
    setOverlayPane((current) => (current === 'files' ? null : 'files'));
  }, [desktop, ready]);

  const toggleMonitor = useCallback(() => {
    if (!ready) return;
    if (desktop) {
      setFilesDesktopOpen(false);
      writePreference(FILES_OPEN_KEY, false);
      setMonitorDesktopOpen((open) => {
        const next = !open;
        writePreference(MONITOR_OPEN_KEY, next);
        return next;
      });
      return;
    }
    setOverlayPane((current) => (current === 'monitor' ? null : 'monitor'));
  }, [desktop, ready]);

  const closeFiles = useCallback(() => {
    if (desktop) {
      setFilesDesktopOpen(false);
      writePreference(FILES_OPEN_KEY, false);
    } else {
      setOverlayPane(null);
    }
    document.getElementById('files-toggle')?.focus();
  }, [desktop]);

  const closeMonitor = useCallback(() => {
    if (desktop) {
      setMonitorDesktopOpen(false);
      writePreference(MONITOR_OPEN_KEY, false);
    } else {
      setOverlayPane(null);
    }
    document.getElementById('monitor-toggle')?.focus();
  }, [desktop]);

  return (
    <>
      <AppShell
        // 桌面 ≥760px 恢复 legacy 双栏；移动端只保留聊天区，返回箭头由 CSS 显示。
        sidebar={
          mobile ? undefined : (
            <AppSidebar live={false} streamError={chat.streamError} />
          )
        }
        main={
          <>
            <section className="chat-pane" aria-label="聊天区">
              <header className={`chat-head${loadingShell ? ' chat-head--loading' : ''}`} aria-busy={loadingShell}>
                <Link className="back" id="back" to="/" aria-label="返回会话列表">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </Link>
                <div className={`chat-id${loadingShell ? ' chat-id--loading' : ''}`}>
                  <div className="title-row">
                    {groupColor && !loadingShell ? (
                      <span
                        className="group-color-dot"
                        data-group-color={groupColor.index}
                        style={groupColorStyle(groupColor)}
                        aria-hidden="true"
                      />
                    ) : null}
                    <h2 id="title">{title}</h2>
                  </div>
                  <p className="muted" id="subtitle" hidden={loadingShell || !subtitle}>
                    {subtitle}
                  </p>
                  {loadingShell ? (
                    <>
                      <span className="chat-skeleton-line chat-skeleton-line--title" aria-hidden="true" />
                      <span className="chat-skeleton-line chat-skeleton-line--subtitle" aria-hidden="true" />
                    </>
                  ) : null}
                </div>
                {loadingShell ? (
                  <div className="chat-head-actions chat-head-actions--skeleton" aria-hidden="true">
                    <span className="head-skeleton head-skeleton--search" />
                    <span className="head-skeleton head-skeleton--monitor" />
                    <span className="head-skeleton head-skeleton--files" />
                    <span className="head-skeleton head-skeleton--account" />
                    <span className="head-skeleton head-skeleton--menu" />
                  </div>
                ) : room ? (
                  <div className="chat-head-actions">
                    {peer?.kind === 'agent' ? (
                      <Button
                        className="link-btn"
                        id="rename"
                        type="button"
                        onClick={() => roomActions.setRenameAgentOpen(true)}
                      >
                        改名
                      </Button>
                    ) : null}
                    <Button
                      className="link-btn"
                      id="message-search-button"
                      type="button"
                      aria-label="搜索聊天记录"
                      title="搜索聊天记录"
                      onClick={() => setSearchOpen(true)}
                    >
                      搜索
                    </Button>
                    {room.kind === 'group' ? (
                      <Button
                        ref={membersButtonRef}
                        className="link-btn"
                        id="members-button"
                        type="button"
                        onClick={() => setOverlay('members')}
                      >
                        群成员
                      </Button>
                    ) : null}
                    <Button
                      className={`monitor-toggle${monitorVisible ? ' active' : ''}`}
                      id="monitor-toggle"
                      type="button"
                      aria-controls="monitor-pane"
                      aria-expanded={monitorVisible}
                      aria-label="打开网页监控"
                      title="网页监控"
                      onClick={toggleMonitor}
                    >
                      <span>网页</span>
                    </Button>
                    <Button
                      className={`files-toggle${filesVisible ? ' active' : ''}`}
                      id="files-toggle"
                      type="button"
                      aria-controls="files-pane"
                      aria-expanded={filesVisible}
                      onClick={toggleFiles}
                    >
                      文件
                    </Button>
                    {/* 桌面账号区在侧栏；移动端侧栏隐藏，才在聊天头部提供入口。 */}
                    {identity && mobile ? <AccountMenu me={identity} /> : null}
                    {room.announcement ? (
                      <AnnouncementPopover
                        announcement={room.announcement}
                        canEdit={
                          !room.read_only && room.capabilities?.manage_announcement === true
                        }
                        onEdit={() => setOverlay('announcement')}
                      />
                    ) : null}
                    <RoomMenu
                      toggleRef={roomMenuToggleRef}
                      room={room}
                      peerName={peer?.name ?? null}
                      peerKind={peer?.kind ?? null}
                      preference={roomPreferences.preference(room.room_id)}
                      blocked={blocked}
                      agent={
                        peer?.kind === 'agent'
                          ? {
                              canManage: roomActions.canManageAgent === true,
                              disabled: management.data?.disabled === true,
                              canTransfer:
                                management.data?.can_transfer === true ||
                                management.data?.pending_transfer?.can_accept === true ||
                                management.data?.pending_transfer?.can_cancel === true ||
                                room.peer_can_manage === true,
                              canArchive: roomActions.canManageAgent === true,
                            }
                          : null
                      }
                      onOpen={setOverlay}
                      onViewMemory={
                        peer?.kind === 'agent'
                          ? () =>
                              openAgentMemory(
                                { actor_id: peer.actor_id, name: peer.name },
                                { returnFocus: () => roomMenuToggleRef.current },
                              )
                          : null
                      }
                      onTogglePreference={roomActions.onTogglePreference}
                      onArchive={() => void roomActions.onArchive()}
                      onCopyPrompt={() => void roomActions.onCopyPrompt()}
                      onToggleBlock={() => void roomActions.onToggleBlock()}
                      onDeleteFriend={() => void roomActions.onDeleteFriend()}
                      onToggleAgentDisabled={() => void roomActions.onToggleAgentDisabled()}
                      onReissueToken={() => void roomActions.onReissueToken()}
                      onDissolve={() => void roomActions.onDissolve()}
                    />
                  </div>
                ) : null}
              </header>
              {room?.announcement ? (
                <div id="room-announcement" className="room-announcement" role="note">
                  {room.announcement}
                </div>
              ) : null}
              {room?.read_only ? (
                <div id="room-archive-banner" className="room-archive-banner" role="note">
                  群聊已解散，当前为只读归档；截至解散点的历史仍可查看。
                </div>
              ) : null}
              <div
                {...getRootProps({
                  className: 'chat-body',
                  id: 'chat-body',
                  'aria-busy': loadingShell,
                })}
              >
                {dropEnabled ? (
                  <div id="composer-drop" className="composer-drop" hidden={!isDragActive}>
                    <span className="composer-drop-title">松开上传附件</span>
                    <span className="composer-drop-hint">支持拖拽多个文件，上传后随消息发送</span>
                  </div>
                ) : null}
                <div id="chat-loading" className="chat-loading" role="status" hidden={chat.status !== 'loading'}>
                  正在加载会话…
                </div>
                {loadingShell ? (
                  <div id="chat-skeleton" className="chat-skeleton" aria-hidden="true">
                    <div className="skeleton-row">
                      <span className="skeleton-avatar" />
                      <span className="skeleton-bubble" />
                    </div>
                    <div className="skeleton-row mine">
                      <span className="skeleton-avatar" />
                      <span className="skeleton-bubble" />
                    </div>
                    <div className="skeleton-row">
                      <span className="skeleton-avatar" />
                      <span className="skeleton-bubble" />
                    </div>
                  </div>
                ) : null}
                <div id="chat-error" className="chat-error" role="alert" hidden={chat.status !== 'error'}>
                  <p id="chat-error-text">{chat.error || '读取会话失败'}</p>
                  <div className="chat-error-actions">
                    <Button id="chat-error-retry" type="button" onClick={() => void chat.load()}>
                      重试
                    </Button>
                    <Link id="chat-error-back" to="/">
                      返回会话列表
                    </Link>
                  </div>
                </div>
                {ready && room && identity ? (
                  <Timeline
                    items={chat.items}
                    room={room}
                    members={members}
                    identityId={identity.actor_id}
                    identityName={identity.name}
                    identityKind={identity.kind}
                    mentions={mentions}
                    outbox={queue.items}
                    olderLoading={chat.olderLoading}
                    olderError={chat.olderError}
                    olderEnded={chat.olderEnded}
                    hasOlder={chat.hasOlder}
                    forcePinToken={forcePinToken}
                    onLoadOlder={chat.loadOlder}
                    onRetryOutbox={(id) => void onRetryOutbox(id)}
                    onRemoveOutbox={queue.remove}
                    onQuote={onQuote}
                    onStatus={onStatus}
                    onMarkRead={chat.markRead}
                    onToggleTask={(item) => void onToggleTask(item)}
                    onOpenTask={openTrace}
                    onRecall={(item) => void onRecall(item)}
                    onForward={setForwardItem}
                  />
                ) : null}
                <p id="status" role="status">
                  {shownStatus}
                </p>
                {/* Task dock 浮动锚点：绝对定位不占文档流，不推移消息或输入框。 */}
                <div className="composer-area">
                  {ready && room && identity ? (
                    <RoomTaskDock
                      roomId={roomId}
                      room={room}
                      token={token}
                      actorId={identity.actor_id}
                      canAskTask={canAskTask}
                      onAskProgress={onAskTaskProgress}
                      onOpenTrace={openTrace}
                    />
                  ) : null}
                  {loadingShell ? (
                    // 静态输入区：与真实 composer 同高，避免历史到达时列表被撑开。
                    <form
                      id="composer"
                      className="composer composer--loading"
                      aria-busy="true"
                      onSubmit={(event) => event.preventDefault()}
                    >
                      <Button className="attach-btn" type="button" aria-label="添加附件" disabled>
                        +
                      </Button>
                      <div className="composer-main">
                        <textarea
                          id="body"
                          rows={1}
                          placeholder="正在加载会话…"
                          aria-label="消息正文，加载中"
                          disabled
                        />
                      </div>
                      <Button className="send-btn primary" id="send" type="submit" disabled>
                        发送
                      </Button>
                    </form>
                  ) : null}
                  {ready && room && identity && token && !room.read_only ? (
                    <Composer
                      room={room}
                      members={members}
                      identity={identity}
                      token={token}
                      reply={reply}
                      draftRequest={draftRequest}
                      onDraftApplied={clearDraftRequest}
                      sending={false}
                      onCancelReply={() => setReply(null)}
                      onSend={onSend}
                      onStatus={onStatus}
                      registerFileDrop={registerFileDrop}
                    />
                  ) : null}
                </div>
              </div>
            </section>
            {filesShellVisible ? (
              <Suspense fallback={<FilesPaneFallback />}>
                {filesVisible ? (
                  <FilesPane
                    roomId={roomId}
                    token={token ?? ''}
                    readOnly={room?.read_only === true}
                    open={filesVisible}
                    onClose={closeFiles}
                    files={files}
                  />
                ) : (
                  <FilesPaneFallback />
                )}
              </Suspense>
            ) : null}
            {monitorVisible ? (
              <Suspense fallback={null}>
                <MonitorPane open={monitorVisible} onClose={closeMonitor} monitor={monitor} />
              </Suspense>
            ) : null}
            <div
              className="files-backdrop"
              id="files-backdrop"
              hidden={!tablet || !filesVisible}
              onClick={() => setOverlayPane(null)}
            />
            <div
              className="monitor-backdrop"
              id="monitor-backdrop"
              hidden={!tablet || !monitorVisible}
              onClick={() => setOverlayPane(null)}
            />
          </>
        }
      />
      {ready && room && identity && token ? (
        <>
          <MembersDialog
            open={overlay === 'members'}
            onOpenChange={(open) => setOverlay(open ? 'members' : null)}
            room={room}
            members={Array.from(members.values())}
            ownerTransfer={chat.detail?.owner_transfer ?? null}
            identityId={identity.actor_id}
            token={token}
            returnFocusRef={membersButtonRef}
            memoryFallbackFocus={() => membersButtonRef.current}
          />
          <AnnouncementDialog
            open={overlay === 'announcement'}
            onOpenChange={(open) => setOverlay(open ? 'announcement' : null)}
            room={room}
            token={token}
          />
          <RenameRoomDialog
            open={overlay === 'rename'}
            onOpenChange={(open) => setOverlay(open ? 'rename' : null)}
            room={room}
            token={token}
          />
          {peer ? (
            <ReportDialog
              open={overlay === 'report'}
              onOpenChange={(open) => setOverlay(open ? 'report' : null)}
              targetId={peer.actor_id}
              targetName={peer.name}
              roomId={room.room_id}
              token={token}
            />
          ) : null}
          {peer?.kind === 'agent' ? (
            <TransferDialog
              open={overlay === 'transfer'}
              onOpenChange={(open) => setOverlay(open ? 'transfer' : null)}
              agentId={peer.actor_id}
              token={token}
            />
          ) : null}
          <LeaveRoomDialog
            open={overlay === 'leave'}
            onOpenChange={(open) => setOverlay(open ? 'leave' : null)}
            room={room}
            token={token}
          />
          <AgentReissueDialog
            open={roomActions.reissue !== null}
            onOpenChange={(open) => {
              if (!open) roomActions.setReissue(null);
            }}
            agentName={roomActions.reissue?.name ?? peer?.name ?? 'Agent'}
            prompt={roomActions.reissue?.prompt ?? ''}
          />
          {peer?.kind === 'agent' ? (
            <RenameAgentDialog
              open={roomActions.renameAgentOpen}
              onOpenChange={roomActions.setRenameAgentOpen}
              actorId={peer.actor_id}
              currentName={peer.name}
              token={token}
              onRenamed={() => {
                setStatus('已更新 Agent 名称');
                invalidateTasks();
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.room(room.room_id),
                });
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.rooms(identity.actor_id),
                });
              }}
            />
          ) : null}
          <MessageSearchDialog
            open={searchOpen}
            onOpenChange={setSearchOpen}
            roomId={room.room_id}
            token={token}
            onOpenTask={(rootId, focusId) => {
              setSearchOpen(false);
              openTrace(rootId, focusId);
            }}
          />
          <TaskTraceDialog
            open={taskTrace !== null}
            onOpenChange={(open) => {
              if (!open) closeTrace();
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
                if (!open) setForwardItem(null);
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
              onSent={(roomName) => {
                setStatus(`已转发给 ${roomName}`);
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.rooms(identity.actor_id),
                });
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
