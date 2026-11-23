import { useSyncExternalStore } from 'react';

import { LIMITS } from '../../contracts/limits';
import { bumpIdentityEpoch } from '../lib/identity-epoch';
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
  /**
   * 身份边界遮罩：切号、撤权或凭据失效后一直保持，直到新凭据通过
   * `network_me` 与房间边界校验，或确认无凭据进入配对/登录引导。
   */
  sticky: boolean;
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
  sticky: false,
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
/** 身份信号触发的遮罩只能由成功鉴权或明确的 blocked 状态结束。 */
let stickyMask = false;
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
  if (stickyMask) {
    emit({ online: false, masked: true, sticky: true, phase: 'offline' });
    return;
  }
  emit({ online: false, masked: false, sticky: false, phase: 'offline' });
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
      masked: round.masked || stickyMask,
      sticky: stickyMask,
      longBackground: round.longBackground,
      rounds: round.id,
      lastReasons: round.reasons,
      completedAt: snapshot.completedAt,
    });
    if (runner) {
      try {
        await runner(round);
      } catch {
        // Runner 内部负责把失败分类为 offline/blocked；这里只避免未捕获异常。
        if (stickyMask) {
          reportRecoveryUnavailable('网络不可用，已暂停显示旧身份的私有内容。');
        } else if (currentOnline()) {
          emit({ phase: 'offline', masked: false, sticky: false });
        } else {
          markOffline();
        }
      }
      return;
    }
    emit({
      phase: 'ready',
      masked: false,
      sticky: false,
      longBackground: false,
      completedAt: Date.now(),
    });
  },
  {
    debounceMs: LIMITS.webRecoveryDebounceMs,
    quietMs: LIMITS.webRecoveryQuietMs,
  },
);

/**
 * 触发一轮前台恢复。
 *
 * 安全取舍：普通回到前台（visibility / pageshow / online / stream-ack）以及
 * 长后台恢复都继续显示同一身份的内存/缓存内容，只做后台核对，避免恢复期间
 * 聊天闪空。旧内容可能短暂过期，但仍属于当前已授权身份。
 *
 * 只有身份切换、撤权、凭据失效等边界信号才置 `mask`：遮罩必须在发起任何
 * 网络核对之前同步出现，随后 `RecoveryHost` 才清私有缓存并重新鉴权，绝不
 * 允许「先显示新身份内容、后校验权限」的顺序。
 */
export function triggerRecovery(
  reason: RecoveryReason,
  options: RecoveryTriggerOptions = {},
): void {
  // 身份切换/撤权/退出：遮罩一旦出现就必须粘住，直到新凭据/成员边界被确认。
  if (reason === 'auth' || reason === 'membership') {
    stickyMask = true;
    pendingMask = true;
    // 身份/成员边界事件：从此刻起旧身份/旧成员代次的在途响应不能写回新缓存。
    bumpIdentityEpoch();
  }
  if (options.longBackground === true) pendingLongBackground = true;
  // 长后台不是身份边界，不置 pendingMask；只用来标记本轮需要完整核对。
  if (options.mask === true) pendingMask = true;
  if (pendingMask) {
    emit({
      masked: true,
      sticky: stickyMask,
      longBackground: pendingLongBackground || options.longBackground === true,
    });
  }
  scheduler.trigger(reason, {
    longBackground: pendingLongBackground || options.longBackground === true,
    mask: pendingMask,
  });
}

/**
 * 调用方已确认当前浏览器凭据与内存身份不一致（例如 token 已被其他标签页
 * 替换）：在发起网络核对前先粘住遮罩，并立即遮蔽旧私有视图。
 */
export function reportIdentitySignal(): void {
  bumpIdentityEpoch();
  if (stickyMask && pendingMask) return;
  stickyMask = true;
  pendingMask = true;
  emit({ masked: true, sticky: true });
}

export function reportRecoveryReady(): void {
  stickyMask = false;
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'ready',
    online: currentOnline(),
    masked: false,
    sticky: false,
    longBackground: false,
    blockedReason: null,
    completedAt: Date.now(),
  });
}

export function reportRecoveryOffline(message?: string): void {
  if (stickyMask) {
    // 身份尚未确认：离线只更新原因，不撤掉身份遮罩；已确认撤权时保留引导。
    if (snapshot.phase === 'blocked') {
      emit({ online: false, masked: true, sticky: true, blockedReason: snapshot.blockedReason });
      return;
    }
    emit({
      phase: 'offline',
      online: false,
      masked: true,
      sticky: true,
      longBackground: false,
      blockedReason: message ?? '网络不可用，需要联网确认身份后才能恢复。',
    });
    return;
  }
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'offline',
    online: false,
    masked: false,
    sticky: false,
    longBackground: false,
    blockedReason: message ?? null,
  });
}

/** 网络可达但服务暂不可用：保留内存内容并标为不可用，不声称已撤权。 */
export function reportRecoveryUnavailable(message?: string): void {
  if (stickyMask) {
    // 身份边界尚未确认：保持遮罩，绝不展示旧身份的私有内容。
    if (snapshot.phase === 'blocked') {
      emit({ masked: true, sticky: true, blockedReason: snapshot.blockedReason });
      return;
    }
    emit({
      phase: 'offline',
      online: currentOnline(),
      masked: true,
      sticky: true,
      longBackground: false,
      blockedReason: message ?? '暂时无法连接，需要联网确认身份后才能恢复。',
    });
    return;
  }
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'offline',
    online: currentOnline(),
    masked: false,
    sticky: false,
    longBackground: false,
    blockedReason: message ?? '暂时无法连接，已保留当前内容。',
  });
}

export function reportRecoveryBlocked(reason: string, revokedRoomId: string | null = null): void {
  // blocked 是身份/权限边界的终态：后续恢复轮失败时也不能把遮罩撤掉。
  bumpIdentityEpoch();
  stickyMask = true;
  pendingMask = false;
  pendingLongBackground = false;
  emit({
    phase: 'blocked',
    masked: true,
    sticky: true,
    blockedReason: reason,
    revokedRoomId,
  });
}

export function clearRecoveryBlock(): void {
  if (snapshot.phase !== 'blocked') return;
  stickyMask = false;
  pendingMask = false;
  emit({
    phase: currentOnline() ? 'ready' : 'offline',
    masked: false,
    sticky: false,
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
      // 离线只标离线；长后台仍不遮罩，联网后由恢复轮继续核对。
      triggerRecovery('visibility', { longBackground });
      return;
    }
    // 长后台只要求完整核对并显示非阻塞提示，不清空、不遮蔽当前聊天。
    triggerRecovery('visibility', { longBackground });
  };
  const onOnline = () => {
    emit({ online: true, phase: snapshot.phase === 'offline' ? 'ready' : snapshot.phase });
    triggerRecovery('online');
  };
  const onOffline = () => {
    markOffline();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    // 初次加载也会触发 pageshow；只有 bfcache 恢复才需要额外核对。
    if (!event.persisted) return;
    if (!currentOnline()) {
      hiddenAt = null;
      markOffline();
      return;
    }
    // bfcache 恢复本身不代表离开很久：短时间往返只核对，不遮罩。
    const backgroundMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    const longBackground = backgroundMs >= LIMITS.webRecoveryLongBackgroundMs;
    // bfcache 长后台同样只核对，不遮罩同一身份的既有聊天。
    triggerRecovery('pageshow', { longBackground });
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
