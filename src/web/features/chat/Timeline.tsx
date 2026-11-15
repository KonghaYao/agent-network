import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  chatTime,
  historyItemKey,
  timelineTimestamp,
  type HistoryItem,
  type HistoryMessage,
  type RoomMember,
  type RoomView,
} from '../../lib/chat';
import { outboxPreview, type OutboxIntent } from '../../lib/outbox';
import { ChatMessage } from './ChatMessage';

const TIME_GAP = 5 * 60 * 1000;

interface ScrollAnchor {
  messageId: string;
  /** 消息顶部相对滚动容器顶部的偏移；可为负（消息顶部已在视口上方）。 */
  offset: number;
}

interface ScrollSnapshot {
  scrollTop: number;
  pinned: boolean;
  anchor: ScrollAnchor | null;
}

/**
 * 按房间保留滚动快照。只在当前页面生命周期内有效，刷新后回到首次进入
 * 的默认行为（底部），与 legacy 的 roomCache 一致。
 */
const roomScrollSnapshots = new Map<string, ScrollSnapshot>();

function rememberRoomScroll(roomId: string, snapshot: ScrollSnapshot): void {
  roomScrollSnapshots.delete(roomId);
  roomScrollSnapshots.set(roomId, snapshot);
  while (roomScrollSnapshots.size > LIMITS.webRoomScrollCacheMax) {
    const oldest = roomScrollSnapshots.keys().next().value;
    if (oldest === undefined) break;
    roomScrollSnapshots.delete(oldest);
  }
}

/** 视口内第一条消息；时间胶囊、分页器和底部 sentinel 都不是稳定锚点。 */
function firstVisibleMessage(element: HTMLOListElement): ScrollAnchor | null {
  const listTop = element.getBoundingClientRect().top;
  const listBottom = element.getBoundingClientRect().bottom;
  for (const child of element.children) {
    const node = child as HTMLElement;
    if (!node.dataset.messageId) continue;
    const rect = node.getBoundingClientRect();
    if (rect.top >= listBottom || rect.bottom <= listTop) continue;
    return { messageId: node.dataset.messageId, offset: rect.top - listTop };
  }
  return null;
}

function findMessageElement(
  element: HTMLOListElement,
  messageId: string,
): HTMLElement | null {
  for (const child of element.children) {
    const node = child as HTMLElement;
    if (node.dataset.messageId === messageId) return node;
  }
  return null;
}

interface TimelineProps {
  items: HistoryItem[];
  room: RoomView;
  members: Map<string, RoomMember>;
  identityId: string;
  identityName: string;
  identityKind: 'human' | 'agent';
  mentions: string[];
  outbox: OutboxIntent[];
  olderLoading: boolean;
  olderError: string | null;
  olderEnded: boolean;
  hasOlder: boolean;
  forcePinToken: number;
  onLoadOlder: () => Promise<void>;
  onRetryOutbox: (clientMessageId: string) => void;
  onRemoveOutbox: (clientMessageId: string) => void;
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onMarkRead: (throughSeq: string) => void;
  onToggleTask: (item: HistoryMessage) => void;
  onOpenTask: (rootId: string, focusMessageId: string | null) => void;
  onRecall: (item: HistoryMessage) => void;
  onForward: (item: HistoryMessage) => void;
}

