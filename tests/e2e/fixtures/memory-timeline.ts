/**
 * E2E 记忆时间线的分组 fixture。
 *
 * stub 必须像服务端一样按入参 `timezone`（优先）或 `tz_offset_minutes` 分组，
 * 这样页面断言的是「透传的时区」而不是跑测试机器的本地时区。
 */
import { timelineRange, type TimelineZone } from '../../../src/memory/insight/timeline-zone';

export interface TimelineFixtureItem {
  id: string;
  text: string;
  fact_type: 'world' | 'experience' | 'observation';
  state: 'valid';
  occurred_at: string | null;
  mentioned_at: string;
  entities: string[];
}

export function timelineGroups(
  items: TimelineFixtureItem[],
  granularity: 'year' | 'day' | 'week' | 'month',
  timeZone: string | undefined,
  offsetMinutes: number,
) {
  const zone: TimelineZone = { timeZone: timeZone ?? null, offsetMinutes };
  const groups: {
    key: string;
    label: string;
    start: string | null;
    end: string | null;
    count: number;
    start_index: number;
    end_index: number;
  }[] = [];
  items.forEach((item, index) => {
    const ms = Date.parse(item.occurred_at ?? item.mentioned_at);
    const range = timelineRange(ms, granularity, zone);
    const last = groups.at(-1);
    if (!last || last.key !== range.key) {
      groups.push({ ...range, count: 0, start_index: index, end_index: index + 1 });
    }
    const current = groups.at(-1)!;
    current.count += 1;
    current.end_index = index + 1;
  });
  return groups;
}
