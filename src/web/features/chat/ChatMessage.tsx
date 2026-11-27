import { Tooltip } from '../../app/lenso-tooltip';
import { Button, Menu } from '../../app/lenso-controls';
import { ContextMenu, ContextMenuItem } from '../../app/lenso-context-menu';
import {
  lazy,
  memo,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  chatTime,
  fullTime,
  isAgentMessage,
  messageBodyBytes,
  receiptText,
  senderName,
  type HistoryMessage,
  type RoomMember,
  type RoomView,
} from '../../lib/chat';
import { copyText, extractFileCards } from '../../lib/files';
import type { RoomFileItem } from '../../lib/files-ui';
import { readFullMessage } from '../../lib/message-body';
import { useActorAvatarRecord } from '../../lib/actor-avatars';
import { useRecalledDraft } from '../../hooks/useRecalledDraft';
import { useUpdateWriteBlocked } from '../../pwa/update-store';
import { openAgentMemory, type AgentMemoryTarget } from '../memory/memory-store';
import { ActorAvatar } from '../avatar/ActorAvatar';
import { HumanBody } from './MessageBody';
import { MarkdownIsland } from './MarkdownIsland';
import { BodyPendingContext } from './body-pending';
import { scrollToMessage } from './scroll-to-message';

/**
 * 文件卡片只在消息正文含同源 `/f/` 链接时才会第一次渲染，因此把元数据、
 * 票据与降级逻辑拆成独立 chunk；普通消息不下载这部分代码。
 */
const MessageFileCard = lazy(() =>
  import('./MessageFileCard').then((module) => ({ default: module.MessageFileCard })),
);

/**
 * lazy chunk 未就绪时卡片本身还不在 DOM 里，高度也尚未出现。入口隐藏阶段
 * 把这次等待计入正文 pending，避免 reveal 后卡片整块出现把底部顶开。
 */
function MessageFileCardFallback() {
  const pendingRegistry = useContext(BodyPendingContext);
  useLayoutEffect(() => {
    const release = pendingRegistry?.begin();
    return release;
  }, [pendingRegistry]);
  return null;
}

interface ChatMessageProps {
  item: HistoryMessage;
  members: Map<string, RoomMember>;
  room: RoomView;
  identityId: string;
  identityName: string;
  identityKind: 'human' | 'agent';
  token: string;
  mentions: string[];
  allItems: HistoryMessage[];
  /** 搜索结果当前定位；只影响目标消息的轮廓与闪烁，不改正文渲染。 */
  searchActive?: boolean;
  searchFlash?: boolean;
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onOpenFile: (item: RoomFileItem) => void;
  onRecall: (item: HistoryMessage) => void;
  /** 把自己撤回、且本机有原文副本的消息放回输入框。 */
  onReedit: (item: HistoryMessage, body: string) => void;
  onSetPinned: (item: HistoryMessage, pinned: boolean) => void;
  pinnedMessageIds: ReadonlySet<string>;
  moderationBusy?: boolean;
  onForward: (item: HistoryMessage) => void;
}

/**
 * 视口内自动展开的并发闸门。
 *
 * 队列跨消息共享，避免首屏同时触发几十条 `network_message_read`；只在消息
 * 仍在视口且尚未展开时执行，卸载或滚出视口后释放名额。
 */
const autoExpandQueue: ((release: () => void) => void)[] = [];
let autoExpandActive = 0;

function drainAutoExpandQueue(): void {
  while (autoExpandActive < LIMITS.webAgentAutoExpandConcurrency && autoExpandQueue.length > 0) {
    const task = autoExpandQueue.shift();
    if (!task) return;
    autoExpandActive += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      autoExpandActive -= 1;
      drainAutoExpandQueue();
    };
    try {
      task(release);
    } catch {
      release();
    }
  }
}

function enqueueAutoExpand(task: (release: () => void) => void): void {
  autoExpandQueue.push(task);
  drainAutoExpandQueue();
}

