import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { AppShell } from '../app/AppShell';
import { Composer, type ComposerSendInput } from '../features/chat/Composer';
import { Timeline } from '../features/chat/Timeline';
import { AnnouncementDialog } from '../features/overlays/AnnouncementDialog';
import { AnnouncementPopover } from '../features/overlays/AnnouncementPopover';
import { confirmDialog } from '../features/overlays/confirm';
import { LeaveRoomDialog } from '../features/overlays/LeaveRoomDialog';
import { MembersDialog } from '../features/overlays/MembersDialog';
import { RenameRoomDialog } from '../features/overlays/RenameRoomDialog';
import { ReportDialog } from '../features/overlays/ReportDialog';
import { RoomMenu, type RoomOverlay } from '../features/overlays/RoomMenu';
import { TransferDialog } from '../features/overlays/TransferDialog';
import { AccountMenu } from '../features/sidebar/AccountMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useRoomChat } from '../hooks/useRoomChat';
import { useRoomFiles } from '../hooks/useRoomFiles';
import { useRoomMonitor } from '../hooks/useRoomMonitor';
import { useSendQueue } from '../hooks/useSendQueue';
import {
  buildSendPlan,
  composeMessageBody,
  mentionNames,
  senderName,
  type HistoryMessage,
} from '../lib/chat';
import { callTool } from '../lib/mcp-client';
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

function onlineLabel(online: boolean | null): string {
  if (online === true) return '在线';
  if (online === false) return '离线';
  return '未知';
}

/**
 * React Chat 页：`/c/:room_id` 在 `WEB_SPA_ROUTES=room` 时接管。
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
  const desktop = useMediaQuery('(min-width: 1200px)');
  const tablet = useMediaQuery('(min-width: 760px) and (max-width: 1199px)');
  const mobile = useIsMobile();

  const identity = chat.session?.identity ?? null;
  const token = chat.session?.token ?? null;
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

  const onArchive = useCallback(async () => {
    if (!peer || peer.kind !== 'agent' || !token || !identity) return;
    const confirmed = await confirmDialog({
      title: '归档 Agent',
      message: `归档 ${peer.name} 后，这个单聊会从默认会话列表隐藏，可随时在“已归档 Agents”中恢复；消息、文件与凭据都不受影响。`,
      confirmText: '归档',
    });
    if (!confirmed) return;
    try {
      await callTool(
        'network_agent_archive',
        { request_id: newRequestId('web_agent_archive'), actor_id: peer.actor_id },
        { token },
      );
      setStatus('已归档，可在已归档 Agents 中恢复');
      await queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) });
    } catch (error) {
      setStatus(
        `归档失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [identity, peer, queryClient, token]);

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
                      onOpen={setOverlay}
                      onArchive={() => void onArchive()}
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
        </>
      ) : null}
    </>
  );
}
