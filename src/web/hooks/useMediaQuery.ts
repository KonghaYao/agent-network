import { useCallback, useSyncExternalStore } from 'react';

/**
 * 与 CSS 断点共用的媒体查询订阅。
 *
 * `matchMedia` 是浏览器状态而不是 React 状态：用 `useSyncExternalStore`
 * 保证首帧、SSR 占位与 resize 后都读到同一个值，避免布局先渲染再跳变。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined') return () => {};
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  }, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
