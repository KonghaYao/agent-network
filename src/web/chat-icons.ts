import { animate, bindTrigger } from 'kubai-icons/runtime';
import AppWindow from 'kubai-icons/icons/app-window';
import Archive from 'kubai-icons/icons/archive';
import ChevronLeft from 'kubai-icons/icons/chevron-left';
import CircleCheck from 'kubai-icons/icons/circle-check';
import CircleX from 'kubai-icons/icons/circle-x';
import ClipboardCheck from 'kubai-icons/icons/clipboard-check';
import Copy from 'kubai-icons/icons/copy';
import ExternalLink from 'kubai-icons/icons/external-link';
import LogOut from 'kubai-icons/icons/log-out';
import Pencil from 'kubai-icons/icons/pencil';
import RotateCw from 'kubai-icons/icons/rotate-cw';
import Search from 'kubai-icons/icons/search';
import Trash from 'kubai-icons/icons/trash';
import Users from 'kubai-icons/icons/users';

/**
 * 图标悬停动效：只在浏览器运行，按需加载。
 *
 * 服务端 `src/web/icons.ts` 已生成静态 SVG；这里扫描 `data-kubai-icon`，
 * 把动效绑到最近的按钮/链接/搜索框。脚本 404、导入失败或任一图标动效
 * 异常都不影响静态图标，属于 fail-open 的渐进增强。图标当前都是首屏
 * SSR 标记，页面后续不会动态插入，因此不需要 MutationObserver。
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
} as const;

type IconName = keyof typeof ICONS;

function bindIcons(): void {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const svg of document.querySelectorAll<SVGSVGElement>('svg[data-kubai-icon]')) {
      const name = svg.getAttribute('data-kubai-icon') as IconName | null;
      if (!name || !(name in ICONS) || svg.dataset.kubaiMotion === 'bound') continue;
      const host = svg.closest<HTMLElement>('button, a, label') ?? svg.parentElement;
      if (!host) continue;
      try {
        const icon = ICONS[name];
        bindTrigger(host, animate(svg, icon), icon);
        svg.dataset.kubaiMotion = 'bound';
      } catch {
        // 单枚图标动效失败时保留静态 SVG，继续处理其余图标。
      }
    }
  } catch {
    // 动效是加分项；任何异常都不阻塞页面脚本或静态图标。
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindIcons, { once: true });
} else {
  bindIcons();
}
