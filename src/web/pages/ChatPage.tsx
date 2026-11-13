import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { AppShell } from '../app/AppShell';
import { Composer, type ComposerSendInput } from '../features/chat/Composer';
import { ForwardDialog } from '../features/chat/ForwardDialog';
import { Timeline } from '../features/chat/Timeline';
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
import { TaskTraceDialog } from '../features/tasks/TaskTraceDialog';
import { AccountMenu } from '../features/sidebar/AccountMenu';
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
  senderName,
  type HistoryMessage,
} from '../lib/chat';
import { callTool, type McpError } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { newRequestId } from '../lib/request-id';

const FilesPane = lazy(() =>
  import('../features/panels/FilesPane').then((module) => ({ default: module.FilesPane })),
);
const MonitorPane = lazy(() =>
  import('../features/panels/MonitorPane').then((module) => ({ default: module.MonitorPane })),
);

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
  const [reply, setReply] = useState<{ messageId: string; label: string } | null>(null);
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
  const [trace, setTrace] = useState<{ rootId: string; focusId: string | null } | null>(null);
  const [forwardItem, setForwardItem] = useState<HistoryMessage | null>(null);
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

  const refresh = chat.refresh;
  const queue = useSendQueue({
    actorId: identity?.actor_id ?? null,
    token,
    roomId,
    onCommitted: useCallback(() => {
      void refresh();
    }, [refresh]),
  });

  useEffect(() => {
    setReply(null);
    setStatus('');
    setOverlay(null);
    setSearchOpen(false);
    setTrace(null);
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

  const onQuote = useCallback((item: HistoryMessage) => {
    setReply({
      messageId: item.message_id,
      label: `${senderName(item.sender_id, members, identity?.name ?? null, identity?.actor_id ?? null)}：${item.preview.slice(0, 120)}`,
    });
    document.getElementById('body')?.focus();
  }, [members, identity]);

  const onStatus = useCallback((message: string) => {
    setStatus(message);
  }, []);

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

  const onToggleTask = useCallback(
    async (item: HistoryMessage) => {
      if (!token || !room || room.read_only) return;
      const mark = item.task_root_id !== item.message_id;
      try {
        await callTool(
          mark ? 'network_task_mark' : 'network_task_unmark',
          {
            request_id: newRequestId('web_task_mark'),
            room_id: room.room_id,
            message_id: item.message_id,
          },
          { token },
        );
        setStatus(mark ? '已标记为 Task' : '已取消 Task 标记');
        if (!mark && trace?.rootId === item.message_id) setTrace(null);
        await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
      } catch (error) {
        setStatus(`${mark ? '标记失败' : '取消标记失败'}：${failureText(error)}`);
      }
    },
    [queryClient, room, token, trace],
  );

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
        if (trace?.rootId === item.message_id) setTrace(null);
        if (reply?.messageId === item.message_id) setReply(null);
        setSearchOpen(false);
        setForwardItem((current) =>
          current?.message_id === item.message_id ? null : current,
        );
        await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
      } catch (error) {
        setStatus(`撤回失败：${failureText(error)}`);
      }
    },
    [queryClient, reply, room, token, trace],
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
        body,
        selections: input.selections,
      });
      if (plan.error) {
        setStatus(plan.error);
        return { ok: false, error: plan.error };
      }
      const outcome = await queue.send({
        body,
        invoke: plan.invoke,
        mentions: plan.mentions,
        // 页面始终显式发送 invoke（含 []），阻止服务端再从正文猜测目标。
        invokeExplicit: true,
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
    [room, identity, members, queue, reply, refresh],
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
  const filesVisible =
    ready && (desktop ? filesDesktopOpen : overlayPane === 'files');
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
        main={
          <>
            <section className="chat-pane" aria-label="聊天区">
              <header className="chat-head">
                <a className="back" id="back" href="/" aria-label="返回会话列表">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </a>
                <div className="chat-id">
                  <div className="title-row">
                    <h2 id="title">{title}</h2>
                  </div>
                  <p className="muted" id="subtitle" hidden={!subtitle}>
                    {subtitle}
                  </p>
                </div>
                {room ? (
                  <div className="chat-head-actions">
                    {peer?.kind === 'agent' ? (
                      <button
                        className="link-btn"
                        id="rename"
                        type="button"
                        onClick={() => roomActions.setRenameAgentOpen(true)}
                      >
                        改名
                      </button>
                    ) : null}
                    <button
                      className="link-btn"
                      id="message-search-button"
                      type="button"
                      aria-label="搜索聊天记录"
                      title="搜索聊天记录"
                      onClick={() => setSearchOpen(true)}
                    >
                      搜索
                    </button>
                    <button
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
                    </button>
                    <button
                      className={`files-toggle${filesVisible ? ' active' : ''}`}
                      id="files-toggle"
                      type="button"
                      aria-controls="files-pane"
                      aria-expanded={filesVisible}
                      onClick={toggleFiles}
                    >
                      文件
                    </button>
                    {identity ? <AccountMenu me={identity} /> : null}
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
              <div className="chat-body" id="chat-body" aria-busy={chat.status === 'loading'}>
                <div id="chat-loading" className="chat-loading" role="status" hidden={chat.status !== 'loading'}>
                  正在加载会话…
                </div>
                <div id="chat-error" className="chat-error" role="alert" hidden={chat.status !== 'error'}>
                  <p id="chat-error-text">{chat.error || '读取会话失败'}</p>
                  <div className="chat-error-actions">
                    <button id="chat-error-retry" type="button" onClick={() => void chat.load()}>
                      重试
                    </button>
                    <a id="chat-error-back" href="/">
                      返回会话列表
                    </a>
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
                    onOpenTask={(rootId, focusId) => setTrace({ rootId, focusId })}
                    onRecall={(item) => void onRecall(item)}
                    onForward={setForwardItem}
                  />
                ) : null}
                <p id="status" role="status">
                  {shownStatus}
                </p>
                {ready && room && identity && token && !room.read_only ? (
                  <Composer
                    room={room}
                    members={members}
                    identity={identity}
                    token={token}
                    reply={reply}
                    sending={false}
                    onCancelReply={() => setReply(null)}
                    onSend={onSend}
                    onStatus={onStatus}
                  />
                ) : null}
              </div>
            </section>
            {filesVisible ? (
              <Suspense fallback={null}>
                <FilesPane
                  roomId={roomId}
                  token={token ?? ''}
                  readOnly={room?.read_only === true}
                  open={filesVisible}
                  onClose={closeFiles}
                  files={files}
                />
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
              setTrace({ rootId, focusId });
            }}
          />
          <TaskTraceDialog
            open={trace !== null}
            onOpenChange={(open) => {
              if (!open) setTrace(null);
            }}
            roomId={room.room_id}
            rootId={trace?.rootId ?? null}
            focusId={trace?.focusId ?? null}
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
