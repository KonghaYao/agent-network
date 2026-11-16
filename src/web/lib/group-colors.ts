import type { CSSProperties } from 'react';

/**
 * 群聊专属色：按 `room_id` 稳定映射到一组低饱和、同明度的色相。
 *
 * 颜色只用于辅助识别，群名始终可见，不新增仅靠颜色传达的信息。
 * 调色板在 OKLCH 中取相近明度（Lab L* 约 49–50）与低彩度
 * （Lab C* 约 22–30），避免高饱和撞色挤在一起；同时满足：
 * - 渐变最亮端（`hex`）与白色文字的对比度 >= 4.55；
 * - 与浅色侧栏 `#f7f7f7`、暗色侧栏 `#2b2b2b` 的非文本对比度 >= 3；
 * - 与未读红 `#fa5151`、发送气泡绿 `#07c160`、自己气泡绿 `#95ec69`
 *   与危险红 `#c0392b` 保持足够感知距离，避免被误读为状态色。
 *
 * 每个颜色给出一对同色系明暗值：`hex` 是渐变起点（也是深色文字/深色
 * 主题下的识别色），`dark` 是渐变终点。两者都由设计时固定，不在运行时
 * 做混色，保证浏览器与测试看到同一组颜色。
 *
 * 同一 `room_id` 在刷新、重进或不同设备上得到同一颜色。映射是
 * `FNV-1a(room_id) % 调色板长度`，因此调色板长度是映射的一部分：
 * 当前固定为 10 色。修改长度（包括在末尾追加颜色）会按新模数整体
 * 重排已有群的颜色——10→11 时约 90.9% 的 `room_id` 会换色。若确需
 * 增色，必须引入版本化映射或一次性迁移，不能只改数组。
 * `scripts/verify-group-colors.ts` 锁定长度为 10；变更必须显式改测试。
 *
 * 替换色值（保持长度不变）也会让已有群换色。2026-11 的“单瓦片”视觉
 * 升级整体替换了调色板：这是一次性的外观变更，不写迁移、不改服务端，
 * 已存在的群在下次加载时直接使用新颜色。
 */

export interface GroupColor {
  /** 调色板下标；用于 `data-group-color` 与测试断言。 */
  index: number;
  /** 中文色名，仅用于可读性与调试，不参与渲染。 */
  name: string;
  /** 群头像渐变起点，也是群名旁色标使用的颜色。 */
  hex: string;
  /** 群头像渐变终点；与 `hex` 同色系、更暗，白字对比度更高。 */
  dark: string;
}

export const GROUP_COLORS: readonly GroupColor[] = [
  { index: 0, name: '陶土', hex: '#9e685d', dark: '#7b5149' },
  { index: 1, name: '琥珀', hex: '#946e47', dark: '#735637' },
  { index: 2, name: '橄榄', hex: '#807642', dark: '#645c33' },
  { index: 3, name: '苔绿', hex: '#647c50', dark: '#4e613e' },
  { index: 4, name: '青瓷', hex: '#45816b', dark: '#366553' },
  { index: 5, name: '湖蓝', hex: '#387f87', dark: '#2c6369' },
  { index: 6, name: '雾蓝', hex: '#4c7b9b', dark: '#3b6079' },
  { index: 7, name: '靛青', hex: '#6a73a1', dark: '#535a7e' },
  { index: 8, name: '紫藤', hex: '#866b97', dark: '#695376' },
  { index: 9, name: '藕荷', hex: '#976783', dark: '#765066' },
];

/**
 * FNV-1a 32 位哈希。`Math.imul` 与 `>>> 0` 保证所有 JS 运行时得到
 * 同一个 32 位结果，不依赖本地化或随机数。
 */
export function groupColorIndex(roomId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < roomId.length; index += 1) {
    hash ^= roomId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % GROUP_COLORS.length;
}

export function groupColorFor(roomId: string): GroupColor {
  return GROUP_COLORS[groupColorIndex(roomId)]!;
}

/**
 * 把群色放进 CSS 自定义属性，由样式表统一消费；头像瓦片的渐变两端与
 * 头部色标共用同一组变量，也便于未来在主题层调整。
 */
export function groupColorStyle(color: GroupColor): CSSProperties {
  return {
    '--group-color': color.hex,
    '--group-color-dark': color.dark,
  } as CSSProperties;
}
