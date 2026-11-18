import type { CSSProperties } from 'react';

/**
 * Lenso 组件会用 StyleX 原子类重写 `className`，业务选择器和定位样式
 * 必须落在最终宿主节点上。适配器用这两个 helper 合并 base/override，
 * 不通过 `!important` 或额外包裹语义节点解决。
 */

export type HostProps = {
  className?: string;
  style?: CSSProperties;
  [key: string]: unknown;
};

export function hostStyle(
  base?: CSSProperties | null,
  override?: CSSProperties | null,
): CSSProperties | undefined {
  if (!base) return override ?? undefined;
  if (!override) return base;
  return { ...base, ...override };
}

/**
 * 合并两组宿主 props：override 覆盖同名属性，className 去重拼接，
 * `style` 浅合并，base 的 `data-*` 在没有同名 override 时保留。
 */
export function mergeHostProps<T extends HostProps>(
  base: T,
  override?: Partial<T> | null,
): T {
  if (!override) return base;
  const tokens = [base.className, override.className]
    .flatMap((value) => (typeof value === 'string' ? value.trim().split(/\s+/u) : []))
    .filter((value) => value.length > 0);
  const className = [...new Set(tokens)].join(' ');
  const merged = {
    ...base,
    ...override,
    style: hostStyle(base.style, override.style as CSSProperties | undefined),
  } as T;
  if (className) merged.className = className;
  else delete merged.className;
  return merged;
}
