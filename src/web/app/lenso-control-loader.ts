import { useRef, useState, useSyncExternalStore, type ComponentPropsWithRef } from 'react';
import { useLenso } from './lenso-display';

type Renderers = typeof import('./lenso-control-renderers');
let loaded: Renderers | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function preloadControlRenderers() {
  loading ??= import('./lenso-control-renderers').then((module) => {
    loaded = module;
    for (const notify of listeners) notify();
  }).catch(() => {
    // 加载失败继续保留同语义 fallback；下一次交互可重试。
    loading = null;
  });
}

/** 编辑控件锁到卸载；菜单只锁到本轮关闭，不在操作中替换 DOM。 */
export function useControlRenderer(open?: boolean) {
  const lenso = useLenso();
  const renderers = useSyncExternalStore(subscribe, () => loaded, () => null);
  const [interacting, setInteracting] = useState(false);
  const lease = useRef<boolean | null>(null);
  const ready = Boolean(lenso && renderers);
  if (open === undefined) lease.current ??= ready;
  else if (!open) lease.current = ready;
  else lease.current ??= ready;
  const active = lease.current && !interacting;
  return {
    lenso: active ? lenso : null,
    renderers: active ? renderers : null,
    intent: preloadControlRenderers,
    lockFallback: () => { if (!active) setInteracting(true); },
  };
}

export type ControlIntentProps = Pick<ComponentPropsWithRef<'div'>,
  'onPointerEnter' | 'onFocusCapture' | 'onPointerDownCapture' | 'onKeyDownCapture'>;

/** 不增加布局盒；捕获阶段先锁定正在使用的 fallback，再启动网络请求。 */
export function controlIntent(intent: () => void, lockFallback: () => void): ControlIntentProps {
  return {
    onPointerEnter: intent,
    onFocusCapture: () => { lockFallback(); intent(); },
    onPointerDownCapture: () => { lockFallback(); intent(); },
    onKeyDownCapture: () => { lockFallback(); intent(); },
  };
}
