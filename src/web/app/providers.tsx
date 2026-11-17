import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeScope } from './lenso-controls';
import type { ReactNode } from 'react';

import { queryClient } from './query';

/** 应用级 provider：React Query 与 Lenso 主题；UI store 是模块级 zustand。 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeScope className="lenso-root" style={{ display: 'contents' }}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeScope>
  );
}
