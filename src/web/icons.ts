import {
  AppWindow,
  Archive,
  ChevronLeft,
  CircleCheck,
  CircleX,
  ClipboardCheck,
  Copy,
  ExternalLink,
  LogOut,
  Pencil,
  RotateCw,
  Search,
  Trash,
  Users,
  toSvg,
  type KubaiIconData,
} from 'kubai-icons';

/**
 * 服务端图标映射：页面 HTML 只通过这里生成 Kubai SVG。
 *
 * 这个模块只能在服务端使用。`kubai-icons` 根入口会加载完整图标表，
 * 浏览器端动效走 `src/web/chat-icons.ts` 的按需子路径导入，不要把本文件
 * 带进客户端 bundle。图标尺寸由调用点沿用既有 CSS 像素值；颜色由
 * `ICON_COLORS` 集中给出，调用点仍可用 `color` 覆盖，`null` 保持
 * `currentColor` 跟随亮/暗主题。
 */
const ICONS = {
  'contact-requests': Users,
  'my-tasks': ClipboardCheck,
  search: Search,
  back: ChevronLeft,
  'copy-group-info': Copy,
  'monitor-toggle': AppWindow,
  'monitor-save': CircleCheck,
  'monitor-clear': Trash,
  'monitor-external': ExternalLink,
  'monitor-refresh': RotateCw,
  'monitor-close': CircleX,
  'account-edit': Pencil,
  'archived-agents': Archive,
  logout: LogOut,
} satisfies Record<string, KubaiIconData>;

export type KubaiIconName = keyof typeof ICONS;

/**
 * 语义色板：中等饱和，在亮色（#ffffff / #f7f7f7）与暗色（#191919 / #2b2b2b）
 * 背景上都保持 ≥3:1 的非文本对比度；同一语义组共用同一色值。
 */
const ICON_TONES = {
  success: '#0e9f4f',
  info: '#3b82f6',
  warning: '#c47a00',
  danger: '#e5484d',
} as const;

/** 每个图标的默认语义色；`null` 表示跟随 `currentColor`（主题文字色）。 */
const ICON_COLORS = {
  'contact-requests': ICON_TONES.success,
  'my-tasks': ICON_TONES.info,
  search: null,
  back: null,
  'copy-group-info': ICON_TONES.info,
  'monitor-toggle': ICON_TONES.info,
  'monitor-save': ICON_TONES.success,
  'monitor-clear': ICON_TONES.danger,
  'monitor-external': ICON_TONES.info,
  'monitor-refresh': ICON_TONES.info,
  'monitor-close': ICON_TONES.danger,
  'account-edit': null,
  'archived-agents': ICON_TONES.warning,
  logout: ICON_TONES.danger,
} satisfies Record<KubaiIconName, string | null>;

export interface KubaiIconOptions {
  /** 与既有调用点一致的像素尺寸；默认 18。 */
  size?: number;
  /** 保留调用点原有的 class（例如搜索框的 `search-icon`）。 */
  className?: string;
  /** 覆盖默认语义色；传 `null` 强制跟随 `currentColor`。 */
  color?: string | null;
}

/**
 * 生成单枚图标 HTML。
 *
 * 所有图标都是装饰性的：按钮/链接已有 `aria-label`/可见文字，图标本身
 * 保持 `aria-hidden` 与 `focusable="false"`。`data-kubai-icon` 只供
 * `/assets/chat-icons.js` 绑定悬停动效；脚本缺失或失败时静态图标不受影响。
 */
export function kubaiIcon(name: KubaiIconName, options: KubaiIconOptions = {}): string {
  const color = options.color === undefined ? ICON_COLORS[name] : options.color;
  return toSvg(ICONS[name], {
    size: options.size ?? 18,
    ...(options.className ? { className: options.className } : {}),
    ...(color ? { color } : {}),
    attrs: {
      focusable: 'false',
      'data-kubai-icon': name,
    },
  });
}
