import type {
  ButtonRootProps,
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

  if (!lenso) {
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

export interface MenuAction {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  className?: string;
  disabled?: boolean;
}

export interface MenuAdapterProps {
  id: string;
  trigger: ReactElement;
  items: MenuAction[];
  label?: string;
  className?: string;
  itemClassName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sideOffset?: number;
  align?: 'start' | 'center' | 'end';
  container?: Element | DocumentFragment | null;
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
  sideOffset,
  align,
  container,
}: MenuAdapterProps) {
  const lenso = useLenso();
  const triggerRef = useRef<HTMLElement | null>(null);
  const triggerProps = {
    'aria-haspopup': 'menu' as const,
    'aria-controls': id,
    'aria-expanded': open,
    ref: triggerRef,
  };

  if (lenso) {
    const Content = lenso.Menu.Content as unknown as ComponentType<Record<string, unknown>>;
    const Item = lenso.Menu.Item as unknown as ComponentType<Record<string, unknown>>;
    const Trigger = lenso.Menu.Trigger as unknown as ComponentType<Record<string, unknown>>;
    return createElement(
      lenso.Menu as unknown as ComponentType<Record<string, unknown>>,
      {
        open,
        onOpenChange,
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
          style: { zIndex: 'var(--app-z-portal-local-menu)' },
          render: createElement('div', { className }),
        },
        items.map((item) =>
          createElement(
            Item,
            {
              key: item.id,
              id: item.id,
              className: itemClassName,
              disabled: item.disabled,
              onSelect: () => item.onSelect(),
              render: createElement('div', { className: itemClassName }),
            },
            item.label,
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
      if (!event.defaultPrevented) onOpenChange(!open);
    },
  });

  return createElement(
    Fragment,
    null,
    triggerElement,
    open
      ? createElement(
          'div',
          {
            id,
            role: 'menu',
            'aria-label': label,
            'data-lenso-slot': 'menu-fallback',
            className: [className, 'attach-menu-native'].filter(Boolean).join(' '),
            onKeyDown: (event: { key: string }) => {
              if (event.key !== 'Escape') return;
              onOpenChange(false);
              triggerRef.current?.focus();
            },
          },
          items.map((item, index) =>
            createElement(
              'button',
              {
                key: item.id,
                id: item.id,
                type: 'button',
                role: 'menuitem',
                className: itemClassName,
                disabled: item.disabled,
                autoFocus: index === 0,
                onClick: () => {
                  item.onSelect();
                  onOpenChange(false);
                },
              },
              item.label,
            ),
          ),
        )
      : null,
  );
}

export interface CheckboxAdapterProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
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
  if (!lenso) {
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
  if (!lenso) {
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

/**
 * 展示/布局原语（P0）：只提供懒加载适配，不替换现有 UI。
 *
 * 原生 fallback：
 * - Avatar / AvatarGroup / TagGroup / Card / Surface / Toolbar /
 *   ScrollShadow / ScrollEdge → `div`
 * - Badge / Chip / Tag / Spinner → `span`
 * - Separator → `hr`；ProgressBar → `progress`；ProgressCircle → `div[role=progressbar]`
 * - Pagination / NavigationBar → `nav`；Kbd → `kbd`；Link → `a`
 *
 * Lenso 未就绪时加 `data-lenso-slot="<slot>-fallback"`，就绪后保留
 * `data-lenso-slot="<slot>"`（组件自身也会设置同名默认值）。
 */
export type DisplayPrimitiveName =
  | 'Avatar'
  | 'AvatarGroup'
  | 'Badge'
  | 'Chip'
  | 'Tag'
  | 'TagGroup'
  | 'Card'
  | 'Surface'
  | 'Separator'
  | 'Skeleton'
  | 'EmptyState'
  | 'ProgressBar'
  | 'ProgressCircle'
  | 'Pagination'
  | 'Toolbar'
  | 'NavigationBar'
  | 'Kbd'
  | 'Spinner'
  | 'Link'
  | 'ScrollShadow'
  | 'ScrollEdge';

export type PrimitiveFallbackTag = 'div' | 'span' | 'hr' | 'nav' | 'progress' | 'kbd' | 'a';

export type LazyPrimitiveProps = {
  name: DisplayPrimitiveName;
  fallbackTag: PrimitiveFallbackTag;
  slot?: string;
  fallbackDefaults?: Record<string, unknown>;
  defaultChildren?: (lenso: LensoModule) => ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  ref?: ComponentPropsWithRef<'div'>['ref'];
  'data-lenso-slot'?: string;
  [key: string]: unknown;
};

export type PrimitiveProps = Omit<
  LazyPrimitiveProps,
  'name' | 'fallbackTag' | 'slot' | 'fallbackDefaults' | 'defaultChildren'
>;

/** 只属于 Lenso 的展示属性，不能落到原生 fallback 节点上。 */
const LENSO_ONLY_PROPS = new Set([
  'size',
  'color',
  'variant',
  'placement',
  'animationType',
  'overlap',
  'isGrid',
  'visibility',
  'hideScrollBar',
  'isEnabled',
  'scrollRef',
  'fadeStart',
  'isAttached',
  'elastic',
  'large',
  'backLabel',
  'leading',
  'trailing',
  'level',
  'onBack',
  'onVisibilityChange',
  'itemKey',
  'textValue',
  'items',
  'defaultItems',
  'onItemsChange',
  'onRemove',
  'selectionMode',
  'selectedKeys',
  'defaultSelectedKeys',
  'disabledKeys',
  'onSelectionChange',
  'render',
  'isActive',
  'offset',
  'value',
  'max',
  'min',
  'orientation',
  'xstyle',
]);

function primitiveSlot(name: DisplayPrimitiveName) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function nativePrimitiveProps(
  tag: PrimitiveFallbackTag,
  slot: string,
  fallbackDefaults: Record<string, unknown> | undefined,
  props: Record<string, unknown>,
) {
  const native: Record<string, unknown> = { ...fallbackDefaults, ...props };
  for (const key of LENSO_ONLY_PROPS) delete native[key];
  if (props.orientation) native['aria-orientation'] = props.orientation;
  if (!native['aria-label'] && typeof props.title === 'string') {
    native['aria-label'] = props.title;
  }
  if (tag === 'progress') {
    native.value = props.value;
    native.max = props.max;
  } else if (fallbackDefaults?.role === 'progressbar') {
    if (props.value != null) native['aria-valuenow'] = props.value;
    if (props.max != null) native['aria-valuemax'] = props.max;
    if (props.min != null) native['aria-valuemin'] = props.min;
  }
  if (tag === 'a' && props.disabled) {
    native['aria-disabled'] = 'true';
    native.tabIndex = -1;
    delete native.href;
  }
  native['data-lenso-slot'] = props['data-lenso-slot'] ?? `${slot}-fallback`;
  return native;
}

/** 通用懒加载原语：Lenso 未就绪时渲染同语义原生节点，就绪后换成对应组件。 */
export function LazyPrimitive({
  name,
  fallbackTag,
  slot = primitiveSlot(name),
  fallbackDefaults,
  defaultChildren,
  ...props
}: LazyPrimitiveProps): ReactElement {
  const lenso = useLenso();
  if (!lenso) {
    return createElement(
      fallbackTag as 'div',
      nativePrimitiveProps(fallbackTag, slot, fallbackDefaults, props) as ComponentPropsWithRef<'div'>,
    );
  }
  return createElement(
    lenso[name] as unknown as ComponentType<Record<string, unknown>>,
    {
      ...props,
      children: props.children ?? defaultChildren?.(lenso),
      'data-lenso-slot': props['data-lenso-slot'] ?? slot,
    },
  );
}

function displayPrimitive(
  name: DisplayPrimitiveName,
  fallbackTag: PrimitiveFallbackTag,
  fallbackDefaults?: Record<string, unknown>,
  defaultChildren?: (lenso: LensoModule) => ReactNode,
) {
  const slot = primitiveSlot(name);
  return function Primitive(props: PrimitiveProps): ReactElement {
    return createElement(LazyPrimitive, {
      ...props,
      name,
      fallbackTag,
      slot,
      fallbackDefaults,
      defaultChildren,
    });
  };
}

export const Avatar = /* @__PURE__ */ displayPrimitive('Avatar', 'div');
export const AvatarGroup = /* @__PURE__ */ displayPrimitive('AvatarGroup', 'div');
export const Badge = /* @__PURE__ */ displayPrimitive('Badge', 'span');
export const Chip = /* @__PURE__ */ displayPrimitive('Chip', 'span');
export const Tag = /* @__PURE__ */ displayPrimitive('Tag', 'span');
export const TagGroup = /* @__PURE__ */ displayPrimitive('TagGroup', 'div');
export const Card = /* @__PURE__ */ displayPrimitive('Card', 'div');
export const Surface = /* @__PURE__ */ displayPrimitive('Surface', 'div');
export const Separator = /* @__PURE__ */ displayPrimitive('Separator', 'hr');
export const Skeleton = /* @__PURE__ */ displayPrimitive('Skeleton', 'div', {
  'aria-hidden': 'true',
});
export const EmptyState = /* @__PURE__ */ displayPrimitive('EmptyState', 'div');
export const ProgressBar = /* @__PURE__ */ displayPrimitive(
  'ProgressBar',
  'progress',
  undefined,
  (lenso) =>
    createElement(lenso.ProgressBar.Track, null, createElement(lenso.ProgressBar.Fill)),
);
export const ProgressCircle = /* @__PURE__ */ displayPrimitive(
  'ProgressCircle',
  'div',
  { role: 'progressbar' },
  (lenso) =>
    createElement(
      lenso.ProgressCircle.Track,
      null,
      createElement(lenso.ProgressCircle.TrackCircle),
      createElement(lenso.ProgressCircle.FillCircle),
    ),
);
export const Pagination = /* @__PURE__ */ displayPrimitive('Pagination', 'nav');
export const Toolbar = /* @__PURE__ */ displayPrimitive('Toolbar', 'div', { role: 'toolbar' });
export const NavigationBar = /* @__PURE__ */ displayPrimitive('NavigationBar', 'nav');
export const Kbd = /* @__PURE__ */ displayPrimitive('Kbd', 'kbd');
export const Spinner = /* @__PURE__ */ displayPrimitive('Spinner', 'span', { role: 'status' });
export const Link = /* @__PURE__ */ displayPrimitive('Link', 'a');
export const ScrollShadow = /* @__PURE__ */ displayPrimitive('ScrollShadow', 'div');
export const ScrollEdge = /* @__PURE__ */ displayPrimitive('ScrollEdge', 'div', {
  'aria-hidden': 'true',
});

/**
 * Lenso 展示组件会用 StyleX 原子类覆盖传入的 `className`；需要保留现有
 * class/DOM 契约时，把 class 留在原生外壳上，让 Lenso 组件铺满外壳。
 * 这些 reset 只负责尺寸与背景透明，颜色/边框由外壳决定。
 */
export const LENSO_AVATAR_FILL = {
  width: '100%',
  height: '100%',
  borderRadius: 'inherit',
  background: 'transparent',
  color: 'inherit',
  fontSize: 'inherit',
} as const;

export const LENSO_BADGE_FILL = {
  display: 'inline-flex',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  padding: 0,
  border: 0,
  borderRadius: 'inherit',
  background: 'transparent',
  color: 'inherit',
  fontSize: 'inherit',
  fontWeight: 'inherit',
  lineHeight: 'inherit',
  gap: 0,
} as const;

export const LENSO_SKELETON_FILL = {
  width: '100%',
  height: '100%',
  borderRadius: 'inherit',
} as const;

export function ThemeScope({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const theme = useColorScheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return createElement('div', { ...props, className, 'data-theme': theme });
}
