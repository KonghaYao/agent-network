import { createElement, type ComponentPropsWithRef, type ReactNode } from 'react';

import { useLenso, useLensoBackendScope } from './lenso-runtime';

/** 仅提供内联候选列表视觉；过滤、焦点与选择仍由调用方的 Ariakit store 管理。 */
export function InlineCandidateList({ style, ...props }: Omit<ComponentPropsWithRef<'ul'>, 'defaultValue'>) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  const layout = { margin: 0, padding: 0, listStyle: 'none', minHeight: 1, ...style } as const;
  return !lenso || scope === 'fallback'
    ? createElement('ul', { ...props, style: layout })
    : createElement(lenso.List, { ...props, style: layout, variant: 'plain' });
}

export function InlineCandidateItem({ children }: { children: ReactNode }) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  const props = { role: 'presentation', style: { padding: 0, minHeight: 44 }, children };
  return !lenso || scope === 'fallback'
    ? createElement('li', props)
    : createElement(lenso.List.Item, props);
}
