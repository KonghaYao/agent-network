import { create } from 'zustand';

/** 弹窗目标只保留展示与定位字段；权限始终由服务端工具判断。 */
export interface AgentMemoryTarget {
  actor_id: string;
  name: string;
}

export interface AgentMemoryOpenOptions {
  /** 关闭后优先归还的触发元素；可能随菜单/成员弹窗卸载。 */
  returnFocus?: () => HTMLElement | null;
  /** 触发元素已卸载时的稳定落点。 */
  fallbackFocus?: () => HTMLElement | null;
}

interface AgentMemoryPanelState {
  target: AgentMemoryTarget | null;
  returnFocus: (() => HTMLElement | null) | null;
  fallbackFocus: (() => HTMLElement | null) | null;
  open: (target: AgentMemoryTarget, options?: AgentMemoryOpenOptions) => void;
  close: () => void;
}

/**
 * 记忆弹窗是跨页面的单例浮层：侧栏、消息、群成员与账号头像都只负责
 * 写入目标。store 不持久化，也不保存 token 或服务端数据。
 */
export const useAgentMemoryPanel = create<AgentMemoryPanelState>((set) => ({
  target: null,
  returnFocus: null,
  fallbackFocus: null,
  open: (target, options = {}) =>
    set({
      target,
      returnFocus: options.returnFocus ?? null,
      fallbackFocus: options.fallbackFocus ?? null,
    }),
  close: () => set({ target: null, returnFocus: null, fallbackFocus: null }),
}));

export function openAgentMemory(
  target: AgentMemoryTarget,
  options?: AgentMemoryOpenOptions,
): void {
  useAgentMemoryPanel.getState().open(target, options);
}
