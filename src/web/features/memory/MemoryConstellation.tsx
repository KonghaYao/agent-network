import { useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  availabilityText,
  FACT_TYPE_LABEL,
  fetchMemoryGraph,
  memoryFailureOf,
  type MemoryFactType,
  type MemoryFailure,
  type MemoryGraphNode,
  type MemoryGraphResult,
} from './memory-data';
import { GraphNodeTable } from './MemoryGraphCanvas';
import { ConstellationCanvas } from './ConstellationCanvas';
import { adaptMemoryGraph } from './constellation-adapter';
import './memory-viz.css';

type TypeFilter = 'all' | MemoryFactType;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '全部类型' },
  { value: 'world', label: '世界' },
  { value: 'experience', label: '经历' },
  { value: 'observation', label: '观察' },
];

const NODE_LIMITS = [20, 50, 120] as const;

function nodeLabel(node: MemoryGraphNode): string {
  return node.label || node.text || '未命名记忆';
}

/** 节点 id 就是记忆单元 id；点击后复用右侧 MemoryDetail。 */
export function MemoryConstellation({
  actorId,
  token,
  activeId,
  onSelect,
}: {
  actorId: string;
  token: string;
  activeId: string | null;
  onSelect: (id: string, trigger?: HTMLElement | null) => void;
}) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [nodeLimit, setNodeLimit] = useState<(typeof NODE_LIMITS)[number]>(120);
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<MemoryGraphResult | null>(null);
  const [loading, setLoading] = useState(true);
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
    setResult(null);
    void (async () => {
      try {
        const next = await fetchMemoryGraph(
          actorId,
          token,
          {
            limit: nodeLimit,
            ...(typeFilter === 'all' ? {} : { type: typeFilter }),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!next.available) {
          setReason(availabilityText(next.reason));
          setReasonCode(next.reason);
          return;
        }
        setResult(next);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, nodeLimit, reloadKey, token, typeFilter]);

  const nodes = result?.nodes ?? [];
  const edges = result?.edges ?? [];

  const edgeTypeOrder = useMemo(
    () => [...new Set(edges.map((edge) => edge.type))].sort(),
    [edges],
  );

  const graph = useMemo(
    () => adaptMemoryGraph(nodes, edges, { edgeTypeOrder }),
    [edgeTypeOrder, edges, nodes],
  );

  const legendTypes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const link of graph.links) {
      if (!seen.has(link.type)) seen.set(link.type, link.color);
    }
    return [...seen.entries()];
  }, [graph.links]);

  const degrees = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of edges) {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    }
    return map;
  }, [edges]);

  const rows = useMemo(
    () =>
      [...nodes]
        .sort((left, right) => (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0))
        .map((node) => ({
          id: node.id,
          label: nodeLabel(node),
          typeLabel: node.fact_type ? FACT_TYPE_LABEL[node.fact_type] : '未分类',
          degree: degrees.get(node.id) ?? 0,
          meta: node.entities?.length ? `${node.entities.length} 个实体` : node.date ?? '—',
        })),
    [degrees, nodes],
  );

  const selectNode = (id: string, trigger?: HTMLElement | null) => {
    onSelect(id, trigger ?? null);
  };

  const truncatedText =
    result && result.truncated
      ? `已截断：显示 ${nodes.length.toLocaleString('zh-CN')} 个节点 / ${edges.length.toLocaleString('zh-CN')} 条边；原始 ${result.raw_node_count.toLocaleString('zh-CN')} 个节点、${result.raw_edge_count.toLocaleString('zh-CN')} 条边，服务端上限 ${LIMITS.memoryPanelGraphNodesMax} 节点 / ${LIMITS.memoryPanelGraphEdgesMax} 边。`
      : '';

  return (
    <section className="memory-constellation" id="memory-constellation" aria-labelledby="memory-constellation-title">
      <div className="memory-section-head">
        <h3 id="memory-constellation-title">星座图</h3>
        {result ? (
          <span className="memory-updated" id="memory-graph-summary">
            已绘制 {nodes.length.toLocaleString('zh-CN')} 个节点 ·{' '}
            {edges.length.toLocaleString('zh-CN')} 条边
          </span>
        ) : null}
      </div>

      <div className="memory-filters">
        <label className="visually-hidden" htmlFor="memory-graph-type-filter">
          按事实类型筛选星座图
        </label>
        <select
          id="memory-graph-type-filter"
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
        <label className="visually-hidden" htmlFor="memory-graph-limit">
          选择节点数量上限
        </label>
        <select
          id="memory-graph-limit"
          className="memory-type-filter"
          value={nodeLimit}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (value === 20 || value === 50 || value === 120) setNodeLimit(value);
          }}
        >
          {NODE_LIMITS.map((value) => (
            <option value={value} key={value}>
              {value} 个节点
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="memory-status" id="memory-graph-status" role="status">
          正在读取记忆星座图…
        </p>
      ) : null}

      {!loading && failure ? (
        <div className="memory-empty" id="memory-graph-status" data-state={failure.kind} role="status">
          <p>{failure.message}</p>
          <button type="button" id="memory-graph-retry" onClick={() => setReloadKey((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !failure && reason ? (
        <p className="memory-empty" id="memory-graph-status" data-state={reasonCode ?? 'unavailable'} role="status">
          {reason}
        </p>
      ) : null}

      {!loading && !failure && !reason && result && nodes.length === 0 ? (
        <p className="memory-empty" id="memory-graph-status" data-state="empty" role="status">
          {typeFilter === 'all'
            ? '还没有可绘制的星座图。Agent 完成对话后，记忆之间会形成关系。'
            : `没有「${FACT_TYPE_LABEL[typeFilter]}」类型的记忆节点。`}
        </p>
      ) : null}

      {!loading && !failure && result && nodes.length > 0 ? (
        <>
          {truncatedText ? (
            <p className="memory-hint memory-truncated" id="memory-graph-truncated" role="status">
              {truncatedText}
            </p>
          ) : null}
          <ConstellationCanvas
            graph={graph}
            selectedId={activeId}
            onSelect={(id) => selectNode(id)}
            canvasId="memory-graph-canvas"
            label="滚轮缩放，拖拽平移，点击节点查看记忆详情；也可以使用下方表格。"
            legendTypes={legendTypes}
          />
          {legendTypes.length > 0 ? (
            <ul className="memory-graph-legend" aria-label="关系类型图例">
              {legendTypes.map(([type, color]) => (
                <li key={type}>
                  <span
                    className="memory-graph-swatch"
                    style={{ background: color }}
                    aria-hidden="true"
                  />
                  {type}
                </li>
              ))}
            </ul>
          ) : null}
          <GraphNodeTable
            id="memory-graph-list"
            rows={rows}
            selectedId={activeId}
            onSelect={selectNode}
            label="星座图节点列表（键盘可达的替代视图）"
          />
        </>
      ) : null}
    </section>
  );
}
