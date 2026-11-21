import type {
  InsightGraphRow,
  InsightGraphTimeline,
  InsightTimelineGroup,
  InsightTimelineItem,
  InsightTimelineResult,
} from './contracts';
import { graphRowTimeMs } from './normalize';
import { timelineRange, type TimelineGranularity, type TimelineZone } from './timeline-zone';

function timelineTimeMs(item: InsightTimelineItem): number | null {
  for (const value of [item.occurred_at, item.mentioned_at]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function sortTimelineItems(items: InsightTimelineItem[]): InsightTimelineItem[] {
  return [...items].sort((left, right) => {
    const leftTime = timelineTimeMs(left);
    const rightTime = timelineTimeMs(right);
    if (leftTime !== rightTime) {
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return rightTime - leftTime;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function buildTimelineGroups<T>(
  items: T[],
  granularity: TimelineGranularity,
  zone: TimelineZone,
  timeOf: (item: T) => number | null,
  includeUndated = true,
): InsightTimelineGroup[] {
  const groups: InsightTimelineGroup[] = [];
  let current: InsightTimelineGroup | null = null;
  items.forEach((item, index) => {
    const ms = timeOf(item);
    if (ms === null && !includeUndated) return;
    const range =
      ms === null
        ? { key: 'undated', label: '无日期', start: null, end: null }
        : timelineRange(ms, granularity, zone);
    if (!current || current.key !== range.key) {
      current = {
        ...range,
        count: 0,
        start_index: index,
        end_index: index + 1,
      };
      groups.push(current);
    }
    current.count += 1;
    current.end_index = index + 1;
  });
  return groups;
}

export function timelineGroups(
  items: InsightTimelineItem[],
  zone: TimelineZone,
): InsightTimelineResult['groups'] {
  return {
    day: buildTimelineGroups(items, 'day', zone, timelineTimeMs),
    week: buildTimelineGroups(items, 'week', zone, timelineTimeMs),
    month: buildTimelineGroups(items, 'month', zone, timelineTimeMs),
  };
}

function summarize<T extends InsightTimelineItem | InsightGraphRow>(
  items: T[],
  total: number | null,
  timeOf: (item: T) => number | null,
): InsightTimelineResult['summary'] {
  const byType = { world: 0, experience: 0, observation: 0 };
  let dated = 0;
  for (const item of items) {
    if (item.fact_type) byType[item.fact_type] += 1;
    if (timeOf(item) !== null) dated += 1;
  }
  return { total, returned: items.length, dated, undated: items.length - dated, by_type: byType };
}

export function timelineSummary(items: InsightTimelineItem[], total: number | null): InsightTimelineResult['summary'] {
  return summarize(items, total, timelineTimeMs);
}

export function graphTimeline(
  rows: InsightGraphRow[],
  total: number | null,
  zone: TimelineZone,
): InsightGraphTimeline {
  return {
    groups: {
      year: buildTimelineGroups(rows, 'year', zone, graphRowTimeMs, false),
      month: buildTimelineGroups(rows, 'month', zone, graphRowTimeMs, false),
      week: buildTimelineGroups(rows, 'week', zone, graphRowTimeMs, false),
      day: buildTimelineGroups(rows, 'day', zone, graphRowTimeMs, false),
    },
    summary: summarize(rows, total, graphRowTimeMs),
    basis: 'occurred_at',
  };
}
