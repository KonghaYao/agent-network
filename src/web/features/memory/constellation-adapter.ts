/**
 * 把 `network_agent_memory_graph` 的扁平 nodes/edges 转成星座图场景输入。
 *
 * 只使用图谱工具实际返回的字段：id/label/text/fact_type/date/entities 与
 * edge 的 type/weight。没有 context/occurred/proof/tags 就不伪造；
 * tooltip 只展示类型、日期、实体与连接数，点击后仍走现有 `get` 详情。
 * 所有进入 DOM/canvas 的文本先过 `maskSecrets`。
 */

import { maskSecrets } from './mask';
import type { MemoryFactType, MemoryGraphEdge, MemoryGraphNode } from './memory-data';
import { FACT_TYPE_LABEL } from './memory-data';
import {
  LINK_TYPE_COLORS,
  type ConstellationGraphData,
  type ConstellationLink,
  type ConstellationNode,
} from './constellation-scene';

const FALLBACK_LINK_COLORS = [
  '#2563eb',
  '#0d9488',
  '#b45309',
  '#9333ea',
  '#dc2626',
  '#64748b',
  '#ca8a04',
] as const;

export function linkColorForType(type: string, order: readonly string[]): string {
  const named = LINK_TYPE_COLORS[type];
  if (named) return named;
  const index = order.indexOf(type);
  return FALLBACK_LINK_COLORS[Math.max(0, index) % FALLBACK_LINK_COLORS.length] ?? '#64748b';
}

function nodeLabel(node: MemoryGraphNode): string {
  // 卡片标签最多 5 行；限制输入长度，避免超长正文在每帧折行时拖慢绘制。
  return maskSecrets(node.label || node.text || '未命名记忆').slice(0, 240);
}

function nodeTypeLabel(type: MemoryFactType | undefined): string {
  return type ? FACT_TYPE_LABEL[type] : '未分类';
}

function nodeEntities(node: MemoryGraphNode): string[] {
  if (!node.entities?.length) return [];
  return [...new Set(node.entities.map((entity) => maskSecrets(entity)).filter(Boolean))];
}

export interface AdaptMemoryGraphOptions {
  /** 当前数据里出现过的边类型，按首次出现排序；用于稳定分配兜底颜色。 */
  edgeTypeOrder: readonly string[];
}

export function adaptMemoryGraph(
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
  options: AdaptMemoryGraphOptions,
): ConstellationGraphData {
  const adaptedNodes: ConstellationNode[] = nodes.map((node) => ({
    id: node.id,
    label: nodeLabel(node),
    typeLabel: nodeTypeLabel(node.fact_type),
    date: node.date ? maskSecrets(node.date) : null,
    entities: nodeEntities(node),
  }));

  const adaptedLinks: ConstellationLink[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    color: linkColorForType(edge.type, options.edgeTypeOrder),
    weight: edge.weight,
  }));

  return { nodes: adaptedNodes, links: adaptedLinks };
}
