import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { createIdentity, login, row, type SuiteIdentity } from './fixtures/memory-constellation';
import {
  SECRET_BEARER,
  SECRET_CONTEXT,
  SECRET_ENTITY_AWS,
  SECRET_URL,
  callsOf,
  installMemoryFenixStub,
  memoryRows,
  type FenixRow,
  type MemoryCall,
} from './fixtures/memory-fenix';

/**
 * Agent 记忆弹窗的 Fenix 视角 IA（阶段 4）。
 *
 * 断言口径：每个用户动作最多 1 次 `network_agent_memory_graph`；
 * overview/list/timeline 调用 0 次；视图切换、表格翻页、时间线缩放不发请求。
 */

async function openMemory(page: Page, directRoom: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, directRoom);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await expect(page.locator('#room-row-menu')).toBeVisible();
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

function generatedRows(count: number): FenixRow[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, '0');
    const month = String(((index + 7) % 12) + 1).padStart(2, '0');
    return {
      id: `bulk-${index}`,
      text: `Bulk memory ${index}`,
      fact_type: 'world',
      state: 'valid',
      occurred_at: `2026-${month}-${day}T09:00:00.000Z`,
      occurred_start: `2026-${month}-${day}T09:00:00.000Z`,
      occurred_end: null,
      mentioned_at: `2026-${month}-${day}T10:00:00.000Z`,
      entities: ['bulk'],
      proof_count: 1,
      tags: [],
    };
  });
}

