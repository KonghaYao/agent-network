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
 * Memory 抽屉专用的 Lenso Tabs 懒加载适配。
 *
 * 与 `lenso-controls.ts` 共用同一个 `import('@lenso/ui')`；这个文件只被
 * MemoryDialog 懒加载 chunk 引用，不进入主入口预算。未就绪时渲染
 * `role=tablist/tab/tabpanel` 的原生节点，并保持受控值与面板挂载。
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

export function TabsRoot({
  value,
  onValueChange,
  className,
  children,
}: SlotProps & { value: string; onValueChange: (value: string) => void }): ReactElement {
  const lenso = useLenso();
  const content = createElement(TabsContext.Provider, { value: { value, onValueChange } }, children);
  if (!lenso) {
    return createElement('div', { className, 'data-lenso-slot': 'tabs-fallback' }, content);
  }
  return createElement(
    lenso.Tabs as unknown as ComponentType<Record<string, unknown>>,
    {
      value,
      onValueChange: (next: string | null) => onValueChange(next ?? ''),
      className,
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
