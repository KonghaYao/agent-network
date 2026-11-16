/**
 * 群聊专属色单测：不依赖服务端，只验证派生确定性、调色板边界与对比度。
 *
 * 运行：bun scripts/verify-group-colors.ts
 */

import {
  GROUP_COLORS,
  groupColorFor,
  groupColorIndex,
  groupColorStyle,
} from '../src/web/lib/group-colors';
import { groupAvatarCells } from '../src/web/lib/rooms';
import { check, checkEqual, checksPassed } from './lib/harness';

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (!match) throw new Error(`非法颜色：${hex}`);
  const value = match[1]!;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const left = relativeLuminance(first);
  const right = relativeLuminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/** CIE76 色差；约 2.3 为一个可觉察差异，这里用更宽松的阈值做设计边界。 */
function deltaE(first: Rgb, second: Rgb): number {
  const lab = (rgb: Rgb): Rgb => {
    const [r, g, b] = rgb.map((value) => {
      const unit = value / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
    const pivot = (value: number): number =>
      value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27) * value / 116 + 16 / 116;
    const fx = pivot(x / 0.95047);
    const fy = pivot(y);
    const fz = pivot(z / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const WHITE: Rgb = [255, 255, 255];
const SIDEBAR_LIGHT: Rgb = [0xf7, 0xf7, 0xf7];
const SIDEBAR_DARK: Rgb = [0x2b, 0x2b, 0x2b];
const SEMANTIC_COLORS: { label: string; rgb: Rgb }[] = [
  { label: '未读红', rgb: parseHex('#fa5151') },
  { label: '发送气泡绿', rgb: parseHex('#07c160') },
  { label: '自己气泡绿', rgb: parseHex('#95ec69') },
  { label: '危险红', rgb: parseHex('#c0392b') },
];

function verifyPalette(): void {
  check('调色板至少 8 色', GROUP_COLORS.length >= 8, GROUP_COLORS.length);
  check(
    '调色板下标连续且唯一',
    GROUP_COLORS.every((color, index) => color.index === index),
  );
  const hexes = new Set(GROUP_COLORS.map((color) => color.hex));
  checkEqual('每个色值唯一', hexes.size, GROUP_COLORS.length);

  for (const color of GROUP_COLORS) {
    const rgb = parseHex(color.hex);
    const textContrast = contrastRatio(rgb, WHITE);
    const lightContrast = contrastRatio(rgb, SIDEBAR_LIGHT);
    const darkContrast = contrastRatio(rgb, SIDEBAR_DARK);
    check(`${color.name} 色块白字对比度 >= 4.5`, textContrast >= 4.5, textContrast);
    check(`${color.name} 浅色头部非文本对比度 >= 3`, lightContrast >= 3, lightContrast);
    check(`${color.name} 暗色头部非文本对比度 >= 3`, darkContrast >= 3, darkContrast);
    for (const semantic of SEMANTIC_COLORS) {
      const distance = deltaE(rgb, semantic.rgb);
      check(
        `${color.name} 与${semantic.label}保持感知距离`,
        distance >= 25,
        distance.toFixed(2),
      );
    }
  }

  let minimum = Number.POSITIVE_INFINITY;
  let pair = '';
  for (let left = 0; left < GROUP_COLORS.length; left += 1) {
    for (let right = left + 1; right < GROUP_COLORS.length; right += 1) {
      const distance = deltaE(
        parseHex(GROUP_COLORS[left]!.hex),
        parseHex(GROUP_COLORS[right]!.hex),
      );
      if (distance < minimum) {
        minimum = distance;
        pair = `${GROUP_COLORS[left]!.name}/${GROUP_COLORS[right]!.name}`;
      }
    }
  }
  check('任意两色具有可感知差异', minimum >= 10, `${pair} ${minimum.toFixed(2)}`);
}

function verifyDerivation(): void {
  checkEqual('空字符串仍有确定颜色', groupColorIndex(''), 1);
  checkEqual('rm_alpha 稳定映射', groupColorIndex('rm_alpha'), 5);
  checkEqual('rm_beta 稳定映射', groupColorIndex('rm_beta'), 3);
  checkEqual(
    'UUID 稳定映射',
    groupColorIndex('3f9c2b7e-1a4d-4c8e-9f00-2b6a5d4c3e1f'),
    9,
  );
  check(
    '同一 room_id 始终同色',
    ['rm_same', 'rm_same', 'rm_same'].every(
      (roomId) => groupColorFor(roomId).hex === groupColorFor('rm_same').hex,
    ),
  );

  const counts = new Array<number>(GROUP_COLORS.length).fill(0);
  const samples = 10_000;
  let outOfRange = 0;
  for (let index = 0; index < samples; index += 1) {
    const bucket = groupColorIndex(`rm_dist_${index}`);
    if (bucket < 0 || bucket >= GROUP_COLORS.length) outOfRange += 1;
    else counts[bucket] = counts[bucket]! + 1;
  }
  checkEqual('派生下标始终在调色板范围内', outOfRange, 0);
  const expected = samples / GROUP_COLORS.length;
  check(
    '每个色相都被使用',
    counts.every((count) => count > 0),
    counts,
  );
  check(
    '分布均匀（每桶在期望值 20% 内）',
    counts.every((count) => Math.abs(count - expected) <= expected * 0.2),
    counts,
  );
  // 卡方检验 df=9，p=0.001 的临界值约 27.88；当前固定样本远低于该值。
  const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
  check('卡方检验通过（p=0.001）', chiSquare < 27.88, chiSquare.toFixed(3));
}

function verifyConsumers(): void {
  const roomId = 'rm_consumer_test';
  const color = groupColorFor(roomId);
  const cells = groupAvatarCells('测试群聊', color.hex);
  checkEqual('2×2 头像产生四个色块', cells.length, 4);
  check(
    '四个色块共用同一群色',
    cells.every((cell) => cell.color === color.hex),
    cells,
  );
  checkEqual('头像首字按群名循环', cells.map((cell) => cell.char).join(''), '测试群聊');
  checkEqual(
    '空群名回退为“群聊”',
    groupAvatarCells('', color.hex).map((cell) => cell.char).join(''),
    '群聊群聊',
  );
  const style = groupColorStyle(color.hex) as Record<string, string>;
  checkEqual('CSS 自定义属性写入颜色', style['--group-color'], color.hex);
}

function main(): void {
  console.log('群聊专属色单测');
  verifyPalette();
  verifyDerivation();
  verifyConsumers();
  console.log(`\n群聊专属色单测通过 ${checksPassed()} 项`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
