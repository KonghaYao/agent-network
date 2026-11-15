/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/ui-components/web/lib/clipboard.ts
 * Modified for Agent Network: 原样移植；不依赖宿主 polyfill，API 缺失或被拒时返回 false。
 */

export async function copyTextToClipboard(value: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export async function copyDialogTextToClipboard(value: string, element: HTMLElement | null): Promise<boolean> {
  if (globalThis.window?.isSecureContext && (await copyTextToClipboard(value))) return true;
  if (!element || typeof document === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
  }
}
