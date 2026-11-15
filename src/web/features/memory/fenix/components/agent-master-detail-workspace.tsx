/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/ui-components/web/components/agent-master-detail-workspace.tsx
 * Modified for Agent Network: 用原生 overflow-auto 容器替代上游 `ScrollArea`，
 * 保留 index / detailHeader / detailFooter / children 的插槽与两列布局；不引入滚动条组件。
 */

import type { ReactNode } from 'react';

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
      className={`grid min-h-120 min-w-0 overflow-hidden rounded-lg bg-background max-md:grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)] ${className ?? ''}`}
    >
      <div className="min-h-0 overflow-y-auto border-b bg-muted/20 md:border-r md:border-b-0">{index}</div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {detailHeader ? <div className="shrink-0 bg-background">{detailHeader}</div> : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
        {detailFooter ? <div className="shrink-0 bg-background">{detailFooter}</div> : null}
      </div>
    </section>
  );
}

export function AgentMasterDetailHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <header className={`bg-background ${className ?? ''}`}>{children}</header>;
}
