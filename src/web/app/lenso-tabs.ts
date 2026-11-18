import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useLensoBackendScope, useLenso as useRuntimeLenso } from './lenso-runtime';

function useLenso() {
  const module = useRuntimeLenso();
  const scope = useLensoBackendScope();
  return scope === 'fallback' ? null : module;
}

/**
 * Memory 抽屉与添加好友弹窗共用的 Lenso Tabs 懒加载适配。
 *
 * 与 `lenso-controls.ts` 共用同一个 `import('@lenso/ui')`；只在懒加载
 * 对话框 chunk 中引用，不进入主入口预算。未就绪时渲染
 * `role=tablist/tab/tabpanel` 的原生节点，并保持受控值、roving tab stop
 * 与面板挂载。根节点显式撑满宽度，避免 Lenso 默认的
 * `align-items: flex-start` 让 tabs 与 panels 收缩。
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
  style?: CSSProperties;
  [key: string]: unknown;
};

/** Lenso Tabs root 默认 `align-items: flex-start`，会让抽屉里的 tabs 与 panels 收缩到内容宽度。 */
const TABS_ROOT_LAYOUT = { alignItems: 'stretch', width: '100%' } as const;

/** fallback 根与 Lenso 的 root 一致按列排布；宽度撑满容器，避免 tabs 收缩。 */
const TABS_ROOT_FALLBACK_LAYOUT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  width: '100%',
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
    return createElement(
      'div',
      { className, style: TABS_ROOT_FALLBACK_LAYOUT, 'data-lenso-slot': 'tabs-fallback' },
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

export function TabList({ className, children, xstyle, style, ...props }: SlotProps): ReactElement {
  const lenso = useLenso();
  if (!lenso) {
    return createElement(
      'div',
      {
        ...props,
        className,
        role: 'tablist',
        style: {
          display: 'flex',
          alignItems: 'stretch',
          width: '100%',
          ...style,
          ...(xstyle as CSSProperties | undefined),
        },
        'data-lenso-slot': 'tabs-list-fallback',
      } as Record<string, unknown>,
      children,
    );
  }
  return createElement(
    lenso.Tabs.List as unknown as ComponentType<Record<string, unknown>>,
    { ...props, className, style, xstyle },
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
    const selected = state?.value === value;
    return createElement(
      'button',
      {
        ...props,
        className,
        type: 'button',
        role: 'tab',
        'aria-selected': selected,
        tabIndex: selected ? 0 : -1,
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