test.describe('Agent 记忆：Fenix 视角 IA', () => {
  let identity: SuiteIdentity;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('世界视角一次 graph；视图切换/时间线缩放 0 请求', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    await expect(page.locator('[data-fenix-summary]')).toContainText(
      '显示 12 条记忆中的 3 条',
      { timeout: 15_000 },
    );
    await expect(page.locator('#memory-perspective-world')).toHaveAttribute('aria-pressed', 'true');

    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
    const graphCall = callsOf(calls, 'network_agent_memory_graph')[0]!;
    expect(graphCall.args.include_rows).toBe(true);
    expect(graphCall.args.type).toBe('world');
    expect(
      typeof graphCall.args.timezone === 'string' || typeof graphCall.args.tz_offset_minutes === 'number',
    ).toBe(true);
    expect(callsOf(calls, 'network_agent_memory_overview')).toHaveLength(0);
    expect(callsOf(calls, 'network_agent_memory_list')).toHaveLength(0);
    expect(callsOf(calls, 'network_agent_memory_timeline')).toHaveLength(0);

    // 星座图（默认视图）
    await expect(page.locator('.fenix-constellation-canvas')).toBeVisible({ timeout: 15_000 });

    // 表格：本地展示窗口，不发请求
    await page.getByRole('button', { name: '表格' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(3);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);

    // 时间线：使用服务端 timeline.groups（标签带 S: 前缀），缩放/导航不发请求
    await page.getByRole('button', { name: '时间线' }).click();
    await expect(page.locator('.agent-memory-content')).toContainText('S:', { timeout: 15_000 });
    const beforeZoom = callsOf(calls, 'network_agent_memory_graph').length;
    await page.getByRole('button', { name: '放大' }).click();
    await page.getByRole('button', { name: '放大' }).click();
    await page.getByRole('button', { name: '缩小' }).click();
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(beforeZoom);

    // 切回星座图：仍然 0 请求
    await page.getByRole('button', { name: '星座图' }).click();
    await expect(page.locator('.fenix-constellation-canvas')).toBeVisible();
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
  });

  test('表格翻页只是本地窗口：120 行 1 次 graph', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      rows: generatedRows(120),
      totalUnits: 120,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    await page.getByRole('button', { name: '表格' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(100, { timeout: 15_000 });
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);

    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(20);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
  });

  test('详情默认掩码，查看原文后才揭示；get 恰好 1 次', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    await page.getByRole('button', { name: '表格' }).click();
    await page.locator('table tbody tr').first().click();
    const detailText = page.locator('[data-memory-detail-text]');
    await expect(detailText).toBeVisible({ timeout: 15_000 });
    await expect(detailText).toContainText('[已隐藏]');
    for (const secret of [SECRET_BEARER, SECRET_URL, SECRET_CONTEXT]) {
      await expect(detailText).not.toContainText(secret);
    }
    await expect(page.locator('[data-memory-detail-context]')).not.toContainText(SECRET_CONTEXT);
    // 实体即使未揭示也保持掩码。
    await expect(page.locator('[role="dialog"]').last()).not.toContainText(SECRET_ENTITY_AWS);
    expect(callsOf(calls, 'network_agent_memory_get')).toHaveLength(1);

    await page.getByRole('button', { name: '查看原文' }).click();
    await expect(detailText).toContainText(SECRET_BEARER);
    await expect(detailText).toContainText(SECRET_URL);
    await expect(page.locator('[data-memory-detail-context]')).toContainText(SECRET_CONTEXT);
    await expect(page.locator('[role="dialog"]').last()).not.toContainText(SECRET_ENTITY_AWS);
    await expect(page.getByRole('button', { name: '隐藏原文' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(detailText).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
  });

  test('搜索：每次提交最多 1 次 graph，list 调用 0 次', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.locator('[data-fenix-summary]')).toContainText(
      '显示 12 条记忆中的 3 条',
      { timeout: 15_000 },
    );

    await page.locator('#memory-fenix-search').fill('runbook');
    await page.locator('#memory-fenix-search').press('Enter');
    await expect
      .poll(() => callsOf(calls, 'network_agent_memory_graph').length)
      .toBe(2);
    const searchCall = callsOf(calls, 'network_agent_memory_graph')[1]!;
    expect(searchCall.args.q).toBe('runbook');
    expect(callsOf(calls, 'network_agent_memory_list')).toHaveLength(0);

    await page.getByRole('button', { name: '表格' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(2);
  });

  test('视角切换：经历/观察各 1 次 graph；实体走 entities 且按需加载 chunk', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.locator('[data-fenix-summary]')).toContainText(
      '显示 12 条记忆中的 3 条',
      { timeout: 15_000 },
    );
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);

    await page.locator('#memory-perspective-experience').click();
    await expect
      .poll(() => callsOf(calls, 'network_agent_memory_graph').length)
      .toBe(2);
    expect(callsOf(calls, 'network_agent_memory_graph')[1]!.args.type).toBe('experience');

    await page.locator('#memory-perspective-observation').click();
    await expect
      .poll(() => callsOf(calls, 'network_agent_memory_graph').length)
      .toBe(3);
    expect(callsOf(calls, 'network_agent_memory_graph')[2]!.args.type).toBe('observation');

    await page.locator('#memory-perspective-entities').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });
    const entityCalls = callsOf(calls, 'network_agent_memory_entities');
    expect(entityCalls).toHaveLength(1);
    expect(entityCalls[0]!.args.view).toBe('list');
    expect(entityCalls[0]!.args.limit).toBe(50);
    expect(entityCalls[0]!.args.offset).toBe(0);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(3);
    expect(callsOf(calls, 'network_agent_memory_overview')).toHaveLength(0);
    expect(callsOf(calls, 'network_agent_memory_list')).toHaveLength(0);
    expect(callsOf(calls, 'network_agent_memory_timeline')).toHaveLength(0);
  });

  test('视角栏键盘：End 到实体、Home 回世界，各触发 1 次对应取数', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.locator('[data-fenix-summary]')).toContainText(
      '显示 12 条记忆中的 3 条',
      { timeout: 15_000 },
    );

    await page.locator('#memory-perspective-world').focus();
    await page.keyboard.press('End');
    await expect(page.locator('#memory-perspective-entities')).toBeFocused();
    await expect(page.locator('#memory-perspective-entities')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('Home');
    await expect(page.locator('#memory-perspective-world')).toBeFocused();
    await expect
      .poll(() => callsOf(calls, 'network_agent_memory_graph').length)
      .toBe(2);
    expect(callsOf(calls, 'network_agent_memory_entities')).toHaveLength(1);
  });

  test('空态与不可用态分开渲染', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      rows: [],
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.getByText('暂无记忆数据')).toBeVisible({ timeout: 15_000 });

    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();

    const disabledCalls: MemoryCall[] = [];
    await installMemoryFenixStub(page, disabledCalls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      panelDisabled: true,
    });
    await openMemory(page, identity.directRoom);
    await expect(page.getByRole('alert')).toContainText('记忆暂不可用', { timeout: 15_000 });
    await expect(page.getByRole('alert')).toContainText('当前部署未开启 Agent 记忆面板');
    await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
  });

  test('bank_missing 按空态渲染，不显示记忆暂不可用', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      bankMissing: true,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.getByText('暂无记忆数据')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
  });

  test('失败态可重试，不与空态混淆', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      graphFailure: true,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.getByRole('alert')).toContainText('上游记忆服务超时', {
      timeout: 15_000,
    });
    await expect(page.getByRole('alert')).toContainText('加载记忆失败');
    await expect(page.getByText('暂无记忆数据')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
  });

  test('390 暗色：单栏、无页面横向溢出、表格内部滚动、axe 无 critical/serious', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.locator('[data-fenix-summary]')).toContainText(
      '显示 12 条记忆中的 3 条',
      { timeout: 15_000 },
    );

    const box = await page.locator('#agent-memory-dialog').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.width).toBeLessThanOrEqual(391);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const background = await page.evaluate(
      () => getComputedStyle(document.querySelector('#agent-memory-dialog') as HTMLElement).backgroundColor,
    );
    expect(background).toBe('rgb(43, 43, 43)');

    await page.getByRole('button', { name: '表格' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(3);
    const tableScroll = await page.locator('table').first().evaluate((element) => {
      const scroller = element.parentElement?.parentElement?.parentElement?.parentElement;
      return scroller
        ? { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
        : null;
    });
    expect(tableScroll).not.toBeNull();
    expect(tableScroll!.scrollWidth).toBeGreaterThan(tableScroll!.clientWidth);
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

  test('默认世界视角不预加载实体 chunk', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await expect(page.locator('.fenix-constellation-canvas')).toBeVisible({ timeout: 15_000 });
    const assets = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name),
    );
    expect(assets.some((url) => /DataView-[^/]+\.js/u.test(url))).toBe(true);
    expect(assets.some((url) => /MemoryEntities-[^/]+\.js/u.test(url))).toBe(false);

    await page.locator('#memory-perspective-entities').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });
    const after = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name),
    );
    expect(after.some((url) => /MemoryEntities-[^/]+\.js/u.test(url))).toBe(true);
  });
});
