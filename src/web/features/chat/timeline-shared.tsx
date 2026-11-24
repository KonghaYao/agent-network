import { Button } from '../../app/lenso-controls';
import { Tooltip } from '../../app/lenso-tooltip';
import type { ReactNode } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  chatTime,
  type HistoryItem,
  type HistoryMessage,
  type RoomMember,
  type RoomView,
} from '../../lib/chat';
import type { OutboxIntent } from '../../lib/outbox';
import type { RoomFileItem } from '../../lib/files-ui';

export const TIME_GAP = 5 * 60 * 1000;

export type TimelineMode = 'virtual' | 'dom';

export interface TimelineSearchNavigation {
  activeMessageId: string | null;
  query: string;
  mode: 'exact' | 'fuzzy' | null;
  jumpToken: number;
  anchored: boolean;
  hasNewer: boolean;
  onReturnLatest: () => void;
}

export interface TimelineProps {
  items: HistoryItem[];
  room: RoomView;
  members: Map<string, RoomMember>;
  identityId: string;
  identityName: string;
  identityKind: 'human' | 'agent';
  token: string;
  mentions: string[];
  outbox: OutboxIntent[];
  olderLoading: boolean;
  olderError: string | null;
  olderEnded: boolean;
  hasOlder: boolean;
  forcePinToken: number;
  /** anchor 因撤回被丢弃时复位到最新页顶部；不滚底、不推进已读。 */
  scrollResetToken: number;
  /** 恢复/补洞期间不自动滚底、不推进已读。 */
  restoring?: boolean;
  searchNavigation?: TimelineSearchNavigation | null;
  onLoadOlder: () => Promise<void>;
  onRetryOutbox: (clientMessageId: string) => void;
  onRemoveOutbox: (clientMessageId: string) => void;
  /** 契约不兼容期间禁止任何重发；按钮保持可解释的禁用态。 */
  retryBlocked?: boolean;
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onMarkRead: (throughSeq: string) => void;
  onToggleTask: (item: HistoryMessage) => void;
  onOpenTask: (rootId: string, focusMessageId: string | null) => void;
  onOpenFile: (item: RoomFileItem) => void;
  onRecall: (item: HistoryMessage) => void;
  onReedit: (item: HistoryMessage, body: string) => void;
  onSetPinned: (item: HistoryMessage, pinned: boolean) => void;
  pinnedMessageIds: ReadonlySet<string>;
  moderationBusy?: boolean;
  onForward: (item: HistoryMessage) => void;
}

/**
 * 时间线渲染模式。URL `?timeline=dom` 优先于 `LIMITS`，方便不发版灰度回滚。
 * 只读取 location.search，不触发网络或服务端变更。
 */
export function timelineMode(
  search: string | null = typeof window === 'undefined' ? '' : window.location.search,
): TimelineMode {
  if (!LIMITS.webTimelineVirtual) return 'dom';
  const requested = new URLSearchParams(search ?? '').get('timeline');
  return requested === 'dom' ? 'dom' : 'virtual';
}

export function timelineTimeGap(timestamp: number, previous: number): boolean {
  return !previous || timestamp - previous > TIME_GAP;
}

export function TimelineTimeRow({ timestamp }: { timestamp: number }) {
  return (
    <div className="msg-time">
      <span>{chatTime(timestamp)}</span>
    </div>
  );
}

export function TimelinePresenceRow({
  item,
  members,
}: {
  item: Extract<HistoryItem, { kind: 'presence' }>;
  members: Map<string, RoomMember>;
}) {
  const name = members.get(item.agent_id)?.name ?? item.agent_id;
  const action = item.transition === 'online' ? '上线' : '下线';
  return (
    <div
      className="msg-system msg-presence"
      data-presence-id={item.presence_event_id}
      role="note"
    >
      <Tooltip as="span" hint={item.time_basis === 'inferred' ? '下线时间为崩溃后推断' : undefined}>
        {name} {action}
        {chatTime(item.occurred_at) ? ` · ${chatTime(item.occurred_at)}` : ''}
      </Tooltip>
    </div>
  );
}

export function TimelinePager({
  olderLoading,
  olderError,
  olderEnded,
  hasOlder,
  itemCount,
  onLoadOlder,
}: {
  olderLoading: boolean;
  olderError: string | null;
  olderEnded: boolean;
  hasOlder: boolean;
  itemCount: number;
  onLoadOlder: () => void;
}): ReactNode {
  const showPager =
    hasOlder ||
    olderLoading ||
    olderError !== null ||
    (olderEnded && itemCount >= LIMITS.historyPageDefault);
  if (!showPager) return null;
  return (
    <div id="history-pager" className="history-pager">
      <Button
        id="older"
        type="button"
        variant="bordered"
        size="sm"
        aria-busy={olderLoading ? 'true' : 'false'}
        disabled={olderLoading || !hasOlder}
        onClick={onLoadOlder}
      >
        加载更早
      </Button>
      <span id="older-status" className="history-status" role="status" aria-live="polite">
        {olderError ?? (olderEnded && itemCount > 0 ? '已经到最早的消息了' : '')}
      </span>
    </div>
  );
}
