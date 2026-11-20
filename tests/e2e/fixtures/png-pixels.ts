import { inflateSync } from 'node:zlib';

/**
 * 右键菜单像素探针的最小 PNG 解码器。
 *
 * Playwright/CDP screencast 输出 8 位 RGB/RGBA PNG；这里只解出亮度，供逐帧
 * 断言“菜单壳已绘制但文字尚未出现”使用。不引入额外依赖，也不把截图写盘。
 */

export interface LumaImage {
  width: number;
  height: number;
  /** 每像素亮度，长度 = width * height。 */
  data: Uint8Array;
}

export interface RasterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePngLuma(buffer: Buffer): LumaImage {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (bitDepth !== 8 || data[12] !== 0) {
        throw new Error(`不支持的 PNG：bitDepth=${bitDepth} interlace=${data[12]}`);
      }
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!channels || width <= 0 || height <= 0) {
    throw new Error(`不支持的 PNG：colorType=${colorType} ${width}x${height}`);
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const out = new Uint8Array(width * height);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset]!;
    rawOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset + x]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let decoded: number;
      switch (filter) {
        case 0:
          decoded = value;
          break;
        case 1:
          decoded = (value + left) & 0xff;
          break;
        case 2:
          decoded = (value + up) & 0xff;
          break;
        case 3:
          decoded = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          decoded = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`未知 PNG 行过滤：${filter}`);
      }
      current[x] = decoded;
    }
    rawOffset += stride;
    for (let x = 0; x < width; x += 1) {
      const base = x * channels;
      const red = current[base]!;
      const green = channels >= 3 ? current[base + 1]! : red;
      const blue = channels >= 3 ? current[base + 2]! : red;
      out[y * width + x] = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
    }
    previous.set(current);
  }
  return { width, height, data: out };
}

export function clampRect(rect: RasterRect, width: number, height: number): RasterRect {
  const x = Math.max(0, Math.min(width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height, Math.round(rect.y)));
  const right = Math.max(x, Math.min(width, Math.round(rect.x + rect.width)));
  const bottom = Math.max(y, Math.min(height, Math.round(rect.y + rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function meanAbsDiff(a: LumaImage, b: LumaImage, rect: RasterRect): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  let sum = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const row = y * a.width;
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      sum += Math.abs(a.data[row + x]! - b.data[row + x]!);
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

function gradientAt(image: LumaImage, x: number, y: number, rect: RasterRect): number {
  const at = (dx: number, dy: number) => image.data[(y + dy) * image.width + (x + dx)]!;
  const centre = at(0, 0);
  let value = 0;
  if (x + 1 < rect.x + rect.width) value += Math.abs(centre - at(1, 0));
  if (y + 1 < rect.y + rect.height) value += Math.abs(centre - at(0, 1));
  return value;
}

/** 从稳定帧提取文字边缘掩码，并向外膨胀 1 像素，容忍抗锯齿偏移。 */
export function buildTextMask(image: LumaImage, rect: RasterRect, threshold = 30): { mask: Uint8Array; count: number } {
  const { width, height } = rect;
  const mask = new Uint8Array(width * height);
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (gradientAt(image, rect.x + dx, rect.y + dy, rect) > threshold) {
        mask[dy * width + dx] = 1;
      }
    }
  }
  const dilated = mask.slice();
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (!mask[dy * width + dx]) continue;
      for (const [nx, ny] of [[dx - 1, dy], [dx + 1, dy], [dx, dy - 1], [dx, dy + 1]] as const) {
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) dilated[ny * width + nx] = 1;
      }
    }
  }
  let count = 0;
  for (const value of dilated) count += value;
  return { mask: dilated, count };
}

/** 帧在文字掩码位置上的平均局部对比度；空白玻璃面接近 0。 */
export function gradientMeanAtMask(image: LumaImage, rect: RasterRect, mask: Uint8Array): number {
  const { width, height } = rect;
  let sum = 0;
  let count = 0;
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (!mask[dy * width + dx]) continue;
      sum += gradientAt(image, rect.x + dx, rect.y + dy, rect);
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}
