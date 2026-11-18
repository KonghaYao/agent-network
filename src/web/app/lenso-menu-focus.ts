import { useEffect, type RefObject } from 'react';

/** fallback 与 SDK 共用关闭后的归焦；新对话框已取得焦点时不抢回。 */
export function restoreMenuFocus(trigger: RefObject<HTMLElement | null>) {
  requestAnimationFrame(() => {
    if (!document.querySelector('[role="dialog"], [role="alertdialog"]')) {
      trigger.current?.focus({ preventScroll: true });
    }
  });
}

/** 原生降级的 roving focus；不接管 Lenso 的键盘控制器。 */
export function useFallbackMenuKeyboard(
  enabled: boolean,
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>,
  change: (open: boolean, details?: { reason?: 'escape-key' }) => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as Node;
      const inMenu = menu.current?.contains(target);
      const inTrigger = trigger.current?.contains(target);
      if (!inMenu && !inTrigger) return;
      if (!open && inTrigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        change(true);
        return;
      }
      if (!open) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        change(false, { reason: 'escape-key' });
        restoreMenuFocus(trigger);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [enabled, open, trigger, menu, change]);
}
