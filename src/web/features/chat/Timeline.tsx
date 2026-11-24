import { TimelineDom } from './TimelineDom';
import { TimelineVirtual } from './TimelineVirtual';
import { timelineMode, type TimelineProps } from './timeline-shared';

export type { TimelineMode, TimelineProps, TimelineSearchNavigation } from './timeline-shared';

/**
 * 时间线入口：只做模式选择。
 *
 * 默认虚拟化；`?timeline=dom` 或 `LIMITS.webTimelineVirtual=false` 回滚到
 * 保留一个迭代的 DOM 实现。两条路径共享 props 与数据模型。
 */
export function Timeline(props: TimelineProps) {
  return timelineMode() === 'dom' ? <TimelineDom {...props} /> : <TimelineVirtual {...props} />;
}
