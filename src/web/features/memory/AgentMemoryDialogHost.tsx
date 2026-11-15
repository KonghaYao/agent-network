import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';

import { useAgentMemoryPanel } from './memory-store';

const AgentMemoryDialog = lazy(() =>
  import('./AgentMemoryDialog').then((module) => ({ default: module.AgentMemoryDialog })),
);

interface RestoreTarget {
  returnFocus?: (() => HTMLElement | null) | null;
  fallbackFocus?: (() => HTMLElement | null) | null;
}

/** 全局只挂一次；侧栏、消息、群成员和账号头像都通过 store 打开同一弹窗。 */
export function AgentMemoryDialogHost() {
  const target = useAgentMemoryPanel((state) => state.target);
  const returnFocus = useAgentMemoryPanel((state) => state.returnFocus);
  const fallbackFocus = useAgentMemoryPanel((state) => state.fallbackFocus);
  const restoreRef = useRef<RestoreTarget>({});

  useEffect(() => {
    if (target) restoreRef.current = { returnFocus, fallbackFocus };
  }, [fallbackFocus, returnFocus, target]);

  const close = useCallback(() => {
    const restore = restoreRef.current;
    useAgentMemoryPanel.getState().close();
    // 菜单项/群成员弹窗可能在打开记忆时卸载；先尝试原触发元素，再退回稳定入口。
    requestAnimationFrame(() => {
      const preferred = restore.returnFocus?.() ?? null;
      const next = preferred?.isConnected ? preferred : restore.fallbackFocus?.() ?? null;
      if (next?.isConnected) next.focus();
    });
  }, []);

  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <AgentMemoryDialog key={target.actor_id} target={target} onClose={close} />
    </Suspense>
  );
}
