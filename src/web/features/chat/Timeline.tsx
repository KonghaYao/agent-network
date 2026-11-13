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

interface TimelineProps {
  items: HistoryItem[];
  room: RoomView;
  members: Map<string, RoomMember>;
  identityId: string;
  identityName: string;
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
}

export function Timeline({
  items,
  room,
  members,
  identityId,
  identityName,
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
}: TimelineProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const lastKeyRef = useRef<string | null>(null);
  const lastForceRef = useRef(forcePinToken);
  const autoLoadingRef = useRef(false);

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
      });
    } finally {
      autoLoadingRef.current = false;
    }
  }, [onLoadOlder]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance <= LIMITS.webScrollStickyPx) {
      if (!pinnedRef.current) setPin(true);
    } else if (pinnedRef.current) {
      setPin(false);
    }
    if (hasOlder && !olderLoading && element.scrollTop <= element.clientHeight * LIMITS.webOlderAutoTopRatio) {
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
          mentions={mentions}
          allItems={messages}
          onQuote={onQuote}
          onStatus={onStatus}
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
