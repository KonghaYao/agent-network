import { expect, type Page } from '@playwright/test';

/** 在真实 Lenso 页面上检查尺寸，而不是仅匹配 CSS 源码。 */
export async function expectTaskDetailStyle(page: Page, width: number, colorScheme: string) {
  const values = await page.evaluate(() => {
    const pick = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`缺少 ${selector}`);
      const css = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        font: css.fontSize, line: css.lineHeight, height: css.height,
        radius: css.borderRadius, border: css.borderWidth, gap: css.gap,
        padding: css.padding, background: css.backgroundColor, zIndex: css.zIndex,
        rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width },
      };
    };
    const selectors = ['[data-task-toolbar] .task-dock-title', '.task-dock-toggle', '.task-dock-preview',
      '.task-preview-meta', '[data-task-surface="panel"]', '.task-dock-item', '.task-preview-popover',
      '.task-preview-sender', '.task-preview-time', '.task-preview-ask', '.task-preview-all',
      '.task-bar-preview', '[data-task-surface="summary"]', '.task-preview-head', '.task-preview-scroll',
      '.task-preview-actions', '#composer', '#messages', '#jump-latest'];
    return Object.fromEntries(selectors.map((selector) => [selector, pick(selector)]));
  });
  const at = (selector: string) => values[selector]!;
  for (const selector of ['[data-task-toolbar] .task-dock-title', '.task-dock-preview', '.task-preview-sender']) {
    expect(at(selector).font).toBe('14px');
    expect(at(selector).line).toBe('20px');
  }
  for (const selector of ['.task-preview-meta', '.task-preview-time']) {
    expect(at(selector).font).toBe('12px');
    expect(at(selector).line).toBe('16px');
  }
  expect(at('.task-bar-preview').font).toBe('13px');
  expect(at('.task-bar-preview').line).toBe('19px');
  expect(at('.task-dock-toggle').height).toBe('28px');
  expect(at('.task-dock-toggle').radius).toBe('6px');
  expect(at('.task-dock-toggle').gap).toBe('8px');
  expect(at('.task-preview-ask').height).toBe(width < 760 ? '44px' : '36px');
  expect(at('.task-preview-ask').radius).toBe('8px');
  expect(at('.task-preview-ask').border).toBe('1px');
  expect(at('.task-preview-all').height).toBe(width < 760 ? '44px' : '40px');
  expect(at('.task-preview-all').border).toBe('0px');
  for (const selector of ['[data-task-surface="summary"]', '.task-preview-popover']) {
    expect(at(selector).radius).toBe('12px');
    expect(at(selector).border).toBe('0px');
  }
  expect(at('.task-dock-item').border).toBe('0px');
  await expect(page.locator('#task-dock-count [data-lenso-slot="badge"]')).toHaveCSS('height', '18px');
  await expect(page.locator('#task-dock-count [data-lenso-slot="badge"]')).toHaveCSS('font-size', '11px');
  await expect(page.locator('.task-dock-item-trigger').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.task-dock-item-trigger').first()).toHaveCSS('box-shadow', 'none');
  await expect(page.locator('#task-dock-toggle .task-dock-title')).toHaveCSS('font-size', '11px');
  for (const selector of ['.task-dock-ask', '.task-dock-complete']) {
    await expect(page.locator(selector).first()).toHaveCSS('height', width < 760 ? '44px' : '32px');
    await expect(page.locator(selector).first()).toHaveCSS('font-size', '13px');
    await expect(page.locator(selector).first()).toHaveCSS('border-radius', '8px');
  }
  const row = await page.locator('.task-dock-item').first().boundingBox();
  const body = await page.locator('.task-dock-preview').first().boundingBox();
  expect(body!.width).toBeGreaterThanOrEqual(row!.width - 1);
  await expect(page.locator('.task-dock-item [data-lenso-slot="card"]')).toHaveCount(0);
  await expect(page.locator('.task-dock-item .task-dock-avatars')).toHaveCount(0);
  const recent = await page.locator('.task-preview-recent').first().boundingBox();
  const recentTime = await page.locator('.task-preview-recent-time').first().boundingBox();
  expect(Math.abs(recent!.x + recent!.width - recentTime!.x - recentTime!.width)).toBeLessThanOrEqual(1);
  expect(at('.task-preview-head').gap).toBe('8px');
  expect(at('.task-preview-scroll').padding).toBe(width < 760 ? '12px' : '16px');
  expect(at('.task-preview-popover').rect.width).toBeCloseTo(width < 760 ? Math.min(width * .92, 390) : 400, 0);
  expect(parseFloat(at('.task-preview-popover').height)).toBeLessThanOrEqual(844 * .6 + 1);
  expect(at('.task-preview-popover').background).not.toBe('transparent');
  expect(at('.task-preview-popover').background).not.toMatch(/rgba\([^)]*,\s*(?:0|0?\.\d+)\)$/u);
  expect(Number(at('.task-preview-popover').zIndex)).toBeGreaterThan(Number(at('#messages').zIndex) || 0);
  const intersects = (a: typeof values[string]['rect'], b: typeof a) =>
    Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
    Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  expect(intersects(at('.task-preview-popover').rect, at('#composer').rect)).toBe(false);
  if (await page.locator('#jump-latest').isVisible()) {
    expect(intersects(at('.task-preview-popover').rect, at('#jump-latest').rect)).toBe(false);
  }
  const footer = page.locator('.task-preview-actions');
  const before = await footer.boundingBox();
  await page.locator('.task-preview-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  expect(await footer.boundingBox()).toEqual(before);
  await page.locator('.task-preview-scroll').evaluate((node) => { node.scrollTop = 0; });
  console.log('TASK_COMPUTED', width, colorScheme, JSON.stringify({
    title: `${at('.task-preview-sender').font}/${at('.task-preview-sender').line}`,
    meta: `${at('.task-preview-time').font}/${at('.task-preview-time').line}`,
    chip: at('.task-dock-toggle').height, secondary: at('.task-preview-ask').height,
    cardRadius: at('.task-preview-popover').radius, cardBorder: at('.task-preview-popover').border,
    panelWidth: at('.task-preview-popover').rect.width, background: at('.task-preview-popover').background,
  }));
}
