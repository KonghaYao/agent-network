import { Button } from '../../app/lenso-controls';
import { Tooltip } from '../../app/lenso-tooltip';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso';

import { LIMITS } from '../../../contracts/limits';
import {
  historyItemKey,
  timelineTimestamp,
  type HistoryItem,
  type HistoryMessage,
} from '../../lib/chat';
import { outboxPreview } from '../../lib/outbox';
import { BodyPendingContext, createBodyPendingRegistry } from './body-pending';
import { ChatMessage } from './ChatMessage';
import {
  registerLoadedMessageTest,
  registerScrollToMessage,
} from './scroll-to-message';
import {
  TimelinePager,
  TimelinePresenceRow,
  TimelineTimeRow,
  timelineTimeGap,
  type TimelineProps,
} from './timeline-shared';
import { ScrollerContext, TimelineJumpLatest, TimelineScroller } from './timeline-virtual-scroller';
import { useTimelineBottomFollow } from './use-timeline-bottom-follow';

/**
 * 虚拟时间线。
 *
 * Virtuoso 负责动态高度测量、prepend 锚定与贴底；`firstItemIndex` 只随
 * “更早页”递减，实时追加不移动既有索引。旧的 scrollHeight 差值补偿不
 * 进入本路径。贴底/入口 reveal 由 `useTimelineBottomFollow` 负责，scroller
 * 与按钮等纯视图在 `timeline-virtual-scroller`。
 */

/** 初始绝对索引；只为 prepend 预留，业务上无意义。 */
const FIRST_ITEM_INDEX_BASE = 100_000;

interface IndexState {
  items: HistoryItem[];
  firstItemIndex: number;
}

function nextIndexState(previous: IndexState, items: HistoryItem[]): IndexState {
  const oldFirst = previous.items[0];
  const nextFirst = items[0];
  if (!nextFirst) {
    return { items, firstItemIndex: FIRST_ITEM_INDEX_BASE };
  }
  if (!oldFirst) {
    return { items, firstItemIndex: FIRST_ITEM_INDEX_BASE - items.length };
  }
  const oldKey = historyItemKey(oldFirst);
  const index = items.findIndex((item) => historyItemKey(item) === oldKey);
  // 找到旧首项：index > 0 表示 prepend 了 index 条，既有项索引保持不变。
  if (index > 0) {
    return { items, firstItemIndex: Math.max(1, previous.firstItemIndex - index) };
  }
  if (index === 0) {
    return { items, firstItemIndex: previous.firstItemIndex };
  }
  // 窗口被替换（搜索 anchor、切房或恢复重建）：重新给一个靠前的绝对区间。
  return { items, firstItemIndex: Math.max(1, FIRST_ITEM_INDEX_BASE - items.length) };
}

