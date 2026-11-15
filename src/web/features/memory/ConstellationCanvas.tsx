import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { maskSecrets } from './mask';
import { paintConstellationFrame } from './constellation-paint';
import {
  clamp,
  fitScaleFor,
  HEAT_GRADIENT,
  prepareConstellationScene,
  type ConstellationGraphData,
} from './constellation-scene';
import { createConstellationViewState } from './constellation-state';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
}

interface Measure {
  width: number;
  height: number;
}

/**
 * 星座图 canvas：星空布局 + 热度色 + hover 邻边隔离 + 卡片标签 + tooltip。
 *
 * 只绘制需要的东西：指针、滚轮、平移、缩放、数据与主题变化时各画一帧，
 * 没有持续 RAF。DPR 上限 2；没有动画，因此 `prefers-reduced-motion`
 * 下行为一致。键盘可达性仍由外部 `GraphNodeTable` 提供。
 */
export function ConstellationCanvas({
  graph,
  selectedId,
  onSelect,
  canvasId,
  label,
  legendTypes,
}: {
  graph: ConstellationGraphData;
  selectedId: string | null;
  onSelect: (id: string) => void;
  canvasId: string;
  label: string;
  legendTypes: [string, string][];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<HTMLSpanElement>(null);
  const labelsRef = useRef<HTMLSpanElement>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const fullscreenInteractedRef = useRef(false);

  const [size, setSize] = useState<Measure>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDark, setIsDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  const scene = useMemo(() => prepareConstellationScene(graph), [graph]);
  const fitScale = fitScaleFor(scene, size.width, size.height);
  const viewRef = useRef({ W: size.width, H: size.height, zoom, panX: pan.x, panY: pan.y, fitScale });
  viewRef.current = { W: size.width, H: size.height, zoom, panX: pan.x, panY: pan.y, fitScale };

  const hoveredIndex = hoverId ? scene.indexById.get(hoverId) : undefined;
  const hovered = hoveredIndex === undefined ? null : (scene.preparedNodes[hoveredIndex] ?? null);
  const hoveredDate = hovered?.node.date ? maskSecrets(hovered.node.date).slice(0, 10) : '—';
  const hoveredEntities = hovered?.node.entities.length
    ? maskSecrets(hovered.node.entities.join('、'))
    : '—';

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setIsDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [isFullscreen]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setHoverId(null);
  }, [graph]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrap);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!isFullscreen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void document.exitFullscreen?.().finally(() => setIsFullscreen(false));
        return;
      }
      if (event.key !== 'Tab') return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const focusable = [...wrap.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isFullscreen]);

  useEffect(() => {
    if (!fullscreenInteractedRef.current) return undefined;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`${canvasId}-fullscreen`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasId, isFullscreen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(size.width * dpr);
    const pixelHeight = Math.round(size.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const state = createConstellationViewState();
    state.W = size.width;
    state.H = size.height;
    state.dpr = dpr;
    state.zoom = zoom;
    state.panX = pan.x;
    state.panY = pan.y;
    state.fitScale = fitScale;

    const started = performance.now();
    const stats = paintConstellationFrame(context, canvas, {
      state,
      scene,
      isDark,
      hoverId,
      selectedId,
    });
    const elapsed = performance.now() - started;

    canvas.dataset.zoom = zoom.toFixed(2);
    canvas.dataset.hoverId = hoverId ?? '';
    canvas.dataset.linksDrawn = String(stats.links);
    canvas.dataset.labelCount = String(stats.labels);
    canvas.dataset.labelMode = stats.labelMode;
    canvas.dataset.visibleCount = String(stats.visible);
    canvas.dataset.paintMs = elapsed.toFixed(1);
    canvas.dataset.paintCount = String(Number(canvas.dataset.paintCount ?? '0') + 1);
    // 测试需要逐点坐标；默认不把整张图的 JSON 写进生产 DOM。
    const exposePoints =
      typeof window !== 'undefined' &&
      (window as Window & { __AGENT_NETWORK_E2E_POINTS__?: boolean })
        .__AGENT_NETWORK_E2E_POINTS__ === true;
    if (exposePoints) canvas.dataset.nodePoints = JSON.stringify(stats.points);
    else delete canvas.dataset.nodePoints;
    canvas.dataset.dpr = dpr.toFixed(2);
    canvas.dataset.width = String(state.W);
    canvas.dataset.height = String(state.H);
    canvas.dataset.fitScale = fitScale.toFixed(3);
    canvas.dataset.panX = pan.x.toFixed(1);
    canvas.dataset.panY = pan.y.toFixed(1);
    if (visibleRef.current) visibleRef.current.textContent = String(stats.visible);
    if (labelsRef.current) labelsRef.current.textContent = String(stats.labels);
  }, [scene, size, zoom, pan, fitScale, isDark, hoverId, selectedId, isFullscreen]);

  const positionTooltip = useCallback(() => {
    const tip = tooltipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = pointerRef.current.x - rect.left;
    const y = pointerRef.current.y - rect.top;
    const left = Math.min(Math.max(4, x + 16), Math.max(4, rect.width - tip.offsetWidth - 12));
    const top = Math.min(Math.max(4, y + 16), Math.max(4, rect.height - tip.offsetHeight - 12));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, []);

  useLayoutEffect(() => {
    if (hoverId) positionTooltip();
  }, [hoverId, positionTooltip]);

  const hitTest = useCallback((clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const centerX = view.W / 2 + view.panX;
    const centerY = view.H / 2 + view.panY;
    const scale = view.fitScale * view.zoom;
    const limit = view.zoom > 1.5 ? 80 : 30;
    let bestId: string | null = null;
    let bestDistance = limit;
    for (const node of scene.preparedNodes) {
      const distance = Math.hypot(x - (centerX + node.wx * scale), y - (centerY + node.wy * scale));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = node.node.id;
      }
    }
    return bestId;
  }, [scene]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = viewRef.current;
      if (view.W <= 0 || view.H <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextZoom = clamp(view.zoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (Math.abs(nextZoom - view.zoom) < 0.0001) return;
      const ratio = nextZoom / view.zoom;
      const offsetX = event.clientX - rect.left - view.W / 2;
      const offsetY = event.clientY - rect.top - view.H / 2;
      setPan({
        x: offsetX - ratio * (offsetX - view.panX),
        y: offsetY - ratio * (offsetY - view.panY),
      });
      setZoom(nextZoom);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [isFullscreen]);

  const zoomBy = (factor: number) => {
    setZoom((current) => clamp(current * factor, ZOOM_MIN, ZOOM_MAX));
  };

  const toggleFullscreen = () => {
    fullscreenInteractedRef.current = true;
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement === wrap) {
      void document.exitFullscreen?.().finally(() => setIsFullscreen(false));
      return;
    }
    const request = wrap.requestFullscreen?.();
    if (request) {
      void request.then(() => setIsFullscreen(true)).catch(() => setIsFullscreen(false));
    }
  };

  const content = (
    <div
      ref={wrapRef}
      className={`memory-graph memory-graph-constellation${isFullscreen ? ' is-fullscreen' : ''}`}
      role="region"
      aria-label={isFullscreen ? '星座图全屏' : '星座图'}
      data-fullscreen={isFullscreen ? 'true' : 'false'}
      data-theme={isDark ? 'dark' : 'light'}
    >
      <canvas
        ref={canvasRef}
        className="memory-graph-canvas"
        id={canvasId}
        aria-hidden="true"
        data-node-count={graph.nodes.length}
        data-edge-count={graph.links.length}
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
          const canvas = event.currentTarget;
          pointerRef.current = { x: event.clientX, y: event.clientY };
          const drag = dragRef.current;
          if (drag && drag.pointerId === event.pointerId) {
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) drag.moved = true;
            if (drag.moved) {
              setPan({ x: drag.panX + dx, y: drag.panY + dy });
              setHoverId(null);
              canvas.style.cursor = 'grabbing';
              return;
            }
          }
          const hit = hitTest(event.clientX, event.clientY);
          setHoverId((current) => (current === hit ? current : hit));
          canvas.style.cursor = hit ? 'pointer' : 'grab';
          if (hit) positionTooltip();
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
        onPointerCancel={() => {
          dragRef.current = null;
          setHoverId(null);
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          setHoverId(null);
        }}
      />

      {hovered ? (
        <div
          ref={tooltipRef}
          className="memory-graph-tooltip"
          aria-hidden="true"
          data-node-id={hovered.node.id}
        >
          <div className="memory-graph-tooltip-head">
            <span
              className="memory-graph-tooltip-dot"
              style={{ background: hovered.heatColor }}
              aria-hidden="true"
            />
            <span className="memory-graph-tooltip-type">{maskSecrets(hovered.node.typeLabel)}</span>
            <span className="memory-graph-tooltip-links">{hovered.linkCount} 条连接</span>
          </div>
          <dl className="memory-graph-tooltip-rows">
            <div>
              <dt>日期</dt>
              <dd>{hoveredDate}</dd>
            </div>
            <div>
              <dt>实体</dt>
              <dd>{hoveredEntities}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div
        id={`${canvasId}-hud`}
        className="memory-graph-hud"
        role="group"
        aria-label="星座图统计"
      >
        <span>节点 {graph.nodes.length}</span>
        <span>边 {graph.links.length}</span>
        <span>
          可见 <span ref={visibleRef}>0</span>
        </span>
        <span>
          标签 <span ref={labelsRef}>0</span>
        </span>
      </div>

      <div
        id={`${canvasId}-heat`}
        className="memory-graph-heat"
        role="group"
        aria-label="节点热度图例：连接少到连接多"
      >
        <span>热度</span>
        <span
          className="memory-graph-heat-bar"
          style={{ backgroundImage: HEAT_GRADIENT }}
          aria-hidden="true"
        />
        <span>连接少</span>
        <span>连接多</span>
      </div>

      {isFullscreen && legendTypes.length > 0 ? (
        <ul
          className="memory-graph-legend memory-graph-legend-overlay"
          aria-label="关系类型图例"
        >
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

      <div className="memory-graph-controls">
        <button type="button" id={`${canvasId}-zoom-out`} aria-label="缩小" onClick={() => zoomBy(1 / ZOOM_STEP)}>          −
        </button>
        <span className="memory-graph-zoom" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" id={`${canvasId}-zoom-in`} aria-label="放大" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button
          type="button"
          id={`${canvasId}-reset`}
          aria-label="重置缩放与平移"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          重置
        </button>
        <button
          type="button"
          id={`${canvasId}-fullscreen`}
          aria-label={isFullscreen ? '退出全屏' : '全屏查看星座图'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? '退出全屏（Esc）' : '全屏查看'}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? '退出全屏' : '全屏'}
        </button>
      </div>
      <p className="memory-graph-hint">{label}</p>
    </div>
  );

  return content;
}
