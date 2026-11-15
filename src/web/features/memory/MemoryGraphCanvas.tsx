import { useEffect, useMemo, useRef, useState } from 'react';

import { maskSecrets } from './mask';

/** 懒加载视图共享的节点/边形状；颜色由各视图按业务类型计算。 */
export interface VizNode {
  id: string;
  label: string;
  typeLabel: string;
  color: string;
  weight?: number;
  meta?: string;
}

export interface VizEdge {
  id: string;
  source: string;
  target: string;
  color: string;
  weight: number;
}

export interface GraphListRow {
  id: string;
  label: string;
  typeLabel: string;
  degree: number;
  meta?: string;
}

interface Point {
  x: number;
  y: number;
}

const LABEL_MAX_CHARS = 18;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

/** 固定种子的确定性布局：同一份数据每次绘制位置一致，避免筛选后节点乱跳。 */
function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 手写力导向布局：斥力 O(n²)、边弹簧、向心重力。
 * 120 个节点 × 约 200 轮的规模远低于一帧预算，不需要引入 d3。
 */
function computeLayout(
  nodes: VizNode[],
  edges: VizEdge[],
): { positions: Map<string, Point>; degree: Map<string, number> } {
  const count = nodes.length;
  const positions = new Map<string, Point>();
  const degree = new Map<string, number>();
  if (count === 0) return { positions, degree };

  const random = seededRandom(hashSeed(nodes.map((node) => node.id).join('|')));
  const points: Point[] = nodes.map((node, index) => {
    const angle = (index / count) * Math.PI * 2 + random() * 0.5;
    const radius = 0.3 + random() * 0.65;
    positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    degree.set(node.id, 0);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });

  const links: { source: number; target: number }[] = [];
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  for (const edge of edges) {
    const source = indexOf.get(edge.source);
    const target = indexOf.get(edge.target);
    if (source === undefined || target === undefined) continue;
    links.push({ source, target });
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const velocities: Point[] = points.map(() => ({ x: 0, y: 0 }));
  const iterations = count > 80 ? 180 : 240;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / iterations;

    for (let left = 0; left < count; left += 1) {
      const a = points[left]!;
      const velocityA = velocities[left]!;
      for (let right = left + 1; right < count; right += 1) {
        const b = points[right]!;
        const velocityB = velocities[right]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 0.0004) {
          dx = (random() - 0.5) * 0.02;
          dy = (random() - 0.5) * 0.02;
          distanceSquared = dx * dx + dy * dy || 0.0004;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = (0.0022 / (distanceSquared + 0.015)) * cooling;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        velocityA.x += fx;
        velocityA.y += fy;
        velocityB.x -= fx;
        velocityB.y -= fy;
      }
    }

    for (const link of links) {
      const a = points[link.source]!;
      const b = points[link.target]!;
      const velocityA = velocities[link.source]!;
      const velocityB = velocities[link.target]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const force = (distance - 0.5) * 0.035 * cooling;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      velocityA.x += fx;
      velocityA.y += fy;
      velocityB.x -= fx;
      velocityB.y -= fy;
    }

    for (let index = 0; index < count; index += 1) {
      const point = points[index]!;
      const velocity = velocities[index]!;
      velocity.x += -point.x * 0.006 * cooling;
      velocity.y += -point.y * 0.006 * cooling;
      velocity.x = clamp(velocity.x * 0.82, -0.08, 0.08);
      velocity.y = clamp(velocity.y * 0.82, -0.08, 0.08);
      point.x += velocity.x;
      point.y += velocity.y;
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  for (let index = 0; index < count; index += 1) {
    const normalized = {
      x: ((points[index]!.x - centerX) / span) * 1.8,
      y: ((points[index]!.y - centerY) / span) * 1.8,
    };
    positions.set(nodes[index]!.id, normalized);
  }
  return { positions, degree };
}

function truncateLabel(value: string): string {
  const masked = maskSecrets(value);
  return masked.length > LABEL_MAX_CHARS ? `${masked.slice(0, LABEL_MAX_CHARS)}…` : masked;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
}

/**
 * 星座图/实体共现图共用的 canvas。键盘可达性由外部的表格替代提供，
 * canvas 本身只承担指针交互与视觉呈现。
 */
export function GraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  canvasId,
  label,
}: {
  nodes: VizNode[];
  edges: VizEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canvasId: string;
  label: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const dragRef = useRef<DragState | null>(null);

  const layout = useMemo(() => computeLayout(nodes, edges), [edges, nodes]);
  const stateRef = useRef({ size, zoom, pan, layout, nodes });
  stateRef.current = { size, zoom, pan, layout, nodes };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rect = entry.contentRect;
      setSize({ width: Math.max(0, Math.floor(rect.width)), height: Math.max(0, Math.floor(rect.height)) });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setThemeVersion((value) => value + 1);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [edges, nodes]);

  const scaleFor = (currentZoom: number, currentSize: { width: number; height: number }) =>
    Math.min(currentSize.width, currentSize.height) * 0.44 * currentZoom;

  const hitTest = (clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const state = stateRef.current;
    const scale = scaleFor(state.zoom, state.size);
    const centerX = state.size.width / 2 + state.pan.x;
    const centerY = state.size.height / 2 + state.pan.y;
    let best: { id: string; distance: number } | null = null;
    for (const node of state.nodes) {
      const point = state.layout.positions.get(node.id);
      if (!point) continue;
      const x = centerX + point.x * scale;
      const y = centerY + point.y * scale;
      const radius = 5 + Math.min(6, Math.sqrt(state.layout.degree.get(node.id) ?? 0) * 2);
      const distance = Math.hypot(clientX - rect.left - x, clientY - rect.top - y);
      if (distance <= radius + 6 && (!best || distance < best.distance)) {
        best = { id: node.id, distance };
      }
    }
    return best?.id ?? null;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const state = stateRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextZoom = clamp(state.zoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (nextZoom === state.zoom) return;
      const ratio = nextZoom / state.zoom;
      const offsetX = event.clientX - rect.left - state.size.width / 2;
      const offsetY = event.clientY - rect.top - state.size.height / 2;
      setPan({
        x: offsetX - ratio * (offsetX - state.pan.x),
        y: offsetY - ratio * (offsetY - state.pan.y),
      });
      setZoom(nextZoom);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);

    const styles = getComputedStyle(canvas);
    const textColor = styles.getPropertyValue('--wx-text').trim() || '#1a1a1a';
    const mutedColor = styles.getPropertyValue('--wx-muted').trim() || '#7a7a7a';
    const scale = scaleFor(zoom, size);
    const centerX = size.width / 2 + pan.x;
    const centerY = size.height / 2 + pan.y;
    const screenOf = (point: Point) => ({
      x: centerX + point.x * scale,
      y: centerY + point.y * scale,
    });

    context.lineCap = 'round';
    for (const edge of edges) {
      const source = layout.positions.get(edge.source);
      const target = layout.positions.get(edge.target);
      if (!source || !target) continue;
      const from = screenOf(source);
      const to = screenOf(target);
      const highlighted =
        selectedId !== null && (edge.source === selectedId || edge.target === selectedId);
      context.globalAlpha = highlighted ? 0.9 : 0.32;
      context.strokeStyle = edge.color;
      context.lineWidth = highlighted
        ? 1.6 + Math.min(1.4, Math.log2(edge.weight + 1) * 0.4)
        : 0.7 + Math.min(1.4, Math.log2(edge.weight + 1) * 0.35);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }
    context.globalAlpha = 1;

    const topByDegree = [...nodes]
      .sort((left, right) => (layout.degree.get(right.id) ?? 0) - (layout.degree.get(left.id) ?? 0))
      .slice(0, nodes.length > 60 ? 14 : 24)
      .map((node) => node.id);
    const labelled = new Set(topByDegree);
    if (selectedId) labelled.add(selectedId);
    if (hoverId) labelled.add(hoverId);

    for (const node of nodes) {
      const point = layout.positions.get(node.id);
      if (!point) continue;
      const screen = screenOf(point);
      const degree = layout.degree.get(node.id) ?? 0;
      const radius = 5 + Math.min(6, Math.sqrt(degree) * 2);
      const active = node.id === selectedId;
      const hovered = node.id === hoverId;
      if (active || hovered) {
        context.globalAlpha = 0.22;
        context.fillStyle = node.color;
        context.beginPath();
        context.arc(screen.x, screen.y, radius + 7, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;
      }
      context.fillStyle = node.color;
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fill();
      if (active) {
        context.strokeStyle = textColor;
        context.lineWidth = 2;
        context.stroke();
      }
      if (labelled.has(node.id)) {
        context.fillStyle = active || hovered ? textColor : mutedColor;
        context.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
        context.textBaseline = 'middle';
        context.fillText(truncateLabel(node.label), screen.x + radius + 5, screen.y);
      }
    }
  }, [edges, hoverId, layout, nodes, pan, selectedId, size, themeVersion, zoom]);

  const zoomBy = (factor: number) => {
    setZoom((current) => clamp(current * factor, ZOOM_MIN, ZOOM_MAX));
  };

  return (
    <div className="memory-graph" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="memory-graph-canvas"
        id={canvasId}
        aria-hidden="true"
        data-node-count={nodes.length}
        data-edge-count={edges.length}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            panX: pan.x,
            panY: pan.y,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
            if (drag.moved) {
              setPan({ x: drag.panX + dx, y: drag.panY + dy });
              return;
            }
          }
          const hit = hitTest(event.clientX, event.clientY);
          setHoverId(hit);
          event.currentTarget.style.cursor = drag?.moved ? 'grabbing' : hit ? 'pointer' : 'grab';
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (!drag || drag.pointerId !== event.pointerId || drag.moved) return;
          const hit = hitTest(event.clientX, event.clientY);
          if (hit) onSelect(hit);
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          setHoverId(null);
        }}
      />
      <div className="memory-graph-controls">
        <button type="button" id={`${canvasId}-zoom-out`} aria-label="缩小" onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <span className="memory-graph-zoom" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" id={`${canvasId}-zoom-in`} aria-label="放大" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button
          type="button"
          id={`${canvasId}-reset`}
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          重置
        </button>
      </div>
      <p className="memory-graph-hint">{label}</p>
    </div>
  );
}

/** 图谱的键盘可达替代：节点、类型、连接数；行内按钮可打开详情。 */
export function GraphNodeTable({
  id,
  rows,
  selectedId,
  onSelect,
  label,
  typeHeader = '类型',
}: {
  id: string;
  rows: GraphListRow[];
  selectedId: string | null;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
  label: string;
  typeHeader?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="memory-graph-list-wrap">
      <table className="memory-graph-list" id={id}>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">节点</th>
            <th scope="col">{typeHeader}</th>
            <th scope="col">连接数</th>
            <th scope="col">信息</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-node-id={row.id} className={row.id === selectedId ? 'active' : ''}>
              <th scope="row">
                <button
                  type="button"
                  aria-pressed={row.id === selectedId}
                  onClick={(event) => onSelect(row.id, event.currentTarget)}
                >
                  {maskSecrets(row.label)}
                </button>
              </th>
              <td>{row.typeLabel}</td>
              <td>{row.degree}</td>
              <td>{row.meta ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
