import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { createIdentity, login, row, type SuiteIdentity } from './fixtures/memory-constellation';
import {
  SECRET_BEARER,
  SECRET_ENTITY_AWS,
  SECRET_PASSWORD,
  callsOf,
  installMemoryFenixStub,
  memoryRows,
  type MemoryCall,
} from './fixtures/memory-fenix';

/**
 * Fenix 星座图（上游 `Constellation.tsx`）在记忆弹窗中的验收：
 * canvas 可读标签、tooltip 掩码/无 HTML 注入、全屏与 Escape。
 */

async function openMemory(page: Page, directRoom: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, directRoom);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

async function hoverNode(page: Page): Promise<boolean> {
  const canvas = page.locator('.fenix-constellation-canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) return false;
  for (let rowIndex = 1; rowIndex < 12; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex < 12; columnIndex += 1) {
      const x = box.x + (box.width * columnIndex) / 12;
      const y = box.y + (box.height * rowIndex) / 12;
      await page.mouse.move(x, y);
      const display = await page
        .locator('.fenix-constellation-tooltip')
        .evaluate((element) => getComputedStyle(element).display);
      if (display !== 'none') return true;
    }
  }
  return false;
}

test.describe('Fenix 星座图移植', () => {
  let identity: SuiteIdentity;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('默认世界视角 tooltip 逐个掩码实体名，不出现原文', async ({ page }) => {
    // 世界视角的每个节点都带敏感实体名，保证悬停到任意节点都能验证实体行。
    const rows = memoryRows().map((rowItem) => ({
      ...rowItem,
      entities: ['deploy', SECRET_ENTITY_AWS, `password=${SECRET_PASSWORD}`],
    }));
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      rows,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    expect(await hoverNode(page)).toBe(true);
    const tooltip = page.locator('.fenix-constellation-tooltip');
    await expect(tooltip).toContainText('实体');
    await expect(tooltip).toContainText('[已隐藏]');
    // 实体行本身必须被掩码；只掩码正文/标签不足以满足该断言。
    await expect(tooltip).toContainText('password=[已隐藏]');
    await expect(tooltip).not.toContainText(SECRET_ENTITY_AWS);
    await expect(tooltip).not.toContainText(SECRET_PASSWORD);
  });

  test('画布交互：节点标签、滚轮缩放与拖拽平移都会更新绘制', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    const canvas = page.locator('.fenix-constellation-canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(0);

    // 悬停节点总会绘制标签（`paintConstellationFrame` 的 hovered 分支）。
    expect(await hoverNode(page)).toBe(true);
    await expect.poll(async () => Number(await canvas.getAttribute('data-labels'))).toBeGreaterThan(0);

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const centerX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;
    const initialZoom = Number(await canvas.getAttribute('data-zoom'));

    await page.mouse.move(centerX, centerY);
    await page.mouse.wheel(0, -300);
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-zoom')))
      .toBeGreaterThan(initialZoom);

    const initialPanX = Number(await canvas.getAttribute('data-pan-x'));
    const initialPanY = Number(await canvas.getAttribute('data-pan-y'));
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 80, centerY + 50, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-pan-x')))
      .toBeGreaterThan(initialPanX + 20);
    await expect
      .poll(async () => Number(await canvas.getAttribute('data-pan-y')))
      .toBeGreaterThan(initialPanY + 10);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
  });

  test('canvas 可读标签、tooltip 掩码防注入、全屏与 Escape', async ({ page }) => {
    const rows = memoryRows().map((rowItem) => ({
      ...rowItem,
      text: `<img src=x onerror="window.__xss=1"> runbook Authorization: Bearer ${SECRET_BEARER}`,
    }));
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      rows,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    const canvas = page.locator('.fenix-constellation-canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect(canvas).toHaveAttribute('role', 'img');
    await expect(canvas).toHaveAttribute('aria-label', /记忆星座图（3 个节点）/);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);

    expect(await hoverNode(page)).toBe(true);
    const tooltip = page.locator('.fenix-constellation-tooltip');
    await expect(tooltip).toContainText('[已隐藏]');
    await expect(tooltip).not.toContainText(SECRET_BEARER);
    await expect(tooltip).toContainText('<img');
    await expect(tooltip.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __xss?: number }).__xss)).toBeUndefined();

    await page.getByRole('button', { name: '全屏' }).click();
    await expect(page.locator('.fenix-constellation.is-fullscreen')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fenix-constellation.is-fullscreen')).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
  });

  test('390 暗色星座图：无页面横向溢出、axe 无 critical/serious', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    const wrapper = page.locator('.fenix-constellation');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });
    await expect(wrapper).toHaveAttribute('data-theme', 'dark');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);
  });
});
