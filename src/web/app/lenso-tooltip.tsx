import {
  createElement, useCallback, useEffect, useId, useRef, useState,
  type ComponentPropsWithRef, type ElementType, type FocusEvent,
  type HTMLAttributes, type PointerEvent,
} from 'react';
import {
  LensoBackendProvider, useBackendLease, useLenso, useLensoBackendScope,
} from './lenso-runtime';

/** 复用原宿主及其 props/ref，不额外包裹布局节点或生成第二个按钮。 */
export type TooltipProps<T extends ElementType> = {
  as: T;
  hint?: string | null;
  delay?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
} & Omit<ComponentPropsWithRef<T>, 'as' | 'title'>;

/**
 * SDK 的 Trigger 会管理自己的定时与宿主；这里用 Content 的公开 anchor API，
 * 把触发事件留在原节点，避免与 ContextMenu/Popover 的 ref、长按和焦点竞争。
 * Content 内建 portal（没有独立 Tooltip.Portal）；延迟从交互开始锁定 backend。
 */
export function Tooltip<T extends ElementType>({
  as, hint, delay = 500, side = 'top', ...props
}: TooltipProps<T>) {
  const module = useLenso();
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(false);
  const lease = useBackendLease(active);
  const scope = useLensoBackendScope();
  // 关闭态不能沿用上一轮 fallback，否则父 Dialog 归还焦点后再次升级会丢焦。
  const backend = active ? lease : scope === 'fallback' || !module ? 'fallback' : 'lenso';
  const origin = useRef<HTMLElement | null>(null);
  const touch = useRef(false);
  const id = useId();
  const original = props as HTMLAttributes<HTMLElement>;
  const lenso = backend === 'lenso' ? module : null;
  const localPortal = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // SDK 默认 showPopover 会越过所有 z-index；仅对本提示退回本地 portal 带。
    queueMicrotask(() => {
      if (!node.isConnected) return;
      if (node.matches(':popover-open')) node.hidePopover();
      node.removeAttribute('popover');
    });
  }, []);

  const close = () => { setActive(false); setOpen(false); };
  const start = (element: HTMLElement) => {
    if (!hint || touch.current || !matchMedia('(hover: hover)').matches) return;
    origin.current = element;
    setActive(true);
  };

  useEffect(() => {
    if (!active || !hint) return;
    const timer = setTimeout(() => setOpen(true), delay);
    const escape = (event: KeyboardEvent) => {
      // 不吞 Escape，菜单和父浮层仍拥有原先的键盘行为。
      if (event.key === 'Escape') close();
    };
    const blur = () => close();
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    window.addEventListener('scroll', blur, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('scroll', blur, true);
    };
  }, [active, hint, delay]);

  const trigger = createElement(as, {
    ...props,
    // Lenso 与原生提示互斥；fallback 周期结束后才允许升级。
    title: lenso ? undefined : hint ?? undefined,
    'aria-label': original['aria-label'] ?? hint ?? undefined,
    'aria-describedby': [original['aria-describedby'], open && lenso ? id : null].filter(Boolean).join(' ') || undefined,
    'data-tooltip-backend': lenso ? 'lenso' : 'fallback',
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      original.onPointerEnter?.(event);
      touch.current = event.pointerType === 'touch';
      if (!event.defaultPrevented) start(event.currentTarget);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => { original.onPointerLeave?.(event); close(); },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      touch.current = event.pointerType === 'touch';
      original.onPointerDown?.(event);
      close();
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => { original.onPointerCancel?.(event); close(); },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      original.onFocus?.(event);
      if (!event.defaultPrevented) start(event.currentTarget);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => { original.onBlur?.(event); close(); },
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => { original.onContextMenu?.(event); close(); },
    onClick: (event: React.MouseEvent<HTMLElement>) => { original.onClick?.(event); close(); },
  });

  return <LensoBackendProvider backend={backend}>
    {trigger}
    {open && lenso && origin.current ? <lenso.Tooltip open delay={delay} closeDelay={0}
      onOpenChange={(next) => { if (!next) close(); }} container={document.body}>
      <lenso.Tooltip.Content ref={localPortal} id={id} anchor={origin.current} side={side} sideOffset={8}
        collisionPadding={12} data-app-tooltip="" style={{
          zIndex: 'var(--app-z-portal-local-menu)', maxWidth: 'min(360px, calc(100vw - 24px))',
          whiteSpace: 'normal', overflowWrap: 'anywhere', pointerEvents: 'none',
          background: 'var(--wx-text)', color: 'var(--wx-panel)',
          padding: '8px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
        }}>{hint}</lenso.Tooltip.Content>
    </lenso.Tooltip> : null}
  </LensoBackendProvider>;
}
