/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/components/constellation-labels.ts
 * Modified for Agent Network: 移除 @chenglou/pretext，卡片换行改用 canvas measureText 的贪心折行；
 * 标签文本经 maskSecrets 再绘制；两种画法与配色不变。
 */

import { maskSecrets } from '../../mask';
import { FONT_SMALL, type PreparedNode } from './constellation-scene';

const CARD_LINE_HEIGHT = 15;

function wrapLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of text) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawConstellationLabel(
  ctx: CanvasRenderingContext2D,
  n: PreparedNode,
  sx: number,
  sy: number,
  r: number,
  isHovered: boolean,
  force: boolean,
  dark: boolean,
  zoom: number,
): void {
  if (zoom > 1.5 || isHovered) {
    // Card mode
    const cardW = Math.min(220, 80 + zoom * 25);
    const textW = cardW - 16;
    ctx.font = FONT_SMALL;
    const raw = maskSecrets(n.node.label || n.node.id.substring(0, 12));
    const lines = wrapLabel(ctx, raw, textW);
    const maxLines = isHovered ? Math.min(lines.length, 5) : Math.min(lines.length, Math.floor(zoom));
    const cardH = 8 + maxLines * CARD_LINE_HEIGHT + 8;

    const cardX = sx - cardW / 2;
    const cardY = sy + r + 4;

    ctx.fillStyle = isHovered ? (dark ? '#1c1c1e' : '#f4f4f5') : dark ? 'rgba(9,9,11,0.92)' : 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 6);
    ctx.fill();

    ctx.strokeStyle = isHovered ? n.color : dark ? 'rgba(63,63,70,0.5)' : 'rgba(212,212,216,0.6)';
    ctx.lineWidth = isHovered ? 1.5 : 0.5;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 6);
    ctx.stroke();

    if (isHovered) {
      ctx.shadowColor = n.color;
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, 6);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.font = FONT_SMALL;
    ctx.fillStyle = isHovered ? (dark ? '#e4e4e7' : '#18181b') : dark ? '#71717a' : '#71717a';
    ctx.textAlign = 'left';
    for (let j = 0; j < maxLines; j++) {
      const line = lines[j];
      if (line) ctx.fillText(line, cardX + 8, cardY + 8 + j * CARD_LINE_HEIGHT + 11);
    }
  } else {
    // Inline label
    ctx.font = FONT_SMALL;
    ctx.fillStyle = isHovered ? (dark ? '#e4e4e7' : '#18181b') : dark ? '#52525b' : '#a1a1aa';
    ctx.globalAlpha = isHovered ? 1 : force ? 0.85 : Math.min(1, (zoom - 0.3) * 2.5);
    ctx.textAlign = 'left';
    const text = maskSecrets(n.node.label || n.node.id.substring(0, 12));
    const label = text.length > 45 ? `${text.slice(0, 45)}...` : text;
    ctx.fillText(label, sx + r + 5, sy + 4);
    ctx.globalAlpha = 1;
  }
}
