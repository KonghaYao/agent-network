import type { CSSProperties } from 'react';

/**
 * 群聊专属色：按 `room_id` 稳定映射到一组经过挑选的色相。
 *
 * 颜色只用于辅助识别，群名始终可见，不新增仅靠颜色传达的信息。
 * 调色板在线性亮度上基本一致（相对亮度约 0.178），同时满足：
 * - 与 10px 白色首字的对比度 >= 4.5；
 * - 与浅色头部 `#f7f7f7`、暗色头部 `#2b2b2b` 的非文本对比度 >= 3；
 * - 与未读红 `#fa5151`、发送气泡绿 `#07c160`、危险红 `#c0392b`
 *   保持足够感知距离，避免被误读为状态色。
 *
 * 同一 `room_id` 在刷新、重进或不同设备上得到同一颜色。映射是
 * `FNV-1a(room_id) % 调色板长度`，因此调色板长度是映射的一部分：
 * 当前固定为 10 色。修改长度（包括在末尾追加颜色）会按新模数整体
 * 重排已有群的颜色——10→11 时约 90.9% 的 `room_id` 会换色。若确需
 * 增色，必须引入版本化映射或一次性迁移，不能只改数组。
 * `scripts/verify-group-colors.ts` 锁定长度为 10；变更必须显式改测试。
 */

export interface GroupColor {
  /** 调色板下标；用于 `data-group-color` 与测试断言。 */
  index: number;
  /** 中文色名，仅用于可读性与调试，不参与渲染。 */
  name: string;
  /** 群聊头像色块与头部色标使用的 sRGB 颜色。 */
  hex: string;
}

export const GROUP_COLORS: readonly GroupColor[] = [
  { index: 0, name: '松石', hex: '#008474' },
  { index: 1, name: '深青', hex: '#00818e' },
  { index: 2, name: '海蓝', hex: '#007eaa' },
  { index: 3, name: '钴蓝', hex: '#0079c7' },
  { index: 4, name: '宝蓝', hex: '#1572e3' },
  { index: 5, name: '靛紫', hex: '#626fc3' },
  { index: 6, name: '紫罗兰', hex: '#8061d4' },
  { index: 7, name: '灰紫', hex: '#8d65a8' },
  { index: 8, name: '品红', hex: '#b04fac' },
  { index: 9, name: '藕荷', hex: '#a85d86' },
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
 * 把颜色放进 CSS 自定义属性，由样式表统一消费；这样头像色块与头部
 * 色标共用同一变量，也便于未来在主题层调整。
 */
export function groupColorStyle(hex: string): CSSProperties {
  return { '--group-color': hex } as CSSProperties;
}
