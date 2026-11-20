/**
 * 浏览器安装能力与移动引导判定。
 *
 * 设备识别只决定首屏引导，不参与任何权限判断；平板桌面模式仍可通过
 * “连接已有账号”显式进入配对。`beforeinstallprompt` 只在用户点击后
 * 调用，不自动弹系统安装框。
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISSED_KEY = 'webots-install-dismissed:v1';

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 在应用入口调用一次；重复调用是幂等的。 */
export function initInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    emit();
  });
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/** 系统安装框只允许消费一次；避免重复点击继续使用已失效事件。 */
export function consumeInstallPrompt(): void {
  if (!deferredPrompt) return;
  deferredPrompt = null;
  emit();
}

export function isAppInstalled(): boolean {
  return installed;
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/iu.test(ua)) return true;
  return (
    navigator.platform === 'MacIntel' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  );
}

/** 独立窗口由显示模式或 iOS 专有标记判定；每次现查，不写“已安装”状态。 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  } catch {
    // matchMedia 不可用时退回 iOS 标记。
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * 移动设备启发式：移动 UA，或触控粗指针。只用于展示引导；桌面窗口仍
 * 保留原有自动访客与身份流程。
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/iu.test(ua)) return true;
  // iPadOS 桌面模式伪装成 Macintosh；触控点用于区分 Mac 笔记本。
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  try {
    return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

export function isInstallGuideDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInstallGuide(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // 存储不可用时只在本次内存状态收起。
  }
}

/** 手动入口重新打开时不清除已关闭偏好；关闭仍会写回同一键。 */
export function resetInstallGuideDismissal(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // 忽略。
  }
}
