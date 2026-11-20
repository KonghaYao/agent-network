import { Alert, Button } from '../app/lenso-controls';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { AppShell } from '../app/AppShell';
import { Link } from '../app/router';
import { ChatDialogsMount } from '../features/chat/ChatDialogsMount';
import { ChatHeader } from '../features/chat/ChatHeader';
import { Composer, type ComposerReply, type ComposerSendInput } from '../features/chat/Composer';
import { Timeline } from '../features/chat/Timeline';
import { AppSidebar } from '../features/layout/AppSidebar';
import { FilesPaneFallback } from '../features/panels/FilesPaneFallback';
import { LazyFilePreviewDialog } from '../features/panels/LazyFilePreviewDialog';
import type { RoomOverlay } from '../features/overlays/RoomMenu';
import { RoomTaskDock } from '../features/tasks/RoomTaskDock';
import { useRoomTaskController } from '../features/tasks/useRoomTaskController';
import { useTaskAskProgress } from '../features/tasks/useTaskAskProgress';
import { openAgentMemory } from '../features/memory/memory-store';
import { useChatSearchNavigation } from '../features/search/useChatSearchNavigation';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useRoomChat } from '../hooks/useRoomChat';
import { useRoomFiles } from '../hooks/useRoomFiles';
import { useRoomMonitor } from '../hooks/useRoomMonitor';
import { useRoomPreferences } from '../hooks/useRoomPreferences';
import { useRoomMenuActions, type AgentManagementView } from '../hooks/useRoomMenuActions';
import { useRoomMessageModeration } from '../hooks/useRoomMessageModeration';
import { useSendQueue } from '../hooks/useSendQueue';
import {
  buildSendPlan,
  composeMessageBody,
  mentionNames,
  resolveReplyAgentTarget,
  senderName,
  type HistoryMessage,
} from '../lib/chat';
import { groupColorFor } from '../lib/group-colors';
import { filePreviewKind, type RoomFileItem } from '../lib/files-ui';
import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { SCOPE_RESET_EVENT, type ScopeResetDetail } from '../lib/scope-reset';
import { outboxUpdateBusy, setUpdateBusy } from '../pwa/update-busy';
import { useRecoveryState } from '../pwa/recovery';
import { isUpdateWriteBlocked, useUpdateWriteBlocked } from '../pwa/update-store';

const FilesPane = lazy(() =>
  import('../features/panels/FilesPane').then((module) => ({ default: module.FilesPane })),
);
const MonitorPane = lazy(() =>
  import('../features/panels/MonitorPane').then((module) => ({ default: module.MonitorPane })),
);

