import { badgeLabel } from './tab-badge';

/**
 * 标签页图标：在应用基础图标上叠加红点/数字。
 *
 * 基础图标是内联的 data URI，不请求外部服务；服务端壳把它写进
 * `<link rel="icon">`，客户端只替换 `href`，归零时恢复同一基础图标。
 * 画布不可用、图标加载失败等情况下保持基础图标，不影响页面功能。
 */

const ICON_SIZE = 64;
const BADGE_COLOR = '#fa5151';
const BASE_COLOR = '#07c160';

/**
 * 基础图标：微信式绿色圆角方块 + 白色对话气泡。
 *
 * 同时供服务端 `<link rel="icon">` 与客户端 canvas 底图使用，保证恢复后
 * 的图标与有红点时完全一致。
 */
export const BASE_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  `<rect width="64" height="64" rx="14" fill="${BASE_COLOR}"/>` +
  '<path d="M33 16.6c-10.5 0-19 6.4-19 14.2 0 4.5 2.6 8.5 6.7 11.1l-1.7 6.3 7.3-3.9c2 .6 4.4.9 6.7.9 10.5 0 19-6.4 19-14.2s-8.5-14.4-19-14.4z" fill="#ffffff"/>' +
  '</svg>';

export const BASE_FAVICON_HREF = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  BASE_FAVICON_SVG,
)}`;

const FAVICON_SELECTOR = 'link[rel~="icon"]';

let baseHref: string | null = null;
/** 递增序号让晚到的异步绘制失效，避免慢图覆盖新状态。 */
let revision = 0;

function faviconLink(doc: Document): HTMLLinkElement {
  const existing = doc.querySelector<HTMLLinkElement>(FAVICON_SELECTOR);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = BASE_FAVICON_HREF;
  doc.head.append(link);
  return link;
}

/** 首次调用时记住原始图标；之后的替换都以它为基准恢复。 */
function baseFavicon(doc: Document): string {
  if (baseHref === null) {
    baseHref = faviconLink(doc).getAttribute('href') || BASE_FAVICON_HREF;
  }
  return baseHref;
}

/** 恢复原始图标并让仍在绘制的请求失效。 */
export function resetFavicon(doc: Document = document): void {
  revision += 1;
  faviconLink(doc).href = baseFavicon(doc);
}

function drawFallbackBase(context: CanvasRenderingContext2D): void {
  context.fillStyle = BASE_COLOR;
  context.beginPath();
  context.roundRect(0, 0, ICON_SIZE, ICON_SIZE, 14);
  context.fill();
}

async function drawBase(context: CanvasRenderingContext2D): Promise<void> {
  try {
    const image = new Image();
    image.src = BASE_FAVICON_HREF;
    if (typeof image.decode === 'function') {
      await image.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('favicon 底图加载失败'));
      });
    }
    context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  } catch {
    // 无法栅格化 SVG 时仍画出可辨识的底色，红点提示不受影响。
    drawFallbackBase(context);
  }
}

function drawBadge(context: CanvasRenderingContext2D, label: string): void {
  const wide = label.length > 1;
  const radius = wide ? 17 : 15;
  const centerX = ICON_SIZE - radius - 2;
  const centerY = radius + 2;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fillStyle = BADGE_COLOR;
  context.fill();
  // 白色描边让红点在深色/浅色标签栏上都与底图分开。
  context.lineWidth = 4;
  context.strokeStyle = '#ffffff';
  context.stroke();
  context.fillStyle = '#ffffff';
  context.font = `600 ${wide ? 20 : 26}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, centerX, centerY + 1);
}

/** 在浏览器里栅格化底图并叠加红点，返回 PNG data URI。 */
export async function badgeFaviconHref(label: string): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 favicon canvas');
  await drawBase(context);
  drawBadge(context, label);
  return canvas.toDataURL('image/png');
}

/**
 * 按未读会话数更新 favicon；0 或非法计数恢复原图标。
 *
 * 绘制是异步的，序号保证只有最后一次请求能写回 `href`。
 */
export function applyFaviconBadge(doc: Document, count: number): void {
  const label = badgeLabel(count);
  if (!label) {
    resetFavicon(doc);
    return;
  }
  const link = faviconLink(doc);
  baseFavicon(doc);
  const current = ++revision;
  void badgeFaviconHref(label)
    .then((href) => {
      if (current !== revision) return;
      link.href = href;
    })
    .catch(() => {
      // 保持基础图标；不要在标签栏留下半成品。
    });
}
