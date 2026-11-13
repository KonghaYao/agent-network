import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

const MOVE_TOLERANCE = 10;
const DEFAULT_DELAY = 500;

/**
 * 移动端长按：用 pointer 计时，不依赖浏览器原生 contextmenu。
 *
 * 计时结束后由调用方合成一次 `contextmenu` 事件，把坐标交给 Radix
 * ContextMenu 定位；指针移动/抬起/取消都会取消计时，避免滚动误触。
 */
export function useLongPress(
  onLongPress: (element: HTMLElement, x: number, y: number) => void,
  delay = DEFAULT_DELAY,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse') return;
    clear();
    startRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = setTimeout(() => {
      const start = startRef.current;
      timerRef.current = null;
      if (!start) return;
      onLongPress(event.currentTarget, start.x, start.y);
    }, delay);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = startRef.current;
    if (!start) return;
    if (
      Math.abs(event.clientX - start.x) > MOVE_TOLERANCE ||
      Math.abs(event.clientY - start.y) > MOVE_TOLERANCE
    ) {
      clear();
    }
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  };
}

/** 把长按坐标合成为 Radix 能识别的 contextmenu 事件。 */
export function openContextMenuAt(element: HTMLElement, x: number, y: number): void {
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 2,
    }),
  );
}
