import type { Page } from '@playwright/test';

/**
 * 读取 Lenso 语义色在当前主题下的计算值。
 *
 * 断言主题表面时比较语义变量而不是写死调色板，既保护“暗色生效”，
 * 也允许 Lenso token 调整而无需同步多处十六进制值。
 */
export async function semanticColor(
  page: Page,
  variable: string,
  property: 'backgroundColor' | 'color' = 'backgroundColor',
): Promise<string> {
  return page.evaluate(
    ({ name, prop }) => {
      const sample = document.createElement('div');
      sample.style.setProperty(
        prop === 'backgroundColor' ? 'background-color' : 'color',
        `var(${name})`,
      );
      document.body.append(sample);
      const value = getComputedStyle(sample)[prop];
      sample.remove();
      return value;
    },
    { name: variable, prop: property },
  );
}
