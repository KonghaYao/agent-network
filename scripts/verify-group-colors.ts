/**
 * 群聊专属色单测：不依赖服务端，只验证派生确定性、调色板边界、对比度
 * 与群头像文字规则。
 *
 * 运行：bun scripts/verify-group-colors.ts
 */

import {
  GROUP_COLORS,
  groupColorFor,
  groupColorIndex,
  groupColorStyle,
} from '../src/web/lib/group-colors';
import { groupAvatarLabel } from '../src/web/lib/rooms';
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

/** CIELAB；用于明度区间、彩度上限与 CIE76 色差。 */
function lab(rgb: Rgb): Rgb {
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
}

/** CIE76 色差；约 2.3 为一个可觉察差异，这里用更宽松的阈值做设计边界。 */
function deltaE(first: Rgb, second: Rgb): number {
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
  // 映射是 `hash % length`，长度变化会重排所有已有群的颜色。锁死 10 色，
  // 让任何扩色都必须连同版本化迁移一起显式修改本断言。
  checkEqual('调色板长度锁定为 10（变更需版本化迁移）', GROUP_COLORS.length, 10);
  check(
    '调色板下标连续且唯一',
    GROUP_COLORS.every((color, index) => color.index === index),
  );
  const hexes = new Set(GROUP_COLORS.map((color) => color.hex));
  const darks = new Set(GROUP_COLORS.map((color) => color.dark));
  const names = new Set(GROUP_COLORS.map((color) => color.name));
  checkEqual('每个基色唯一', hexes.size, GROUP_COLORS.length);
  checkEqual('每个渐变终点唯一', darks.size, GROUP_COLORS.length);
  checkEqual('色名唯一', names.size, GROUP_COLORS.length);

  const lightness: number[] = [];
  for (const color of GROUP_COLORS) {
    const base = parseHex(color.hex);
    const dark = parseHex(color.dark);
    const [baseL, baseA, baseB] = lab(base);
    const baseChroma = Math.hypot(baseA, baseB);
    lightness.push(baseL);
    check(`${color.name} 基色（渐变最亮端）白字对比度 >= 4.5`, contrastRatio(base, WHITE) >= 4.5);
    check(`${color.name} 渐变终点白字对比度 >= 4.5`, contrastRatio(dark, WHITE) >= 4.5);
    check(
      `${color.name} 渐变终点比基色更暗`,
      relativeLuminance(dark) < relativeLuminance(base),
    );
    check(
      `${color.name} 浅色侧栏非文本对比度 >= 3`,
      contrastRatio(base, SIDEBAR_LIGHT) >= 3,
      contrastRatio(base, SIDEBAR_LIGHT),
    );
    check(
      `${color.name} 暗色侧栏非文本对比度 >= 3`,
      contrastRatio(base, SIDEBAR_DARK) >= 3,
      contrastRatio(base, SIDEBAR_DARK),
    );
    check(`${color.name} 彩度上限（低饱和）`, baseChroma <= 36, baseChroma.toFixed(1));
    for (const semantic of SEMANTIC_COLORS) {
      const distance = deltaE(base, semantic.rgb);
      check(
        `${color.name} 与${semantic.label}保持感知距离`,
        distance >= 25,
        distance.toFixed(2),
      );
    }
  }

  const spread = Math.max(...lightness) - Math.min(...lightness);
  check('十个群色处于同一明度区间（ΔL* <= 3）', spread <= 3, spread.toFixed(2));

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

function verifyLabels(): void {
  const pair = groupAvatarLabel('配色测试群');
  checkEqual('中文群名取前 2 个汉字', pair.text, '配色');
  checkEqual('中文群名标记 2 字', pair.length, 2);
  checkEqual('中文群名标记汉字', pair.script, 'han');

  const single = groupAvatarLabel('猫');
  checkEqual('单字中文群名保留 1 字', single.text, '猫');
  checkEqual('单字中文群名标记 1 字', single.length, 1);

  const latin = groupAvatarLabel('Codex 讨论组');
  checkEqual('英文/混合取前 2 个字母并大写', latin.text, 'CO');
  checkEqual('英文标记 latin', latin.script, 'latin');

  const oneLatin = groupAvatarLabel('Q 研究组');
  checkEqual('单个英文字母只显示 1 个', oneLatin.text, 'Q');
  checkEqual('单个英文字母标记 1 字', oneLatin.length, 1);

  checkEqual('拉丁字母开头的混合名取字母', groupAvatarLabel('AI 研究小组').text, 'AI');
  checkEqual('空格群名回退为“群聊”', groupAvatarLabel('   ').text, '群聊');
  checkEqual('空群名回退为“群聊”', groupAvatarLabel('').text, '群聊');
  checkEqual('标点包裹的中文名取汉字', groupAvatarLabel('「读书会」').text, '读书');
  checkEqual('纯符号名取前 2 个字符', groupAvatarLabel('#!').text, '#!');

  // 标签只由群名决定，颜色只由 room_id 决定，两者互不影响。
  checkEqual(
    '标签不改变颜色派生',
    groupColorFor('rm_label_test').hex,
    groupColorFor('rm_label_test').hex,
  );
}

function verifyConsumers(): void {
  const roomId = 'rm_consumer_test';
  const color = groupColorFor(roomId);
  const style = groupColorStyle(color) as Record<string, string>;
  checkEqual('CSS 自定义属性写入基色', style['--group-color'], color.hex);
  checkEqual('CSS 自定义属性写入渐变终点', style['--group-color-dark'], color.dark);
  check('渐变终点与基色不同', color.dark !== color.hex, color.dark);
}

function main(): void {
  console.log('群聊专属色单测');
  verifyPalette();
  verifyDerivation();
  verifyLabels();
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
