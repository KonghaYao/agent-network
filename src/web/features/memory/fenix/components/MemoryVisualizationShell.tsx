/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/components/MemoryVisualizationShell.tsx
 * Modified for Agent Network: 平台导入替换；自适应高度与侧栏宽度不变。
 */

import { Tooltip } from '../../../../app/lenso-tooltip';
import { Button } from "../ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useElementHeight } from "../element-height";

interface MemoryVisualizationShellProps {
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  toggleLabel: string;
  sidebar: ReactNode;
  children: (height: number) => ReactNode;
}

/** 为记忆图谱视图提供统一、自适应且无外溢的可视化容器。 */
export function MemoryVisualizationShell({
  panelOpen,
  onPanelOpenChange,
  toggleLabel,
  sidebar,
  children,
}: MemoryVisualizationShellProps) {
  const graphicRef = useRef<HTMLDivElement>(null);
  const height = useElementHeight(graphicRef);

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <div ref={graphicRef} className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        {children(height)}
      </div>
      <Tooltip as={Button}
        variant="ghost"
        size="icon-xs"
        onClick={() => onPanelOpenChange(!panelOpen)}
        hint={toggleLabel}
        aria-label={toggleLabel}
        className="hidden h-full w-5 shrink-0 rounded-none border-l md:inline-flex"
      >
        {panelOpen ? <ChevronRight className="size-3" /> : <ChevronLeft className="size-3" />}
      </Tooltip>
      <div
        className={`${panelOpen ? "md:w-80 md:border-l" : "md:w-0"} h-full min-h-0 w-0 shrink-0 overflow-hidden bg-card transition-[width] duration-300`}
      >
        <div className="h-full w-80 overflow-y-auto">{sidebar}</div>
      </div>
    </div>
  );
}