interface CachedExpandedBody {
  text: string;
  expanded: boolean;
  bytes: number;
}

/**
 * 虚拟时间线会卸载窗口外的消息；全文与展开状态按 message_id 缓存，
 * 回滚到可见位置时不再重新请求，也不会把已展开正文重新藏起来。
 * 上限由 LIMITS.webExpandedBodyCache* 控制，超出按插入顺序淘汰。
 */
const expandedBodyCache = new Map<string, CachedExpandedBody>();
let expandedBodyBytes = 0;

function readExpandedBody(messageId: string): CachedExpandedBody | null {
  return expandedBodyCache.get(messageId) ?? null;
}

function rememberExpandedBody(messageId: string, text: string, expanded: boolean): void {
  const previous = expandedBodyCache.get(messageId);
  if (previous) {
    expandedBodyBytes -= previous.bytes;
    expandedBodyCache.delete(messageId);
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > LIMITS.webExpandedBodyCacheBytes) return;
  while (
    expandedBodyCache.size > 0 &&
    (expandedBodyBytes + bytes > LIMITS.webExpandedBodyCacheBytes ||
      expandedBodyCache.size >= LIMITS.webExpandedBodyCacheMax)
  ) {
    const oldest = expandedBodyCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const entry = expandedBodyCache.get(oldest);
    expandedBodyCache.delete(oldest);
    if (entry) expandedBodyBytes -= entry.bytes;
  }
  expandedBodyCache.set(messageId, { text, expanded, bytes });
  expandedBodyBytes += bytes;
}

function rememberExpandedState(messageId: string, expanded: boolean): void {
  const entry = expandedBodyCache.get(messageId);
  if (entry) entry.expanded = expanded;
}

function Receipt({
  item,
  members,
  identityId,
}: {
  item: HistoryMessage;
  members: Map<string, RoomMember>;
  identityId: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const last = Number(item.delivery_updated_at ?? item.delivery_claimed_at ?? 0);
  useEffect(() => {
    setNow(Date.now());
    if (!Number(item.delivery_states.claimed ?? 0) || !last) return undefined;
    const delay = last + LIMITS.claimedStaleMs - Date.now();
    if (delay <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), delay + 50);
    return () => clearTimeout(timer);
  }, [item.delivery_states.claimed, item.delivery_updated_at, item.delivery_claimed_at, last]);

  const stale = Boolean(
    Number(item.delivery_states.claimed ?? 0) &&
      last > 0 &&
      now - last >= LIMITS.claimedStaleMs,
  );
  return (
    <div
      className={`msg-system msg-receipt${stale ? ' stale' : ''}`}
      data-receipt-for={item.message_id}
      role="note"
    >
      <span>{receiptText(item, members, identityId, now)}</span>
    </div>
  );
}

function ReplyReference({
  item,
  allItems,
  members,
  identityId,
  identityName,
}: {
  item: HistoryMessage;
  allItems: HistoryMessage[];
  members: Map<string, RoomMember>;
  identityId: string;
  identityName: string;
}) {
  const target = useMemo(
    () => allItems.find((entry) => entry.message_id === item.reply_to) ?? null,
    [allItems, item.reply_to],
  );
  const [fallback, setFallback] = useState('');
  const label = target
    ? `${senderName(target.sender_id, members, identityName, identityId)}：${target.preview.slice(0, 120)}`
    : fallback || '引用消息 · 查看上下文';
  const showTarget = () => {
    if (!item.reply_to) return;
    if (scrollToMessage(item.reply_to)) return;
    if (fallback) return;
    void readFullMessage(item.reply_to)
      .then((text) => setFallback(`引用消息：${text.slice(0, 120)}`))
      .catch(() => setFallback('引用消息不可见'));
  };
  return (
    <Button
      type="button"
      className="reply-reference"
      data-reply-to={item.reply_to ?? undefined}
      onClick={showTarget}
    >
      {label}
    </Button>
  );
}

