import { Surface } from '../../app/lenso-controls';
import type { ReactNode } from 'react';

/** Lenso Surface 会覆盖根 className，列表布局与本地 class 由原生 wrapper 承载。 */
export function MemoryList({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="memory-list">
      <Surface
        id={id}
        role="list"
        style={{ display: 'flex', flexDirection: 'column', gap: 0, margin: 0 }}
      >
        {children}
      </Surface>
    </div>
  );
}