export function TimelineVirtual({
  items,
  room,
  members,
  identityId,
  identityName,
  identityKind,
  token,
  mentions,
  outbox,
  olderLoading,
  olderError,
  olderEnded,
  hasOlder,
  forcePinToken,
  scrollResetToken,
  restoring = false,
  searchNavigation,
  onLoadOlder,
  onRetryOutbox,
  onRemoveOutbox,
  retryBlocked = false,
  onQuote,
  onStatus,
  onMarkRead,
  onOpenFile,
  onRecall,
  onReedit,
  onSetPinned,
  pinnedMessageIds,
  moderationBusy = false,
  onForward,
}: TimelineProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollerNode, setScrollerNode] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node;
    if (!node) return;
    setScrollerNode(node);
    if (!node.hasAttribute('data-loaded-ready')) {
      node.setAttribute('data-loaded-ready', 'false');
    }
  }, []);
  const [flashId, setFlashId] = useState<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const lastForceRef = useRef(forcePinToken);
  // 复位令牌来自“anchor 窗口被撤回丢弃”。它和 anchor→live 的 key 切换发生在
  // 同一次提交里；用状态记住是否已应用，才能在重挂载的初始定位上生效。
  const [appliedResetToken, setAppliedResetToken] = useState(scrollResetToken);
  const resetPending = scrollResetToken !== appliedResetToken;
  const lastJumpRef = useRef(searchNavigation?.jumpToken ?? -1);
  const anchored = searchNavigation?.anchored === true;
  const loadingRef = useRef(false);
  const startLatchRef = useRef(false);
  const lastLoadAtRef = useRef(0);
  // 只统计当前挂载窗口的正文就绪情况；入口 reveal 在 count()===0 前不显示。
  const [bodyPending] = useState(() =>
    createBodyPendingRegistry((count) => {
      scrollerRef.current?.setAttribute('data-body-pending', String(count));
    }),
  );

  const [indexState, setIndexState] = useState<IndexState>(() => ({
    items,
    firstItemIndex: FIRST_ITEM_INDEX_BASE,
  }));
  if (indexState.items !== items) {
    setIndexState((previous) => nextIndexState(previous, items));
  }
  const firstItemIndexRef = useRef(indexState.firstItemIndex);
  firstItemIndexRef.current = indexState.firstItemIndex;

  const messages = useMemo(
    () => items.filter((entry): entry is HistoryMessage => entry.kind !== 'presence'),
    [items],
  );
  const messageIds = useMemo(
    () => new Set(messages.map((message) => message.message_id)),
    [messages],
  );

  const {
    pinned,
    pinnedRef,
    anchoredRef,
    hasNew,
    ready,
    suppressFollowUntilRef,
    initialSettledRef,
    visibleEndRef,
    setPin,
    setHasNew,
    followOutput,
    revealWhenSettled,
    watchInitialReveal,
    scheduleMarkRead,
    handleAtBottom,
    handleTotalListHeightChanged,
    snapPinnedToBottom,
    followLatest,
  } = useTimelineBottomFollow({
    virtuosoRef,
    scrollerRef,
    scrollerNode,
    items,
    bodyPending,
    anchored,
    restoring,
    onMarkRead,
  });

  const anchorTargetId = anchored ? (searchNavigation?.activeMessageId ?? null) : null;
  const anchorIndex =
    anchorTargetId === null
      ? -1
      : items.findIndex(
          (item) => item.kind !== 'presence' && item.message_id === anchorTargetId,
        );
  // 复位时必须让新挂载的 live 窗口从顶部开始，而不是用“最后一条 align=end”
  // 的初始定位把 anchor 撤销后的页面直接带到底部。
  const initialTopMostItemIndex = resetPending
    ? { index: 0, align: 'start' as const }
    : anchorIndex >= 0
      ? { index: anchorIndex, align: 'center' as const }
      : { index: Math.max(0, items.length - 1), align: 'end' as const };
  // anchor 窗口整体替换数据；换 key 让 Virtuoso 用初始索引定位，避免旧窗口
  // 的测量与滚动位置污染新窗口。实时窗口保持同一实例以持续跟随底部。
  const timelineKey = anchorTargetId ? `anchor:${anchorTargetId}` : `live:${room.room_id}`;

  const jumpToLatest = useCallback(
    (smooth = false) => {
      const index = indexState.items.length - 1;
      if (index < 0) return;
      virtuosoRef.current?.scrollToIndex({
        index,
        align: 'end',
        behavior: smooth ? 'smooth' : 'auto',
      });
    },
    [indexState.items.length],
  );

  // 搜索/引用跳转共用：只有目标在已加载数据窗口内才滚动。
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const index = indexState.items.findIndex(
        (item) => item.kind !== 'presence' && item.message_id === messageId,
      );
      if (index < 0) return false;
      const handle = virtuosoRef.current;
      if (!handle) return false;
      setPin(false);
      suppressFollowUntilRef.current = Date.now() + 600;
      handle.scrollToIndex({ index, align: 'center' });
      // 搜索/引用跳转发生在首屏 settle 期间时，立即结束入口遮罩，
      // 否则随后的逐帧贴底会把用户刚定位的消息带回底部。
      revealWhenSettled();
      return true;
    },
    [indexState.items, revealWhenSettled, setPin],
  );

  useEffect(() => registerScrollToMessage(jumpToMessage), [jumpToMessage]);
  useEffect(() => registerLoadedMessageTest((messageId) => messageIds.has(messageId)), [messageIds]);

  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      const relative = (index: number): number =>
        index >= firstItemIndexRef.current ? index - firstItemIndexRef.current : index;
      const start = relative(range.startIndex);
      const end = Math.max(start, relative(range.endIndex));
      const clampedEnd = Math.min(items.length - 1, Math.max(0, end));
      visibleEndRef.current = clampedEnd;
      // 初次定位到底部后 range 才可信；避免启动阶段的探测渲染触发补页。
      // 此时高度可能仍是估算值，只启动 settle 观察，不立刻显示。
      if (clampedEnd >= items.length - 3) watchInitialReveal();
      // anchor 窗口以目标为中心，range 不一定到底；首帧测量后即可显示。
      if (anchoredRef.current) {
        initialSettledRef.current = true;
        revealWhenSettled();
      } else {
        watchInitialReveal();
      }
      if (start > 0) startLatchRef.current = false;
      if (items.length > 0 && end >= start) {
        scrollerRef.current?.setAttribute('data-loaded-ready', 'true');
      }
      scrollerRef.current?.setAttribute(
        'data-visible-count',
        String(Math.max(0, Math.min(items.length, end - start + 1))),
      );
      scheduleMarkRead(clampedEnd);
    },
    [
      anchoredRef,
      initialSettledRef,
      items.length,
      revealWhenSettled,
      scheduleMarkRead,
      scrollerRef,
      visibleEndRef,
      watchInitialReveal,
    ],
  );

  const handleStartReached = useCallback(() => {
    if (!initialSettledRef.current || startLatchRef.current || loadingRef.current) return;
    if (!hasOlder || olderLoading || !onLoadOlder) return;
    const node = scrollerRef.current;
    // 不可滚动时不自动补页；短列表保持现状，用户仍可点“加载更早”。
    if (!node || node.scrollHeight <= node.clientHeight + LIMITS.webScrollStickyPx) return;
    // overscan 会让首项在远离顶部时也已渲染；只有真正接近顶部才自动补页，
    // 避免进入房间/贴底时级联加载。
    if (node.scrollTop > Math.max(LIMITS.webScrollStickyPx, node.clientHeight * 0.1)) return;
    const now = Date.now();
    if (now - lastLoadAtRef.current < LIMITS.webTimelineLoadCooldownMs) return;
    lastLoadAtRef.current = now;
    startLatchRef.current = true;
    loadingRef.current = true;
    void onLoadOlder().finally(() => {
      loadingRef.current = false;
    });
  }, [hasOlder, initialSettledRef, olderLoading, onLoadOlder, scrollerRef]);

  useLayoutEffect(() => {
    if (!resetPending) return undefined;
    setPin(false);
    const toTop = () => virtuosoRef.current?.scrollToIndex({ index: 0, align: 'start' });
    toTop();
    // Virtuoso 的初始测量可能晚于本次布局 effect；在下一帧再补一次，
    // 避免 anchor→live 重挂载的初始定位覆盖复位。initialTopMostItemIndex
    // 已按 resetPending 改为 0/start，这里只兜底异步测量。
    const frame = requestAnimationFrame(() => {
      toTop();
      setAppliedResetToken(scrollResetToken);
    });
    return () => cancelAnimationFrame(frame);
  }, [resetPending, scrollResetToken, setPin]);

  useEffect(() => {
    if (anchored) setPin(false);
  }, [anchored, setPin]);

  // 相关提交（items/pinned/ready）后、浏览器绘制前再贴一次底。Virtuoso 的
  // 异步测量/内部滚动状态可能在本组件提交之后才按旧锚点写回 scrollTop；
  // ResizeObserver 与 totalListHeightChanged 都是“事件驱动”的兜底，覆盖不了
  // 这种提交后的写回。只在 pinned 且非 anchor/恢复窗口时执行；gap 已 ≤2 时
  // no-op，同一帧多次提交也只有第一次真正写 scrollTop（幂等合并）。
  // 入口隐藏阶段与 reveal 后走同一条路径：是否显示由 watchInitialReveal 的
  // settle/pending 门控决定，这里不再按“reveal 后 N ms”跳过。
  // 绝不在用户上翻/搜索定位时抢滚动。
  useLayoutEffect(() => {
    snapPinnedToBottom();
  }, [snapPinnedToBottom]);

  const lastItem: HistoryItem | undefined = items[items.length - 1];
  const lastKey = lastItem ? historyItemKey(lastItem) : null;

  useLayoutEffect(() => {
    if (!lastKey) return;
    if (anchored) {
      lastKeyRef.current = lastKey;
      return;
    }
    if (restoring) {
      lastKeyRef.current = lastKey;
      return;
    }
    if (forcePinToken !== lastForceRef.current) {
      lastForceRef.current = forcePinToken;
      followLatest();
      requestAnimationFrame(() => jumpToLatest());
    } else if (!pinnedRef.current && lastKey !== lastKeyRef.current) {
      setHasNew(true);
    }
    lastKeyRef.current = lastKey;
  }, [anchored, followLatest, forcePinToken, jumpToLatest, lastKey, restoring]);

  // 搜索定位：目标必须在当前 items 中；否则由调用方先打开 anchor 窗口。
  useLayoutEffect(() => {
    const activeId = searchNavigation?.activeMessageId;
    const jumpToken = searchNavigation?.jumpToken ?? -1;
    if (!activeId || jumpToken === lastJumpRef.current) return undefined;
    lastJumpRef.current = jumpToken;
    if (!jumpToMessage(activeId)) return undefined;
    setFlashId(activeId);
    const timer = window.setTimeout(() => {
      setFlashId((current) => (current === activeId ? null : current));
    }, LIMITS.webMessageSearchFlashMs);
    return () => window.clearTimeout(timer);
  }, [jumpToMessage, searchNavigation?.activeMessageId, searchNavigation?.jumpToken]);

  const lastRendered = useRef<{ length: number; messageCount: number }>({
    length: items.length,
    messageCount: messages.length,
  });
  lastRendered.current = { length: items.length, messageCount: messages.length };
  const oldestLoadedId = messages[0]?.message_id ?? '';
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    node.setAttribute('data-loaded-count', String(lastRendered.current.length));
    node.setAttribute('data-loaded-message-count', String(lastRendered.current.messageCount));
    node.setAttribute('data-loaded-oldest-id', oldestLoadedId);
  }, [items.length, messages.length, oldestLoadedId, scrollerNode]);

  const components = useMemo(
    () => ({
      Scroller: TimelineScroller,
      Header: () => (
        <div className="vt-header">
          <TimelinePager
            olderLoading={olderLoading}
            olderError={olderError}
            olderEnded={olderEnded}
            hasOlder={hasOlder}
            itemCount={items.length}
            onLoadOlder={() => void onLoadOlder()}
          />
        </div>
      ),
      Footer: () => (
        <div className="vt-footer">
          {outbox.map((item) => {
            const state =
              item.status === 'committed'
                ? '已提交，正在同步'
                : item.status === 'failed'
                  ? item.retryable
                    ? '发送失败，可重试'
                    : '发送失败'
                  : '发送中';
            return (
              <div
                className="msg-system msg-outbox"
                key={item.client_message_id}
                data-client-message-id={item.client_message_id}
              >
                <Tooltip as="span" hint={item.error || undefined}>
                  {state} · {outboxPreview(item.body)}
                </Tooltip>
                {item.status === 'failed' && item.retryable ? (
                  <Button
                    className="outbox-retry"
                    type="button"
                    variant="borderless"
                    size="sm"
                    disabled={retryBlocked}
                    onClick={() => onRetryOutbox(item.client_message_id)}
                  >
                    重试
                  </Button>
                ) : null}
                {item.status === 'failed' ? (
                  <Button
                    className="outbox-dismiss"
                    type="button"
                    variant="borderless"
                    size="sm"
                    onClick={() => onRemoveOutbox(item.client_message_id)}
                  >
                    移除
                  </Button>
                ) : null}
              </div>
            );
          })}
          <div id="messages-end" className="messages-end" aria-hidden="true" />
        </div>
      ),
    }),
    [
      hasOlder,
      items.length,
      olderEnded,
      olderError,
      olderLoading,
      onLoadOlder,
      onRemoveOutbox,
      onRetryOutbox,
      outbox,
      retryBlocked,
    ],
  );

  const scrollerContext = useMemo(
    () => ({
      long: items.length >= LIMITS.webLongMessageListThreshold,
      anchored,
      hidden: !ready,
    }),
    [anchored, items.length, ready],
  );

  const renderItem = useCallback(
    (index: number, item: HistoryItem): ReactNode => {
      const timestamp = timelineTimestamp(item);
      const previousItem = index > 0 ? items[index - 1] : undefined;
      const previous = previousItem ? timelineTimestamp(previousItem) : 0;
      return (
        <div className="vt-item" data-item-key={historyItemKey(item)}>
          {item.kind !== 'presence' && timelineTimeGap(timestamp, previous) ? (
            <TimelineTimeRow timestamp={timestamp} />
          ) : null}
          {item.kind === 'presence' ? (
            <TimelinePresenceRow item={item} members={members} />
          ) : (
            <ChatMessage
              item={item}
              members={members}
              room={room}
              identityId={identityId}
              identityName={identityName}
              identityKind={identityKind}
              token={token}
              mentions={mentions}
              allItems={messages}
              searchActive={searchNavigation?.activeMessageId === item.message_id}
              searchFlash={flashId === item.message_id}
              onQuote={onQuote}
              onStatus={onStatus}
              onOpenFile={onOpenFile}
              onRecall={onRecall}
              onReedit={onReedit}
              onSetPinned={onSetPinned}
              pinnedMessageIds={pinnedMessageIds}
              moderationBusy={moderationBusy}
              onForward={onForward}
            />
          )}
        </div>
      );
    },
    [
      flashId,
      identityId,
      identityKind,
      identityName,
      items,
      members,
      mentions,
      messages,
      moderationBusy,
      onForward,
      onOpenFile,
      onQuote,
      onRecall,
      onReedit,
      onSetPinned,
      onStatus,
      pinnedMessageIds,
      room,
      searchNavigation?.activeMessageId,
      token,
    ],
  );

  return (
    <div className="timeline-wrap" style={{ display: 'contents' }}>
      {anchored && searchNavigation ? (
        <div
          id="search-navigation-bar"
          className="search-navigation-bar"
          role="region"
          aria-label="历史搜索结果导航"
        >
          <span className="search-navigation-label">
            历史搜索结果
            {searchNavigation.query ? `：${searchNavigation.query}` : ''}
            {searchNavigation.hasNewer ? ' · 窗口之后还有更新消息' : ''}
          </span>
          <Button
            type="button"
            variant="borderless"
            size="sm"
            id="search-return-latest"
            className="search-return-latest"
            onClick={searchNavigation.onReturnLatest}
          >
            返回最新消息
          </Button>
        </div>
      ) : null}
      <BodyPendingContext.Provider value={bodyPending}>
        <ScrollerContext.Provider value={scrollerContext}>
          <Virtuoso<HistoryItem>
            key={timelineKey}
            ref={virtuosoRef}
            data={items}
            computeItemKey={(_, item) => historyItemKey(item)}
            firstItemIndex={indexState.firstItemIndex}
            initialTopMostItemIndex={initialTopMostItemIndex}
            defaultItemHeight={96}
            initialItemCount={Math.min(30, items.length)}
            followOutput={followOutput}
            startReached={handleStartReached}
            atBottomStateChange={handleAtBottom}
            atBottomThreshold={LIMITS.webScrollStickyPx}
            rangeChanged={handleRangeChanged}
            increaseViewportBy={{ top: 1_200, bottom: 1_200 }}
            totalListHeightChanged={handleTotalListHeightChanged}
            scrollerRef={(node) => {
              if (node instanceof HTMLDivElement) {
                attachScroller(node);
                node.setAttribute('data-loaded-count', String(items.length));
                node.setAttribute('data-loaded-message-count', String(messages.length));
              } else {
                attachScroller(null);
              }
            }}
            components={components}
            itemContent={renderItem}
          />
        </ScrollerContext.Provider>
      </BodyPendingContext.Provider>
      <TimelineJumpLatest
        pinned={pinned}
        anchored={anchored}
        hasNew={hasNew}
        onJumpLatest={() => {
          followLatest();
          jumpToLatest(true);
        }}
      />
    </div>
  );
}
