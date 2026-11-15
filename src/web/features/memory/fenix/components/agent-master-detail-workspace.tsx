/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/ui-components/web/components/agent-master-detail-workspace.tsx
 * Modified for Agent Network: 用原生 overflow-auto 容器替代上游 `ScrollArea`，
 * 保留 index / detailHeader / detailFooter / children 的插槽与两列布局；不引入滚动条组件。
 * 高度不再由组件写死 `calc(100dvh - 210px)`：弹窗内容区通过 flex 高度链提供约束，
 * 短视口由 `min-h-0` 让内容自己滚动。`data-slot` 与 surface/shadow/238px 列宽对齐上游。
 */

import type { ReactNode } from 'react';
import './agent-master-detail-workspace.css';

export interface AgentMasterDetailWorkspaceProps {
  index: ReactNode;
  detailHeader?: ReactNode;
  detailFooter?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AgentMasterDetailWorkspace({
  index,
  detailHeader,
  detailFooter,
  children,
  className,
}: AgentMasterDetailWorkspaceProps) {
  return (
    <section
      data-slot="agent-master-detail-workspace"
      className={`agent-master-detail-workspace grid min-h-0 min-w-0 overflow-hidden rounded-lg bg-surface-1 max-md:grid-cols-1 ${className ?? ''}`}
    >
      <div
        data-slot="agent-master-detail-index"
        className="min-h-0 overflow-y-auto bg-surface-0 shadow-[inset_-1px_0_var(--color-border)]"
      >
        {index}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {detailHeader ? <div className="shrink-0 bg-surface-1">{detailHeader}</div> : null}
        <div data-slot="agent-master-detail-detail" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {children}
        </div>
        {detailFooter ? <div className="shrink-0 bg-surface-1">{detailFooter}</div> : null}
      </div>
    </section>
  );
}

export function AgentMasterDetailHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <header className={`bg-surface-1 ${className ?? ''}`}>{children}</header>;
}
