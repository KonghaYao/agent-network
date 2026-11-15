/**
 * 星座图标签：单个节点的「卡片」与「行内」两种画法。
 *
 * 移植自 FenixAgent `constellation-labels.ts`（Apache-2.0，commit 72a1e47）。
 * 修改：去掉 `@chenglou/pretext`，折行改用 canvas `measureText` 逐字符贪心；
 * 字号、卡片宽度、配色与去冲突口径保持不变。
 */

import { FONT_SMALL, type PreparedNode } from './constellation-scene';

/** 按字符宽度折行；中英文都可用，过长单词按字符断开。 */
export function wrapConstellationLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of Array.from(text)) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char === ' ' ? '' : char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawConstellationLabel(
  ctx: CanvasRenderingContext2D,
  node: PreparedNode,
  sx: number,
  sy: number,
  radius: number,
  isHovered: boolean,
  force: boolean,
  dark: boolean,
  zoom: number,
): void {
  const text = node.node.label;
  if (zoom > 1.5 || isHovered) {
    // Card mode
    const cardW = Math.min(220, 80 + zoom * 25);
    ctx.font = FONT_SMALL;
    const lines = wrapConstellationLabel(ctx, text, cardW - 16);
    const maxLines = isHovered
      ? Math.min(lines.length, 5)
      : Math.min(lines.length, Math.max(1, Math.floor(zoom)));
    const visibleLines = lines.slice(0, maxLines);
    const cardH = 8 + visibleLines.length * 15 + 8;
    if (visibleLines.length === 0) return;

    const cardX = sx - cardW / 2;
    const cardY = sy + radius + 4;

    ctx.fillStyle = isHovered
      ? dark
        ? '#1c1c1e'
        : '#f4f4f5'
      : dark
        ? 'rgba(9,9,11,0.92)'
        : 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 6);
    ctx.fill();

    ctx.strokeStyle = isHovered
      ? node.heatColor
      : dark
        ? 'rgba(63,63,70,0.5)'
        : 'rgba(212,212,216,0.6)';
    ctx.lineWidth = isHovered ? 1.5 : 0.5;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 6);
    ctx.stroke();

    if (isHovered) {
      ctx.shadowColor = node.heatColor;
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, 6);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.font = FONT_SMALL;
    ctx.fillStyle = isHovered ? (dark ? '#e4e4e7' : '#18181b') : '#71717a';
    ctx.textAlign = 'left';
    for (let index = 0; index < visibleLines.length; index += 1) {
      ctx.fillText(visibleLines[index]!, cardX + 8, cardY + 8 + index * 15 + 11);
    }
    return;
  }

  // Inline label
  ctx.font = FONT_SMALL;
  ctx.fillStyle = isHovered ? (dark ? '#e4e4e7' : '#18181b') : dark ? '#52525b' : '#a1a1aa';
  ctx.globalAlpha = isHovered ? 1 : force ? 0.85 : Math.min(1, (zoom - 0.3) * 2.5);
  ctx.textAlign = 'left';
  const label = text.length > 45 ? `${text.slice(0, 45)}…` : text;
  ctx.fillText(label, sx + radius + 5, sy + 4);
  ctx.globalAlpha = 1;
}
