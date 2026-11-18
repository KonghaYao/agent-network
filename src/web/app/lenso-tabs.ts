import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useLenso } from './lenso-controls';

/**
 * Lenso Tabs 适配器：供 MemoryDialog 懒加载 chunk 使用的受控 Tabs。
 *
 * 与 `lenso-controls.ts` 共用同一个 `import('@lenso/ui')`；本文件只随
 * MemoryDialog 动态加载，不进入主入口预算。Lenso 未就绪时渲染
 * `role=tablist/tab/tabpanel` 的原生节点并保持受控值；根节点显式撑满宽度，
 * 避免 Lenso 默认的 `align-items: flex-start` 让 tabs 与 panels 收缩。
 */
interface TabsState {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = createContext<TabsState | null>(null);

type SlotProps = {
  className?: string;
  children?: ReactNode;
  xstyle?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Lenso Tabs root 默认 `align-items: flex-start`，会让抽屉里的 tabs 与 panels 收缩到内容宽度。 */
const TABS_ROOT_LAYOUT = { alignItems: 'stretch', width: '100%' } as const;

export function TabsRoot({
  value,
  onValueChange,
  className,
  children,
}: SlotProps & { value: string; onValueChange: (value: string) => void }): ReactElement {
  const lenso = useLenso();
  const content = createElement(TabsContext.Provider, { value: { value, onValueChange } }, children);
  if (!lenso) {
    return createElement(
      'div',
      { className, style: TABS_ROOT_LAYOUT, 'data-lenso-slot': 'tabs-fallback' },
      content,
    );
  }
  return createElement(
    lenso.Tabs as unknown as ComponentType<Record<string, unknown>>,
    {
      value,
      onValueChange: (next: string | null) => onValueChange(next ?? ''),
      className,
      xstyle: TABS_ROOT_LAYOUT,
    },
    content,
  );
}

export function TabList({ className, children, ...props }: SlotProps): ReactElement {
  const lenso = useLenso();
  if (!lenso) {
    return createElement(
      'div',
      {
        ...props,
        className,
        role: 'tablist',
        'data-lenso-slot': 'tabs-list-fallback',
      } as Record<string, unknown>,
      children,
    );
  }
  return createElement(
    lenso.Tabs.List as unknown as ComponentType<Record<string, unknown>>,
    { ...props, className },
    children,
  );
}

export function Tab({
  value,
  className,
  children,
  xstyle,
  ...props
}: SlotProps & { value: string }): ReactElement {
  const lenso = useLenso();
  const state = useContext(TabsContext);
  if (!lenso) {
    return createElement(
      'button',
      {
        ...props,
        className,
        type: 'button',
        role: 'tab',
        'aria-selected': state?.value === value,
        'data-lenso-slot': 'tabs-tab-fallback',
        onClick: () => state?.onValueChange(value),
      } as Record<string, unknown>,
      children,
    );
  }
  return createElement(
    lenso.Tabs.Tab as unknown as ComponentType<Record<string, unknown>>,
    { ...props, value, className, xstyle },
    children,
  );
}

export function TabPanel({
  value,
  className,
  children,
  keepMounted = true,
  ...props
}: SlotProps & { value: string; keepMounted?: boolean }): ReactElement {
  const lenso = useLenso();
  const state = useContext(TabsContext);
  if (!lenso) {
    return createElement(
      'div',
      {
        ...props,
        className,
        role: 'tabpanel',
        hidden: state ? state.value !== value : false,
        'data-lenso-slot': 'tabs-panel-fallback',
      } as Record<string, unknown>,
      children,
    );
  }
  return createElement(
    lenso.Tabs.Panel as unknown as ComponentType<Record<string, unknown>>,
    { ...props, value, keepMounted, className },
    children,
  );
}

export const Tabs = Object.assign(TabsRoot, { List: TabList, Tab, Panel: TabPanel });
