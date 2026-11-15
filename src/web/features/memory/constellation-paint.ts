/**
 * 星座图绘制主体：背景 → 连线 → 节点（带标签去冲突栅格）。
 *
 * 移植自 FenixAgent `constellation-paint.ts`（Apache-2.0，commit 72a1e47）。
 * 修改：由持续 RAF 改为组件按需调用；增加选中节点描边；统计值返回给组件
 * 写入 DOM data 属性与 HUD；仍保留 hover 时只画邻边、邻居高亮、其余淡化，
 * 热度色、节点半径、光晕与二次曲线参数与原版一致。标签改为节点绘制完成后
 * 按度数优先放置：48px 栅格 + 实测文本宽度，避让高度数节点，最多 24 个。
 */

import { drawConstellationLabel } from './constellation-labels';
import { FONT_INLINE, nodeRadius, type ConstellationScene } from './constellation-scene';
import type { ConstellationViewState } from './constellation-state';

const MARGIN = 60;
const LABEL_GRID_CELL = 48;
const INLINE_LABEL_HEIGHT = 14;
const INLINE_LABEL_MAX_CHARS = 45;
/** 度数达到该值的节点视为关键节点，行内标签主动避让。 */
const KEY_NODE_DEGREE = 8;
/** 100% 下最多画 24 个行内标签；先按度数挑最重要的节点，避免满屏文字。 */
const MAX_INLINE_LABELS = 24;

export interface ConstellationPaintInput {
  state: ConstellationViewState;
  scene: ConstellationScene;
  isDark: boolean;
  hoverId: string | null;
  selectedId: string | null;
}

export interface ConstellationNodePoint {
  id: string;
  /** 相对 canvas 左上角的 CSS 像素坐标。 */
  x: number;
  y: number;
  radius: number;
}

export interface ConstellationPaintStats {
  visible: number;
  labels: number;
  links: number;
  labelMode: 'inline' | 'card';
  points: ConstellationNodePoint[];
}