interface MessageAction {
  id: string;
  label: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** 菜单项选中后菜单会卸载，焦点回到同一条消息的可聚焦操作按钮。 */
function findMessageAction(messageId: string): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.dataset.messageId !== messageId) continue;
    return node.querySelector<HTMLElement>('button[aria-label="消息操作"]');
  }
  return null;
}

/** 复制/引用同时供 `···` 下拉与右键菜单使用，避免两套逻辑漂移。 */
function useMessageActions(
  item: HistoryMessage,
  room: RoomView,
  identityId: string,
  identityKind: 'human' | 'agent',
  onQuote: (item: HistoryMessage) => void,
  onStatus: (message: string) => void,
  onRecall: (item: HistoryMessage) => void,
  onSetPinned: (item: HistoryMessage, pinned: boolean) => void,
  pinnedMessageIds: ReadonlySet<string>,
  moderationBusy: boolean,
  onForward: (item: HistoryMessage) => void,
  memoryTarget: AgentMemoryTarget | null,
): MessageAction[] {
  const writeBlocked = useUpdateWriteBlocked();
  const truncated = item.body_bytes > messageBodyBytes(item.preview);
  const mine = item.sender_id === identityId;
  const canModerate =
    room.kind === 'group' && !room.read_only && room.capabilities?.manage_messages === true;
  const pinned = pinnedMessageIds.has(item.message_id);
  const pinFull = pinnedMessageIds.size >= LIMITS.roomPinnedMessagesMax;
  const moderationDisabled = writeBlocked || moderationBusy;
  const copy = async () => {
    try {
      const text = truncated ? await readFullMessage(item.message_id) : item.preview;
      await copyText(text);
      onStatus('已复制');
    } catch (error) {
      onStatus((error as Error).message || '复制失败');
    }
  };
  const actions: MessageAction[] = [{ id: 'message-action-copy', label: '复制', run: copy }];
  if (!room.read_only) {
    actions.push({ id: 'message-action-quote', label: '引用', run: () => onQuote(item) });
  }
  actions.push({
    id: 'message-action-forward',
    label: '转发',
    disabled: writeBlocked,
    run: () => onForward(item),
  });
  if (memoryTarget) {
    actions.push({
      id: 'message-action-memory',
      label: mine ? '查看我的记忆' : '查看发送者记忆',
      run: () =>
        openAgentMemory(memoryTarget, {
          returnFocus: () => findMessageAction(item.message_id),
        }),
    });
  }
  const canSelfRecall = identityKind === 'human' && mine && !room.read_only;
  if (canModerate || canSelfRecall) {
    actions.push({
      id: 'message-action-recall',
      label: '撤回',
      disabled: moderationDisabled,
      run: () => onRecall(item),
    });
  }
  if (canModerate) {
    actions.push({
      id: pinned ? 'message-action-unpin' : 'message-action-pin',
      label: pinned
        ? '取消置顶'
        : pinFull
          ? '置顶（最多置顶 3 条）'
          : '置顶',
      disabled: moderationDisabled || (!pinned && pinFull),
      run: () => onSetPinned(item, !pinned),
    });
  }
  return actions;
}

function MessageMenuItems({
  actions,
  Item,
}: {
  actions: MessageAction[];
  Item: React.ElementType;
}) {
  return (
    <>
      {actions.map((action) => (
        <Item
          key={action.id}
          id={action.id}
          className="room-menu-item"
          disabled={action.disabled}
          onSelect={() => {
            void action.run();
          }}
        >
          {action.label}
        </Item>
      ))}
    </>
  );
}

