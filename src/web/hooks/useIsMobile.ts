import { useCallback, useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 759px)';

/**
 * 移动端断点与 legacy CSS 完全一致（<760px）。
 *
 * SSR 不存在应用页，因此初始值直接读 `matchMedia`；水合页不存在该 hook。
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  const onChange = useCallback((event: MediaQueryListEvent) => {
    setMobile(event.matches);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    setMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [onChange]);

  return mobile;
}
