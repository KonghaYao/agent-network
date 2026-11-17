import type {
  ButtonRootProps,
  NumberFieldProps,
  SegmentedControlProps,
} from '@lenso/ui';
import {
  createElement,
  useEffect,
  useSyncExternalStore,
  type ChangeEvent,
  type ComponentProps,
  type ComponentPropsWithRef,
  type ComponentType,
  type ReactElement,
} from 'react';

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

/**
 * 共享的懒加载槽位工厂：Lenso 未就绪时渲染同语义的原生控件，
 * 就绪后由调用方从动态模块里取组件替换。所有控件共用一次
 * `import('@lenso/ui')`，不会把 UI 库静态拉进主包。
 */
function createLazySlot<Props>(
  tag: 'input' | 'textarea',
  select: (lenso: LensoModule) => ComponentType<Props>,
  defaults?: Partial<Props>,
) {
  function LazySlot(props: Props): ReactElement {
    const lenso = useLenso();
    const merged = defaults ? { ...defaults, ...props } : props;
    if (!lenso) {
      const fallback = { ...(merged as Record<string, unknown>) };
      delete fallback.fullWidth;
      return tag === 'input'
        ? createElement('input', fallback as ComponentPropsWithRef<'input'>)
        : createElement('textarea', fallback as ComponentPropsWithRef<'textarea'>);
    }
    return createElement(
      select(lenso) as ComponentType<Record<string, unknown>>,
      merged as Record<string, unknown>,
    );
  }
  return LazySlot;
}

type LegacyButtonProps = Omit<ButtonRootProps, 'onClick' | 'ref'> &
  Pick<ComponentPropsWithRef<'button'>, 'className' | 'onClick' | 'ref'>;

/** legacy class 名到 Lenso variant 的唯一映射点，避免调用点各自猜语义。 */
function buttonVariant(className: string | undefined, variant: ButtonRootProps['variant']) {
  if (variant) return variant;
  const tokens = new Set(className?.split(/\s+/u));
  if (tokens.has('primary') || tokens.has('danger')) return 'prominent';
  if (tokens.has('ghost')) return 'borderless';
  if (tokens.has('secondary') || tokens.has('default')) return 'bordered';
  return undefined;
}

export function Button({ className, variant, ...props }: LegacyButtonProps) {
  const lenso = useLenso();
  if (!lenso) return createElement('button', { ...props, className });
  const tokens = new Set(className?.split(/\s+/u));
  return createElement(lenso.Button, {
    ...props,
    className,
    variant: buttonVariant(className, variant),
    destructive: props.destructive ?? tokens.has('danger'),
    'data-lenso-slot': props['data-lenso-slot'] ?? 'button',
  } as ButtonRootProps);
}

type InputAdapterProps = Omit<ComponentPropsWithRef<'input'>, 'className'> & {
  fullWidth?: boolean;
};

export type { InputAdapterProps };

/** 单行输入：保留 id/name/maxLength/ref 与 RHF register 的原生契约。 */
export const Input = createLazySlot<InputAdapterProps>(
  'input',
  (lenso) => lenso.Input as unknown as ComponentType<InputAdapterProps>,
  { fullWidth: true },
);

type TextAreaAdapterProps = Omit<ComponentPropsWithRef<'textarea'>, 'className'> & {
  fullWidth?: boolean;
};

export type { TextAreaAdapterProps };

export const TextArea = createLazySlot<TextAreaAdapterProps>(
  'textarea',
  (lenso) => lenso.TextArea as unknown as ComponentType<TextAreaAdapterProps>,
  { fullWidth: true },
);

type SearchInputProps = Omit<ComponentPropsWithRef<'input'>, 'className' | 'type'> & {
  fullWidth?: boolean;
};

/** 搜索输入：Lenso 的复合标签页，只把真实 input 属性透传给输入框。 */
export function SearchInput({ fullWidth = true, onChange, ...props }: SearchInputProps) {
  const lenso = useLenso();
  if (!lenso) {
    return createElement('input', { ...props, onChange, type: 'search' });
  }
  return createElement(
    lenso.SearchField,
    { fullWidth },
    createElement(
      lenso.SearchField.Group,
      null,
      createElement(lenso.SearchField.SearchIcon),
      createElement(lenso.SearchField.Input, {
        ...props,
        ...(onChange
          ? {
              onValueChange: (next: string) =>
                onChange({ target: { value: next } } as ChangeEvent<HTMLInputElement>),
            }
          : {}),
      } as ComponentProps<typeof lenso.SearchField.Input>),
    ),
  );
}

type NumberInputProps = {
  id?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  'aria-label'?: string;
  onValueChange: (value: number) => void;
};

/** 数字输入：Lenso NumberField 使用 value/onValueChange，空值回落为 0。 */
export function NumberInput({
  id,
  value,
  min,
  max,
  step,
  disabled,
  'aria-label': ariaLabel,
  onValueChange,
}: NumberInputProps) {
  const lenso = useLenso();
  if (!lenso) {
    return createElement('input', {
      id,
      type: 'number',
      min,
      max,
      step,
      disabled,
      value,
      'aria-label': ariaLabel,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        onValueChange(Number(event.currentTarget.value)),
    });
  }
  return createElement(
    lenso.NumberField,
    {
      value,
      min,
      max,
      step,
      disabled,
      onValueChange: (next: number | null) => onValueChange(next ?? 0),
    } as NumberFieldProps,
    createElement(
      lenso.NumberField.Group,
      null,
      createElement(lenso.NumberField.Input, {
        id,
        disabled,
        'aria-label': ariaLabel,
      } as ComponentProps<typeof lenso.NumberField.Input>),
      createElement(lenso.NumberField.IncrementButton),
      createElement(lenso.NumberField.DecrementButton),
    ),
  );
}

type SegmentedControlAdapterProps = Omit<SegmentedControlProps, 'onValueChange'> & {
  onValueChange?: (value: string | null) => void;
};

export function SegmentedControl({ items, value, onValueChange, ...props }: SegmentedControlAdapterProps) {
  const lenso = useLenso();
  if (lenso) return createElement(lenso.SegmentedControl, { ...props, items, value, onValueChange });
  return createElement('div', { role: 'radiogroup', 'aria-label': props['aria-label'] },
    items.map((item) => createElement('button', {
      key: item.value,
      type: 'button',
      role: 'radio',
      'aria-checked': item.value === value,
      onClick: () => onValueChange?.(item.value),
    }, item.label)),
  );
}

export function ThemeScope({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const theme = useColorScheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return createElement('div', { ...props, className, 'data-theme': theme });
}