function MessageActions({
  item,
  room,
  identityId,
  identityKind,
  onQuote,
  onStatus,
  onRecall,
  onSetPinned,
  pinnedMessageIds,
  moderationBusy,
  onForward,
  memoryTarget,
}: {
  item: HistoryMessage;
  room: RoomView;
  identityId: string;
  identityKind: 'human' | 'agent';
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onRecall: (item: HistoryMessage) => void;
  onSetPinned: (item: HistoryMessage, pinned: boolean) => void;
  pinnedMessageIds: ReadonlySet<string>;
  moderationBusy?: boolean;
  onForward: (item: HistoryMessage) => void;
  memoryTarget: AgentMemoryTarget | null;
}) {
  const actions = useMessageActions(
    item,
    room,
    identityId,
    identityKind,
    onQuote,
    onStatus,
    onRecall,
    onSetPinned,
    pinnedMessageIds,
    moderationBusy === true,
    onForward,
    memoryTarget,
  );
  const [open, setOpen] = useState(false);
  return (
    <Menu id="message-action-menu" label="消息操作"
      className="room-menu spa-menu message-action-menu"
      open={open} onOpenChange={setOpen} sideOffset={4} align="start"
      fallbackAnchor instantCloseOnSelect
      items={actions.map((action) => ({
        id: action.id, label: action.label, disabled: action.disabled,
        className: `room-menu-item${action.id === 'message-action-recall' ? ' danger' : ''}`,
        variant: action.id === 'message-action-recall' ? 'danger' : 'default',
        onSelect: () => { void action.run(); },
      }))}
      trigger={<Button type="button" className="message-actions-trigger" aria-label="消息操作">
        ···
      </Button>} />
  );
}

/**
 * 消息右键/长按菜单；统一适配器负责计时、portal 定位、Esc 与焦点返回。
 */
function MessageContextMenu({
  item,
  room,
  identityId,
  identityKind,
  onQuote,
  onStatus,
  onRecall,
  onSetPinned,
  pinnedMessageIds,
  moderationBusy,
  onForward,
  memoryTarget,
  children,
}: {
  item: HistoryMessage;
  room: RoomView;
  identityId: string;
  identityKind: 'human' | 'agent';
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onRecall: (item: HistoryMessage) => void;
  onSetPinned: (item: HistoryMessage, pinned: boolean) => void;
  pinnedMessageIds: ReadonlySet<string>;
  moderationBusy?: boolean;
  onForward: (item: HistoryMessage) => void;
  memoryTarget: AgentMemoryTarget | null;
  children: ReactNode;
}) {
  const actions = useMessageActions(
    item,
    room,
    identityId,
    identityKind,
    onQuote,
    onStatus,
    onRecall,
    onSetPinned,
    pinnedMessageIds,
    moderationBusy === true,
    onForward,
    memoryTarget,
  );
  return (
    <ContextMenu trigger={children as React.ReactElement} id="message-context-menu"
      className="room-menu spa-menu message-action-menu" label="消息操作">
      <MessageMenuItems actions={actions} Item={ContextMenuItem} />
    </ContextMenu>
  );
}

