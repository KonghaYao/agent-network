/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/ui-components/web/lib/theme.tsx
 * Modified for Agent Network: 上游该版本强制亮色；本仓库记忆面板沿用既有
 * `prefers-color-scheme` 暗色规则，因此 `useTheme()` 改为监听系统偏好并返回实际
 * `resolvedTheme`，不写 localStorage、不向 documentElement 写 `dark` 类。
 */

import { useEffect, useState } from 'react';

export type ResolvedTheme = 'light' | 'dark';

function readTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): { theme: ResolvedTheme; resolvedTheme: ResolvedTheme } {
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(readTheme);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolvedTheme(media.matches ? 'dark' : 'light');
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return { theme: resolvedTheme, resolvedTheme };
}
