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

/** 菜单与触发行、视口边缘保持的最小间隙。 */
const GAP = 8;
/** 侧向空间不足一行菜单时改为视口内定位，避免生成不可见的窄条。 */
const MIN_SIDE_ROOM = 48;

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
  // 指针只决定横向位置；纵向用触发行的完整矩形，SDK 才能在翻转时把整个
  // 行让出来，而不是贴着点击点把上半行盖住。
  const anchor = useRef({
    getBoundingClientRect: () => {
      const rect = origin.current?.getBoundingClientRect();
      return {
        x: point.current.x,
        y: rect?.top ?? point.current.y,
        width: 0,
        height: rect?.height ?? 0,
      };
    },
  }).current;
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
    const items = () => [...element.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    let focusedId = '', focusedIndex = 0;
    const refocus = () => {
      const available = items();
      (available.find((item) => item.id === focusedId) ?? available[focusedIndex] ?? available[0] ?? element)
        .focus({ preventScroll: true });
    };
    const remember = () => {
      const index = items().indexOf(document.activeElement as HTMLElement);
      if (index >= 0) {
        focusedId = document.activeElement!.id;
        focusedIndex = index;
      } else if (document.activeElement === element && focusedId) {
        // SDK 的 pointerleave 可能在异步翻转后重置到容器，保留最后的条目位置。
        refocus();
      }
    };
    const position = () => {
      if (lenso) return;
      const rect = origin.current?.getBoundingClientRect();
      const triggerTop = rect?.top ?? point.current.y;
      const triggerBottom = rect?.bottom ?? point.current.y;
      const above = triggerTop - GAP - GAP;
      const below = innerHeight - GAP - (triggerBottom + GAP);
      const height = element.scrollHeight + element.offsetHeight - element.clientHeight;
      const up = height > below && above > below;
      // 触发元素高于视口（长消息）时两侧可能都没有空间：退到视口内定位，
      // 否则 maxHeight 为 0 会得到不可见菜单。正常翻转仍优先保留间隙。
      const room = up ? above : below;
      const viewportRoom = innerHeight - GAP * 2;
      const maxHeight = room >= MIN_SIDE_ROOM ? Math.min(room, viewportRoom) : viewportRoom;
      element.style.maxHeight = `${Math.max(0, maxHeight)}px`;
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(GAP, Math.min(point.current.x, innerWidth - bounds.width - GAP))}px`;
      const top = up ? triggerTop - GAP - bounds.height : triggerBottom + GAP;
      element.style.top = `${Math.max(GAP, Math.min(top, innerHeight - GAP - bounds.height))}px`;
    };
    const update = () => {
      position();
      if (!element.contains(document.activeElement)) refocus();
    };
    // capture 层统一接管导航键，避免 SDK 与兜底各移动一次；body 也能恢复键盘操作。
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && !element.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (!['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape' || event.key === 'Tab') { close(); return; }
      const available = items(), index = available.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
        : index < 0 ? (event.key === 'ArrowDown' ? 0 : available.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length;
      available[next]?.focus({ preventScroll: true });
      available[next]?.scrollIntoView({ block: 'nearest' });
    };
    element.addEventListener('focusin', remember);
    document.addEventListener('keydown', keydown, true);
    const mutations = new MutationObserver(update);
    mutations.observe(element, { childList: true, subtree: true });
    const resize = new ResizeObserver(position);
    if (!lenso) resize.observe(element);
    window.addEventListener('resize', position);
    position();
    element.focus({ preventScroll: true });
    return () => {
      mutations.disconnect();
      resize.disconnect();
      element.removeEventListener('focusin', remember);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', position);
    };
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
  const contentProps = {
    id, ref: menu, role: 'menu', tabIndex: -1, 'aria-label': label,
    className,
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
      <lenso.ContextMenu.Content {...contentProps} anchor={anchor} sideOffset={GAP}
        collisionPadding={GAP} dim={false} finalFocus="none" render={<div className={className} />}>
        {children}
      </lenso.ContextMenu.Content>
    </lenso.ContextMenu> : createPortal(<>
      {/* 透明背板只吞掉关闭这一次点击，不修改 body，也不侵入其他浮层。 */}
      <div onClick={close} style={{ position: 'fixed', inset: 0, ...contentProps.style }} />
      <div {...contentProps}
      data-lenso-slot="context-menu-fallback"
      style={{ ...contentProps.style, position: 'fixed',
        overflowY: 'auto' }}>
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
