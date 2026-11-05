/**
 * 右侧面板拖拽岛：React + @use-gesture/react，只管理分隔条与宽度比例。
 *
 * 聊天、文件、网页监控仍是 vanilla DOM。岛只修改根元素上的
 * `--right-pane-ratio`，由 CSS 计算聊天/右栏宽度；拖动期间不重建 iframe、
 * 文件列表或聊天节点，因此不会重新加载内容。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useDrag } from '@use-gesture/react';
import { createRoot } from 'react-dom/client';

const STORAGE_KEY = 'agent-network-right-pane-ratio';
const DEFAULT_RATIO = 0.5;
/** 与 `chat-styles.ts` 的 `--pane-resizer-width` 一致；仅用于无面板时的可用宽度估算。 */
const FALLBACK_RESIZER_WIDTH = 6;
const MIN_CHAT_WIDTH = 320;
const MIN_RIGHT_WIDTH = 280;
const KEYBOARD_STEP = 24;

interface DragState {
  available: number;
  startWidth: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredRatio(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_RATIO;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp(value, 0, 1) : DEFAULT_RATIO;
  } catch (error) {
    return DEFAULT_RATIO;
  }
}

function saveRatio(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(value * 10_000) / 10_000));
  } catch (error) {
    // 隐私模式禁用存储时只影响记忆，不影响本次拖动。
  }
}

function applyRatio(value: number): void {
  document.documentElement.style.setProperty('--right-pane-ratio', String(value));
}

function chatPane(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.chat-pane:not(.empty-pane)');
}

/** 当前打开的右侧面板；文件与监控互斥，最多一个可见。 */
function activePane(): HTMLElement | null {
  const files = document.getElementById('files-pane');
  if (files && !files.hidden) return files;
  const monitor = document.getElementById('monitor-pane');
  if (monitor && !monitor.hidden) return monitor;
  return null;
}

function resizerWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--pane-resizer-width');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : FALLBACK_RESIZER_WIDTH;
}

/** 聊天 + 右栏（不含分隔条）的可用宽度；侧栏固定 300px。 */
function contentWidth(): number {
  const main = document.querySelector('main');
  const sidebar = document.querySelector('.sidebar');
  if (!main) return 0;
  const mainWidth = main.getBoundingClientRect().width;
  const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;
  return Math.max(0, mainWidth - sidebarWidth - resizerWidth());
}

function clampRightWidth(width: number, available: number): number {
  const max = Math.max(MIN_RIGHT_WIDTH, available - MIN_CHAT_WIDTH);
  return clamp(width, MIN_RIGHT_WIDTH, max);
}

function ratioForWidth(width: number, available: number): number {
  if (available <= 0) return DEFAULT_RATIO;
  return clampRightWidth(width, available) / available;
}

function PaneResizer(): ReactElement {
  const [ratio, setRatio] = useState(readStoredRatio);
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const applyState = useCallback((next: number) => {
    const safe = clamp(next, 0, 1);
    ratioRef.current = safe;
    applyRatio(safe);
    setRatio(safe);
  }, []);

  const reset = useCallback(() => {
    applyState(DEFAULT_RATIO);
    saveRatio(DEFAULT_RATIO);
  }, [applyState]);

  // 首帧就写变量，避免已持久化的比例在面板打开后跳一下。
  useLayoutEffect(() => {
    applyRatio(ratioRef.current);
  }, []);

  useEffect(() => {
    // 视口变化时 CSS 会按比例重新计算；同步清理拖动状态即可。
    const onResize = () => setDragging(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const bind = useDrag(
    ({ first, last, movement: [movementX], memo }) => {
      if (first) {
        const pane = activePane();
        const chat = chatPane();
        if (!pane || !chat) return memo;
        setDragging(true);
        return {
          available: chat.getBoundingClientRect().width + pane.getBoundingClientRect().width,
          startWidth: pane.getBoundingClientRect().width,
        } satisfies DragState;
      }
      const state = memo as DragState | undefined;
      if (!state || state.available <= 0) return memo;
      const next = ratioForWidth(state.startWidth - movementX, state.available);
      applyState(next);
      if (last) {
        setDragging(false);
        saveRatio(next);
      }
      return state;
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { capture: true },
      preventDefault: true,
    },
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const pane = activePane();
      const available = contentWidth();
      if (!pane || available <= 0) return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = ratioForWidth(
        pane.getBoundingClientRect().width + direction * KEYBOARD_STEP,
        available,
      );
      applyState(next);
      saveRatio(next);
    },
    [applyState],
  );

  const bindProps = useMemo(() => bind(), [bind]);
  const valueNow = Math.round(ratio * 100);

  return (
    <div
      {...bindProps}
      className={`pane-resizer-handle${dragging ? ' dragging' : ''}`}
      id="pane-resizer-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右侧面板宽度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={valueNow}
      tabIndex={0}
      title="拖动调整宽度，双击重置为 50/50，方向键微调"
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}

/** 由 `chat-resizer-script.ts` 调用；重复挂载同一 host 时直接忽略。 */
export function mountPaneResizer(host: HTMLElement): void {
  if (host.dataset.resizerMounted === '1') return;
  host.dataset.resizerMounted = '1';
  createRoot(host).render(<PaneResizer />);
}
