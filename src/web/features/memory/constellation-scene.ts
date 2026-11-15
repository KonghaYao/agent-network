/**
 * 星座图纯模型：星空布局、热度色带、连线索引与绘制常量。
 *
 * 移植自 FenixAgent（Apache-2.0）：
 * https://github.com/HuangPuStar/FenixAgent
 * commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * packages/resources/memory/web/pages/hindsight/components/constellation-scene.ts
 *
 * 修改：移除 `@chenglou/pretext` 依赖，标签排版改由 canvas `measureText` 完成；
 * 单节点固定居中；额外输出 `fitRadius` 供画布计算适配缩放；节点/连线输入换成
 * Agent Network 的只读图谱形状。位置、热度归一化与色带数值保持原样。
 */

export interface ConstellationNode {
  id: string;
  /** 已经过 `maskSecrets` 的标签。 */
  label: string;
  typeLabel: string;
  date: string | null;
  /** 已经过 `maskSecrets` 的实体名。 */
  entities: string[];
}

export interface ConstellationLink {
  id: string;
  source: string;
  target: string;
  type: string;
  color: string;
  weight: number;
}

export interface ConstellationGraphData {
  nodes: ConstellationNode[];
  links: ConstellationLink[];
}

export interface PreparedNode {
  node: ConstellationNode;
  /** 世界坐标，尚未叠加平移/缩放。 */
  wx: number;
  wy: number;
  heatColor: string;
  linkCount: number;
}

/** 连线按节点下标存的两份索引：`a`/`b` 是世界坐标下的两个端点。 */
export interface ConstellationIndexedLink {
  a: number;
  b: number;
  color: string;
  type: string;
}

export interface ConstellationScene {
  preparedNodes: PreparedNode[];
  /** 每个节点参与的连线下标（悬停时只画它自己的连线）。 */
  linksByNode: Map<number, number[]>;
  linksWithIndices: ConstellationIndexedLink[];
  indexById: Map<string, number>;
  maxLinkCount: number;
  /** 世界坐标下离原点最远的节点距离，用于按画布尺寸适配缩放。 */
  fitRadius: number;
}

export const FONT_SMALL = '11px Inter, -apple-system, "Segoe UI", sans-serif';

/** 蓝 → 紫 → 橙红；与 Fenix 公开版的色带一致。 */
export const HEAT_STOPS = [
  [56, 130, 220],
  [170, 130, 200],
  [240, 100, 60],
] as const;

export const HEAT_GRADIENT =
  'linear-gradient(90deg, rgb(56, 130, 220), rgb(170, 130, 200), rgb(240, 100, 60))';

export const LINK_TYPE_COLORS: Record<string, string> = {
  semantic: '#0074d9',
  temporal: '#009296',
  entity: '#f59e0b',
  causal: '#8b5cf6',
  caused_by: '#8b5cf6',
  contradicts: '#dc2626',
};

/**
 * 0..1 映射到蓝 → 紫 → 橙红。中段经过低饱和 lavender，亮度大致单调，
 * 读者不查图例也能读出热度位置。
 */
export function heatColor(t: number): string {
  const v = Math.max(0, Math.min(1, t));
  const stops = HEAT_STOPS;
  const seg = v * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const frac = seg - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

function hashStr(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/**
 * 准备场景：按 id 哈希确定性地散布在环上（刷新不跳位），
 * 热度默认取归一化后的连边数（平方根压一下，避免一片全红）。
 */
export function prepareConstellationScene(data: ConstellationGraphData): ConstellationScene {
  const empty: ConstellationScene = {
    preparedNodes: [],
    linksByNode: new Map(),
    linksWithIndices: [],
    indexById: new Map(),
    maxLinkCount: 1,
    fitRadius: 0,
  };
  if (!data.nodes.length) return empty;

  const indexById = new Map<string, number>();
  data.nodes.forEach((node, index) => indexById.set(node.id, index));

  const linkCounts = new Map<string, number>();
  for (const link of data.links) {
    linkCounts.set(link.source, (linkCounts.get(link.source) ?? 0) + 1);
    linkCounts.set(link.target, (linkCounts.get(link.target) ?? 0) + 1);
  }

  let maxLinkCount = 1;
  for (const count of linkCounts.values()) {
    if (count > maxLinkCount) maxLinkCount = count;
  }

  const count = data.nodes.length;
  const preparedNodes: PreparedNode[] = data.nodes.map((node, index) => {
    const linkCount = linkCounts.get(node.id) ?? 0;
    const heat = heatColor(Math.sqrt(linkCount / maxLinkCount));

    let wx = 0;
    let wy = 0;
    if (count > 1) {
      const seed = hashStr(node.id);
      const angle = (index / count) * Math.PI * 2 + ((seed % 100) / 100) * 0.5;
      const baseRadius = Math.sqrt(count) * 30;
      const radius = baseRadius * 0.3 + ((Math.abs(seed) % 1000) / 1000) * baseRadius * 0.7;
      wx = Math.cos(angle) * radius + ((seed % 200) - 100) * 0.5;
      wy = Math.sin(angle) * radius + (((seed >> 8) % 200) - 100) * 0.5;
    }

    return {
      node,
      wx,
      wy,
      heatColor: heat,
      linkCount,
    };
  });

  // 环上散布在少数节点时可能整体偏向一侧；平移到包围盒中心，
  // 保持「按 id 哈希、刷新稳定」的同时让适配视图居中。
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of preparedNodes) {
    minX = Math.min(minX, node.wx);
    maxX = Math.max(maxX, node.wx);
    minY = Math.min(minY, node.wy);
    maxY = Math.max(maxY, node.wy);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  let fitRadius = 0;
  for (const node of preparedNodes) {
    node.wx -= centerX;
    node.wy -= centerY;
    fitRadius = Math.max(fitRadius, Math.hypot(node.wx, node.wy));
  }

  const linksWithIndices: ConstellationIndexedLink[] = [];
  const linksByNode = new Map<number, number[]>();
  for (const link of data.links) {
    const a = indexById.get(link.source);
    const b = indexById.get(link.target);
    if (a === undefined || b === undefined) continue;
    const index = linksWithIndices.length;
    linksWithIndices.push({ a, b, color: link.color, type: link.type });
    for (const nodeIndex of [a, b]) {
      const list = linksByNode.get(nodeIndex);
      if (list) list.push(index);
      else linksByNode.set(nodeIndex, [index]);
    }
  }

  return {
    preparedNodes,
    linksByNode,
    linksWithIndices,
    indexById,
    maxLinkCount,
    fitRadius,
  };
}

/** 按画布短边把最远节点放进视野；`zoom = 1` 表示适配尺寸。 */
export function fitScaleFor(scene: ConstellationScene, width: number, height: number): number {
  if (width <= 0 || height <= 0 || scene.fitRadius <= 0) return 1;
  return Math.min(width, height) / (scene.fitRadius * 2.5);
}

/** 节点半径随度数增长，但压在上限内；与 Fenix 的星等口径一致。 */
export function nodeRadius(linkCount: number, zoom: number): number {
  const base = 2.5 + Math.min(linkCount * 0.15, 2.5);
  return Math.max(1.5, base * Math.min(zoom, 2));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
