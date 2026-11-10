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
 * 带进客户端 bundle。图标尺寸由调用点沿用既有 CSS 像素值，颜色默认取
 * `currentColor`，因此亮/暗主题继续由现有 `--wx-*` 变量控制。
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

export interface KubaiIconOptions {
  /** 与既有调用点一致的像素尺寸；默认 18。 */
  size?: number;
  /** 保留调用点原有的 class（例如搜索框的 `search-icon`）。 */
  className?: string;
}

/**
 * 生成单枚图标 HTML。
 *
 * 所有图标都是装饰性的：按钮/链接已有 `aria-label`/可见文字，图标本身
 * 保持 `aria-hidden` 与 `focusable="false"`。`data-kubai-icon` 只供
 * `/assets/chat-icons.js` 绑定悬停动效；脚本缺失或失败时静态图标不受影响。
 */
export function kubaiIcon(name: KubaiIconName, options: KubaiIconOptions = {}): string {
  return toSvg(ICONS[name], {
    size: options.size ?? 18,
    ...(options.className ? { className: options.className } : {}),
    attrs: {
      focusable: 'false',
      'data-kubai-icon': name,
    },
  });
}
