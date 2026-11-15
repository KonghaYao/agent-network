import { useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  availabilityText,
  FACT_TYPE_LABEL,
  fetchMemoryList,
  memoryFailureOf,
  type MemoryFactType,
  type MemoryFailure,
  type MemoryItem,
} from './memory-data';
import './memory-viz.css';

type TypeFilter = 'all' | MemoryFactType;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '全部类型' },
  { value: 'world', label: '世界' },
  { value: 'experience', label: '经历' },
  { value: 'observation', label: '观察' },
];

const RANGES = [7, 30, 90] as const;

/** 时间线最多聚合的事实数；4 页 × 50 条，避免无限翻页拖慢弹窗。 */
const MAX_ITEMS = 200;

interface DayBucket {
  key: string;
  label: string;
  count: number;
}

function dayKey(time: Date): string {
  const year = time.getFullYear();
  const month = String(time.getMonth() + 1).padStart(2, '0');
  const day = String(time.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDays(rangeDays: number, items: MemoryItem[]): DayBucket[] {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (rangeDays - 1));
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.mentioned_at) continue;
    const time = new Date(item.mentioned_at);
    if (Number.isNaN(time.getTime()) || time < start || time > end) continue;
    const key = dayKey(time);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days: DayBucket[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dayKey(cursor);
    days.push({
      key,
      label: `${cursor.getMonth() + 1}/${cursor.getDate()}`,
      count: counts.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function timeLabel(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return `${time.getMonth() + 1}/${time.getDate()}`;
}

/**
 * 时间线：服务端没有 timeseries 工具，这里按 list 分页取最近事实，
 * 在客户端按本地日期聚合。文案必须明确「基于已加载事实」。
 */
export function MemoryTimeline({ actorId, token }: { actorId: string; token: string }) {
  const [rangeDays, setRangeDays] = useState<(typeof RANGES)[number]>(30);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<MemoryFailure | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setFailure(null);
    setReason(null);
    setReasonCode(null);
    setItems([]);
    setServerTotal(null);
    setProgress(0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (rangeDays - 1));

    void (async () => {
      try {
        const collected: MemoryItem[] = [];
        const seen = new Set<string>();
        let offset = 0;
        for (let page = 0; page < Math.ceil(MAX_ITEMS / LIMITS.memoryPanelFactsPageMax); page += 1) {
          setProgress(page + 1);
          const result = await fetchMemoryList(
            actorId,
            token,
            {
              limit: LIMITS.memoryPanelFactsPageMax,
              offset,
              type: typeFilter === 'all' ? undefined : typeFilter,
              time_field: 'mentioned_at',
              start_date: start.toISOString(),
              end_date: end.toISOString(),
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (!result.available) {
            setReason(availabilityText(result.reason));
            setReasonCode(result.reason);
            return;
          }
          setServerTotal(result.total);
          for (const item of result.items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            collected.push(item);
            if (collected.length >= MAX_ITEMS) break;
          }
          if (collected.length >= MAX_ITEMS || !result.has_more || result.next_offset === null) break;
          offset = result.next_offset;
        }
        setItems(collected);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, rangeDays, reloadKey, token, typeFilter]);

  const days = useMemo(() => buildDays(rangeDays, items), [items, rangeDays]);
  const maxCount = useMemo(() => Math.max(1, ...days.map((day) => day.count)), [days]);
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const peak = days.reduce(
    (best, day) => (day.count > best.count ? day : best),
    { key: '', label: '', count: 0 } as DayBucket,
  );
  const undated = items.filter((item) => !item.mentioned_at).length;
  const timestamps = items
    .map((item) => (item.mentioned_at ? Date.parse(item.mentioned_at) : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const first = timestamps.length > 0 ? new Date(timestamps[0]!).toISOString() : null;
  const last = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]!).toISOString() : null;
  const loadedNote =
    serverTotal !== null && serverTotal > items.length
      ? `服务端共 ${serverTotal.toLocaleString('zh-CN')} 条匹配，这里只聚合已加载的 ${items.length.toLocaleString('zh-CN')} 条。`
      : `基于已加载事实（最多 ${MAX_ITEMS} 条，按 mentioned_at 归档）。`;

  // fetchMemoryList 的类型尚未包含时间过滤；在这里显式传给工具，避免改主数据层契约。
  return (
    <section className="memory-timeline" id="memory-timeline" aria-labelledby="memory-timeline-title">
      <div className="memory-section-head">
        <h3 id="memory-timeline-title">时间线</h3>
        <span className="memory-updated" id="memory-timeline-summary">
          {loading
            ? '正在读取…'
            : `最近 ${rangeDays} 天 · 已加载 ${items.length.toLocaleString('zh-CN')} 条 · ${total.toLocaleString('zh-CN')} 条有日期`}
        </span>
      </div>

      <div className="memory-filters">
        <label className="visually-hidden" htmlFor="memory-timeline-range">
          选择时间范围
        </label>
        <select
          id="memory-timeline-range"
          className="memory-type-filter"
          value={rangeDays}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (value === 7 || value === 30 || value === 90) setRangeDays(value);
          }}
        >
          {RANGES.map((value) => (
            <option value={value} key={value}>
              最近 {value} 天
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor="memory-timeline-type-filter">
          按事实类型筛选时间线
        </label>
        <select
          id="memory-timeline-type-filter"
          className="memory-type-filter"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
        >
          {TYPE_FILTERS.map((filter) => (
            <option value={filter.value} key={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="memory-status" id="memory-timeline-status" role="status">
          正在读取事实{progress > 1 ? `（第 ${progress} 页）` : ''}…
        </p>
      ) : null}

      {!loading && failure ? (
        <div className="memory-empty" id="memory-timeline-status" data-state={failure.kind} role="status">
          <p>{failure.message}</p>
          <button
            type="button"
            id="memory-timeline-retry"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : null}

      {!loading && !failure && reason ? (
        <p className="memory-empty" id="memory-timeline-status" data-state={reasonCode ?? 'unavailable'} role="status">
          {reason}
        </p>
      ) : null}

      {!loading && !failure && !reason && total === 0 ? (
        <p className="memory-empty" id="memory-timeline-status" data-state="empty" role="status">
          {typeFilter === 'all'
            ? `最近 ${rangeDays} 天没有带时间戳的事实。`
            : `最近 ${rangeDays} 天没有「${FACT_TYPE_LABEL[typeFilter]}」类型的事实。`}
          {items.length > 0 ? ' 已加载的事实缺少可用时间戳。' : ''}
        </p>
      ) : null}

      {!loading && !failure && !reason && total > 0 ? (
        <>
          <div
            className="memory-timeline-chart"
            id="memory-timeline-chart"
            role="img"
            aria-label={`最近 ${rangeDays} 天的每日事实数量，共 ${total} 条，峰值 ${peak.count} 条`}
          >
            {days.map((day) => (
              <span
                key={day.key}
                className={`memory-timeline-bar${day.count === 0 ? ' empty' : ''}`}
                data-day={day.key}
                data-count={day.count}
                style={{ height: `${Math.max(3, Math.round((day.count / maxCount) * 100))}%` }}
                title={`${day.key}：${day.count} 条`}
                aria-hidden="true"
              />
            ))}
          </div>
          <div className="memory-timeline-axis" aria-hidden="true">
            <span>{days[0]?.label}</span>
            <span>{days[Math.floor(days.length / 2)]?.label}</span>
            <span>{days[days.length - 1]?.label}</span>
          </div>
          <p className="memory-hint" id="memory-timeline-note">
            {loadedNote}
            峰值 {peak.count > 0 ? `${peak.label}（${peak.count} 条）` : '—'}。
            {undated > 0 ? ` ${undated} 条缺少时间戳，未计入柱状图。` : ''}
            {first && last ? ` 已加载范围 ${timeLabel(first)} – ${timeLabel(last)}。` : ''}
          </p>
          <details className="memory-timeline-table" id="memory-timeline-table">
            <summary>按天数据（表格）</summary>
            <table>
              <caption>每日事实数量</caption>
              <thead>
                <tr>
                  <th scope="col">日期</th>
                  <th scope="col">数量</th>
                </tr>
              </thead>
              <tbody>
                {days
                  .filter((day) => day.count > 0)
                  .map((day) => (
                    <tr key={day.key}>
                      <th scope="row">{day.key}</th>
                      <td>{day.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </>
      ) : null}
    </section>
  );
}
