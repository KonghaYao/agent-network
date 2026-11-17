import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import type { ReactNode } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useUiPrefStore } from '../../stores/ui';

/**
 * 读取布局 token。库的 `Panel` 约束只接受数字/长度字符串，不能直接使用
 * `var()`，因此在模块加载时把 `tokens.css` 的像素变量解析成数字。
 */
function readPixels(name: string): number | undefined {
  if (typeof document === 'undefined') return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

const SIDEBAR_WIDTH = readPixels('--app-sidebar-width');
const SIDEBAR_MIN = readPixels('--app-sidebar-min');
const SIDEBAR_MAX = readPixels('--app-sidebar-max');
const CHAT_MIN = readPixels('--app-chat-min');

/**
 * 桌面双栏：`react-resizable-panels` 拥有左右比例。
 *
 * - 侧栏宽度来自 `--app-sidebar-*`，默认 300px，可拖到 280–320px；
 * - 只有存在持久化布局时才传 `defaultLayout`，否则使用 `Panel` 的像素默认值；
 * - 分隔条自带键盘步进与 `aria-valuenow`，双击回到 token 默认宽度；
 * - 比例写入 zustand（`agent-network-ui-v1`），保存约束前的 `requestedLayout`；
 * - <760px 直接渲染单列 DOM，不挂载面板组件，避免移动端出现横向分割。
 */
export function SplitLayout({
  sidebar,
  main,
}: {
  sidebar: ReactNode;
  main: ReactNode;
}) {
  const mobile = useIsMobile();
  const stored = useUiPrefStore((state) => state.homeLayout);
  const saveLayout = useUiPrefStore((state) => state.setHomeLayout);
  const groupRef = useGroupRef();

  if (mobile) {
    return (
      <main>
        {sidebar}
        {main}
      </main>
    );
  }

  // 只有双方都是数字时才恢复；损坏/旧版本的存储回退到 Panel 默认值。
  const restored =
    stored && typeof stored.sidebar === 'number' && typeof stored.main === 'number'
      ? { sidebar: stored.sidebar, main: stored.main }
      : undefined;

  return (
    <main>
      <Group
        id="home-split"
        className="spa-split"
        orientation="horizontal"
        groupRef={groupRef}
        defaultLayout={restored}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          const next = meta.requestedLayout ?? layout;
          if (typeof next.sidebar === 'number' && typeof next.main === 'number') {
            saveLayout(next);
          }
        }}
      >
        <Panel
          id="sidebar"
          className="spa-split-sidebar"
          minSize={SIDEBAR_MIN}
          maxSize={SIDEBAR_MAX}
          defaultSize={SIDEBAR_WIDTH}
        >
          {sidebar}
        </Panel>
        <Separator
          id="sidebar-resizer"
          className="spa-resizer"
          aria-label="调整侧栏宽度"
          disableDoubleClick
          onDoubleClick={() => {
            const width = document
              .getElementById('home-split')
              ?.getBoundingClientRect().width;
            if (!width || SIDEBAR_WIDTH === undefined) return;
            const sidebarPercent = (SIDEBAR_WIDTH / width) * 100;
            const layout = { sidebar: sidebarPercent, main: 100 - sidebarPercent };
            groupRef.current?.setLayout(layout);
            saveLayout(layout);
          }}
        >
          <span className="spa-resizer-grip" aria-hidden="true" />
        </Separator>
        <Panel id="main" className="spa-split-main" minSize={CHAT_MIN}>
          {main}
        </Panel>
      </Group>
    </main>
  );
}
