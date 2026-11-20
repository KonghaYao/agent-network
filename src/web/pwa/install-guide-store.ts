import { useSyncExternalStore } from 'react';

/**
 * 手动恢复入口的轻量状态：侧栏/移动聊天头部点击后重新打开安装引导，
 * 即使 localStorage 里保留了“已关闭”偏好。
 */
let manualOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openInstallGuide(): void {
  if (manualOpen) return;
  manualOpen = true;
  emit();
}

export function closeInstallGuide(): void {
  if (!manualOpen) return;
  manualOpen = false;
  emit();
}

export function useInstallGuideOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => manualOpen,
    () => false,
  );
}
