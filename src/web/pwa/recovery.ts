import { useSyncExternalStore } from 'react';

import { LIMITS } from '../../contracts/limits';
import {
  RecoveryScheduler,
  type RecoveryReason,
  type RecoveryRound,
  type RecoveryTriggerOptions,
} from '../lib/recovery-coordinator';

/**
 * 前台恢复的浏览器外壳：合并触发、维护遮罩/离线/撤权状态，并把实际
 * 鉴权与查询执行交给 `RecoveryHost`。
 *
 * 这里只暴露可解释的连接状态，不缓存消息正文、token 或房间数据。
 */

export type RecoveryPhase = 'idle' | 'checking' | 'ready' | 'offline' | 'blocked';

export interface RecoverySnapshot {
  phase: RecoveryPhase;
  online: boolean;
  masked: boolean;
  longBackground: boolean;
  rounds: number;
  lastReasons: RecoveryReason[];
  /** 身份失效、退出登录或撤权时的可读原因。 */
  blockedReason: string | null;
  /** 当前被服务端拒绝访问的房间。 */
  revokedRoomId: string | null;
  completedAt: number;
}

export type RecoveryRunner = (round: RecoveryRound) => Promise<void> | void;

export const AUTH_SIGNAL_KEY = 'agent-network-auth-signal';
export const TOKEN_KEY = 'agent-network-token';
export const LOGGED_OUT_KEY = 'agent-network-logged-out';
const AUTH_SIGNAL_VERSION = 1;

function initialOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

let snapshot: RecoverySnapshot = {
  phase: 'idle',
  online: initialOnline(),
  masked: false,
  longBackground: false,
  rounds: 0,
  lastReasons: [],
  blockedReason: null,
  revokedRoomId: null,
  completedAt: 0,
};

const listeners = new Set<() => void>();
let runner: RecoveryRunner | null = null;
let installed = false;
let hiddenAt: number | null = null;
let pendingMask = false;
let pendingLongBackground = false;
let teardown: (() => void) | null = null;

function emit(patch: Partial<RecoverySnapshot>): void {
  const next = { ...snapshot, ...patch };
  const changed = (Object.keys(next) as (keyof RecoverySnapshot)[]).some(
    (key) => next[key] !== snapshot[key],
  );
  if (!changed) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function currentOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function markOffline(): void {
  emit({ online: false, masked: false, phase: 'offline' });
}

export function getRecoverySnapshot(): RecoverySnapshot {
  return snapshot;
}

export function subscribeRecovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRecoveryState(): RecoverySnapshot {
  return useSyncExternalStore(subscribeRecovery, getRecoverySnapshot, getRecoverySnapshot);
}

export function setRecoveryRunner(next: RecoveryRunner | null): void {
  runner = next;
}

const scheduler = new RecoveryScheduler(
  async (round) => {
    emit({
      phase: 'checking',
      masked: round.masked,
      longBackground: round.masked,
      rounds: round.id,
      lastReasons: round.reasons,
      completedAt: snapshot.completedAt,
    });
    if (runner) {
      try {
        await runner(round);
      } catch {
        // Runner 内部负责把失败分类为 offline/blocked；这里只避免未捕获异常。
        if (currentOnline()) {
          emit({ phase: 'offline', masked: false });
        } else {
          markOffline();
        }
      }
      return;
    }
    emit({ phase: 'ready', masked: false, longBackground: false, completedAt: Date.now() });
  },
  {
    debounceMs: LIMITS.webRecoveryDebounceMs,
    quietMs: LIMITS.webRecoveryQuietMs,
  },
);

export function triggerRecovery(
  reason: RecoveryReason,
  options: RecoveryTriggerOptions = {},
): void {
  if (options.longBackground === true) pendingLongBackground = true;
  if (options.mask === true || options.longBackground === true) pendingMask = true;
  if (pendingMask) {
    emit({ masked: true, longBackground: pendingLongBackground });
  }
  scheduler.trigger(reason, {
    longBackground: pendingLongBackground || options.longBackground === true,
    mask: pendingMask || options.mask === true,
  });
}

export function reportRecoveryReady(): void {
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'ready',
    online: currentOnline(),
    masked: false,
    longBackground: false,
    blockedReason: null,
    completedAt: Date.now(),
  });
}

