import type {
  NumberFieldProps,
  SegmentedControlProps,
} from '@lenso/ui';
import {
  cloneElement,
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ComponentProps,
  type ComponentPropsWithRef,
  type ComponentType,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { restoreMenuFocus, useFallbackMenuKeyboard } from './lenso-menu-focus';

import {
  LensoBackendProvider,
  useBackendLease,
  useLensoBackendScope,
} from './lenso-runtime';
import {
  nativePrimitiveProps,
  primitiveSlot,
  useLenso,
  type LensoModule,
  type PrimitiveFallbackTag,
  type PrimitiveProps,
} from './lenso-display';

export {
  Avatar,
  AvatarGroup,
  Badge,
  Card,
  Chip,
  EmptyState,
  Kbd,
  LazyPrimitive,
  LENSO_AVATAR_FILL,
  LENSO_BADGE_FILL,
  LENSO_SKELETON_FILL,
  Link,
  NavigationBar,
  Pagination,
  ProgressBar,
  ProgressCircle,
  ScrollEdge,
  ScrollShadow,
  Separator,
  Skeleton,
  Spinner,
  Surface,
  Tag,
  TagGroup,
  Toolbar,
  useLenso,
} from './lenso-display';
export type {
  DisplayPrimitiveName,
  LazyPrimitiveProps,
  PrimitiveFallbackTag,
  PrimitiveProps,
} from './lenso-display';

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
    const scope = useLensoBackendScope();
    const merged = defaults ? { ...defaults, ...props } : props;
    if (!lenso || scope === 'fallback') {
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

export { Button } from './lenso-button';
export { List, ListItem } from './lenso-list';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectAdapterProps {
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  ref?: ComponentPropsWithRef<'button'>['ref'];
}

/**
 * 下拉选择：未就绪时回退原生 select；就绪后 `id` 挂在 trigger，
 * `name/required/disabled` 挂在根节点，保持受控值与 RHF Controller 契约。
 */
export function Select({
  id,
  name,
  required,
  disabled,
  value,
  options,
  onChange,
  placeholder,
  className,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  ref,
}: SelectAdapterProps) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  const [open, setOpen] = useState(false);
  const hasEmpty = options.some((option) => option.value === '');
  const lensoValue = value === '' && placeholder && !hasEmpty ? null : value;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const assignTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
    },
    [ref],
  );

  // Radix 弹窗在 document 捕获阶段监听 Escape；下拉展开时先在 window 捕获阶段
  // 收口，避免一次 Escape 同时关闭下拉和整个弹窗。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!lenso || scope === 'fallback') {
    return createElement(
      'select',
      {
        id,
        name,
        required,
        disabled,
        value,
        className,
        'aria-label': ariaLabel,
        'aria-invalid': ariaInvalid,
        'aria-describedby': ariaDescribedBy,
        'data-lenso-slot': 'select-fallback',
        ref: ref as ComponentPropsWithRef<'select'>['ref'],
        onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange(event.currentTarget.value),
      },
      placeholder && !hasEmpty
        ? createElement('option', { key: '', value: '', disabled: true }, placeholder)
        : null,
      options.map((option) =>
        createElement(
          'option',
          { key: option.value, value: option.value, disabled: option.disabled },
          option.label,
        ),
      ),
    );
  }

  const Root = lenso.Select as unknown as ComponentType<Record<string, unknown>>;
  const Trigger = lenso.Select.Trigger as unknown as ComponentType<Record<string, unknown>>;
  const Value = lenso.Select.Value as unknown as ComponentType<Record<string, unknown>>;
  const Indicator = lenso.Select.Indicator as unknown as ComponentType<Record<string, unknown>>;
  const Content = lenso.Select.Content as unknown as ComponentType<Record<string, unknown>>;
  const Item = lenso.Select.Item as unknown as ComponentType<Record<string, unknown>>;
  const ItemText = lenso.Select.ItemText as unknown as ComponentType<Record<string, unknown>>;
  const ItemIndicator = lenso.Select.ItemIndicator as unknown as ComponentType<
    Record<string, unknown>
  >;
  return createElement(
    Root,
    {
      value: lensoValue,
      name,
      required,
      disabled,
      placeholder,
      open,
      onOpenChange: (next: boolean) => setOpen(next),
      items: options.map((option) => ({
        value: option.value,
        label: option.label,
        disabled: option.disabled,
      })),
      onValueChange: (next: string | null) => onChange(next ?? ''),
    },
    createElement(
      Trigger,
      {
        id,
        ref: assignTriggerRef,
        className,
        'aria-label': ariaLabel,
        'aria-invalid': ariaInvalid,
        'aria-describedby': ariaDescribedBy,
        'data-lenso-slot': 'select-trigger',
      },
      createElement(Value),
      createElement(Indicator),
    ),
    createElement(
      Content,
      null,
      options.map((option) =>
        createElement(
          Item,
          { key: option.value, value: option.value, disabled: option.disabled },
          createElement(ItemText, null, option.label),
          createElement(ItemIndicator),
        ),
      ),
    ),
  );
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
  const scope = useLensoBackendScope();
  if (!lenso || scope === 'fallback') {
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
  const scope = useLensoBackendScope();
  if (!lenso || scope === 'fallback') {
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

export interface MenuAction {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  className?: string;
  disabled?: boolean;
  variant?: 'default' | 'danger';
}

/** 分隔线不是动作，单独作为条目挂在同一列表里，保证键盘顺序不变。 */
export interface MenuSeparatorAction {
  id: string;
  separator: true;
}

export type MenuEntry = MenuAction | MenuSeparatorAction;

/** Lenso 关闭原因；fallback 也按同一词汇上报，调用方可区分选中与取消。 */
export interface MenuOpenChangeDetails {
  reason?: 'item-press' | 'outside-press' | 'escape-key' | 'close-press';
}

export interface MenuAdapterProps {
  id: string;
  trigger: ReactElement;
  items: MenuEntry[];
  label?: string;
  className?: string;
  itemClassName?: string;
  open: boolean;
  onOpenChange: (open: boolean, details?: MenuOpenChangeDetails) => void;
  /** fallback 需要按触发按钮定位并进入本地 Portal 带时启用。 */
  fallbackAnchor?: boolean;
  /**
   * 条目会打开全局对话框时启用：选中瞬间先隐藏 popup，再执行动作。
   * Lenso 的退场动画会保活 popup 约半秒，不能让它盖住同帧打开的 dialog。
   */
  instantCloseOnSelect?: boolean;
  sideOffset?: number;
  align?: 'start' | 'center' | 'end';
  container?: Element | DocumentFragment | null;
}

function isSeparator(entry: MenuEntry): entry is MenuSeparatorAction {
  return 'separator' in entry && entry.separator === true;
}

/** fallback 菜单按触发按钮定位，并夹在视口内；Lenso 由 SDK 自己完成定位。 */
function fallbackMenuStyle(
  trigger: HTMLElement | null,
  align: MenuAdapterProps['align'],
  sideOffset: number | undefined,
): CSSProperties | undefined {
  if (typeof window === 'undefined' || !trigger) return undefined;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(260, window.innerWidth - 16);
  const preferred = align === 'end'
    ? rect.right - width
    : align === 'center'
      ? rect.left + (rect.width - width) / 2
      : rect.left;
  const left = Math.max(8, Math.min(preferred, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(rect.bottom + (sideOffset ?? 4), window.innerHeight - 8));
  return {
    position: 'fixed',
    left,
    top,
    width,
    maxHeight: `calc(100vh - ${Math.round(top)}px - 8px)`,
    overflowY: 'auto',
  };
}

/**
 * 动作菜单：Lenso 未就绪时渲染同样可用的原生菜单，就绪后换成 Lenso Menu。
 * 触发元素与菜单项 id 原样保留；`open` 由调用方持有，异步替换不会丢状态。
 */
export function Menu({
  id,
  trigger,
  items,
  label,
  className,
  itemClassName,
  open,
  onOpenChange,
  fallbackAnchor,
  instantCloseOnSelect,
  sideOffset,
  align,
  container,
}: MenuAdapterProps) {
  const backend = useBackendLease(open);
  const module = useLenso();
  // 打开时选定的 backend 在整个 open 期间不变；模块晚到只影响下一次打开。
  const lenso = backend === 'lenso' ? module : null;
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const [instantHidden, setInstantHidden] = useState(false);
  const triggerProps = {
    'aria-haspopup': 'menu' as const,
    'aria-controls': id,
    'aria-expanded': open,
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const ref = (trigger.props as { ref?: import('react').Ref<HTMLElement> }).ref;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
  };

  const handleOpenChange = useCallback(
    (next: boolean, details?: MenuOpenChangeDetails) => {
      // 重新打开时恢复可见；选中关闭导致的隐藏不能泄漏到下一次打开。
      if (next) setInstantHidden(false);
      onOpenChange(next, details);
      if (!next) restoreMenuFocus(triggerRef);
    },
    [onOpenChange],
  );
  useFallbackMenuKeyboard(!lenso, open, triggerRef, menuRef, handleOpenChange);

  /**
   * Lenso 关闭菜单会保活 popup 播放退场动画；条目要打开 dialog 时必须
   * 先同步隐藏，避免 dialog 第一帧被旧菜单覆盖。fallback 同样先隐藏再动作。
   */
  const hideBeforeSelect = useCallback(() => {
    if (!instantCloseOnSelect) return;
    flushSync(() => setInstantHidden(true));
  }, [instantCloseOnSelect]);

  // fallback 没有 SDK 的外部点击管理；Lenso 就绪后交给原生控制器。
  useEffect(() => {
    if (!open || lenso) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      handleOpenChange(false, { reason: 'outside-press' });
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [lenso, handleOpenChange, open]);

  if (lenso) {
    const Content = lenso.Menu.Content as unknown as ComponentType<Record<string, unknown>>;
    const Item = lenso.Menu.Item as unknown as ComponentType<Record<string, unknown>>;
    const Separator = lenso.Menu.Separator as unknown as ComponentType<Record<string, unknown>>;
    const Trigger = lenso.Menu.Trigger as unknown as ComponentType<Record<string, unknown>>;
    return createElement(
      LensoBackendProvider,
      { backend },
      createElement(
        lenso.Menu as unknown as ComponentType<Record<string, unknown>>,
        {
          open,
          onOpenChange: handleOpenChange,
          container:
            container ?? (typeof document === 'undefined' ? undefined : document.body),
        },
        createElement(Trigger, {
          render: cloneElement(trigger as ReactElement<Record<string, unknown>>, triggerProps),
        }),
        createElement(
          Content,
          {
            id,
            className,
            'aria-label': label,
            sideOffset,
            align,
            ref: menuRef,
            style: {
              zIndex: 'var(--app-z-portal-local-menu)',
              ...(instantHidden ? { display: 'none' } : null),
            },
            render: createElement('div', { className }),
          },
          items.map((item) =>
            isSeparator(item)
              ? createElement(Separator, { key: item.id, id: item.id,
                  render: createElement('div', { className: 'room-menu-sep' }) })
              : createElement(
                  Item,
                  {
                    key: item.id,
                    id: item.id,
                    variant: item.variant,
                    disabled: item.disabled,
                    onSelect: () => {
                      hideBeforeSelect();
                      item.onSelect();
                    },
                    render: createElement('div', {
                      className: item.className ?? itemClassName,
                    }),
                  },
                  item.label,
                ),
          ),
        ),
      ),
    );
  }

  const triggerElement = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
    ...triggerProps,
    onClick: (event: { defaultPrevented: boolean }) => {
      const original = (trigger.props as { onClick?: (next: typeof event) => void }).onClick;
      original?.(event);
      if (!event.defaultPrevented) handleOpenChange(!open);
    },
  });

  return createElement(
    LensoBackendProvider,
    { backend },
    createElement(
      Fragment,
      null,
      triggerElement,
      open
        ? createElement(
            'div',
            {
              id,
              ref: menuRef,
              role: 'menu',
              'aria-label': label,
              'data-lenso-slot': 'menu-fallback',
              className: [className, 'attach-menu-native'].filter(Boolean).join(' '),
              style: fallbackAnchor || instantHidden
                ? {
                    ...(fallbackAnchor
                      ? {
                          ...fallbackMenuStyle(triggerRef.current, align, sideOffset),
                          zIndex: 'var(--app-z-portal-local-menu)',
                        }
                      : null),
                    ...(instantHidden ? { display: 'none' } : null),
                  }
                : undefined,
              onKeyDown: (event: { key: string }) => {
                if (event.key !== 'Escape') return;
                handleOpenChange(false, { reason: 'escape-key' });
                triggerRef.current?.focus();
              },
            },
            items.map((item, index) =>
              isSeparator(item)
                ? createElement('div', {
                    key: item.id,
                    id: item.id,
                    role: 'separator',
                    className: 'room-menu-sep',
                  })
                : createElement(
                    'button',
                    {
                      key: item.id,
                      id: item.id,
                      type: 'button',
                      role: 'menuitem',
                      className: item.className ?? itemClassName,
                      disabled: item.disabled,
                      'data-variant': item.variant,
                      autoFocus: index === 0,
                      onClick: () => {
                        hideBeforeSelect();
                        handleOpenChange(false, { reason: 'item-press' });
                        // Radix fallback Modal 在打开帧记录焦点，不能留下即将卸载的条目。
                        triggerRef.current?.focus({ preventScroll: true });
                        item.onSelect();
                      },
                    },
                    item.label,
                  ),
            ),
          )
        : null,
    ),
  );
}

export interface CheckboxAdapterProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
  children?: ReactNode;
  'aria-label'?: string;
  'data-task-only'?: boolean;
}

/** 复选框：根节点保留受控 `checked`；未就绪时回退原生 input + label。 */
export function Checkbox({
  checked,
  onCheckedChange,
  className,
  children,
  ...props
}: CheckboxAdapterProps) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  if (!lenso || scope === 'fallback') {
    return createElement(
      'label',
      { className },
      createElement('input', {
        ...props,
        type: 'checkbox',
        checked,
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onCheckedChange(event.currentTarget.checked),
      }),
      children,
    );
  }
  const Content = lenso.Checkbox.Content as unknown as ComponentType<Record<string, unknown>>;
  const Control = lenso.Checkbox.Control as unknown as ComponentType<Record<string, unknown>>;
  const Indicator = lenso.Checkbox.Indicator as unknown as ComponentType<Record<string, unknown>>;
  return createElement(
    lenso.Checkbox as unknown as ComponentType<Record<string, unknown>>,
    {
      ...props,
      className,
      checked,
      onCheckedChange: (next: boolean) => onCheckedChange(next === true),
      'data-lenso-slot': 'checkbox',
      render: createElement('button', { type: 'button', className }),
    },
    createElement(
      Content,
      null,
      createElement(Control, null, createElement(Indicator, null)),
      children,
    ),
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupAdapterProps {
  id?: string;
  name?: string;
  value: string;
  options: readonly RadioOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  itemClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/**
 * 单选组：未就绪时回退原生 radio，就绪后换成 Lenso RadioGroup/Radio。
 * 根按钮保留可访问名与 role=radio；隐藏原生 radio 继续承担 `name` 表单值。
 */
export function RadioGroup({
  id,
  name,
  value,
  options,
  onChange,
  disabled,
  required,
  className,
  itemClassName,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: RadioGroupAdapterProps) {
  const lenso = useLenso();
  const scope = useLensoBackendScope();
  if (!lenso || scope === 'fallback') {
    return createElement(
      'div',
      {
        id,
        role: 'radiogroup',
        className,
        'aria-label': ariaLabel,
        'aria-labelledby': ariaLabelledBy,
        'aria-disabled': disabled ? 'true' : undefined,
        'data-lenso-slot': 'radio-group-fallback',
      },
      options.map((option) =>
        createElement(
          'label',
          { key: option.value, className: itemClassName },
          createElement('input', {
            type: 'radio',
            name,
            value: option.value,
            checked: value === option.value,
            disabled: disabled || option.disabled,
            required,
            onChange: () => onChange(option.value),
          }),
          option.label,
        ),
      ),
    );
  }

  const Group = lenso.RadioGroup as unknown as ComponentType<Record<string, unknown>>;
  const Radio = lenso.Radio as unknown as ComponentType<Record<string, unknown>>;
  const Content = lenso.Radio.Content as unknown as ComponentType<Record<string, unknown>>;
  const Control = lenso.Radio.Control as unknown as ComponentType<Record<string, unknown>>;
  const Indicator = lenso.Radio.Indicator as unknown as ComponentType<Record<string, unknown>>;
  return createElement(
    Group,
    {
      id,
      value: value === '' ? null : value,
      name,
      disabled,
      required,
      className,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      'data-lenso-slot': 'radio-group',
      onValueChange: (next: string | null) => onChange(next ?? ''),
    },
    options.map((option) =>
      createElement(
        Radio,
        {
          key: option.value,
          value: option.value,
          disabled: option.disabled,
          className: itemClassName,
          'data-lenso-slot': 'radio',
        },
        createElement(
          Content,
          null,
          createElement(Control, null, createElement(Indicator)),
          option.label,
        ),
      ),
    ),
  );
}

export function ThemeScope({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const theme = useColorScheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return createElement('div', { ...props, className, 'data-theme': theme });
}

/** 内联反馈条：原生 fallback 原样保留 role/aria-live，就绪后交给 Lenso Alert。 */
export function Alert({
  status = 'default',
  title,
  children,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'title'> & {
  status?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
}) {
  const lenso = useLenso();
  if (!lenso) return createElement('div', props, title, children);
  return createElement(
    lenso.Alert,
    { status, ...props } as ComponentProps<typeof lenso.Alert>,
    createElement(lenso.Alert.Content, null,
      title ? createElement(lenso.Alert.Title, null, title) : null,
      createElement(lenso.Alert.Description, null, children)),
  );
}

type FieldPartName = 'Label' | 'Description' | 'FieldError' | 'Fieldset' | 'FieldsetLegend';

function fieldPrimitive(
  name: FieldPartName,
  tag: PrimitiveFallbackTag,
  fallbackDefaults?: Record<string, unknown>,
  lensoDefaults?: Record<string, unknown>,
) {
  const slot = primitiveSlot(name);
  return (props: PrimitiveProps): ReactElement => {
    const lenso = useLenso();
    const scope = useLensoBackendScope();
    if (!lenso || scope === 'fallback') {
      return createElement(
        tag as 'p',
        nativePrimitiveProps(tag, slot, fallbackDefaults, props) as ComponentPropsWithRef<'p'>,
      );
    }
    return createElement(lenso[name] as unknown as ComponentType<Record<string, unknown>>, {
      ...lensoDefaults,
      ...props,
      'data-lenso-slot': props['data-lenso-slot'] ?? slot,
    });
  };
}

export const Label = fieldPrimitive('Label', 'label');
export const Description = fieldPrimitive('Description', 'p');
export const FieldError = fieldPrimitive(
  'FieldError',
  'p',
  { role: 'alert' },
  { match: true, role: 'alert' },
);
export const Fieldset = fieldPrimitive('Fieldset', 'fieldset');
export const FieldsetLegend = fieldPrimitive('FieldsetLegend', 'legend');
