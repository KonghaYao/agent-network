import './lenso-popover.css';
import * as Radix from '@radix-ui/react-popover';
import {
  cloneElement, useCallback, useLayoutEffect, useRef,
  type HTMLAttributes, type ReactElement, type ReactNode, type Ref,
} from 'react';
import {
  LensoBackendProvider, useBackendLease, useLenso,
} from './lenso-runtime';

type TriggerProps = HTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> };

export interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement<TriggerProps>;
  anchor?: HTMLElement | null;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  collisionPadding?: number;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
}

/**
 * Trigger 不随 backend 重挂；打开周期沿用 lease，关闭重开才升级。
 * Lenso Content 内建 positioner/portal，Arrow 可选；这里不添加原页面没有的箭头。
 */
export function Popover({
  id, open, onOpenChange, trigger, anchor, side = 'bottom', align = 'center',
  sideOffset = 4, collisionPadding = 12, onOpenAutoFocus, onCloseAutoFocus,
  onEscapeKeyDown, children, className, style, ...props
}: PopoverProps) {
  const module = useLenso();
  const backend = useBackendLease(open);
  const lenso = backend === 'lenso' ? module : null;
  const origin = useRef<HTMLButtonElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const callbacks = useRef({ onOpenChange, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown });
  callbacks.current = { onOpenChange, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown };
  const cycle = useRef({ open, closing: false });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (cycle.current.open !== open) cycle.current = { open, closing: false };
  const change = (next: boolean) => {
    if (!next) {
      // SDK 外点/失焦可能在同次卸载中重复请求关闭，不能覆盖调用方的还焦意图。
      if (!cycle.current.open || cycle.current.closing) return;
      cycle.current.closing = true;
    }
    callbacks.current.onOpenChange(next);
  };
  const triggerRef = trigger.props.ref;
  const setTrigger = useCallback((node: HTMLButtonElement | null) => {
    origin.current = node;
    if (typeof triggerRef === 'function') return triggerRef(node);
    if (triggerRef) triggerRef.current = node;
  }, [triggerRef]);
  const localPortal = useCallback((node: HTMLDivElement | null) => {
    content.current = node;
    if (!node) return;
    // SDK 默认进入 top layer，会越过 Modal；只对本浮层退回 body 的本地层级。
    queueMicrotask(() => {
      if (!node.isConnected) return;
      if (node.matches(':popover-open')) node.hidePopover();
      node.removeAttribute('popover');
    });
  }, []);

  useLayoutEffect(() => {
    if (open) cycle.current.closing = false;
    if (!open || !lenso) return;
    let active = true;
    // 等 SDK 提交 Content；initialFocus/finalFocus=none，焦点只由兼容回调管理。
    queueMicrotask(() => {
      if (!active) return;
      const event = new Event('openAutoFocus', { cancelable: true });
      callbacks.current.onOpenAutoFocus?.(event);
      if (!event.defaultPrevented) {
        const first = content.current?.querySelector<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        );
        (first ?? content.current)?.focus({ preventScroll: true });
      }
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      callbacks.current.onEscapeKeyDown?.(event);
      if (!event.defaultPrevented) {
        event.preventDefault();
        change(false);
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => {
      active = false;
      clearTimeout(closeTimer.current);
      document.removeEventListener('keydown', escape, true);
      // 外点的默认聚焦发生在 pointerdown 之后，归还焦点须晚于该默认动作。
      requestAnimationFrame(() => {
        const event = new Event('closeAutoFocus', { cancelable: true });
        callbacks.current.onCloseAutoFocus?.(event);
        if (!event.defaultPrevented && !document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) {
          origin.current?.focus({ preventScroll: true });
        }
      });
    };
  }, [open, lenso]);

  const triggerElement = cloneElement(trigger, {
    ref: setTrigger,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: (event) => {
      trigger.props.onClick?.(event);
      if (!event.defaultPrevented) change(!open);
    },
  });
  const shared = {
    ...props, id, className, tabIndex: -1,
    'data-popover-backend': backend,
    style: { ...style, zIndex: 'var(--app-z-portal-local-menu)' },
  };
  // Radix Anchor 而非 Trigger：同一个宿主在两种壳之间保持身份与焦点。
  return <LensoBackendProvider backend={backend}>
    <Radix.Root open={open && !lenso} onOpenChange={change}>
      {anchor ? <>{triggerElement}<Radix.Anchor virtualRef={{ current: anchor }} /></>
        : <Radix.Anchor asChild>{triggerElement}</Radix.Anchor>}
      {open && !lenso ? <Radix.Portal>
        <Radix.Content {...shared} side={side} align={align} sideOffset={sideOffset}
          collisionPadding={collisionPadding} onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (!event.defaultPrevented) {
              event.preventDefault();
              origin.current?.focus({ preventScroll: true });
            }
          }} onEscapeKeyDown={onEscapeKeyDown} onInteractOutside={(event) => {
            if (event.target instanceof Node && origin.current?.contains(event.target)) event.preventDefault();
          }}>{children}</Radix.Content>
      </Radix.Portal> : null}
    </Radix.Root>
    {open && lenso ? <lenso.Popover open modal={false} presentation="popover" container={document.body}
      onOpenChange={(next, details) => {
        // Escape 必须传递原始 DOM 事件，供 dock 区分本次 Esc 是否已被预览消费。
        if (details.reason === 'escape-key') {
          details.cancel();
          return;
        }
        if (details.event?.target instanceof Node && origin.current?.contains(details.event.target)) {
          details.cancel();
          return;
        }
        if (details.reason === 'outside-press' || details.reason === 'focus-out') {
          // 等 pointerdown 走完，避免 dock 新注册的外点监听消费同一事件。
          clearTimeout(closeTimer.current);
          closeTimer.current = setTimeout(() => change(next), 0);
        } else change(next);
      }}>
      <lenso.Popover.Content {...shared} ref={localPortal} anchor={anchor ?? origin.current}
        side={side} align={align} sideOffset={sideOffset} collisionPadding={collisionPadding}
        initialFocus="none" finalFocus="none" render={<div className={className} />}>
        {children}
      </lenso.Popover.Content>
    </lenso.Popover> : null}
  </LensoBackendProvider>;
}