export function reportRecoveryOffline(message?: string): void {
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'offline',
    online: false,
    masked: false,
    longBackground: false,
    blockedReason: message ?? null,
  });
}

/** 网络可达但服务暂不可用：保留内存内容并标为不可用，不声称已撤权。 */
export function reportRecoveryUnavailable(message?: string): void {
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'offline',
    online: currentOnline(),
    masked: false,
    longBackground: false,
    blockedReason: message ?? '暂时无法连接，已保留当前内容。',
  });
}

export function reportRecoveryBlocked(reason: string, revokedRoomId: string | null = null): void {
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'blocked',
    masked: true,
    blockedReason: reason,
    revokedRoomId,
  });
}

export function clearRecoveryBlock(): void {
  if (snapshot.phase !== 'blocked') return;
  emit({
    phase: currentOnline() ? 'ready' : 'offline',
    masked: false,
    blockedReason: null,
    revokedRoomId: null,
  });
}

export function reportNetworkStatus(online: boolean): void {
  if (online === snapshot.online) return;
  if (!online) {
    markOffline();
    return;
  }
  emit({ online: true, phase: snapshot.phase === 'offline' ? 'ready' : snapshot.phase });
}

/** 身份 storage 信号：同源其他标签页在退出、切号或撤权时写入。 */
export function writeAuthSignal(kind: 'logout' | 'switch' | 'revoked'): void {
  try {
    localStorage.setItem(
      AUTH_SIGNAL_KEY,
      JSON.stringify({ v: AUTH_SIGNAL_VERSION, kind, at: Date.now() }),
    );
  } catch {
    // 存储禁用时只依赖 token/logged-out 的 storage 事件。
  }
}

function authStorageSignal(event: StorageEvent): void {
  const key = event.key;
  const authKey =
    key === null || key === TOKEN_KEY || key === LOGGED_OUT_KEY || key === AUTH_SIGNAL_KEY;
  if (!authKey) return;
  triggerRecovery('auth', { mask: true });
}

/**
 * 安装一次全局监听。返回清理函数，供开发环境热更新/测试卸载；
 * 生产入口只调用一次。
 */
export function installRecoveryTriggers(): () => void {
  if (installed) return teardown ?? (() => undefined);
  installed = true;

  const onVisibility = () => {
    const state = typeof document === 'undefined' ? 'visible' : document.visibilityState;
    if (state === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const longBackground =
      hiddenAt !== null && Date.now() - hiddenAt >= LIMITS.webRecoveryLongBackgroundMs;
    hiddenAt = null;
    if (!currentOnline()) {
      markOffline();
      triggerRecovery('visibility', { longBackground, mask: longBackground });
      return;
    }
    triggerRecovery('visibility', { longBackground, mask: longBackground });
  };
  const onOnline = () => {
    emit({ online: true, phase: snapshot.phase === 'offline' ? 'ready' : snapshot.phase });
    triggerRecovery('online');
  };
  const onOffline = () => {
    markOffline();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!currentOnline()) {
      markOffline();
      return;
    }
    triggerRecovery('pageshow', { longBackground: event.persisted, mask: event.persisted });
  };
  const onStorage = (event: StorageEvent) => {
    authStorageSignal(event);
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('storage', onStorage);
    const debug = {
      snapshot: () => snapshot,
      trigger: (reason: RecoveryReason, options?: RecoveryTriggerOptions) =>
        triggerRecovery(reason, options),
    };
    (window as unknown as { __agentNetworkRecovery?: typeof debug }).__agentNetworkRecovery = debug;
  }

  teardown = () => {
    installed = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('storage', onStorage);
      delete (window as unknown as { __agentNetworkRecovery?: unknown }).__agentNetworkRecovery;
    }
    teardown = null;
  };
  return teardown;
}
