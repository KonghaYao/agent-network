import { useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  availabilityText,
  FACT_TYPE_LABEL,
  fetchMemoryTimeline,
  memoryFailureOf,
  type MemoryFailure,
  type MemoryFactType,
  type MemoryTimelineDays,
  type MemoryTimelineGranularity,
  type MemoryTimelineGroup,
  type MemoryTimelineItem,
  type MemoryTimelineResult,
} from './memory-data';
import { maskSecrets } from './mask';
import './memory-viz.css';

type TypeFilter = 'all' | MemoryFactType;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '全部类型' },
  { value: 'world', label: '世界' },
  { value: 'experience', label: '经历' },
  { value: 'observation', label: '观察' },
];

const DAYS: MemoryTimelineDays[] = [7, 30, 90];
const GRANULARITIES: { value: MemoryTimelineGranularity; label: string }[] = [
  { value: 'year', label: '年' },
  { value: 'month', label: '月' },
  { value: 'week', label: '周' },
  { value: 'day', label: '日' },
];
const GRANULARITY_ORDER: MemoryTimelineGranularity[] = ['year', 'month', 'week', 'day'];

function buildYearGroups(monthGroups: MemoryTimelineGroup[]): MemoryTimelineGroup[] {
  const result: MemoryTimelineGroup[] = [];
  let current: MemoryTimelineGroup | null = null;
  for (const group of monthGroups) {
    if (group.key === 'undated') {
      result.push(group);
      current = null;
      continue;
    }
    const year = group.key.slice(0, 4);
    if (!current || current.key !== year) {
      current = {
        key: year,
        label: `${year}年`,
        start: group.start,
        end: group.end,
        count: group.count,
        start_index: group.start_index,
        end_index: group.end_index,
      };
      result.push(current);
      continue;
    }
    current.count += group.count;
    current.end_index = group.end_index;
    current.end = group.end;
  }
  return result;
}

function eventTime(item: MemoryTimelineItem): { basis: string; value: string } {
  const occurred = item.occurred_at;
  const value = occurred ?? item.mentioned_at;
  if (!value) return { basis: '时间', value: '无日期' };
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return { basis: occurred ? '发生' : '提及', value };
  return {
    basis: occurred ? '发生' : '提及',
    value: time.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  };
}

function groupItems(items: MemoryTimelineItem[], group: MemoryTimelineGroup): MemoryTimelineItem[] {
  return items.slice(group.start_index, group.end_index);
}

/**
 * Fenix 风格时间线：服务端一次返回 compact 事件与天/周/月分组，前端只做
 * 视图变换（年分组由月分组聚合），不逐页拉取 facts。
 */
