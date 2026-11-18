import {
  createElement,
  useSyncExternalStore,
  type ComponentPropsWithRef,
  type ComponentType,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';

export type LensoModule = typeof import('@lenso/ui');
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

export function useLenso() {
  return useSyncExternalStore(subscribe, () => loadedLenso, () => null);
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

export type PrimitiveFallbackTag =
  | 'div'
  | 'span'
  | 'hr'
  | 'nav'
  | 'progress'
  | 'kbd'
  | 'a'
  | 'label'
  | 'p'
  | 'fieldset'
  | 'legend';

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
  'required',
  'match',
]);

export function primitiveSlot(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function nativePrimitiveProps(
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
