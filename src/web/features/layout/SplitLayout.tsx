import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import type { ReactNode } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useUiPrefStore } from '../../stores/ui';

const DEFAULT_LAYOUT = { sidebar: 23.5, main: 76.5 };

/**
 * 桌面双栏：`react-resizable-panels` 拥有左右比例。
 *
 * - 侧栏保持 legacy 的 280–320px，默认 300px；
 * - 分隔条自带键盘步进与 `aria-valuenow`，双击恢复默认；
 * - 比例写入 zustand（`agent-network-ui-v1`），刷新后恢复；
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

  // 只有双方都是数字时才恢复；损坏/旧版本的存储回退到源码默认值。
  const restored =
    stored && typeof stored.sidebar === 'number' && typeof stored.main === 'number'
      ? { sidebar: stored.sidebar, main: stored.main }
      : DEFAULT_LAYOUT;

  return (
    <main>
      <Group
        id="home-split"
        className="spa-split"
        orientation="horizontal"
        groupRef={groupRef}
        defaultLayout={restored}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction) saveLayout(layout);
        }}
      >
        <Panel
          id="sidebar"
          className="spa-split-sidebar"
          minSize={280}
          maxSize={320}
          defaultSize={300}
        >
          {sidebar}
        </Panel>
        <Separator
          id="sidebar-resizer"
          className="spa-resizer"
          aria-label="调整侧栏宽度"
          disableDoubleClick
          onDoubleClick={() => {
            groupRef.current?.setLayout(DEFAULT_LAYOUT);
            saveLayout(DEFAULT_LAYOUT);
          }}
        >
          <span className="spa-resizer-grip" aria-hidden="true" />
        </Separator>
        <Panel id="main" className="spa-split-main" minSize={320}>
          {main}
        </Panel>
      </Group>
    </main>
  );
}