export const ChatMessage = memo(function ChatMessage({
  item,
  members,
  room,
  identityId,
  identityName,
  identityKind,
  token,
  mentions,
  allItems,
  searchActive = false,
  searchFlash = false,
  onQuote,
  onStatus,
  onOpenFile,
  onRecall,
  onReedit,
  onSetPinned,
  pinnedMessageIds,
  moderationBusy = false,
  onForward,
}: ChatMessageProps) {
  const cachedBody = readExpandedBody(item.message_id);
  const [fullBody, setFullBody] = useState<string | null>(cachedBody?.text ?? null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [autoPending, setAutoPending] = useState(false);
  const [longExpanded, setLongExpanded] = useState(cachedBody?.expanded ?? false);
  const rowRef = useRef<HTMLDivElement>(null);
  const fullBodyRef = useRef<string | null>(cachedBody?.text ?? null);
  const loadingRef = useRef(false);
  const visibleRef = useRef(false);
  const autoRequestedRef = useRef(false);
  const mine = item.sender_id === identityId;
  const agent = isAgentMessage(item, members);
  const name = senderName(item.sender_id, members, identityName, identityId);
  const cachedSender = useActorAvatarRecord(item.sender_id);
  const senderAvatarUrl =
    item.sender_avatar_url ??
    cachedSender?.avatar_url ??
    members.get(item.sender_id)?.avatar_url ??
    null;
  const truncated = item.body_bytes > messageBodyBytes(item.preview);
  const longBody = item.body_bytes >= LIMITS.webLongMessageCollapseBytes;
  const autoEligible =
    agent && truncated && item.body_bytes <= LIMITS.webAgentAutoExpandBytes;
  const shown = fullBody ?? item.preview;
  const collapsed = longBody && fullBody !== null && !longExpanded;
  const cards = useMemo(() => extractFileCards(shown), [shown]);
  const memoryTarget: AgentMemoryTarget | null = agent
    ? { actor_id: item.sender_id, name: mine ? identityName : name }
    : null;

  const loadFull = async () => {
    if (fullBodyRef.current !== null || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingFull(true);
    try {
      const text = await readFullMessage(item.message_id);
      fullBodyRef.current = text;
      rememberExpandedBody(item.message_id, text, true);
      setFullBody(text);
      // 读取全文就是用户显式展开：直接显示完整正文与「收起」。
      setLongExpanded(true);
    } catch (error) {
      onStatus((error as Error).message || '读取正文失败');
    } finally {
      loadingRef.current = false;
      setLoadingFull(false);
    }
  };

  useEffect(() => {
    if (!autoEligible) return undefined;
    const node = rowRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    let cancelled = false;
    let controller: AbortController | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        visibleRef.current = visible;
        if (!visible || cancelled) return;
        if (autoRequestedRef.current || fullBodyRef.current !== null) return;
        autoRequestedRef.current = true;
        setAutoPending(true);
        enqueueAutoExpand((release) => {
          void (async () => {
            try {
              // 排队期间可能已滚出视口、被卸载或已被手动展开。
              if (cancelled || !visibleRef.current || fullBodyRef.current !== null) {
                if (!cancelled) autoRequestedRef.current = false;
                return;
              }
              controller = new AbortController();
              const text = await readFullMessage(item.message_id, undefined, controller.signal);
              if (cancelled) return;
              fullBodyRef.current = text;
              rememberExpandedBody(item.message_id, text, true);
              setFullBody(text);
              setLongExpanded(true);
            } catch {
              // 自动展开失败只回退到「查看全文」，不打断列表。
              if (!cancelled) autoRequestedRef.current = false;
            } finally {
              controller = null;
              if (!cancelled) setAutoPending(false);
              release();
            }
          })();
        });
      },
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      visibleRef.current = false;
      observer.disconnect();
      controller?.abort();
      controller = null;
      if (fullBodyRef.current === null) autoRequestedRef.current = false;
    };
  }, [autoEligible, item.message_id]);

  const recalledDraft = useRecalledDraft(
    item.body_bytes === 0 && mine ? identityId : null,
    item.message_id,
  );
  const reeditBody = mine && !room.read_only ? recalledDraft : null;

  if (item.body_bytes === 0) {
    const tombstone = (
      <div
        className="msg-system msg-recalled"
        data-message-id={item.message_id}
        role="listitem"
      >
        <span>此消息已撤回</span>
        {reeditBody ? (
          <Button
            type="button"
            variant="borderless"
            className="msg-reedit"
            data-reedit-message-id={item.message_id}
            onClick={() => onReedit(item, reeditBody)}
          >
            重新编辑
          </Button>
        ) : null}
      </div>
    );
    if (!reeditBody) return tombstone;
    // 右键菜单只在本人且有本地原文时出现；与行内按钮共用同一动作。
    return (
      <ContextMenu
        trigger={tombstone}
        id="recalled-message-context-menu"
        className="room-menu spa-menu message-action-menu"
        label="已撤回消息操作"
      >
        <ContextMenuItem
          id="message-action-reedit"
          className="room-menu-item"
          onSelect={() => onReedit(item, reeditBody)}
        >
          重新编辑
        </ContextMenuItem>
      </ContextMenu>
    );
  }

  return (
    <>
      <MessageContextMenu
        item={item}
        room={room}
        identityId={identityId}
        identityKind={identityKind}
        onQuote={onQuote}
        onStatus={onStatus}
        onRecall={onRecall}
        onSetPinned={onSetPinned}
        pinnedMessageIds={pinnedMessageIds}
        moderationBusy={moderationBusy}
        onForward={onForward}
        memoryTarget={memoryTarget}
      >
        <div
          className={`msg${mine ? ' mine has-receipt' : ''}${searchActive ? ' search-active' : ''}${searchFlash ? ' search-flash' : ''}`}
          data-message-id={item.message_id}
          data-search-active={searchActive ? 'true' : undefined}
          data-sender-kind={agent ? 'agent' : 'human'}
          data-auto-pending={autoPending ? 'true' : undefined}
          data-message-preview={item.preview}
          ref={rowRef}
          role="listitem"
        >
          <ActorAvatar
            className="msg-avatar"
            name={mine ? identityName : name}
            avatarUrl={senderAvatarUrl}
          />
          <div className="msg-content">
            {!mine && room.kind === 'group' ? <div className="msg-sender">{name}</div> : null}
            <Tooltip as="div"
              className={`bubble${collapsed ? ' is-collapsed' : ''}`}
              hint={fullTime(item.created_at)}
            >
              {agent ? (
                truncated && fullBody === null ? (
                  // 512B 切口可能落在表格/代码围栏中间；全文加载前只显示纯文本，
                  // 避免渲染半张表或把剩余文字吞进代码块。
                  <div className="msg-plain-preview">{item.preview}</div>
                ) : (
                  <MarkdownIsland text={shown} mentions={mentions} preview={false} />
                )
              ) : (
                <HumanBody text={shown} mentions={mentions} />
              )}
            </Tooltip>
            {cards.length > 0 ? (
              <div className="msg-files">
                <Suspense fallback={<MessageFileCardFallback />}>
                  {cards.map((card) => (
                    <MessageFileCard
                      key={card.fileId}
                      roomId={room.room_id}
                      fileId={card.fileId}
                      token={token}
                      fallbackName={card.fallbackName}
                      onOpenPreview={onOpenFile}
                    />
                  ))}
                </Suspense>
              </div>
            ) : null}
            {item.reply_to ? (
              <ReplyReference
                item={item}
                allItems={allItems}
                members={members}
                identityId={identityId}
                identityName={identityName}
              />
            ) : null}
            {fullBody === null && truncated && !autoPending ? (
              <Button
                type="button"
                className="expand"
                aria-expanded="false"
                disabled={loadingFull}
                onClick={() => void loadFull()}
              >
                {loadingFull ? '正在展开…' : '查看全文'}
              </Button>
            ) : null}
            {fullBody !== null && longBody ? (
              <Button
                type="button"
                className="expand"
                aria-expanded={longExpanded}
                onClick={() =>
                  setLongExpanded((value) => {
                    const next = !value;
                    rememberExpandedState(item.message_id, next);
                    return next;
                  })
                }
              >
                {longExpanded ? '收起' : '展开全文'}
              </Button>
            ) : null}
            {item.body_bytes > 0 ? (
              <MessageActions
                item={item}
                room={room}
                identityId={identityId}
                identityKind={identityKind}
                onQuote={onQuote}
                onStatus={onStatus}
                onRecall={onRecall}
                onSetPinned={onSetPinned}
                pinnedMessageIds={pinnedMessageIds}
                moderationBusy={moderationBusy}
                onForward={onForward}
                memoryTarget={memoryTarget}
              />
            ) : null}
          </div>
        </div>
      </MessageContextMenu>
      {mine ? <Receipt item={item} members={members} identityId={identityId} /> : null}
    </>
  );
});
