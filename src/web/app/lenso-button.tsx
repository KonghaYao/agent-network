import type { ButtonRootProps } from '@lenso/ui';
import { createElement, useRef, type ComponentPropsWithRef, type FocusEvent } from 'react';
import { useLenso, useLensoBackendScope } from './lenso-runtime';

type ButtonProps = Omit<ButtonRootProps, 'onClick' | 'ref'> &
  Pick<ComponentPropsWithRef<'button'>, 'className' | 'onClick' | 'ref'> & {
    'data-button-role'?: 'row' | 'normal' | 'icon';
  };

/** 旧 class 只在边界解释；业务无需随 SDK 的默认胶囊形状变更。 */
export function Button({ className, variant, ...props }: ButtonProps) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  const pinned = useRef(false);
  // 模块到达时保留正在交互的原生节点；不改变浮层 lease 或菜单焦点规则。
  if (!lenso || scope === 'fallback' || pinned.current) {
    return createElement('button', {
      ...props, className,
      onFocus: (event: FocusEvent<HTMLButtonElement>) => { pinned.current = true; props.onFocus?.(event); },
    });
  }
  const tokens = new Set(className?.split(/\s+/u));
  const resolved = variant ?? (tokens.has('primary') || tokens.has('danger') ? 'prominent'
    : tokens.has('ghost') ? 'borderless' : tokens.has('secondary') || tokens.has('default') ? 'bordered' : undefined);
  return createElement(lenso.Button, {
    ...props, className, variant: resolved, destructive: props.destructive ?? tokens.has('danger'),
  } as ButtonRootProps);
}