export function Timeline({
  items,
  room,
  members,
  identityId,
  identityName,
  identityKind,
  mentions,
  outbox,
  olderLoading,
  olderError,
  olderEnded,
  hasOlder,
  forcePinToken,
  onLoadOlder,
  onRetryOutbox,
  onRemoveOutbox,
  onQuote,
  onStatus,
  onMarkRead,
  onToggleTask,
  onOpenTask,
  onRecall,
  onForward,
}: TimelineProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const lastKeyRef = useRef<string | null>(null);
  const lastForceRef = useRef(forcePinToken);
  const autoLoadingRef = useRef(false);

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
    if (value) {
      setHasNew(false);
      anchorRef.current = null;
    }
  }, []);

  const restoreAnchor = useCallback((anchor: ScrollAnchor | null) => {
    const element = listRef.current;
    if (!element || !anchor) return;
    const target = findMessageElement(element, anchor.messageId);
    if (!target) return;
    const listTop = element.getBoundingClientRect().top;
    const drift = target.getBoundingClientRect().top - listTop - anchor.offset;
    if (Math.abs(drift) >= 0.5) element.scrollTop += drift;
  }, []);

  const rememberPosition = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const currentPinned = pinnedRef.current;
    const anchor = currentPinned ? null : firstVisibleMessage(element);
    anchorRef.current = anchor;
    rememberRoomScroll(room.room_id, {
      scrollTop: element.scrollTop,
      pinned: currentPinned,
      anchor,
    });
  }, [room.room_id]);

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

  /**
   * 房间切换后先恢复快照，再让下面的 items effect 决定是否钉底。
   * 同步写入 lastKeyRef，避免把已缓存的历史误判成“切回后有新消息”。
   */
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    lastKeyRef.current = lastKey;
    lastForceRef.current = forcePinToken;
    setHasNew(false);

    const snapshot = roomScrollSnapshots.get(room.room_id);
    if (!snapshot) {
      setPin(true);
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (snapshot.pinned) {
      setPin(true);
      element.scrollTop = element.scrollHeight;
      return;
    }
    setPin(false);
    element.scrollTop = Math.max(0, snapshot.scrollTop);
    anchorRef.current = snapshot.anchor;
    restoreAnchor(snapshot.anchor);
    // 只在房间变化时恢复；items 更新由下方 content effect 与 ResizeObserver 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.room_id]);

  useLayoutEffect(() => {
    if (!lastKey) return;
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
  }, [items, lastKey, forcePinToken, scrollBottom, setPin]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return undefined;
    let frame = 0;
    const settle = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pinnedRef.current) scrollBottom();
        else restoreAnchor(anchorRef.current);
      });
    };
    const observer = new ResizeObserver(settle);
    const observeChildren = () => {
      for (const child of element.children) {
        if (child instanceof HTMLElement) observer.observe(child);
      }
    };
    observer.observe(element);
    observeChildren();
    // Markdown 岛晚一帧挂载只改变消息高度，不改变列表自身盒子；观察子树与每个消息。
    const mutations = new MutationObserver(() => {
      observeChildren();
      settle();
    });
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items, restoreAnchor, scrollBottom]);

  useEffect(() => {
    if (!pinned) return undefined;
    const timer = setTimeout(() => onMarkRead(room.head_seq), LIMITS.webScrollMarkReadDelayMs);
    return () => clearTimeout(timer);
  }, [pinned, room.head_seq, onMarkRead]);

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
        rememberPosition();
      });
    } finally {
      autoLoadingRef.current = false;
    }
  }, [onLoadOlder, rememberPosition]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance <= LIMITS.webScrollStickyPx) {
      if (!pinnedRef.current) setPin(true);
    } else if (pinnedRef.current) {
      setPin(false);
    }
    rememberPosition();
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
    if (item.kind !== 'presence' && (!previous || timestamp - previous > TIME_GAP)) {
      rows.push(
        <li className="msg-time" key={`time:${timestamp}:${rows.length}`}>
          <span>{chatTime(timestamp)}</span>
        </li>,
      );
    }
    if (item.kind === 'presence') {
      const name = members.get(item.agent_id)?.name ?? item.agent_id;
      const action = item.transition === 'online' ? '上线' : '下线';
      rows.push(
        <li
          className="msg-system msg-presence"
          key={`presence:${item.presence_event_id}`}
          data-presence-id={item.presence_event_id}
        >
          <span title={item.time_basis === 'inferred' ? '下线时间为崩溃后推断' : undefined}>
            {name} {action}
            {chatTime(item.occurred_at) ? ` · ${chatTime(item.occurred_at)}` : ''}
          </span>
        </li>,
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
          mentions={mentions}
          allItems={messages}
          onQuote={onQuote}
          onStatus={onStatus}
          onToggleTask={onToggleTask}
          onOpenTask={onOpenTask}
          onRecall={onRecall}
          onForward={onForward}
        />,
      );
    }
    previous = timestamp || previous;
  }

  const showPager = hasOlder || olderLoading || olderError !== null || (olderEnded && items.length >= LIMITS.historyPageDefault);

  return (
    <div className="timeline-wrap" style={{ display: 'contents' }}>
      <ol
        id="messages"
        className={`messages${items.length >= LIMITS.webLongMessageListThreshold ? ' messages--long' : ''}`}
        aria-live="polite"
        ref={listRef}
        onScroll={onScroll}
      >
        {showPager ? (
          <li id="history-pager" className="history-pager">
            <button
              id="older"
              type="button"
              aria-busy={olderLoading ? 'true' : 'false'}
              disabled={olderLoading || !hasOlder}
              onClick={() => void loadOlder()}
            >
              加载更早
            </button>
            <span id="older-status" className="history-status" role="status" aria-live="polite">
              {olderError ?? (olderEnded && items.length > 0 ? '已经到最早的消息了' : '')}
            </span>
          </li>
        ) : null}
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
            <li
              className="msg-system msg-outbox"
              key={item.client_message_id}
              data-client-message-id={item.client_message_id}
            >
              <span title={item.error || undefined}>
                {state} · {outboxPreview(item.body)}
              </span>
              {item.status === 'failed' && item.retryable ? (
                <button
                  className="outbox-retry"
                  type="button"
                  onClick={() => onRetryOutbox(item.client_message_id)}
                >
                  重试
                </button>
              ) : null}
              {item.status === 'failed' ? (
                <button
                  className="outbox-dismiss"
                  type="button"
                  onClick={() => onRemoveOutbox(item.client_message_id)}
                >
                  移除
                </button>
              ) : null}
            </li>
          );
        })}
        <li id="messages-end" className="messages-end" aria-hidden="true" />
      </ol>
      <button
        id="jump-latest"
        className="jump-latest"
        type="button"
        hidden={pinned}
        onClick={() => {
          setPin(true);
          scrollBottom(true);
        }}
      >
        <span id="jump-latest-label">{hasNew ? '有新消息 · 回到最新' : '回到最新'}</span>
      </button>
    </div>
  );
}
