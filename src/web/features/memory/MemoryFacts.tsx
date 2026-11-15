import { useEffect, useRef, useState, type FormEvent } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  availabilityText,
  FACT_TYPE_LABEL,
  fetchMemoryList,
  formatMemoryTime,
  memoryFailureOf,
  type MemoryFactType,
  type MemoryFailure,
  type MemoryItem,
} from './memory-data';
import { maskSecrets } from './mask';

type TypeFilter = 'all' | MemoryFactType;

const FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '全部类型' },
  { value: 'world', label: '世界' },
  { value: 'experience', label: '经历' },
  { value: 'observation', label: '观察' },
];

/**
 * 事实列表：服务端 q/type/offset 分页。搜索 400ms 防抖，Enter 立即执行；
 * 首屏错误、加载更多错误、空态与不可用原因分别呈现。
 */
export function MemoryFacts({
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
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<MemoryFailure | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim()), LIMITS.memoryPanelSearchDebounceMs);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setFailure(null);
    setReason(null);
    setReasonCode(null);
    setItems([]);
    setTotal(null);
    setHasMore(false);
    setNextOffset(null);
    void (async () => {
      try {
        const result = await fetchMemoryList(
          actorId,
          token,
          {
            limit: LIMITS.memoryPanelFactsPageDefault,
            offset: 0,
            ...(query ? { q: query } : {}),
            ...(typeFilter === 'all' ? {} : { type: typeFilter }),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.available) {
          setReason(availabilityText(result.reason));
          setReasonCode(result.reason);
          return;
        }
        setReason(null);
        setReasonCode(null);
        setItems(result.items);
        setTotal(result.total);
        setHasMore(result.has_more);
        setNextOffset(result.next_offset);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, query, token, typeFilter, reloadKey]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || nextOffset === null) return;
    setLoadingMore(true);
    setFailure(null);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const result = await fetchMemoryList(
        actorId,
        token,
        {
          limit: LIMITS.memoryPanelFactsPageDefault,
          offset: nextOffset,
          ...(query ? { q: query } : {}),
          ...(typeFilter === 'all' ? {} : { type: typeFilter }),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!result.available) {
        setReason(availabilityText(result.reason));
        setReasonCode(result.reason);
        return;
      }
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(result.total);
      setHasMore(result.has_more);
      setNextOffset(result.next_offset);
    } catch (error) {
      if (controller.signal.aborted) return;
      setFailure(memoryFailureOf(error));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(queryInput.trim());
    setReloadKey((value) => value + 1);
  };

  const range =
    items.length > 0
      ? `已显示 ${items.length.toLocaleString('zh-CN')} / ${(total ?? items.length).toLocaleString('zh-CN')} 条`
      : '';

  return (
    <section className="memory-facts" aria-labelledby="memory-facts-title">
      <div className="memory-section-head">
        <h3 id="memory-facts-title">事实</h3>
        {range ? <span className="memory-updated" id="memory-facts-range">{range}</span> : null}
      </div>
      <div className="memory-filters">
        <form className="memory-search" onSubmit={submit} role="search">
          <label className="visually-hidden" htmlFor="memory-facts-search">
            搜索记忆正文
          </label>
          <input
            id="memory-facts-search"
            type="search"
            value={queryInput}
            maxLength={LIMITS.memoryPanelSearchMax}
            placeholder="搜索记忆正文（服务端子串匹配）"
            autoComplete="off"
            onChange={(event) => setQueryInput(event.target.value)}
          />
          <button type="submit" className="memory-search-submit">
            搜索
          </button>
        </form>
        <label className="visually-hidden" htmlFor="memory-type-filter">
          按事实类型筛选
        </label>
        <select
          id="memory-type-filter"
          className="memory-type-filter"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
        >
          {FILTERS.map((filter) => (
            <option value={filter.value} key={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="memory-status" id="memory-facts-status" role="status">
          正在读取记忆…
        </p>
      ) : null}

      {!loading && failure ? (
        <div className="memory-empty" id="memory-facts-status" data-state={failure.kind} role="status">
          <p>{failure.message}</p>
          <button type="button" id="memory-facts-retry" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !failure && reason ? (
        <p className="memory-empty" id="memory-facts-status" data-state={reasonCode ?? 'unavailable'} role="status">
          {reason}
        </p>
      ) : null}

      {!loading && !failure && !reason && items.length === 0 ? (
        <p className="memory-empty" id="memory-facts-status" data-state="empty" role="status">
          {query || typeFilter !== 'all' ? '没有匹配的记忆。' : '还没有可查看的记忆。'}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="memory-fact-list" id="memory-facts-list" aria-label="记忆事实列表">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`memory-fact${activeId === item.id ? ' active' : ''}`}
                data-fact-id={item.id}
                aria-pressed={activeId === item.id}
                onClick={(event) => onSelect(item.id, event.currentTarget)}
              >
                <span className="memory-fact-head">
                  <span
                    className={`memory-type type-${item.fact_type ?? 'unknown'}`}
                    data-type={item.fact_type ?? 'unknown'}
                  >
                    {item.fact_type ? FACT_TYPE_LABEL[item.fact_type] : '未分类'}
                  </span>
                  {item.state === 'invalidated' ? (
                    <span className="memory-fact-invalid">已失效</span>
                  ) : null}
                  <span className="memory-fact-time">{formatMemoryTime(item.mentioned_at)}</span>
                </span>
                <span className="memory-fact-text">{maskSecrets(item.text)}</span>
                <span className="memory-fact-meta">
                  {item.entities.slice(0, LIMITS.memoryPanelFactEntitiesShown).map((entity) => (
                    <span className="memory-entity" key={entity}>
                      {maskSecrets(entity)}
                    </span>
                  ))}
                  {item.entities.length > LIMITS.memoryPanelFactEntitiesShown ? (
                    <span className="memory-entity">
                      +{item.entities.length - LIMITS.memoryPanelFactEntitiesShown}
                    </span>
                  ) : null}
                  <span>证据 {item.proof_count}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {loadingMore ? (
        <p className="memory-status" role="status">
          正在加载更多…
        </p>
      ) : null}
      {!loading && hasMore ? (
        <button
          type="button"
          className="memory-more"
          id="memory-facts-more"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </section>
  );
}
