import { Tooltip } from '../../app/lenso-tooltip';
import { Button } from '../../app/lenso-controls';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { useRef, type ReactNode } from 'react';

import { openContextMenuAt, useLongPress } from '../../hooks/useLongPress';
import { openAgentMemory, type AgentMemoryTarget } from './memory-store';

/**
 * 头像右键/长按菜单：只用于没有外层菜单的头像（群成员、账号自身）。
 * 有外层菜单的会话行与消息头像直接复用现成菜单项，不嵌套第二层。
 * 保留 Radix：真实 Lenso 0.11.4 菜单即使 portal 到 Members 内容内，
 * Escape 仍会同时关闭 Radix 父层；等待父层同库迁移后再切换，不加全局补丁。
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
  const longPress = useLongPress(openContextMenuAt);

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        <Tooltip as={Button}
          ref={triggerRef}
          type="button"
          className={`memory-avatar-trigger${className ? ` ${className}` : ''}`}
          aria-label={`${label}（右键或长按打开记忆菜单）`}
          hint="右键或长按打开记忆菜单"
          {...longPress}
        >
          {children}
        </Tooltip>
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal container={portalContainer?.() ?? undefined}>
        <ContextMenuPrimitive.Content
          className="room-menu spa-menu memory-avatar-menu"
          id="memory-avatar-menu"
          aria-label={`${target.name} 的记忆`}
          onCloseAutoFocus={(event) => {
            if (memoryOpened.current) {
              memoryOpened.current = false;
              event.preventDefault();
            }
          }}
        >
          <ContextMenuPrimitive.Item
            id="memory-avatar-open"
            className="room-menu-item"
            onSelect={() => {
              memoryOpened.current = true;
              onBeforeOpen?.();
              // 让父级弹窗先完成关闭与焦点收尾，再打开记忆弹窗。
              requestAnimationFrame(() => {
                openAgentMemory(target, {
                  returnFocus: () => triggerRef.current,
                  fallbackFocus,
                });
              });
            }}
          >
            {menuLabel}
          </ContextMenuPrimitive.Item>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
