import type { ButtonRootProps } from '@lenso/ui';
import { createElement, useEffect, useSyncExternalStore, type ComponentPropsWithRef } from 'react';

type LensoModule = typeof import('@lenso/ui');
let loadedLenso: LensoModule | null = null;
let loadingLenso: Promise<LensoModule> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  loadingLenso ??= import('@lenso/ui').then((module) => {
    loadedLenso = module;
    for (const notify of listeners) notify();
    return module;
  });
  return () => { listeners.delete(listener); };
}

function useLenso() {
  return useSyncExternalStore(subscribe, () => loadedLenso, () => null);
}

function subscribeColorScheme(listener: () => void) {
  const query = matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function useColorScheme() {
  return useSyncExternalStore(
    subscribeColorScheme,
    () => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    () => 'light',
  );
}

type LegacyButtonProps = Omit<ButtonRootProps, 'onClick' | 'ref'> &
  Pick<ComponentPropsWithRef<'button'>, 'className' | 'onClick' | 'ref'>;

export function Button({ className, variant, ...props }: LegacyButtonProps) {
  const lenso = useLenso();
  if (!lenso) return createElement('button', { ...props, className });
  return createElement(lenso.Button, {
    ...props,
    className,
    variant: variant ?? (className?.split(/\s+/).includes('primary') ? 'prominent' : undefined),
  } as ButtonRootProps);
}

export function ThemeScope({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const theme = useColorScheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return createElement('div', { ...props, className, 'data-theme': theme });
}
