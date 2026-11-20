/**
 * 版本检查协调器、更新交互状态与安全重载。
 *
 * 单例状态供入口提示和错误页共享；检查本身是 single-flight，失败只记录
 * 不抛错，不阻断聊天。程序性重载前重新获取目标、重新判定忙碌状态并写入
 * 一次性快照；同一标签与目标最多一次，第二次停在可操作错误信息上。
 */

import { useSyncExternalStore } from 'react';

import { LIMITS } from '../../contracts/limits';
import { getUpdateBusyReasons, type UpdateBusyReason } from './update-busy';
import {
  claimUpdateReload,
  defaultSnapshotStorage,
  getUpdateTabId,
  writeUpdateSnapshot,
  type UpdateDraftSource,
} from './update-snapshot';
import { setUpdateWriteBlocked } from './update-write-guard';
import {
  decideVersionCheck,
  fetchWebVersion,
  readPageRelease,
  versionRelation,
  type PageRelease,
  type VersionCheckTrigger,
  type VersionRelation,
  type WebVersionInfo,
} from './version';

export { isUpdateWriteBlocked } from './update-write-guard';

export type UpdatePhase = 'idle' | 'available' | 'incompatible' | 'reloading' | 'error';

export type UpdateErrorKind = 'version' | 'snapshot' | 'storage' | 'reloaded' | null;

export interface UpdateState {
  readonly phase: UpdatePhase;
  readonly page: PageRelease | null;
  readonly target: WebVersionInfo | null;
  readonly busy: readonly UpdateBusyReason[];
  readonly message: string;
  readonly draftText: string;
  readonly checking: boolean;
  readonly errorKind: UpdateErrorKind;
  /**
   * 与提示是否可见无关的粘性写保护：一旦确认页面契约不在服务器区间内，
   * 只有页面真正切到当前发布（关系变为 `same`）才解除。
   */
  readonly contractIncompatible: boolean;
  /** 用户点了“稍后/留在当前页”；只隐藏提示，不清除任何待恢复信息。 */
  readonly noticeDismissed: boolean;
}

const EMPTY_STATE: UpdateState = {
  phase: 'idle',
  page: null,
  target: null,
  busy: [],
  message: '',
  draftText: '',
  checking: false,
  errorKind: null,
  contractIncompatible: false,
  noticeDismissed: false,
};

let state: UpdateState = EMPTY_STATE;
const listeners = new Set<() => void>();
let pageRelease: PageRelease | null | undefined;
let inFlight: Promise<UpdateState> | null = null;
let lastCheckAt: number | null = null;
let reloading = false;
let draftProvider: (() => UpdateDraftSource | null) | null = null;

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  // 网络层闸门与可见状态共用同一个事实：提示可以隐藏，写保护不能。
  setUpdateWriteBlocked(state.contractIncompatible);
  for (const listener of listeners) listener();
  return state;
}

export function subscribeUpdateState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdateState, getUpdateState, getUpdateState);
}

export function useUpdateWriteBlocked(): boolean {
  return useSyncExternalStore(
    subscribeUpdateState,
    () => state.contractIncompatible,
    () => false,
  );
}

/** 关系变化后的写保护：不兼容立即锁定；只有页面已等于当前发布才解除。 */
export function contractIncompatibleAfter(
  current: boolean,
  relation: VersionRelation,
): boolean {
  if (relation === 'same') return false;
  if (relation === 'incompatible') return true;
  return current;
}

export function getPageRelease(): PageRelease | null {
  if (pageRelease === undefined) pageRelease = readPageRelease();
  return pageRelease;
}

