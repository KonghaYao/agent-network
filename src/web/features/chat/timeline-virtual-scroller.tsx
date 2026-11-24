import { createContext, forwardRef, useContext } from 'react';
import type { ScrollerProps } from 'react-virtuoso';

import { Button } from '../../app/lenso-controls';

/**
 * 虚拟时间线的纯视图部件：Virtuoso 的 scroller、上下文与“回到最新”按钮。
 * 滚动跟随与 reveal 门控在 `use-timeline-bottom-follow`，数据组合在
 * `TimelineVirtual`。
 */

export interface ScrollerContextValue {
  long: boolean;
  anchored: boolean;
  hidden: boolean;
}

export const ScrollerContext = createContext<ScrollerContextValue>({
  long: false,
  anchored: false,
  hidden: false,
});

export const TimelineScroller = forwardRef<HTMLDivElement, ScrollerProps>(
  function TimelineScroller(props, ref) {
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
  },
);

export interface TimelineJumpLatestProps {
  pinned: boolean;
  anchored: boolean;
  hasNew: boolean;
  onJumpLatest: () => void;
}

export function TimelineJumpLatest({
  pinned,
  anchored,
  hasNew,
  onJumpLatest,
}: TimelineJumpLatestProps) {
  return (
    <Button
      id="jump-latest"
      className="jump-latest"
      type="button"
      variant="bordered"
      size="sm"
      hidden={pinned || anchored}
      onClick={onJumpLatest}
    >
      <span id="jump-latest-label">{hasNew ? '有新消息 · 回到最新' : '回到最新'}</span>
    </Button>
  );
}
