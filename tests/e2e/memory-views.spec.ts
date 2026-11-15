import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { createIdentity, login, row, type SuiteIdentity } from './fixtures/memory-constellation';
import {
  SECRET_BEARER,
  callsOf,
  installMemoryFenixStub,
  type MemoryCall,
} from './fixtures/memory-fenix';

/**
 * 视角 IA 的实体分支与响应式行为。
 *
 * 事实视角的视图模式、单次取数与时间线服务端分组在 `memory-fenix.spec.ts`；
 * 本文件覆盖实体视角（本阶段沿用既有实现）及其详情到 Fenix 记忆详情的接线。
 */

async function openMemory(page: Page, directRoom: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, directRoom);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

test.describe('Agent 记忆：实体视角与响应式', () => {
  let identity: SuiteIdentity;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('实体：列表 1 次取数、客户端筛选、关系图与记忆详情弹窗', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    await page.locator('#memory-perspective-entities').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });
    const rows = page.locator('#memory-entities-list .memory-entity-row');
    await expect(rows).toHaveCount(3);
    expect(callsOf(calls, 'network_agent_memory_entities')).toHaveLength(1);
    expect(callsOf(calls, 'network_agent_memory_overview')).toHaveLength(0);
    expect(callsOf(calls, 'network_agent_memory_list')).toHaveLength(0);

    await page.locator('#memory-entities-search').fill('beta');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#memory-entities-filter-note')).toContainText(
      '只在已加载的 3 个实体中筛选',
    );
    await page.locator('#memory-entities-search').fill('');

    await rows.first().click();
    await expect(page.locator('#memory-entity-detail')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-entity-observations')).toContainText(
      'Observation for Alpha Node',
    );
    await page.locator('#memory-entity-memories button').first().click();
    const detailText = page.locator('[data-memory-detail-text]');
    await expect(detailText).toBeVisible({ timeout: 15_000 });
    await expect(detailText).toContainText('[已隐藏]');
    await expect(detailText).not.toContainText(SECRET_BEARER);
    await page.getByRole('button', { name: '查看原文' }).click();
    await expect(detailText).toContainText(SECRET_BEARER);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(detailText).toHaveCount(0);

    await page.locator('#memory-entities-view-graph').click();
    await expect(page.locator('#memory-entity-graph-canvas')).toBeVisible({ timeout: 15_000 });
    expect(callsOf(calls, 'network_agent_memory_entities').length).toBeGreaterThanOrEqual(2);
    const graphCall = callsOf(calls, 'network_agent_memory_entities').find(
      (call) => call.args.view === 'graph',
    );
    expect(graphCall).toBeTruthy();
    expect(graphCall!.args.limit).toBe(200);
    await page.locator('#memory-entities-view-list').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible();
  });

  test('390 暗色实体视角：无页面横向溢出、axe 无 critical/serious', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await page.locator('#memory-perspective-entities').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });

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

  test('视角栏切换后焦点仍在被点击的视角按钮上', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    const world = page.locator('#memory-perspective-world');
    const experience = page.locator('#memory-perspective-experience');
    await world.focus();
    await page.keyboard.press('ArrowRight');
    await expect(experience).toBeFocused();
    await expect(experience).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-fenix-summary]')).toBeVisible({ timeout: 15_000 });
  });
});
