import { Button } from '../../app/lenso-controls';
import { Tooltip } from '../../app/lenso-tooltip';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
import { scrollToMessage } from './scroll-to-message';
import {
  TimelinePager,
  TimelinePresenceRow,
  TimelineTimeRow,
  timelineTimeGap,
  type TimelineProps,
} from './timeline-shared';

/**
 * DOM 时间线（回滚路径）。
 *
 * 虚拟化默认开启；本文件保留原实现一个迭代，供 `?timeline=dom` 或
 * `LIMITS.webTimelineVirtual=false` 回滚。旧的 scrollHeight 差值补偿只服务
 * 这条路径，新增功能不要再依赖 `#messages` 的全量 DOM。
 */
export function TimelineDom({
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
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const lastForceRef = useRef(forcePinToken);
  const lastScrollResetRef = useRef(scrollResetToken);
  /** 复位产生的 scroll 事件不能重新 pin、不能自动补读旧页。 */
  const programmaticScrollRef = useRef(false);
  const lastJumpRef = useRef(searchNavigation?.jumpToken ?? -1);
  const autoLoadingRef = useRef(false);
  const restoreScrollSkipRef = useRef(false);
  const anchored = searchNavigation?.anchored === true;

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
    if (value) setHasNew(false);
  }, []);

  const scrollBottom = useCallback((smooth = false) => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const lastItem: HistoryItem | undefined = items[items.length - 1];
  const lastKey = lastItem ? historyItemKey(lastItem) : null;
  const messages = useMemo(
    () => items.filter((entry): entry is HistoryMessage => entry.kind !== 'presence'),
    [items],
  );

  useLayoutEffect(() => {
    if (scrollResetToken === lastScrollResetRef.current) return;
    lastScrollResetRef.current = scrollResetToken;
    const element = listRef.current;
    if (!element) return;
    setPin(false);
    if (element.scrollTop !== 0) {
      programmaticScrollRef.current = true;
      element.scrollTop = 0;
    }
  }, [scrollResetToken, setPin]);

  useLayoutEffect(() => {
    if (!lastKey) return;
    if (anchored) {
      lastKeyRef.current = lastKey;
      return;
    }
    if (restoring) {
      // 恢复期间只记录提交位置，不自动滚底；避免把用户从正在阅读/编辑的位置拉走。
      if (lastKey !== lastKeyRef.current) restoreScrollSkipRef.current = true;
      lastKeyRef.current = lastKey;
      return;
    }
    if (restoreScrollSkipRef.current) {
      // 恢复刚结束时也不补一次滚底；用户自己回到底部后才会重新 pin。
      restoreScrollSkipRef.current = false;
      lastKeyRef.current = lastKey;
      return;
    }
    if (forcePinToken !== lastForceRef.current) {
      lastForceRef.current = forcePinToken;
      setPin(true);
      requestAnimationFrame(() => scrollBottom());
    } else if (pinnedRef.current) {
      scrollBottom();
    } else if (lastKey !== lastKeyRef.current) {
      setHasNew(true);
    }
    lastKeyRef.current = lastKey;
  }, [anchored, items, lastKey, forcePinToken, restoring, scrollBottom, setPin]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return undefined;
    let frame = 0;
    const keepPinned = () => {
      if (!pinnedRef.current) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => scrollBottom());
    };
    const observer = new ResizeObserver(keepPinned);
    observer.observe(element);
    // Markdown 岛晚一帧挂载只改变内容高度，不改变列表自身盒子；同时观察子树。
    const mutations = new MutationObserver(keepPinned);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollBottom]);

  // 历史窗口不跟最新页，不推进已读，也不因底部位置重新 pin。
  useEffect(() => {
    if (anchored) setPin(false);
  }, [anchored, setPin]);

  // 搜索定位：锚点窗口或当前实时列表提交 DOM 后滚动到目标并短暂闪烁。
  useLayoutEffect(() => {
    const activeId = searchNavigation?.activeMessageId;
    const jumpToken = searchNavigation?.jumpToken ?? -1;
    if (!activeId || jumpToken === lastJumpRef.current) return undefined;
    lastJumpRef.current = jumpToken;
    setPin(false);
    if (!scrollToMessage(activeId)) return undefined;
    setFlashId(activeId);
    const timer = window.setTimeout(() => {
      setFlashId((current) => (current === activeId ? null : current));
    }, LIMITS.webMessageSearchFlashMs);
    return () => window.clearTimeout(timer);
  }, [searchNavigation?.activeMessageId, searchNavigation?.jumpToken, setPin]);

  const renderedMaxSeq = useMemo(() => renderedWatermark(items), [items]);

  useEffect(() => {
    if (!pinned || anchored || restoring || !renderedMaxSeq) return undefined;
    const timer = setTimeout(() => {
      const element = listRef.current;
      if (!element) return;
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      // 恢复后即使 pin 仍为 true，也要以真实滚动位置确认真实展示。
      if (distance > LIMITS.webScrollStickyPx) return;
      onMarkRead(renderedMaxSeq);
    }, LIMITS.webScrollMarkReadDelayMs);
    return () => clearTimeout(timer);
  }, [anchored, onMarkRead, pinned, renderedMaxSeq, restoring]);

  const loadOlder = useCallback(async () => {
    const element = listRef.current;
    if (!element || autoLoadingRef.current) return;
    autoLoadingRef.current = true;
    const beforeHeight = element.scrollHeight;
    const beforeTop = element.scrollTop;
    try {
      await onLoadOlder();
      requestAnimationFrame(() => {
        const next = listRef.current;
        if (!next) return;
        next.scrollTop = beforeTop + (next.scrollHeight - beforeHeight);
      });
    } finally {
      autoLoadingRef.current = false;
    }
  }, [onLoadOlder]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    if (!anchored) {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (distance <= LIMITS.webScrollStickyPx) {
        if (!pinnedRef.current) setPin(true);
      } else if (pinnedRef.current) {
        setPin(false);
      }
    }
    const scrollRange = element.scrollHeight - element.clientHeight;
    if (
      hasOlder &&
      !olderLoading &&
      scrollRange > 0 &&
      element.scrollTop <= scrollRange * LIMITS.webOlderAutoTopRatio
    ) {
      void loadOlder();
    }
  };

  const rows: ReactNode[] = [];
  let previous = 0;
  for (const item of items) {
    const timestamp = timelineTimestamp(item);
    if (item.kind !== 'presence' && timelineTimeGap(timestamp, previous)) {
      rows.push(<TimelineTimeRow key={`time:${timestamp}:${rows.length}`} timestamp={timestamp} />);
    }
    if (item.kind === 'presence') {
      rows.push(
        <TimelinePresenceRow key={`presence:${item.presence_event_id}`} item={item} members={members} />,
      );
    } else {
      rows.push(
        <ChatMessage
          key={item.message_id}
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
        />,
      );
    }
    previous = timestamp || previous;
  }

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
      <div
        id="messages"
        className={`messages${items.length >= LIMITS.webLongMessageListThreshold ? ' messages--long' : ''}`}
        role="log"
        aria-live="polite"
        ref={listRef}
        data-search-anchored={anchored ? 'true' : 'false'}
        data-timeline-mode="dom"
        data-loaded-count={items.length}
        data-loaded-message-count={messages.length}
        onScroll={onScroll}
      >
        <TimelinePager
          olderLoading={olderLoading}
          olderError={olderError}
          olderEnded={olderEnded}
          hasOlder={hasOlder}
          itemCount={items.length}
          onLoadOlder={() => void loadOlder()}
        />
        {rows}
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
      <Button
        id="jump-latest"
        className="jump-latest"
        type="button"
        variant="bordered"
        size="sm"
        hidden={pinned || anchored}
        onClick={() => {
          setPin(true);
          scrollBottom(true);
        }}
      >
        <span id="jump-latest-label">{hasNew ? '有新消息 · 回到最新' : '回到最新'}</span>
      </Button>
    </div>
  );
}
