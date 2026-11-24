import { Button } from '../../app/lenso-controls';
import { Tooltip } from '../../app/lenso-tooltip';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Virtuoso,
  type ListRange,
  type ScrollerProps,
  type VirtuosoHandle,
} from 'react-virtuoso';

import { LIMITS } from '../../../contracts/limits';
import {
  historyItemKey,
  renderedWatermark,
  timelineTimestamp,
  type HistoryItem,
  type HistoryMessage,
} from '../../lib/chat';
import { outboxPreview } from '../../lib/outbox';
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

/**
 * 虚拟时间线。
 *
 * Virtuoso 负责动态高度测量、prepend 锚定与贴底；`firstItemIndex` 只随
 * “更早页”递减，实时追加不移动既有索引。旧的 scrollHeight 差值补偿不
 * 进入本路径。
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

interface ScrollerContextValue {
  long: boolean;
  anchored: boolean;
  hidden: boolean;
}

const ScrollerContext = createContext<ScrollerContextValue>({
  long: false,
  anchored: false,
  hidden: false,
});

const TimelineScroller = forwardRef<HTMLDivElement, ScrollerProps>(function TimelineScroller(
  props,
  ref,
) {
  const { long, anchored, hidden } = useContext(ScrollerContext);
  return (
    <div
      ref={ref}
      {...props}
      id="messages"
      className={`messages messages--virtual${long ? ' messages--long' : ''}`}
      style={{ ...props.style, visibility: hidden ? 'hidden' : undefined }}
      role="log"
      aria-live="polite"
      data-search-anchored={anchored ? 'true' : 'false'}
      data-timeline-mode="virtual"
      data-virtualized="true"
    />
  );
});

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
  onToggleTask,
  onOpenTask,
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
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const lastForceRef = useRef(forcePinToken);
  // 复位令牌来自“anchor 窗口被撤回丢弃”。它和 anchor→live 的 key 切换发生在
  // 同一次提交里；用状态记住是否已应用，才能在重挂载的初始定位上生效。
  const [appliedResetToken, setAppliedResetToken] = useState(scrollResetToken);
  const resetPending = scrollResetToken !== appliedResetToken;
  const lastJumpRef = useRef(searchNavigation?.jumpToken ?? -1);
  const anchored = searchNavigation?.anchored === true;
  const anchoredRef = useRef(anchored);
  const restoringRef = useRef(restoring);
  const loadingRef = useRef(false);
  const startLatchRef = useRef(false);
  const lastLoadAtRef = useRef(0);
  const initialSettledRef = useRef(false);
  const atBottomRef = useRef(false);
  const visibleEndRef = useRef(0);
  const lastUserInputRef = useRef(0);
  const markReadTimerRef = useRef<number | null>(null);
  anchoredRef.current = anchored;
  restoringRef.current = restoring;

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

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
    scrollerRef.current?.setAttribute('data-virt-pinned', String(value));
    setPinned(value);
    if (value) setHasNew(false);
  }, []);

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

  // 搜索/引用/Task 跳转共用：只有目标在已加载数据窗口内才滚动。
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const index = indexState.items.findIndex(
        (item) => item.kind !== 'presence' && item.message_id === messageId,
      );
      if (index < 0) return false;
      const handle = virtuosoRef.current;
      if (!handle) return false;
      setPin(false);
      handle.scrollToIndex({ index, align: 'center' });
      return true;
    },
    [indexState.items, setPin],
  );

  useEffect(() => registerScrollToMessage(jumpToMessage), [jumpToMessage]);
  useEffect(() => registerLoadedMessageTest((messageId) => messageIds.has(messageId)), [messageIds]);

  useEffect(
    () => () => {
      if (markReadTimerRef.current !== null) window.clearTimeout(markReadTimerRef.current);
    },
    [],
  );

  // 已读水位：只推进到当前可见的最后一条消息；anchor/恢复期间不推进。
  const scheduleMarkRead = useCallback(
    (endIndex: number) => {
      if (anchoredRef.current || restoringRef.current || !atBottomRef.current) return;
      const through = renderedWatermark(items.slice(0, Math.max(0, endIndex) + 1));
      if (!through) return;
      if (markReadTimerRef.current !== null) window.clearTimeout(markReadTimerRef.current);
      markReadTimerRef.current = window.setTimeout(() => {
        markReadTimerRef.current = null;
        if (anchoredRef.current || restoringRef.current || !atBottomRef.current) return;
        onMarkRead(through);
      }, LIMITS.webScrollMarkReadDelayMs);
    },
    [items, onMarkRead],
  );

  const revealWhenSettled = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    setReady(true);
  }, []);

  const handleAtBottom = useCallback(
    (value: boolean) => {
      atBottomRef.current = value;
      const scrollTop = scrollerRef.current?.scrollTop ?? 0;
      scrollerRef.current?.setAttribute('data-virt-at-bottom', String(value));
      scrollerRef.current?.setAttribute('data-virt-scroll-top', String(Math.round(scrollTop)));
      if (value) {
        initialSettledRef.current = true;
        revealWhenSettled();
        if (anchoredRef.current) {
          setPin(false);
          return;
        }
        setPin(true);
        scheduleMarkRead(visibleEndRef.current);
        return;
      }
      if (!pinnedRef.current || anchoredRef.current) return;
      // 只有近期真实用户输入才取消贴底；图片/Markdown/文件卡异步长高
      // 造成的离底保持 pinned，由 ResizeObserver 反复贴回底部。
      if (Date.now() - lastUserInputRef.current < 500) setPin(false);
    },
    [revealWhenSettled, scheduleMarkRead, setPin],
  );

  useEffect(() => {
    const node = scrollerNode;
    if (!node) return undefined;
    const mark = (event: Event) => {
      lastUserInputRef.current = Date.now();
      if (event.type === 'wheel' && (event as WheelEvent).deltaY < 0) {
        setPin(false);
      } else if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key === 'PageUp' || key === 'ArrowUp' || key === 'Home') setPin(false);
      }
    };
    const onScroll = () => {
      // 程序化/测试滚动到顶部也视为离开底部；初始定位完成前忽略。
      // 用真实可滚动高度判断，避免 atBottom 回调晚于 scroll 事件时误判。
      if (
        initialSettledRef.current &&
        node.scrollTop <= 2 &&
        node.scrollHeight > node.clientHeight + LIMITS.webScrollStickyPx
      ) {
        setPin(false);
      }
    };
    node.addEventListener('wheel', mark, { passive: true });
    node.addEventListener('touchstart', mark, { passive: true });
    node.addEventListener('touchmove', mark, { passive: true });
    node.addEventListener('pointerdown', mark, { passive: true });
    node.addEventListener('keydown', mark);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('wheel', mark);
      node.removeEventListener('touchstart', mark);
      node.removeEventListener('touchmove', mark);
      node.removeEventListener('pointerdown', mark);
      node.removeEventListener('keydown', mark);
      node.removeEventListener('scroll', onScroll);
    };
  }, [scrollerNode, setPin]);

  // 内容异步长高（Markdown 岛、图片、文件卡）时保持贴底；虚拟化后
  // Virtuoso 只在追加数据时 followOutput，不会自动跟随单条 item 的高度变化。
  useEffect(() => {
    const node = scrollerNode;
    if (!node) return undefined;
    let frame = 0;
    const keepPinned = () => {
      if (!pinnedRef.current || anchoredRef.current || restoringRef.current) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 调度后到执行前用户可能已上翻，必须在帧内再次确认。
        if (!pinnedRef.current || anchoredRef.current || restoringRef.current) return;
        const node = scrollerRef.current;
        // Virtuoso 的尺寸缓存可能仍按估算高度计算底部；直接贴到真实
        // scrollHeight，连续测量帧会继续把随后长高的内容纳入底部。
        if (node) node.scrollTop = node.scrollHeight;
        else {
          const lastIndex = Math.max(0, items.length - 1);
          virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: 'end' });
        }
      });
    };
    let resizeObserver: ResizeObserver | null = null;
    const observeContent = () => {
      const list = node.querySelector('[data-testid="virtuoso-item-list"]');
      if (!list) return;
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(keepPinned);
      resizeObserver.observe(list);
    };
    observeContent();
    const mutations = new MutationObserver(() => {
      observeContent();
      keepPinned();
    });
    mutations.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      resizeObserver?.disconnect();
      mutations.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items.length, scrollerNode]);

  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      const relative = (index: number): number =>
        index >= firstItemIndexRef.current ? index - firstItemIndexRef.current : index;
      const start = relative(range.startIndex);
      const end = Math.max(start, relative(range.endIndex));
      const clampedEnd = Math.min(items.length - 1, Math.max(0, end));
      visibleEndRef.current = clampedEnd;
      // 初次定位到底部后 range 才可信；避免启动阶段的探测渲染触发补页。
      if (!initialSettledRef.current && clampedEnd >= items.length - 3) {
        initialSettledRef.current = true;
        revealWhenSettled();
      }
      // anchor 窗口以目标为中心，range 不一定到底；首帧测量后即可显示。
      if (anchoredRef.current) {
        initialSettledRef.current = true;
        revealWhenSettled();
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
    [items.length, revealWhenSettled, scheduleMarkRead],
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
  }, [hasOlder, olderLoading, onLoadOlder]);

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (!isAtBottom || anchoredRef.current || restoringRef.current) return false as const;
      return 'auto' as const;
    },
    [],
  );

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
      setPin(true);
      requestAnimationFrame(() => jumpToLatest());
    } else if (!pinnedRef.current && lastKey !== lastKeyRef.current) {
      setHasNew(true);
    }
    lastKeyRef.current = lastKey;
  }, [anchored, forcePinToken, jumpToLatest, lastKey, restoring, setPin]);

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
              onToggleTask={onToggleTask}
              onOpenTask={onOpenTask}
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
      onOpenTask,
      onQuote,
      onRecall,
      onReedit,
      onSetPinned,
      onStatus,
      onToggleTask,
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
      <Button
        id="jump-latest"
        className="jump-latest"
        type="button"
        variant="bordered"
        size="sm"
        hidden={pinned || anchored}
        onClick={() => {
          setPin(true);
          jumpToLatest(true);
        }}
      >
        <span id="jump-latest-label">{hasNew ? '有新消息 · 回到最新' : '回到最新'}</span>
      </Button>
    </div>
  );
}
