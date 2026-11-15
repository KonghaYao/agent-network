import { useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  availabilityText,
  FACT_TYPE_LABEL,
  fetchMemoryEntities,
  formatMemoryTime,
  memoryFailureOf,
  type MemoryEntityDetail,
  type MemoryEntityGraph,
  type MemoryEntityItem,
  type MemoryFailure,
} from './memory-data';
import { maskSecrets } from './mask';
import { GraphCanvas, GraphNodeTable, type VizEdge, type VizNode } from './MemoryGraphCanvas';
import './memory-viz.css';

type EntityMode = 'list' | 'graph';

const PAGE_SIZE = LIMITS.memoryPanelEntitiesPageDefault;
const MAX_LOADED = 200;
const GRAPH_EDGE_LIMIT = LIMITS.memoryPanelEntityGraphEdgesMax;

const EDGE_PALETTE = ['#7c3aed', '#2563eb', '#0d9488', '#b45309', '#64748b'];

function edgeColor(type: string, order: string[]): string {
  const index = order.indexOf(type);
  return EDGE_PALETTE[index % EDGE_PALETTE.length] ?? '#64748b';
}

function entityLabel(entity: MemoryEntityItem): string {
  return maskSecrets(entity.name);
}

/** 实体视图：分页列表（客户端名称过滤）+ 共现图 + 实体详情。 */
export function MemoryEntities({
  actorId,
  token,
  onSelectMemory,
}: {
  actorId: string;
  token: string;
  onSelectMemory: (id: string, trigger?: HTMLElement | null) => void;
}) {
  const [mode, setMode] = useState<EntityMode>('list');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MemoryEntityItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<MemoryFailure | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);
  const listRequest = useRef<AbortController | null>(null);

  const [graph, setGraph] = useState<MemoryEntityGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphFailure, setGraphFailure] = useState<MemoryFailure | null>(null);
  const [graphReason, setGraphReason] = useState<string | null>(null);
  const [graphReasonCode, setGraphReasonCode] = useState<string | null>(null);
  const [graphKey, setGraphKey] = useState(0);
  const graphRequest = useRef<AbortController | null>(null);

  const [entityId, setEntityId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryEntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailure, setDetailFailure] = useState<MemoryFailure | null>(null);
  const detailRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setFailure(null);
    setReason(null);
    setReasonCode(null);
    setItems([]);
    setTotal(null);
    setHasMore(false);
    setNextOffset(null);
    void (async () => {
      try {
        const result = await fetchMemoryEntities(
          actorId,
          token,
          { view: 'list', limit: PAGE_SIZE, offset: 0 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.available) {
          setReason(availabilityText(result.reason));
          setReasonCode(result.reason);
          return;
        }
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
  }, [actorId, listKey, token]);

  useEffect(() => {
    if (mode !== 'graph') return undefined;
    graphRequest.current?.abort();
    const controller = new AbortController();
    graphRequest.current = controller;
    setGraphLoading(true);
    setGraphFailure(null);
    setGraphReason(null);
    setGraphReasonCode(null);
    void (async () => {
      try {
        const result = await fetchMemoryEntities(
          actorId,
          token,
          { view: 'graph', limit: GRAPH_EDGE_LIMIT },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.available || !result.graph) {
          setGraphReason(availabilityText(result.reason));
          setGraphReasonCode(result.reason);
          setGraph(null);
          return;
        }
        setGraph(result.graph);
      } catch (error) {
        if (controller.signal.aborted) return;
        setGraphFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setGraphLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, graphKey, mode, token]);

  useEffect(() => {
    if (!entityId) {
      detailRequest.current?.abort();
      setDetail(null);
      setDetailFailure(null);
      setDetailLoading(false);
      return undefined;
    }
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setDetailLoading(true);
    setDetailFailure(null);
    setDetail(null);
    void (async () => {
      try {
        const result = await fetchMemoryEntities(
          actorId,
          token,
          { view: 'detail', entity_id: entityId },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!result.available) {
          setDetailFailure({ kind: 'unavailable', message: availabilityText(result.reason) });
          return;
        }
        if (!result.entity) {
          setDetailFailure({ kind: 'error', message: '这个实体不存在或已被移除。' });
          return;
        }
        setDetail(result.entity);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDetailFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, entityId, token]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || nextOffset === null || items.length >= MAX_LOADED) {
      return;
    }
    setLoadingMore(true);
    const controller = new AbortController();
    listRequest.current = controller;
    try {
      const result = await fetchMemoryEntities(
        actorId,
        token,
        { view: 'list', limit: PAGE_SIZE, offset: nextOffset },
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

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      normalizedQuery
        ? items.filter((item) => item.name.toLowerCase().includes(normalizedQuery))
        : items,
    [items, normalizedQuery],
  );

  const graphNodes = graph?.nodes ?? [];
  const graphEdges = graph?.edges ?? [];
  const edgeOrder = useMemo(
    () => [...new Set(graphEdges.map((edge) => edge.type))].sort(),
    [graphEdges],
  );

  const vizNodes = useMemo<VizNode[]>(
    () =>
      graphNodes.map((node) => ({
        id: node.id,
        label: node.label || '未命名实体',
        typeLabel: `${node.mention_count ?? 0} 次提及`,
        color: '#7c3aed',
        ...(node.mention_count !== undefined ? { weight: node.mention_count } : {}),
      })),
    [graphNodes],
  );

  const vizEdges = useMemo<VizEdge[]>(
    () =>
      graphEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        color: edgeColor(edge.type, edgeOrder),
        weight: edge.weight,
      })),
    [edgeOrder, graphEdges],
  );

  const graphDegrees = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of graphEdges) {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    }
    return map;
  }, [graphEdges]);

  const graphRows = useMemo(
    () =>
      [...graphNodes]
        .sort(
          (left, right) =>
            (graphDegrees.get(right.id) ?? 0) - (graphDegrees.get(left.id) ?? 0),
        )
        .map((node) => ({
          id: node.id,
          label: node.label || '未命名实体',
          typeLabel: `${node.mention_count ?? 0} 次`,
          degree: graphDegrees.get(node.id) ?? 0,
          meta: node.date ?? '—',
        })),
    [graphDegrees, graphNodes],
  );

  const range =
    items.length > 0
      ? `已加载 ${items.length.toLocaleString('zh-CN')} / ${(total ?? items.length).toLocaleString('zh-CN')} 个实体`
      : '';

  const selectEntity = (id: string) => {
    setEntityId(id);
  };

  return (
    <section className="memory-entities" id="memory-entities" aria-labelledby="memory-entities-title">
      <div className="memory-section-head">
        <h3 id="memory-entities-title">实体</h3>
        {range ? (
          <span className="memory-updated" id="memory-entities-range">
            {range}
          </span>
        ) : null}
      </div>

      <div className="memory-entities-mode" role="group" aria-label="实体视图切换">
        <button
          type="button"
          id="memory-entities-view-list"
          className={mode === 'list' ? 'active' : ''}
          aria-pressed={mode === 'list'}
          onClick={() => setMode('list')}
        >
          列表
        </button>
        <button
          type="button"
          id="memory-entities-view-graph"
          className={mode === 'graph' ? 'active' : ''}
          aria-pressed={mode === 'graph'}
          onClick={() => setMode('graph')}
        >
          共现图
        </button>
      </div>

      {mode === 'list' ? (
        <>
          <div className="memory-filters">
            <label className="visually-hidden" htmlFor="memory-entities-search">
              按名称筛选已加载实体
            </label>
            <input
              id="memory-entities-search"
              className="memory-entities-search"
              type="search"
              value={query}
              maxLength={LIMITS.memoryPanelSearchMax}
              placeholder="按名称筛选已加载实体"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {loading ? (
            <p className="memory-status" id="memory-entities-status" role="status">
              正在读取实体…
            </p>
          ) : null}

          {!loading && failure ? (
            <div className="memory-empty" id="memory-entities-status" data-state={failure.kind} role="status">
              <p>{failure.message}</p>
              <button
                type="button"
                id="memory-entities-retry"
                onClick={() => setListKey((value) => value + 1)}
              >
                重试
              </button>
            </div>
          ) : null}

          {!loading && !failure && reason ? (
            <p
              className="memory-empty"
              id="memory-entities-status"
              data-state={reasonCode ?? 'unavailable'}
              role="status"
            >
              {reason}
            </p>
          ) : null}

          {!loading && !failure && !reason && items.length === 0 ? (
            <p className="memory-empty" id="memory-entities-status" data-state="empty" role="status">
              还没有可查看的实体。
            </p>
          ) : null}

          {!loading && !failure && !reason && items.length > 0 ? (
            <>
              <p className="memory-hint" id="memory-entities-filter-note">
                名称搜索只在已加载的 {items.length.toLocaleString('zh-CN')} 个实体中筛选，不发额外请求
                {items.length >= MAX_LOADED ? '（已达到 200 个上限）' : '；可加载更多扩大范围'}。
              </p>
              {filtered.length === 0 ? (
                <p className="memory-empty" id="memory-entities-status" data-state="empty" role="status">
                  已加载的实体中没有匹配「{query.trim()}」的名称
                  {hasMore && items.length < MAX_LOADED ? '，可加载更多后继续筛选。' : '。'}
                </p>
              ) : (
                <ul className="memory-entity-list" id="memory-entities-list" aria-label="实体列表">
                  {filtered.map((entity) => (
                    <li key={entity.id}>
                      <button
                        type="button"
                        className={`memory-entity-row${entityId === entity.id ? ' active' : ''}`}
                        data-entity-id={entity.id}
                        aria-pressed={entityId === entity.id}
                        onClick={() => selectEntity(entity.id)}
                      >
                        <span className="memory-entity-name">{entityLabel(entity)}</span>
                        <span className="memory-entity-meta">
                          提及 {entity.mention_count.toLocaleString('zh-CN')} 次
                          {entity.last_seen ? ` · 最近 ${formatMemoryTime(entity.last_seen)}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}

          {!loading && !failure && hasMore && items.length < MAX_LOADED ? (
            <button
              type="button"
              className="memory-more"
              id="memory-entities-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? '正在加载…' : '加载更多实体'}
            </button>
          ) : null}
        </>
      ) : (
        <>
          {graphLoading ? (
            <p className="memory-status" id="memory-entity-graph-status" role="status">
              正在读取实体共现图…
            </p>
          ) : null}

          {!graphLoading && graphFailure ? (
            <div
              className="memory-empty"
              id="memory-entity-graph-status"
              data-state={graphFailure.kind}
              role="status"
            >
              <p>{graphFailure.message}</p>
              <button
                type="button"
                id="memory-entity-graph-retry"
                onClick={() => setGraphKey((value) => value + 1)}
              >
                重试
              </button>
            </div>
          ) : null}

          {!graphLoading && !graphFailure && graphReason ? (
            <p
              className="memory-empty"
              id="memory-entity-graph-status"
              data-state={graphReasonCode ?? 'unavailable'}
              role="status"
            >
              {graphReason}
            </p>
          ) : null}

          {!graphLoading && !graphFailure && graph && graphNodes.length === 0 ? (
            <p className="memory-empty" id="memory-entity-graph-status" data-state="empty" role="status">
              还没有可绘制的实体共现图。
            </p>
          ) : null}

          {!graphLoading && !graphFailure && graph && graphNodes.length > 0 ? (
            <>
              <p className="memory-updated" id="memory-entity-graph-summary">
                {graphNodes.length.toLocaleString('zh-CN')} 个实体 ·{' '}
                {graphEdges.length.toLocaleString('zh-CN')} 条共现边
              </p>
              {graph.truncated || graph.total_edges > graphEdges.length ? (
                <p className="memory-hint memory-truncated" id="memory-entity-graph-truncated" role="status">
                  已截断：显示 {graphEdges.length.toLocaleString('zh-CN')} 条边；原始{' '}
                  {graph.raw_edge_count.toLocaleString('zh-CN')} 条，服务端上限{' '}
                  {LIMITS.memoryPanelEntityGraphEdgesMax} 条。
                </p>
              ) : null}
              <GraphCanvas
                nodes={vizNodes}
                edges={vizEdges}
                selectedId={entityId}
                onSelect={selectEntity}
                canvasId="memory-entity-graph-canvas"
                label="点击实体查看详情；滚轮缩放、拖拽平移，也可使用下方表格。"
              />
              <GraphNodeTable
                id="memory-entity-graph-list"
                rows={graphRows}
                selectedId={entityId}
                onSelect={selectEntity}
                label="实体共现图节点列表（键盘可达的替代视图）"
                typeHeader="提及"
              />
            </>
          ) : null}
        </>
      )}

      {entityId ? (
        <section
          className="memory-entity-detail"
          id="memory-entity-detail"
          aria-labelledby="memory-entity-detail-title"
        >
          <div className="memory-detail-head">
            <h3 id="memory-entity-detail-title">
              {detail ? entityLabel(detail) : '实体详情'}
            </h3>
            <button
              type="button"
              className="memory-detail-close"
              id="memory-entity-detail-close"
              aria-label="关闭实体详情"
              onClick={() => setEntityId(null)}
            >
              ×
            </button>
          </div>

          {detailLoading ? (
            <p className="memory-status" id="memory-entity-detail-status" role="status">
              正在读取实体详情…
            </p>
          ) : null}

          {!detailLoading && detailFailure ? (
            <div
              className="memory-empty"
              id="memory-entity-detail-status"
              data-state={detailFailure.kind}
              role="status"
            >
              <p>{detailFailure.message}</p>
            </div>
          ) : null}

          {!detailLoading && detail ? (
            <>
              <p className="memory-entity-detail-meta">
                提及 {detail.mention_count.toLocaleString('zh-CN')} 次
                {detail.first_seen ? ` · 首次 ${formatMemoryTime(detail.first_seen)}` : ''}
                {detail.last_seen ? ` · 最近 ${formatMemoryTime(detail.last_seen)}` : ''}
              </p>

              <section className="memory-detail-section" aria-labelledby="memory-entity-observations-title">
                <h4 id="memory-entity-observations-title">观察</h4>
                {detail.observations.length === 0 ? (
                  <p className="memory-hint">没有观察记录。</p>
                ) : (
                  <ul className="memory-entity-observations" id="memory-entity-observations">
                    {detail.observations.map((observation) => (
                      <li key={observation.id}>
                        <span className="memory-entity-observation-text">
                          {maskSecrets(observation.text)}
                        </span>
                        <span className="memory-entity-observation-proof">
                          证据 {observation.proof_count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="memory-detail-section" aria-labelledby="memory-entity-memories-title">
                <h4 id="memory-entity-memories-title">相关记忆</h4>
                {detail.memories.length === 0 ? (
                  <p className="memory-hint">没有关联记忆。</p>
                ) : (
                  <ul className="memory-entity-memories" id="memory-entity-memories">
                    {detail.memories.map((memory) => (
                      <li key={memory.id}>
                        <button
                          type="button"
                          data-memory-id={memory.id}
                          aria-pressed={false}
                          onClick={(event) => onSelectMemory(memory.id, event.currentTarget)}
                        >
                          <span className="memory-fact-head">
                            <span
                              className={`memory-type type-${memory.fact_type ?? 'unknown'}`}
                              data-type={memory.fact_type ?? 'unknown'}
                            >
                              {memory.fact_type ? FACT_TYPE_LABEL[memory.fact_type] : '未分类'}
                            </span>
                            <span className="memory-fact-time">
                              {formatMemoryTime(memory.mentioned_at)}
                            </span>
                          </span>
                          <span className="memory-fact-text">
                            {maskSecrets(memory.text_preview)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