/**
 * 文件栏 chunk 到达前的同宽骨架由独立组件承接，避免 ChatPage 继续膨胀。
 */

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
  const recovery = useRecoveryState();
  const restoring = recovery.phase === 'checking' || chat.catchUp?.active === true;
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
  const [previewFile, setPreviewFile] = useState<RoomFileItem | null>(null);
  const [panePreviewFile, setPanePreviewFile] = useState<RoomFileItem | null>(null);

  useEffect(() => {
    const onScopeReset = (event: Event) => {
      const detail = (event as CustomEvent<ScopeResetDetail>).detail;
      if (detail?.roomId !== null && detail?.roomId !== undefined && detail.roomId !== roomId) {
        return;
      }
      // 撤权/切号后立即关闭文件预览与右栏预览，卸载组件会中止预览请求。
      setPreviewFile(null);
      setPanePreviewFile(null);
      setOverlayPane(null);
    };
    window.addEventListener(SCOPE_RESET_EVENT, onScopeReset);
    return () => window.removeEventListener(SCOPE_RESET_EVENT, onScopeReset);
  }, [roomId]);
  // 群成员弹窗从搜索右侧的常驻入口打开；关闭时必须显式回到该按钮。
  const membersButtonRef = useRef<HTMLButtonElement>(null);
  // 搜索弹窗关闭时按 id 取当前节点：Lenso 升级会替换原生按钮 DOM。
  const searchReturnFocusRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return document.getElementById('message-search-button');
      },
    }),
    [],
  );
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
  const writeBlocked = useUpdateWriteBlocked();
  const chatHeadRef = useRef<HTMLElement>(null);

  // 更新提示按真实头部底边定位：桌面 56px、移动端换行后更高，都落在头部
  // 下方，避免 fixed 提示盖住「文件」等操作按钮。
  useEffect(() => {
    const header = chatHeadRef.current;
    if (!header) return undefined;
    const root = document.documentElement;
    const sync = () => {
      const bottom = header.getBoundingClientRect().bottom;
      root.style.setProperty('--pwa-update-top', `${Math.round(bottom + 8)}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      root.style.removeProperty('--pwa-update-top');
    };
  }, []);

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
  const outboxSending = queue.items.some((item) => item.status === 'sending');
  const outboxBusy = outboxUpdateBusy(outboxSending).join('；');

  useEffect(() => {
    setUpdateBusy('outbox', outboxBusy || null);
    return () => setUpdateBusy('outbox', null);
  }, [outboxBusy]);

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
    : !recovery.online
      ? '离线 · 当前显示内存中的数据'
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

  const agentManagement =
    peer?.kind === 'agent'
      ? {
          canManage: roomActions.canManageAgent === true,
          disabled: management.data?.disabled === true,
          canTransfer:
            management.data?.can_transfer === true ||
            management.data?.pending_transfer?.can_accept === true ||
            management.data?.pending_transfer?.can_cancel === true ||
            room?.peer_can_manage === true,
        }
      : null;

  const onRecalled = useCallback(
    (item: HistoryMessage) => {
      if (taskTrace?.rootId === item.message_id) closeTrace();
      if (reply?.messageId === item.message_id) setReply(null);
      setSearchOpen(false);
      setForwardItem((current) =>
        current?.message_id === item.message_id ? null : current,
      );
      invalidateTasks();
    },
    [closeTrace, invalidateTasks, reply, taskTrace],
  );

  const moderation = useRoomMessageModeration({
    room,
    pinnedMessages: chat.detail?.pinned_messages ?? [],
    identityId: identity?.actor_id ?? null,
    token,
    onStatus: setStatus,
    onRecalled,
    refreshModeration: chat.refreshModeration,
  });

  const onRecall = moderation.recall;
  const onSetPinned = moderation.setPinned;

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
      if (isUpdateWriteBlocked()) {
        const message = '当前页面与服务器版本不兼容，请先更新后再发送。';
        setStatus(message);
        return { ok: false, error: message };
      }
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
      if (isUpdateWriteBlocked()) {
        setStatus('当前页面与服务器版本不兼容，请先更新后再重试发送。');
        return;
      }
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
  const dropEnabled = ready && room !== null && !room.read_only && !writeBlocked;
  const onDropFiles = useCallback(
    (files: File[]) => {
      if (!dropEnabled) return;
      fileDropRef.current?.(files);
    },
    [dropEnabled],
  );

  const onForward = useCallback((item: HistoryMessage) => {
    if (isUpdateWriteBlocked()) {
      setStatus('当前页面与服务器版本不兼容，请先更新后再转发。');
      return;
    }
    setForwardItem(item);
  }, []);
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

  // 搜索定位与快捷键；关闭焦点按 id 解析，Lenso 升级替换节点后仍有效。
  const searchNav = useChatSearchNavigation({
    roomId,
    token: token ?? '',
    humanTimeline: identity?.kind === 'human',
    ready,
    roomStatus: chat.status,
    searchOpen,
    setSearchOpen,
    setStatus,
    forcePin: () => setForcePinToken((value) => value + 1),
  });
  const navState = searchNav.navigation.state;
  const anchored = navState.status === 'anchored';

  // 首载骨架与静态输入区：错误态让位给错误页，避免骨架长期占位。
  const loadingShell = !ready && chat.status !== 'error';
  const filesRequested = desktop ? filesDesktopOpen : overlayPane === 'files';
  const filesVisible = ready && filesRequested;
  // 用户是否仍希望文件栏打开：断点只改变呈现方式，不改变这个意图。
  // 桌面缩窄到平板/移动后 overlayPane 为空，但 filesDesktopOpen 仍保留打开状态；
  // 主动关闭文件栏/toggle 监控时该值会同步为 false。
  const filesIntentOpen = desktop
    ? filesDesktopOpen
    : overlayPane === 'files' || (overlayPane === null && filesDesktopOpen);
  // 房间读取失败时不再显示骨架，避免错误页被永久占位；就绪前仍按最终宽度占位。
  const filesShellVisible = filesRequested && chat.status !== 'error';
  const monitorVisible =
    ready && (desktop ? monitorDesktopOpen : overlayPane === 'monitor');
  const files = useRoomFiles(roomId, token, filesVisible);
  const monitor = useRoomMonitor(roomId, token, monitorVisible);

  useEffect(() => {
    setOverlayPane(null);
    setOverlay(null);
    setPreviewFile(null);
    setPanePreviewFile(null);
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

  const openFilePreview = useCallback((item: RoomFileItem) => {
    const kind = filePreviewKind(item);
    if (desktop && (kind === 'html' || kind === 'markdown')) {
      setPreviewFile(null);
      setPanePreviewFile(item);
      setMonitorDesktopOpen(false);
      writePreference(MONITOR_OPEN_KEY, false);
      setFilesDesktopOpen(true);
      writePreference(FILES_OPEN_KEY, true);
    } else {
      setPanePreviewFile(null);
      setPreviewFile(item);
    }
  }, [desktop]);

  // 视口离开内联右栏断点时，将正在查看的文档移交给原有弹窗。
  // 不能直接看渲染后的 filesVisible：断点收窄会让它变为 false，但用户并没有关闭文件栏。
  // 只有用户意图也关闭文件栏时才不移交，避免隐藏文件栏后的残留预览凭空弹出 modal。
  useEffect(() => {
    if (desktop || !filesIntentOpen || !panePreviewFile) return;
    setPreviewFile(panePreviewFile);
    setPanePreviewFile(null);
  }, [desktop, filesIntentOpen, panePreviewFile]);

  // 用户主动隐藏文件栏时内联预览不应继续存在；断点导致的不可见不算隐藏。
  useEffect(() => {
    if (!filesIntentOpen) setPanePreviewFile(null);
  }, [filesIntentOpen]);

  const toggleFiles = useCallback(() => {
    if (!ready) return;
    setPanePreviewFile(null);
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
    // 桌面监控与文件共用右栏；移动/平板切换 overlay 也会隐藏文件栏。
    setPanePreviewFile(null);
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
    setPanePreviewFile(null);
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
              <ChatHeader
                headerRef={chatHeadRef}
                loading={loadingShell}
                title={title}
                subtitle={subtitle}
                groupColor={groupColor}
                room={room}
                peer={peer}
                identity={identity}
                mobile={mobile}
                filesVisible={filesVisible}
                monitorVisible={monitorVisible}
                membersButtonRef={membersButtonRef}
                roomMenuToggleRef={roomMenuToggleRef}
                preference={roomPreferences.preference(roomId)}
                blocked={blocked}
                agentManagement={agentManagement}
                onRenameAgent={() => roomActions.setRenameAgentOpen(true)}
                onSearch={() => setSearchOpen(true)}
                onOpenMembers={() => setOverlay('members')}
                onToggleMonitor={toggleMonitor}
                onToggleFiles={toggleFiles}
                onTogglePreference={roomActions.onTogglePreference}
                onArchive={() => void roomActions.onArchive()}
                onCopyPrompt={() => void roomActions.onCopyPrompt()}
                onToggleBlock={() => void roomActions.onToggleBlock()}
                onDeleteFriend={() => void roomActions.onDeleteFriend()}
                onToggleAgentDisabled={() => void roomActions.onToggleAgentDisabled()}
                onReissueToken={() => void roomActions.onReissueToken()}
                onDissolve={() => void roomActions.onDissolve()}
                onViewMemory={
                  peer?.kind === 'agent'
                    ? () =>
                        openAgentMemory(
                          { actor_id: peer.actor_id, name: peer.name },
                          { returnFocus: () => roomMenuToggleRef.current },
                        )
                    : null
                }
                onOpenOverlay={setOverlay}
              />
              {room?.read_only ? (
                <Alert
                  id="room-archive-banner"
                  className="room-archive-banner"
                  role="note"
                  aria-live="polite"
                  status="warning"
                  style={{ width: 'auto', margin: '8px 16px 0', padding: '8px 12px', borderRadius: 6 }}
                >
                  群聊已解散，当前为只读归档；截至解散点的历史仍可查看。
                </Alert>
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
                {ready && chat.catchUp ? (
                  <div
                    id="history-catchup"
                    className="history-catchup"
                    role="status"
                    aria-live="polite"
                    hidden={!chat.catchUp.active && !chat.catchUp.notice}
                    data-catchup-active={chat.catchUp.active ? '1' : '0'}
                    data-catchup-pages={chat.catchUp.pages}
                    data-catchup-seq={chat.catchUp.coveredSeq ?? ''}
                    data-catchup-rebuilt={chat.catchUp.rebuiltAt ? '1' : '0'}
                  >
                    {chat.catchUp.active
                      ? `正在补齐离线期间的历史（已覆盖 ${chat.catchUp.pages} 页${
                          chat.catchUp.coveredSeq ? `，seq ${chat.catchUp.coveredSeq}` : ''
                        }）…${
                          chat.catchUp.error ? ` ${chat.catchUp.error}` : ''
                        }`
                      : chat.catchUp.notice}
                  </div>
                ) : null}
                {loadingShell ? (
                  <div id="chat-skeleton" className="chat-skeleton" aria-hidden="true">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className={`skeleton-row${row === 1 ? ' mine' : ''}`}>
                        <span className="skeleton-avatar" />
                        <span className="skeleton-bubble" />
                      </div>
                    ))}
                  </div>
                ) : null}
                <Alert
                  id="chat-error"
                  className="chat-error"
                  role="alert"
                  aria-live="assertive"
                  status="danger"
                  hidden={chat.status !== 'error'}
                  style={{ margin: 0, padding: '26px 20px', textAlign: 'center' }}
                >
                  <p id="chat-error-text">{chat.error || '读取会话失败'}</p>
                  <div className="chat-error-actions">
                    <Button id="chat-error-retry" type="button" variant="prominent" size="md" onClick={() => void chat.load()}>
                      重试
                    </Button>
                    <Link id="chat-error-back" to="/">
                      返回会话列表
                    </Link>
                    {!identity ? (
                      <Link id="chat-error-pair" to="/pair">
                        连接已有账号
                      </Link>
                    ) : null}
                  </div>
                </Alert>
                {ready && room && identity ? (
                  <Timeline
                    items={anchored ? navState.items : chat.items}
                    room={room}
                    members={members}
                    identityId={identity.actor_id}
                    identityName={identity.name}
                    identityKind={identity.kind}
                    token={token ?? ''}
                    mentions={mentions}
                    outbox={queue.items}
                    olderLoading={anchored ? navState.olderLoading : chat.olderLoading}
                    olderError={anchored ? navState.olderError : chat.olderError}
                    olderEnded={
                      anchored
                        ? !navState.olderLoading && navState.nextOlder === null && navState.items.length > 0
                        : chat.olderEnded
                    }
                    hasOlder={anchored ? Boolean(navState.nextOlder) : chat.hasOlder}
                    forcePinToken={forcePinToken}
                    restoring={restoring}
                    onLoadOlder={anchored ? searchNav.navigation.loadOlder : chat.loadOlder}
                    onRetryOutbox={(id) => void onRetryOutbox(id)}
                    onRemoveOutbox={queue.remove}
                    retryBlocked={writeBlocked}
                    onQuote={onQuote}
                    onStatus={onStatus}
                    onMarkRead={chat.markRead}
                    onToggleTask={(item) => void onToggleTask(item)}
                    onOpenTask={openTrace}
                    onOpenFile={openFilePreview}
                    onRecall={(item) => void onRecall(item)}
                    onSetPinned={(item, pinned) => void onSetPinned(item, pinned)}
                    pinnedMessageIds={moderation.pinnedMessageIds}
                    moderationBusy={moderation.busy}
                    onForward={onForward}
                    searchNavigation={{
                      activeMessageId: navState.activeMessageId,
                      query: navState.query,
                      mode: navState.mode,
                      jumpToken: navState.jumpToken,
                      anchored,
                      hasNewer: navState.anchorWindow?.has_newer ?? false,
                      onReturnLatest: searchNav.returnLatest,
                    }}
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
                    // 豁免：加载骨架保留原生 textarea，与 Composer 的 #body 同一契约，
                    // 不接入 Lenso TextArea；它只占位、不可交互。
                    <form
                      id="composer"
                      className="composer composer--loading"
                      aria-busy="true"
                      onSubmit={(event) => event.preventDefault()}
                    >
                      <Button className="attach-btn" type="button" variant="bordered" size="md" aria-label="添加附件" disabled>
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
                      <Button className="send-btn primary" id="send" type="submit" variant="prominent" size="md" disabled>
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
                      onOpenFile={openFilePreview}
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
                    preview={desktop ? panePreviewFile : null}
                    onOpenPreview={openFilePreview}
                    onBack={() => setPanePreviewFile(null)}
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
        <ChatDialogsMount
          room={room}
          peer={peer}
          identity={identity}
          token={token}
          members={members}
          overlay={overlay}
          onOverlayChange={setOverlay}
          membersButtonRef={membersButtonRef}
          ownerTransfer={chat.detail?.owner_transfer ?? null}
          roomActions={roomActions}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          searchReturnFocusRef={searchReturnFocusRef}
          onLocateSearchResult={searchNav.locate}
          onOpenTrace={openTrace}
          taskTrace={taskTrace}
          onCloseTrace={closeTrace}
          onJumpToMessage={onJumpToMessage}
          forwardItem={forwardItem}
          onForwardItemChange={setForwardItem}
          invalidateTasks={invalidateTasks}
          setStatus={setStatus}
        />
      ) : null}
      <LazyFilePreviewDialog item={previewFile} onClose={() => setPreviewFile(null)} />
    </>
  );
}
