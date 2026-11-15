/**
 * Local placeholder for FenixAgent `Graph2d.tsx`.
 *
 * Upstream Graph2d renders with Cytoscape.js + cytoscape-fcose. This vendor phase
 * deliberately does not add those heavy runtime dependencies, so the "graph" view
 * keeps the upstream entry point and layout contract but renders an explicit
 * "not enabled" state instead of silently falling back to a different renderer.
 *
 * Not ported from upstream: Cytoscape renderer, use-cytoscape-graph, graph2d-model,
 * graph2d-styles.
 */

import { EmptyState } from '../ui/empty-state';
import type { GraphLink, GraphData, GraphNode } from './graph-model';
import { useTranslation } from '../i18n';

export interface Graph2DProps {
  data: GraphData;
  height?: number;
  showLabels?: boolean;
  onNodeClick?: (node: GraphNode) => void;
  maxNodes?: number;
  nodeColorFn?: (node: GraphNode) => string;
  linkColorFn?: (link: GraphLink) => string;
}

export function Graph2D({ height = 400 }: Graph2DProps) {
  const { t } = useTranslation();
  return (
    <div className="grid h-full min-h-0 place-items-center" style={{ height }}>
      <EmptyState
        title={t('graph2d.optionalTitle')}
        description={t('graph2d.optionalHint')}
        className="px-6"
      />
    </div>
  );
}
