import {
  cloneElement, createContext, useContext, useLayoutEffect, useRef, useState,
  type HTMLAttributes, type ReactElement, type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';

import { useLongPress } from '../hooks/useLongPress';
import { useBackendLease, useLenso, type LensoModule } from './lenso-runtime';

const MenuScope = createContext<{
  module: LensoModule | null;
  select: (action?: () => void) => void;
} | null>(null);

export interface ContextMenuProps {
  id: string;
  label: string;
  className?: string;
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  portalContainer?: () => HTMLElement | null;
}

/**
 * 触发节点始终不重挂；只有打开时挂载实际 Lenso ContextMenu。
 * SDK 使用 native popover，关闭立即卸载，避免 top layer 退场动画覆盖新 Modal。
 * 长按仅由本适配器负责，不再叠加 SDK ContextMenu.Trigger 的内建计时。
 */
export function ContextMenu({
  id, label, className, trigger, children, open: controlled, onOpenChange,
  onCloseAutoFocus, portalContainer,
}: ContextMenuProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlled ?? localOpen;
  const backend = useBackendLease(open);
  const module = useLenso();
  const lenso = backend === 'lenso' ? module : null;
  const origin = useRef<HTMLElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const change = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const restore = () => {
    requestAnimationFrame(() => {
      const event = new Event('closeAutoFocus', { cancelable: true });
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && !document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) {
        origin.current?.focus({ preventScroll: true });
      }
    });
  };
  const close = () => {
    change(false);
    restore();
  };
  const show = (element: HTMLElement, x: number, y: number) => {
    origin.current = element;
    point.current = { x, y };
    change(true);
  };
  const longPress = useLongPress((element, x, y) => {
    suppressClick.current = true;
    show(element, x, y);
  });

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const element = menu.current;
    if (!lenso) {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(point.current.x, innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(point.current.y, innerHeight - bounds.height - 8))}px`;
    }
    element.focus({ preventScroll: true });
  }, [open, lenso]);

  // 调用方交出这组手势事件；原 Link 的导航仍由其内部 onClick 负责。
  const triggerElement = cloneElement(trigger as ReactElement<HTMLAttributes<HTMLElement>>, {
    tabIndex: 0,
    'aria-haspopup': 'menu',
    'aria-controls': id,
    ...longPress,
    onPointerDown: (event) => {
      suppressClick.current = false;
      longPress.onPointerDown(event);
    },
    onContextMenu: (event) => {
      event.preventDefault();
      show(event.currentTarget, event.clientX, event.clientY);
    },
    onKeyDown: (event) => {
      suppressClick.current = false;
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      show(event.currentTarget, rect.left + 24, rect.top + rect.height / 2);
    },
    onClick: (event) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  });
  const keydown: HTMLAttributes<HTMLDivElement>['onKeyDown'] = (event) => {
    if (['Escape', 'Tab'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (lenso || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus({ preventScroll: true });
  };
  const contentProps = {
    id, ref: menu, role: 'menu', tabIndex: -1, 'aria-label': label,
    onKeyDown: keydown, className,
    style: { zIndex: 'var(--app-z-portal-local-menu)' },
  };
  const content = open ? <MenuScope.Provider value={{ module: lenso, select: (action) => {
    flushSync(() => {
      action?.();
      change(false);
    });
    restore();
  } }}>
    {lenso ? <lenso.ContextMenu open modal="pointer" container={portalContainer?.() ?? document.body}
      onOpenChange={close}>
      <lenso.ContextMenu.Content {...contentProps} anchor={point.current} dim={false}
        finalFocus="none" render={<div className={className} />}>
        {children}
      </lenso.ContextMenu.Content>
    </lenso.ContextMenu> : createPortal(<>
      {/* 透明背板只吞掉关闭这一次点击，不修改 body，也不侵入其他浮层。 */}
      <div onClick={close} style={{ position: 'fixed', inset: 0, ...contentProps.style }} />
      <div {...contentProps}
      data-lenso-slot="context-menu-fallback"
      style={{ ...contentProps.style, position: 'fixed',
        maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}>
      {children}
    </div></>, portalContainer?.() ?? document.body)}
  </MenuScope.Provider> : null;
  return <>{triggerElement}{content}</>;
}

export interface ContextMenuItemProps {
  id?: string;
  label?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

/** 兼容共享 RoomMenuItems 的插槽，同时支持数据式 label/icon/danger/separator。 */
export function ContextMenuItem({
  id, label, icon, children, className = 'room-menu-item', disabled, danger, separator, onSelect,
}: ContextMenuItemProps) {
  const scope = useContext(MenuScope)!;
  if (separator) return <ContextMenuSeparator id={id} className={className} />;
  const variant = danger || className.includes('danger') ? 'danger' : 'default';
  const name = `${className}${danger ? ' danger' : ''}`;
  const body = <>{icon ? <span aria-hidden="true">{icon}</span> : null}{label ?? children}</>;
  if (scope.module) return <scope.module.ContextMenu.Item id={id} disabled={disabled} variant={variant}
    onSelect={() => scope.select(onSelect)} render={<div className={name} />}>{body}</scope.module.ContextMenu.Item>;
  return <button type="button" id={id} role="menuitem" tabIndex={-1} className={name}
    disabled={disabled} aria-disabled={disabled || undefined}
    onClick={() => scope.select(onSelect)}>{body}</button>;
}

export function ContextMenuSeparator({ id, className = 'room-menu-sep' }: { id?: string; className?: string }) {
  const scope = useContext(MenuScope)!;
  return scope.module ? <scope.module.ContextMenu.Separator id={id} render={<div className={className} />} />
    : <div id={id} role="separator" className={className} />;
}