/** Composer 提供当前正文与光标；卸载时清理，不保留闭包引用。 */
export function registerUpdateDraftProvider(
  provider: (() => UpdateDraftSource | null) | null,
): () => void {
  draftProvider = provider;
  return () => {
    if (draftProvider === provider) draftProvider = null;
  };
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * 检查一次版本。`force` 用于 chunk/资源错误或集成探针，可绕过 60 秒节流；
 * 后台标签、进行中的请求仍然优先暂停/合并。
 */
export function checkForUpdate(options: {
  readonly force?: boolean;
  readonly trigger?: VersionCheckTrigger;
} = {}): Promise<UpdateState> {
  const page = getPageRelease();
  if (!page) return Promise.resolve(state);
  if (inFlight) return inFlight;
  const trigger = options.trigger ?? (options.force ? 'forced' : 'foreground');
  const now = Date.now();
  const decision = decideVersionCheck({
    trigger,
    visible: visible(),
    inFlight: false,
    now,
    lastCheckAt,
  });
  if (decision !== 'run') return Promise.resolve(state);
  lastCheckAt = now;

  inFlight = (async () => {
    const target = await fetchWebVersion();
    if (!target) {
      // 超时、503 或字段损坏：保持当前页面，不显示阻断性错误。
      return state;
    }
    const relation = versionRelation(page, target);
    if (relation === 'same') {
      return publish({
        phase: 'idle',
        page,
        target: null,
        message: '',
        draftText: '',
        errorKind: null,
        busy: [],
        contractIncompatible: false,
        noticeDismissed: false,
      });
    }
    const contractIncompatible = contractIncompatibleAfter(
      state.contractIncompatible,
      relation,
    );
    const noticeDismissed =
      state.target?.buildId === target.buildId ? state.noticeDismissed : false;
    // 快照/存储/已重载失败仍需要用户复制草稿或手动刷新；后台版本检查不能
    // 把它们覆盖成普通提示，否则复制草稿入口会无声消失。
    if (
      state.phase === 'error' &&
      (state.errorKind === 'snapshot' ||
        state.errorKind === 'storage' ||
        state.errorKind === 'reloaded')
    ) {
      return publish({ page, target, busy: [], contractIncompatible, noticeDismissed });
    }
    return publish({
      phase: relation === 'incompatible' ? 'incompatible' : 'available',
      page,
      target,
      message: '',
      draftText: '',
      errorKind: null,
      busy: getUpdateBusyReasons(),
      contractIncompatible,
      noticeDismissed,
    });
  })()
    .catch(() => state)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * 隐藏更新提示。只改变可见性：不兼容写保护、错误信息与待复制的草稿都
 * 保留，用户仍可通过持久标识重新打开提示。
 */
export function dismissUpdate(): void {
  if (state.phase === 'idle') return;
  publish({ noticeDismissed: true, busy: [], checking: false });
}

/** 从持久标识重新展开提示；不触发版本检查，也不改变写保护。 */
export function showUpdateNotice(): void {
  if (state.phase === 'idle') return;
  publish({ noticeDismissed: false });
}

export function clearUpdateError(): void {
  if (state.phase !== 'error') return;
  dismissUpdate();
}

function errorState(
  kind: Exclude<UpdateErrorKind, null>,
  message: string,
  draftText = '',
): UpdateState {
  return publish({
    phase: 'error',
    message,
    busy: [],
    draftText,
    errorKind: kind,
    checking: false,
  });
}

/**
 * 用户显式点击更新：重新获取目标，重新判定忙碌和版本，写入快照与熔断记录，
 * 最后才 reload 当前会话 URL。任何一步失败都停在原页。
 */
export async function requestSafeUpdate(): Promise<UpdateState> {
  if (reloading || state.checking) return state;
  const page = getPageRelease();
  if (!page) return state;
  // 保留 draftText/errorKind：上一次快照失败后点击重试不应丢掉复制草稿入口。
  publish({ checking: true, message: '' });

  const target = await fetchWebVersion();
  if (!target) {
    return errorState('version', '无法确认服务器版本，当前页面保持不动；请检查网络后重试。');
  }
  if (target.buildId === page.buildId) {
    return publish({
      phase: 'idle',
      page,
      target: null,
      checking: false,
      message: '当前已是最新版本。',
      busy: [],
      errorKind: null,
      contractIncompatible: false,
      noticeDismissed: false,
    });
  }

  const busy = getUpdateBusyReasons();
  const relation = versionRelation(page, target);
  const contractIncompatible = contractIncompatibleAfter(
    state.contractIncompatible,
    relation,
  );
  if (busy.length > 0) {
    return publish({
      phase: relation === 'incompatible' ? 'incompatible' : 'available',
      page,
      target,
      checking: false,
      busy,
      message: `现在不能更新，请先完成或取消：${busy.map((item) => item.label).join('；')}。`,
      draftText: '',
      errorKind: null,
      contractIncompatible,
    });
  }

  const source = draftProvider?.() ?? null;
  const storage = defaultSnapshotStorage();
  const tabId = getUpdateTabId(storage);
  if (!storage || !tabId) {
    return errorState(
      'storage',
      '浏览器无法保存更新状态，当前页面保持不动。请允许本站使用会话存储后重试。',
      source?.text ?? '',
    );
  }

  if (source && source.text.length > 0) {
    const written = writeUpdateSnapshot({
      storage,
      tabId,
      source,
      sourceBuildId: page.buildId,
      targetBuildId: target.buildId,
    });
    if (!written) {
      return errorState(
        'snapshot',
        '草稿快照写入失败。请先复制草稿，再手动刷新；当前页面保持不动。',
        source.text,
      );
    }
  }

  const claim = claimUpdateReload({
    storage,
    tabId,
    targetBuildId: target.buildId,
  });
  if (claim === 'already') {
    return errorState(
      'reloaded',
      '已经尝试过一次更新，但页面仍未切换到新版本。请检查网络后手动刷新；不会再自动重载。',
    );
  }
  if (claim === 'unavailable') {
    return errorState(
      'storage',
      '浏览器无法记录更新状态，当前页面保持不动。请手动刷新或稍后重试。',
      source?.text ?? '',
    );
  }

  reloading = true;
  publish({
    phase: 'reloading',
    page,
    target,
    busy: [],
    checking: false,
    message: '正在更新并恢复草稿…',
    draftText: '',
    errorKind: null,
  });
  if (typeof window !== 'undefined') window.location.reload();
  reloading = false;
  return state;
}

/** 用户主动手动刷新；不消耗程序性重载配额，也不自动触发。 */
export function manualReload(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

let monitorUsers = 0;
let monitorDetach: (() => void) | null = null;

function startMonitoring(): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  let idle: number | ReturnType<typeof setTimeout> | null = null;

  const run = (trigger: VersionCheckTrigger, force = false): void => {
    void checkForUpdate({ trigger, force });
  };
  const startInterval = (): void => {
    if (interval !== null) return;
    interval = setInterval(() => {
      if (visible()) run('interval');
    }, LIMITS.webVersionForegroundIntervalMs);
  };
  const stopInterval = (): void => {
    if (interval === null) return;
    clearInterval(interval);
    interval = null;
  };
  const onVisibility = (): void => {
    if (!visible()) {
      stopInterval();
      return;
    }
    startInterval();
    run('foreground');
  };
  const onPageShow = (): void => {
    if (visible()) run('foreground');
  };
  const onOnline = (): void => {
    if (visible()) run('foreground');
  };
  // 集成探针强制检查一次；不参与业务，也不自动刷新。
  const onProbe = (): void => {
    if (visible()) run('forced', true);
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  window.addEventListener('webots:check-update', onProbe);
  if (visible()) {
    startInterval();
    const requestIdle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (requestIdle) {
      idle = requestIdle(() => run('startup'), { timeout: 2_000 });
    } else {
      idle = globalThis.setTimeout(() => run('startup'), 0);
    }
  }

  return () => {
    if (idle !== null) {
      const cancelIdle = (
        window as unknown as { cancelIdleCallback?: (id: number) => void }
      ).cancelIdleCallback;
      if (cancelIdle) cancelIdle(idle as number);
      else globalThis.clearTimeout(idle);
      idle = null;
    }
    stopInterval();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('webots:check-update', onProbe);
  };
}

/** 首屏可交互后启动；无 `#web-release` 的开发/兼容模式直接跳过。 */
export function startVersionMonitor(): () => void {
  if (typeof window === 'undefined' || !getPageRelease()) return () => undefined;
  monitorUsers += 1;
  if (monitorUsers === 1) monitorDetach = startMonitoring();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    monitorUsers -= 1;
    if (monitorUsers === 0 && monitorDetach) {
      monitorDetach();
      monitorDetach = null;
    }
  };
}
