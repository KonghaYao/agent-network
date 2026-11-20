/**
 * 文件预览可能创建的 object URL 登记表。
 *
 * 当前预览使用服务端受限 URL，不生成 blob URL；这里保留统一释放入口，
 * 供后续需要 Blob 的预览实现和撤权清理共用，避免私有内容在内存中残留。
 */

const tracked = new Set<string>();

export function trackObjectUrl(url: string): string {
  if (url.startsWith('blob:')) tracked.add(url);
  return url;
}

export function trackedObjectUrls(): string[] {
  return [...tracked];
}

/** 撤销登记过的 object URL，并清掉 DOM 里可能残留的 blob 引用。 */
export function releasePreviewObjectUrls(): string[] {
  const released = new Set<string>();
  for (const url of tracked) {
    try {
      URL.revokeObjectURL(url);
      released.add(url);
    } catch {
      // 已撤销或不可用的 URL 不阻塞其余清理。
    }
  }
  tracked.clear();
  if (typeof document !== 'undefined') {
    for (const node of document.querySelectorAll<HTMLElement>('img[src^="blob:"], iframe[src^="blob:"], a[href^="blob:"]')) {
      const value = node.getAttribute('src') ?? node.getAttribute('href');
      if (!value) continue;
      try {
        URL.revokeObjectURL(value);
        released.add(value);
      } catch {
        // 同上。
      }
      node.removeAttribute('src');
      node.removeAttribute('href');
    }
  }
  return [...released];
}

export function resetPreviewObjectUrlsForTests(): void {
  tracked.clear();
}
