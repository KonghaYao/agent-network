import { Tooltip } from '../../app/lenso-tooltip';
import { Button } from '../../app/lenso-controls';
import { ContextMenu, ContextMenuItem } from '../../app/lenso-context-menu';
import { useBackendLease, useLenso } from '../../app/lenso-runtime';
import * as Radix from '@radix-ui/react-context-menu';
import { useRef, useState, type ReactNode } from 'react';

import { openContextMenuAt, useLongPress } from '../../hooks/useLongPress';
import { openAgentMemory, type AgentMemoryTarget } from './memory-store';

/**
 * 头像右键/长按菜单：只用于没有外层菜单的头像（群成员、账号自身）。
 * 有外层菜单的会话行与消息头像直接复用现成菜单项，不嵌套第二层。
 */
export function AgentAvatarMenu({
  target,
  label,
  menuLabel = '查看记忆',
  className,
  fallbackFocus,
  onBeforeOpen,
  portalContainer,
  children,
}: {
  target: AgentMemoryTarget;
  label: string;
  menuLabel?: string;
  className?: string;
  fallbackFocus?: () => HTMLElement | null;
  /** 群成员弹窗需先关闭自己，再打开记忆。 */
  onBeforeOpen?: () => void;
  /** 在 Dialog 内使用时挂到 Dialog 内容上，避免焦点陷阱把菜单关掉。 */
  portalContainer?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const memoryOpened = useRef(false);

  const [open, setOpen] = useState(false);
  const backend = useBackendLease(open);
  const lenso = useLenso();
  const longPress = useLongPress(openContextMenuAt);
  const restore = (event: Event) => {
    event.preventDefault();
    if (memoryOpened.current) memoryOpened.current = false;
    else triggerRef.current?.focus({ preventScroll: true });
  };
  const select = () => {
    memoryOpened.current = true;
    onBeforeOpen?.();
    // 让父级弹窗先完成关闭与焦点收尾，再打开记忆弹窗。
    requestAnimationFrame(() => {
      openAgentMemory(target, {
        returnFocus: () => triggerRef.current,
        fallbackFocus,
      });
    });
  };
  const trigger = (
    <Tooltip as={Button}
      ref={triggerRef}
      type="button"
      className={`memory-avatar-trigger${className ? ` ${className}` : ''}`}
      aria-label={`${label}（右键或长按打开记忆菜单）`}
      hint="右键或长按打开记忆菜单"
    >
      {children}
    </Tooltip>
  );

  if (backend !== 'lenso' || !lenso) return (
    <Radix.Root open={open} onOpenChange={setOpen}>
      <Radix.Trigger asChild {...longPress}>{trigger}</Radix.Trigger>
      <Radix.Portal container={portalContainer?.() ?? undefined}>
        <Radix.Content id="memory-avatar-menu" aria-label={`${target.name} 的记忆`}
          className="room-menu spa-menu memory-avatar-menu" onCloseAutoFocus={restore}>
          <Radix.Item id="memory-avatar-open" className="room-menu-item" onSelect={select}>
            {menuLabel}
          </Radix.Item>
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );

  return (
    <ContextMenu
      id="memory-avatar-menu"
      label={`${target.name} 的记忆`}
      className="room-menu spa-menu memory-avatar-menu"
      portalContainer={portalContainer}
      open={open}
      onOpenChange={setOpen}
      onCloseAutoFocus={restore}
      trigger={trigger}
    >
      <ContextMenuItem
        id="memory-avatar-open"
        className="room-menu-item"
        onSelect={select}
      >
        {menuLabel}
      </ContextMenuItem>
    </ContextMenu>
  );
}
