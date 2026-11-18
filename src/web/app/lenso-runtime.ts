import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/**
 * `@lenso/ui` 的唯一动态装载点。
 *
 * - SSR snapshot 恒为 `idle`/`null`，服务端渲染不会触发动态 import；
 * - 首次订阅只发起一次加载；失败后保留 `error`，由调用方显式 `retryLenso()`；
 * - 模块加载完成后所有订阅者一起升级，不在加载中按控件重复 import。
 */

export type LensoModule = typeof import('@lenso/ui');

export type LensoStatus = 'idle' | 'loading' | 'ready' | 'error';

export type LensoBackend = 'lenso' | 'fallback';

let loadedLenso: LensoModule | null = null;
let status: LensoStatus = 'idle';
let failure: unknown = null;
let loadingLenso: Promise<LensoModule> | null = null;
let generation = 0;

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function settle(
  attempt: number,
  next: { module?: LensoModule; error?: unknown },
) {
  // 旧 generation 的结果不能覆盖显式重试后的新状态。
  if (attempt !== generation) return;
  if (next.module) {
    loadedLenso = next.module;
    status = 'ready';
  } else {
    failure = next.error;
    status = 'error';
  }
  loadingLenso = null;
  notify();
}

export function loadLenso(): Promise<LensoModule> {
  if (loadedLenso) return Promise.resolve(loadedLenso);
  if (loadingLenso) return loadingLenso;
  const attempt = ++generation;
  failure = null;
  status = 'loading';
  notify();
  const pending = import('@lenso/ui').then(
    (module) => {
      settle(attempt, { module });
      return module;
    },
    (error: unknown) => {
      settle(attempt, { error });
      throw error;
    },
  );
  loadingLenso = pending;
  return pending;
}

/**
 * 显式重试：只在失败后重置，加载中或已就绪时复用当前结果。
 * 浏览器对同一个模块 URL 的失败缓存由真实网络恢复决定；调用方据此
 * 决定是否提示用户稍后再试，runtime 不做自动循环重试。
 */
export function retryLenso(): Promise<LensoModule> {
  if (loadedLenso) return Promise.resolve(loadedLenso);
  if (status === 'error') loadingLenso = null;
  return loadingLenso ?? loadLenso();
}

/**
 * 只在调用方明确需要时预加载；失败被吞掉，状态通过 `useLensoStatus()`
 * 或 `getLensoStatus()` 观察，避免无人等待时产生 unhandled rejection。
 */
export function preloadLenso(): Promise<LensoModule | null> {
  return loadLenso().catch(() => null);
}

export function getLensoStatus(): LensoStatus {
  return status;
}

export function getLensoError(): unknown {
  return failure;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 订阅即开始加载，保持 `useLenso()` 现有调用方语义；失败被这里吞掉，
  // 状态仍通过 snapshot 通知 UI，不能产生 unhandled rejection。
  void loadLenso().catch(() => {});
  return () => {
    listeners.delete(listener);
  };
}

export function useLenso(): LensoModule | null {
  return useSyncExternalStore(subscribe, () => loadedLenso, () => null);
}

export function useLensoStatus(): LensoStatus {
  return useSyncExternalStore(subscribe, () => status, () => 'idle');
}

const BackendContext = createContext<LensoBackend | null>(null);

/** 供浮层/表单适配器把当前打开周期的 backend 传给子树控件。 */
export function LensoBackendProvider({
  backend,
  children,
}: {
  backend: LensoBackend;
  children?: ReactNode;
}) {
  return createElement(BackendContext.Provider, { value: backend }, children);
}

export function useLensoBackendScope(): LensoBackend | null {
  return useContext(BackendContext);
}

let fallbackLeases = 0;
const leaseListeners = new Set<() => void>();

function subscribeLeases(listener: () => void) {
  leaseListeners.add(listener);
  return () => {
    leaseListeners.delete(listener);
  };
}

function notifyLeases() {
  for (const listener of leaseListeners) listener();
}

/**
 * 是否有 fallback 浮层仍在打开周期内。结构性外壳（如 Toolbar）据此
 * 推迟热切换，避免模块到达时把正在交互的子树整体重挂。
 */
export function useFallbackLeaseLock(): boolean {
  return useSyncExternalStore(subscribeLeases, () => fallbackLeases > 0, () => false);
}

type Lease = {
  backend: LensoBackend;
  open: boolean;
};

/**
 * 打开周期锁：`open` 从 false→true 时按当下模块是否就绪选 backend，
 * 整个打开期间保持不变；关闭后保留到下一次打开再重新选择。
 *
 * 父级已经锁在 fallback 时，子级只能沿用 fallback，避免同一棵浮层树
 * 混用两套焦点管理。
 */
export function useBackendLease(open: boolean): LensoBackend {
  const lenso = useLenso();
  const parent = useLensoBackendScope();
  const lease = useRef<Lease | null>(null);

  if (open) {
    if (!lease.current?.open) {
      const ready = lenso ? 'lenso' : 'fallback';
      lease.current = {
        backend: parent === 'fallback' ? 'fallback' : ready,
        open: true,
      };
    }
  } else if (lease.current?.open) {
    lease.current = { ...lease.current, open: false };
  }

  const backend = parent === 'fallback'
    ? 'fallback'
    : lease.current?.backend ?? (lenso ? 'lenso' : 'fallback');

  // fallback 打开期间登记全局锁；结构外壳看到后保持原生，直到本周期结束。
  useEffect(() => {
    if (!open || backend !== 'fallback') return;
    fallbackLeases += 1;
    notifyLeases();
    return () => {
      fallbackLeases -= 1;
      notifyLeases();
    };
  }, [open, backend]);

  return backend;
}