export function MemoryTimeline({
  actorId,
  token,
  activeId,
  onSelect,
}: {
  actorId: string;
  token: string;
  activeId: string | null;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const [days, setDays] = useState<MemoryTimelineDays>(30);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [granularity, setGranularity] = useState<MemoryTimelineGranularity>('month');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<MemoryTimelineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<MemoryFailure | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const groupRefs = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setFailure(null);
    setResult(null);
    setCurrentIndex(0);

    void (async () => {
      try {
        const next = await fetchMemoryTimeline(
          actorId,
          token,
          {
            days,
            limit: LIMITS.memoryPanelTimelineLimitDefault,
            ...(typeFilter === 'all' ? {} : { type: typeFilter }),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult(next);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, days, reloadKey, token, typeFilter]);

  const groups = useMemo(() => {
    if (!result?.available) return [];
    if (granularity === 'year') return buildYearGroups(result.groups.month);
    return result.groups[granularity] ?? [];
  }, [granularity, result]);

  const safeIndex = groups.length === 0 ? 0 : Math.min(currentIndex, groups.length - 1);
  const reason = result && !result.available ? availabilityText(result.reason) : null;
  const reasonCode = result && !result.available ? result.reason : null;
  const items = result?.available ? result.items : [];
  const summary = result?.summary;
  const zoomIndex = GRANULARITY_ORDER.indexOf(granularity);

  useEffect(() => {
    if (loading || groups.length === 0) return;
    const element = groupRefs.current.get(safeIndex);
    element?.scrollIntoView({ block: 'nearest' });
  }, [granularity, groups.length, loading, safeIndex]);

  const goToGroup = (index: number) => {
    if (groups.length === 0) return;
    setCurrentIndex(Math.max(0, Math.min(groups.length - 1, index)));
  };

  const changeGranularity = (next: MemoryTimelineGranularity) => {
    setGranularity(next);
    setCurrentIndex(0);
  };

  const zoom = (direction: -1 | 1) => {
    const next = GRANULARITY_ORDER[zoomIndex + direction];
    if (next) changeGranularity(next);
  };

  const summaryText = loading
    ? '正在读取…'
    : summary
      ? `共 ${(summary.total ?? summary.returned).toLocaleString('zh-CN')} 条 · 显示 ${summary.returned.toLocaleString('zh-CN')} 条${summary.undated > 0 ? ` · ${summary.undated} 条无日期` : ''}`
      : '';

  return (
    <section className="memory-timeline" id="memory-timeline" aria-labelledby="memory-timeline-title">
      <div className="memory-section-head">
        <h3 id="memory-timeline-title">时间线</h3>
        <span className="memory-updated" id="memory-timeline-summary">
          {summaryText}
        </span>
      </div>

      <div className="memory-filters">
        <label className="visually-hidden" htmlFor="memory-timeline-range">
          选择时间范围
        </label>
        <select
          id="memory-timeline-range"
          className="memory-type-filter"
          value={days}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (value === 7 || value === 30 || value === 90) setDays(value);
          }}
        >
          {DAYS.map((value) => (
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
          正在读取时间线…
        </p>
      ) : null}

      {!loading && failure ? (
        <div className="memory-empty" id="memory-timeline-status" data-state={failure.kind} role="status">
          <p>{failure.message}</p>
          <button type="button" id="memory-timeline-retry" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !failure && reason ? (
        <p
          className="memory-empty"
          id="memory-timeline-status"
          data-state={reasonCode ?? 'unavailable'}
          role="status"
        >
          {reason}
        </p>
      ) : null}

      {!loading && !failure && !reason && items.length === 0 ? (
        <p className="memory-empty" id="memory-timeline-status" data-state="empty" role="status">
          {typeFilter === 'all'
            ? `最近 ${days} 天没有可展示的记忆事件。`
            : `最近 ${days} 天没有「${FACT_TYPE_LABEL[typeFilter]}」类型的记忆事件。`}
        </p>
      ) : null}

      {!loading && !failure && !reason && items.length > 0 ? (
        <>
          <div className="memory-timeline-toolbar" id="memory-timeline-toolbar">
            <div className="memory-timeline-segments" role="group" aria-label="时间粒度">
              {GRANULARITIES.map((entry) => (
                <button
                  type="button"
                  key={entry.value}
                  id={`memory-timeline-granularity-${entry.value}`}
                  className={granularity === entry.value ? 'active' : ''}
                  aria-pressed={granularity === entry.value}
                  onClick={() => changeGranularity(entry.value)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <div className="memory-timeline-nav" role="group" aria-label="时间线分组导航">
              <button
                type="button"
                id="memory-timeline-first"
                aria-label="跳到首组"
                disabled={safeIndex <= 0}
                onClick={() => goToGroup(0)}
              >
                «
              </button>
              <button
                type="button"
                id="memory-timeline-prev"
                aria-label="上一组"
                disabled={safeIndex <= 0}
                onClick={() => goToGroup(safeIndex - 1)}
              >
                ‹
              </button>
              <span id="memory-timeline-position" aria-live="polite">
                {safeIndex + 1} / {groups.length}
              </span>
              <button
                type="button"
                id="memory-timeline-next"
                aria-label="下一组"
                disabled={safeIndex >= groups.length - 1}
                onClick={() => goToGroup(safeIndex + 1)}
              >
                ›
              </button>
              <button
                type="button"
                id="memory-timeline-last"
                aria-label="跳到末组"
                disabled={safeIndex >= groups.length - 1}
                onClick={() => goToGroup(groups.length - 1)}
              >
                »
              </button>
            </div>

            <div className="memory-timeline-zoom" role="group" aria-label="时间粒度缩放">
              <button
                type="button"
                id="memory-timeline-zoom-out"
                aria-label="缩小时间粒度"
                disabled={zoomIndex <= 0}
                onClick={() => zoom(-1)}
              >
                −
              </button>
              <span>{GRANULARITIES[zoomIndex]?.label ?? '月'}</span>
              <button
                type="button"
                id="memory-timeline-zoom-in"
                aria-label="放大时间粒度"
                disabled={zoomIndex >= GRANULARITY_ORDER.length - 1}
                onClick={() => zoom(1)}
              >
                +
              </button>
            </div>
          </div>

          <p className="memory-hint" id="memory-timeline-note">
            {summaryText}。当前按{GRANULARITIES[zoomIndex]?.label ?? '月'}分组，共 {groups.length} 组；
            切换粒度、导航与缩放不会重新请求。
          </p>

          {result?.truncated ? (
            <p className="memory-truncated" id="memory-timeline-truncated" role="status">
              已截断：只显示最近 {items.length.toLocaleString('zh-CN')} 条。请缩短时间范围或按类型筛选。
            </p>
          ) : null}

          <div className="memory-timeline-chart" id="memory-timeline-chart">
            {groups.map((group, index) => (
              <section
                className={`memory-timeline-group${index === safeIndex ? ' active' : ''}`}
                key={group.key}
                data-timeline-group={group.key}
                data-count={group.count}
                aria-labelledby={`memory-timeline-group-${index}`}
                ref={(element) => {
                  if (element) groupRefs.current.set(index, element);
                  else groupRefs.current.delete(index);
                }}
              >
                <div className="memory-timeline-group-rail">
                  <span className="memory-timeline-group-label" id={`memory-timeline-group-${index}`}>
                    {group.label}
                  </span>
                  <span className="memory-timeline-group-count">{group.count} 条</span>
                </div>
                <div className="memory-timeline-group-body">
                  <ul className="memory-timeline-list" aria-label={`${group.label}的记忆事件`}>
                    {groupItems(items, group).map((item) => {
                      const time = eventTime(item);
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={`memory-timeline-card${activeId === item.id ? ' active' : ''}`}
                            data-timeline-id={item.id}
                            aria-pressed={activeId === item.id}
                            onClick={(event) => onSelect(item.id, event.currentTarget)}
                          >
                            <span className="memory-timeline-card-head">
                              <span
                                className={`memory-type type-${item.fact_type ?? 'unknown'}`}
                                data-type={item.fact_type ?? 'unknown'}
                              >
                                {item.fact_type ? FACT_TYPE_LABEL[item.fact_type] : '未分类'}
                              </span>
                              {item.state === 'invalidated' ? (
                                <span className="memory-fact-invalid">已失效</span>
                              ) : null}
                              <span className="memory-timeline-card-time">
                                {time.basis} {time.value}
                              </span>
                            </span>
                            <span className="memory-timeline-card-text">{maskSecrets(item.text)}</span>
                            {item.entities.length > 0 ? (
                              <span className="memory-timeline-card-meta">
                                {item.entities.map((entity) => (
                                  <span className="memory-entity" key={entity}>
                                    {maskSecrets(entity)}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