export function paintConstellationFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  input: ConstellationPaintInput,
): ConstellationPaintStats {
  const { state, scene, isDark, hoverId, selectedId } = input;
  const { preparedNodes, linksByNode, linksWithIndices, indexById } = scene;
  const { W, H, dpr, zoom, panX, panY, fitScale } = state;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = isDark ? '#09090b' : '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const centerX = W / 2 + panX;
  const centerY = H / 2 + panY;
  const scale = fitScale * zoom;
  const hoverIndex = hoverId ? (indexById.get(hoverId) ?? -1) : -1;
  const selectedIndex = selectedId ? (indexById.get(selectedId) ?? -1) : -1;

  const screenX = new Float32Array(preparedNodes.length);
  const screenY = new Float32Array(preparedNodes.length);
  const visible = new Uint8Array(preparedNodes.length);
  const points: ConstellationNodePoint[] = [];

  for (let index = 0; index < preparedNodes.length; index += 1) {
    const node = preparedNodes[index]!;
    const x = centerX + node.wx * scale;
    const y = centerY + node.wy * scale;
    screenX[index] = x;
    screenY[index] = y;
    visible[index] = x > -MARGIN && x < W + MARGIN && y > -MARGIN && y < H + MARGIN ? 1 : 0;
    points.push({
      id: node.node.id,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      radius: Number(nodeRadius(node.linkCount, zoom).toFixed(2)),
    });
  }

  const hoveredLinks = new Set<number>();
  if (hoverIndex >= 0) {
    for (const linkIndex of linksByNode.get(hoverIndex) ?? []) hoveredLinks.add(linkIndex);
  }

  // --- Links ---
  let linksDrawn = 0;
  if (hoverIndex >= 0) {
    // Hover: only the hovered node's links.
    for (const linkIndex of hoveredLinks) {
      const link = linksWithIndices[linkIndex]!;
      const ax = screenX[link.a]!;
      const ay = screenY[link.a]!;
      const bx = screenX[link.b]!;
      const by = screenY[link.b]!;
      if (!segmentVisible(ax, ay, bx, by, W, H)) continue;

      ctx.strokeStyle = link.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      drawCurve(ctx, ax, ay, bx, by);
      linksDrawn += 1;
    }
    ctx.globalAlpha = 1;
  } else {
    for (const link of linksWithIndices) {
      const ax = screenX[link.a]!;
      const ay = screenY[link.a]!;
      const bx = screenX[link.b]!;
      const by = screenY[link.b]!;
      if (!segmentVisible(ax, ay, bx, by, W, H)) continue;

      const selected = selectedIndex >= 0 && (link.a === selectedIndex || link.b === selectedIndex);
      ctx.strokeStyle = link.color;
      ctx.globalAlpha = selected ? 0.85 : 0.5;
      ctx.lineWidth = selected ? 1.2 : 0.4;
      drawCurve(ctx, ax, ay, bx, by);
      linksDrawn += 1;
    }
    ctx.globalAlpha = 1;
  }

  // --- Nodes ---
  const labelGrid = new Set<string>();
  const canPlace = (x: number, y: number, width: number, height: number): boolean => {
    const c0 = Math.floor(x / LABEL_GRID_CELL);
    const c1 = Math.floor((x + width) / LABEL_GRID_CELL);
    const r0 = Math.floor(y / LABEL_GRID_CELL);
    const r1 = Math.floor((y + height) / LABEL_GRID_CELL);
    for (let c = c0; c <= c1; c += 1) {
      for (let r = r0; r <= r1; r += 1) {
        if (labelGrid.has(`${c},${r}`)) return false;
      }
    }
    return true;
  };
  const claim = (x: number, y: number, width: number, height: number): void => {
    const c0 = Math.floor(x / LABEL_GRID_CELL);
    const c1 = Math.floor((x + width) / LABEL_GRID_CELL);
    const r0 = Math.floor(y / LABEL_GRID_CELL);
    const r1 = Math.floor((y + height) / LABEL_GRID_CELL);
    for (let c = c0; c <= c1; c += 1) {
      for (let r = r0; r <= r1; r += 1) labelGrid.add(`${c},${r}`);
    }
  };
  /** 行内标签不要压住高度数节点；宁可少画，也不遮挡星图骨架。 */
  const overlapsNode = (x: number, y: number, width: number, height: number): boolean => {
    for (let index = 0; index < preparedNodes.length; index += 1) {
      if (!visible[index] || preparedNodes[index]!.linkCount < KEY_NODE_DEGREE) continue;
      const radius = nodeRadius(preparedNodes[index]!.linkCount, zoom) + 1.5;
      const nx = screenX[index]!;
      const ny = screenY[index]!;
      if (nx + radius < x || nx - radius > x + width) continue;
      if (ny + radius < y || ny - radius > y + height) continue;
      return true;
    }
    return false;
  };

  let visibleCount = 0;
  let labelsShown = 0;
  let drewCard = false;

  interface LabelCandidate {
    index: number;
    sx: number;
    sy: number;
    radius: number;
    isHovered: boolean;
    isNeighbor: boolean;
    linkCount: number;
  }
  const labelCandidates: LabelCandidate[] = [];

  // Hovered node last, on top.
  const order: number[] = [];
  for (let index = 0; index < preparedNodes.length; index += 1) {
    if (!visible[index] || index === hoverIndex) continue;
    order.push(index);
  }
  if (hoverIndex >= 0 && visible[hoverIndex]) order.push(hoverIndex);

  for (const index of order) {
    const node = preparedNodes[index]!;
    const sx = screenX[index]!;
    const sy = screenY[index]!;
    visibleCount += 1;

    const isHovered = index === hoverIndex;
    const isNeighbor =
      hoveredLinks.size > 0 &&
      (linksByNode.get(index) ?? []).some((linkIndex) => hoveredLinks.has(linkIndex));
    const radius = nodeRadius(node.linkCount, zoom);
    const baseAlpha = 0.45 + Math.min(node.linkCount * 0.03, 0.5);

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.fillStyle = node.heatColor;
    ctx.globalAlpha = isHovered ? 1 : isNeighbor ? 0.95 : hoverIndex >= 0 ? 0.08 : baseAlpha;

    if (isHovered || isNeighbor) {
      ctx.shadowColor = node.heatColor;
      ctx.shadowBlur = isHovered ? 20 : 10;
    }
    ctx.fill();

    // Soft glow halo for brighter stars (high link count).
    if (node.linkCount > 3 && !isHovered && hoverIndex < 0) {
      ctx.beginPath();
      ctx.arc(sx, sy, radius * 2, 0, Math.PI * 2);
      ctx.fillStyle = node.heatColor;
      ctx.globalAlpha = 0.06 + Math.min(node.linkCount * 0.005, 0.08);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (index === selectedIndex) {
      ctx.beginPath();
      ctx.arc(sx, sy, radius + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = isDark ? '#f4f4f5' : '#18181b';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    if (isHovered || isNeighbor || hoverIndex < 0) {
      labelCandidates.push({
        index,
        sx,
        sy,
        radius,
        isHovered,
        isNeighbor,
        linkCount: node.linkCount,
      });
    }
  }

  // Labels are placed after nodes: degree-first order keeps hubs labelled when
  // the grid is busy, and drawing last keeps text above faint nodes and links.
  labelCandidates.sort((left, right) => {
    if (left.isHovered !== right.isHovered) return left.isHovered ? -1 : 1;
    return right.linkCount - left.linkCount;
  });

  let inlineLabels = 0;
  for (const candidate of labelCandidates) {
    const node = preparedNodes[candidate.index]!;
    const { sx, sy, radius, isHovered, isNeighbor } = candidate;

    if (isHovered) {
      drawConstellationLabel(ctx, node, sx, sy, radius, true, true, isDark, zoom);
      labelsShown += 1;
      drewCard = true;
    } else if (zoom > 1.5) {
      const cardW = Math.min(200, 80 + zoom * 25);
      const cardH = 50;
      const cardX = sx - cardW / 2;
      const cardY = sy + radius + 4;
      if (canPlace(cardX, cardY, cardW, cardH)) {
        claim(cardX, cardY, cardW, cardH);
        drawConstellationLabel(ctx, node, sx, sy, radius, false, isNeighbor, isDark, zoom);
        labelsShown += 1;
        drewCard = true;
      }
    } else if ((zoom > 0.5 || isNeighbor) && inlineLabels < MAX_INLINE_LABELS) {
      const text = node.node.label;
      const label = text.length > INLINE_LABEL_MAX_CHARS
        ? `${text.slice(0, INLINE_LABEL_MAX_CHARS)}…`
        : text;
      ctx.font = FONT_INLINE;
      const labelWidth = Math.min(155, Math.ceil(ctx.measureText(label).width) + 8);
      const labelX = sx + radius + 5;
      const labelY = sy - 8;
      if (canPlace(labelX, labelY, labelWidth, INLINE_LABEL_HEIGHT)) {
        if (overlapsNode(labelX, labelY, labelWidth, INLINE_LABEL_HEIGHT)) continue;
        claim(labelX, labelY, labelWidth, INLINE_LABEL_HEIGHT);
        drawConstellationLabel(ctx, node, sx, sy, radius, false, isNeighbor, isDark, zoom);
        labelsShown += 1;
        inlineLabels += 1;
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  return {
    visible: visibleCount,
    labels: labelsShown,
    links: linksDrawn,
    labelMode: drewCard ? 'card' : 'inline',
    points,
  };
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  const midX = (ax + bx) / 2 + (by - ay) * 0.08;
  const midY = (ay + by) / 2 - (bx - ax) * 0.08;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(midX, midY, bx, by);
  ctx.stroke();
}

function segmentVisible(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
  height: number,
): boolean {
  if (ax < -MARGIN && bx < -MARGIN) return false;
  if (ax > width + MARGIN && bx > width + MARGIN) return false;
  if (ay < -MARGIN && by < -MARGIN) return false;
  if (ay > height + MARGIN && by > height + MARGIN) return false;
  return true;
}
