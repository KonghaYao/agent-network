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
 * Agent 记忆弹窗的 Fenix 视角 IA（阶段 4 事实视角、阶段 5 实体视角）。
 *
 * 断言口径：每个用户动作最多 1 次 `network_agent_memory_graph`；
 * 实体列表首屏/翻页各 1 次 `network_agent_memory_entities`；overview/list/timeline
 * 调用 0 次；视图切换、表格翻页、时间线缩放不发请求。
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

/** Find a canvas point whose tooltip is visible; the same point is clickable. */
async function findNodePoint(page: Page): Promise<{ x: number; y: number } | null> {
  const canvas = page.locator('.fenix-constellation-canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) return null;
  for (let rowIndex = 1; rowIndex < 12; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex < 12; columnIndex += 1) {
      const x = box.x + (box.width * columnIndex) / 12;
      const y = box.y + (box.height * rowIndex) / 12;
      await page.mouse.move(x, y);
      const display = await page
        .locator('.fenix-constellation-tooltip')
        .evaluate((element) => getComputedStyle(element).display);
      if (display !== 'none') return { x, y };
    }
  }
  return null;
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
    await expect(page.locator('[data-fenix-perspective="world"]')).toHaveAttribute('aria-pressed', 'true');

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
    await expect(page.locator('[data-fenix-memory-content]')).toContainText('S:', { timeout: 15_000 });
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

  test('星座节点侧栏：Esc 先关侧栏，不关闭记忆弹窗', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    const point = await findNodePoint(page);
    expect(point).not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    const sidePanel = page.getByRole('button', { name: '关闭记忆详情' });
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#agent-memory-dialog').getByRole('heading', { level: 3 })).toHaveText(
      '世界事实',
    );
    expect(callsOf(calls, 'network_agent_memory_get')).toHaveLength(1);

    await page.keyboard.press('Escape');
    await expect(sidePanel).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
  });

  test('视觉基线：238px 左列、surface 背景、compact 圆角与内距', async ({ page }) => {
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

    const styles = await page
      .locator('[data-slot="agent-master-detail-workspace"]')
      .evaluate((element) => {
        const workspace = getComputedStyle(element);
        const index = element.querySelector<HTMLElement>('[data-fenix-memory-index]');
        if (!index) throw new Error('缺少左列');
        const indexStyle = getComputedStyle(index);
        return {
          indexWidth: index.getBoundingClientRect().width,
          radius: workspace.borderTopLeftRadius,
          indexPaddingLeft: indexStyle.paddingLeft,
          background: workspace.backgroundColor,
        };
      });
    expect(Math.round(styles.indexWidth)).toBe(238);
    expect(styles.radius).toBe('12px');
    expect(styles.indexPaddingLeft).toBe('9px');
    expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('详情遮罩高于父弹窗，点击外部只关闭详情', async ({ page }) => {
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

    const overlayZ = await page
      .locator('[data-slot="dialog-overlay"]')
      .last()
      .evaluate((element) => Number(getComputedStyle(element).zIndex));
    expect(overlayZ).toBeGreaterThan(61);

    await page.mouse.click(5, 5);
    await expect(detailText).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
  });

  test('短视口与横屏：单列、无横向溢出、最小高度归零', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
    });
    await login(page, identity.base, identity.token);

    for (const viewport of [
      { width: 390, height: 600 },
      { width: 600, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await openMemory(page, identity.directRoom);
      await expect(page.locator('[data-fenix-summary]')).toContainText(
        '显示 12 条记忆中的 3 条',
        { timeout: 15_000 },
      );

      const layout = await page
        .locator('[data-slot="agent-master-detail-workspace"]')
        .evaluate((element) => {
          const style = getComputedStyle(element);
          const aside = element.querySelector<HTMLElement>('aside');
          const content = element.querySelector<HTMLElement>('main');
          if (!aside || !content) throw new Error('缺少视角栏或内容区');
          const asideRect = aside.getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          return {
            columns: style.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length,
            minHeight: style.minHeight,
            horizontalOverflow: element.scrollWidth - element.clientWidth,
            stacked: contentRect.top >= asideRect.bottom - 1,
          };
        });
      expect(layout.columns).toBe(1);
      expect(layout.minHeight).toBe('0px');
      expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
      expect(layout.stacked).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);

      await page.locator('#agent-memory-close').click();
      await expect(page.locator('#agent-memory-dialog')).toBeHidden();
    }
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

    await page.locator('[data-fenix-memory-search]').fill('runbook');
    await page.locator('[data-fenix-memory-search]').press('Enter');
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

    await page.locator('[data-fenix-perspective="experience"]').click();
    await expect
      .poll(() => callsOf(calls, 'network_agent_memory_graph').length)
      .toBe(2);
    expect(callsOf(calls, 'network_agent_memory_graph')[1]!.args.type).toBe('experience');

    await page.locator('[data-fenix-perspective="observation"]').click();
    await expect
      .poll(() => callsOf(calls, 'network_agent_memory_graph').length)
      .toBe(3);
    expect(callsOf(calls, 'network_agent_memory_graph')[2]!.args.type).toBe('observation');

    await page.locator('[data-fenix-perspective="entities"]').click();
    await expect(page.locator('[data-slot="table"] tbody tr')).toHaveCount(3, {
      timeout: 15_000,
    });
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

    await page.locator('[data-fenix-perspective="world"]').focus();
    await page.keyboard.press('End');
    await expect(page.locator('[data-fenix-perspective="entities"]')).toBeFocused();
    await expect(page.locator('[data-fenix-perspective="entities"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('[data-slot="table"] tbody tr')).toHaveCount(3, {
      timeout: 15_000,
    });

    await page.keyboard.press('Home');
    await expect(page.locator('[data-fenix-perspective="world"]')).toBeFocused();
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

  test('错误详情携带 token= 时显示 [已隐藏]，不泄露原值', async ({ page }) => {
    const secret = 'e2e-error-secret-token';
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      graphFailure: true,
      graphFailureMessage: `上游失败：https://hindsight.invalid/graph?token=${secret}&mode=1`,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('token=[已隐藏]', { timeout: 15_000 });
    await expect(alert).not.toContainText(secret);
    await expect(page.locator('#agent-memory-dialog')).not.toContainText(secret);
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
    expect(assets.some((url) => /EntitiesView-[^/]+\.js/u.test(url))).toBe(false);

    await page.locator('[data-fenix-perspective="entities"]').click();
    await expect(page.locator('[data-slot="table"] tbody tr')).toHaveCount(3, {
      timeout: 15_000,
    });
    const after = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((entry) => entry.name),
    );
    expect(after.some((url) => /EntitiesView-[^/]+\.js/u.test(url))).toBe(true);
  });
});
