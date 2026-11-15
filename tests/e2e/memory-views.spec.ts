import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { createIdentity, login, row, type SuiteIdentity } from './fixtures/memory-constellation';
import {
  SECRET_BEARER,
  SECRET_ENTITY_AWS,
  callsOf,
  installMemoryFenixStub,
  type FenixEntityFixture,
  type MemoryCall,
} from './fixtures/memory-fenix';

/**
 * 实体视角（阶段 5：Fenix `EntitiesView`）与响应式行为。
 *
 * 断言口径：首屏只发 1 次 list；每次翻页只发 1 次目标页请求并替换当前页；
 * 关系图与详情各由一次用户动作触发 1 次调用；实体名默认掩码；Escape 先关详情。
 */

async function openMemory(page: Page, directRoom: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, directRoom);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

function entityDetail(page: Page) {
  return page.locator('[role="dialog"][aria-labelledby="memory-entity-detail-title"]');
}

test.describe('Agent 记忆：实体视角与响应式', () => {
  let identity: SuiteIdentity;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('实体首屏 1 次 list；翻页单次替换不累加；关系图 1 次、详情 1 次', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      entityCount: 120,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    await page.locator('[data-fenix-perspective="entities"]').click();
    const rows = page.locator('[data-slot="table"] tbody tr');
    await expect(rows).toHaveCount(50, { timeout: 15_000 });

    const entityCalls = callsOf(calls, 'network_agent_memory_entities');
    expect(entityCalls).toHaveLength(1);
    expect(entityCalls[0]!.args).toMatchObject({ view: 'list', limit: 50, offset: 0 });
    expect(entityCalls.some((call) => call.args.view === 'graph')).toBe(false);

    // 第 2 页：只新增 1 次 offset=50 的请求，DOM 替换为第 2 页而不是累加。
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toContainText('Entity 51');
    await expect(page.getByRole('cell', { name: 'Entity 1', exact: true })).toHaveCount(0);
    await expect(page.getByText('51-100 / 120')).toBeVisible();

    const pagedCalls = callsOf(calls, 'network_agent_memory_entities');
    expect(pagedCalls).toHaveLength(2);
    expect(pagedCalls[1]!.args).toMatchObject({ view: 'list', limit: 50, offset: 50 });
    expect(pagedCalls.some((call) => call.args.offset === 100)).toBe(false);

    // 关系图：用户切换动作 1 次调用，min_count 固定为 1，limit 使用服务端上限。
    await page.getByRole('button', { name: '关系图' }).click();
    await expect(page.locator('.fenix-constellation-canvas')).toBeVisible({ timeout: 15_000 });
    const graphCalls = callsOf(calls, 'network_agent_memory_entities').filter(
      (call) => call.args.view === 'graph',
    );
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.args).toMatchObject({ view: 'graph', limit: 200, min_count: 1 });

    // 切回列表不重复拉取列表页。
    await page.getByRole('button', { name: '列表' }).click();
    await expect(rows).toHaveCount(50);
    expect(callsOf(calls, 'network_agent_memory_entities')).toHaveLength(3);

    // 详情：一次点击 1 次调用。
    await page.locator('[data-entity-id="entity-51"]').click();
    await expect(entityDetail(page)).toBeVisible({ timeout: 15_000 });
    await expect(entityDetail(page)).toContainText('Entity 51');
    const detailCalls = callsOf(calls, 'network_agent_memory_entities').filter(
      (call) => call.args.view === 'detail',
    );
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]!.args.entity_id).toBe('entity-51');
  });

  test('实体名与详情默认掩码；Escape 只关详情并归还焦点', async ({ page }) => {
    const secretName = `Alpha ${SECRET_ENTITY_AWS}`;
    const entityItems: FenixEntityFixture[] = [
      {
        id: 'entity-1',
        name: secretName,
        mention_count: 3,
        first_seen: '2026-07-01T00:00:00.000Z',
        last_seen: '2026-10-01T00:00:00.000Z',
      },
      {
        id: 'entity-2',
        name: 'Beta Node',
        mention_count: 2,
        first_seen: '2026-07-01T00:00:00.000Z',
        last_seen: '2026-10-01T00:00:00.000Z',
      },
    ];
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      entityItems,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    await page.locator('[data-fenix-perspective="entities"]').click();
    const trigger = page.locator('[data-entity-id="entity-1"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await expect(trigger).toContainText('[已隐藏]');
    await expect(trigger).not.toContainText(SECRET_ENTITY_AWS);

    await trigger.focus();
    await page.keyboard.press('Enter');
    const detail = entityDetail(page);
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(detail).toContainText('[已隐藏]');
    await expect(detail).not.toContainText(SECRET_ENTITY_AWS);
    // 关联记忆正文即使存在也未渲染；默认掩码不泄露 Bearer 凭据。
    await expect(detail).not.toContainText(SECRET_BEARER);
    const overlayZ = await page
      .locator('[data-fenix-entity-detail-overlay]')
      .evaluate((element) => Number(getComputedStyle(element).zIndex));
    expect(overlayZ).toBeGreaterThan(61);
    expect(
      callsOf(calls, 'network_agent_memory_entities').filter(
        (call) => call.args.view === 'detail',
      ),
    ).toHaveLength(1);

    const close = detail.getByRole('button', { name: '关闭' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test('实体空态、失败态与不可用态分开渲染', async ({ page }) => {
    const emptyCalls: MemoryCall[] = [];
    await installMemoryFenixStub(page, emptyCalls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      entityItems: [],
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);
    await page.locator('[data-fenix-perspective="entities"]').click();
    await expect(page.getByText('未找到实体')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(callsOf(emptyCalls, 'network_agent_memory_entities')).toHaveLength(1);

    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();

    const failedCalls: MemoryCall[] = [];
    await installMemoryFenixStub(page, failedCalls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      entitiesFailure: true,
    });
    await openMemory(page, identity.directRoom);
    await page.locator('[data-fenix-perspective="entities"]').click();
    await expect(page.getByRole('alert')).toContainText('加载实体列表失败', { timeout: 15_000 });
    await expect(page.getByRole('alert')).toContainText('实体服务暂时不可用');
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();

    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();

    const unavailableCalls: MemoryCall[] = [];
    await installMemoryFenixStub(page, unavailableCalls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      entitiesUnavailable: 'panel_disabled',
    });
    await openMemory(page, identity.directRoom);
    await page.locator('[data-fenix-perspective="entities"]').click();
    await expect(page.getByRole('alert')).toContainText('记忆暂不可用', { timeout: 15_000 });
    await expect(page.getByRole('alert')).toContainText('当前部署未开启 Agent 记忆面板');
    await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
  });

  test('390 暗色实体视角：无页面横向溢出、详情收在视口内、axe 无 critical/serious', async ({
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
    await page.locator('[data-fenix-perspective="entities"]').click();
    await expect(page.locator('[data-slot="table"] tbody tr')).toHaveCount(3, {
      timeout: 15_000,
    });

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const background = await page.evaluate(
      () => getComputedStyle(document.querySelector('#agent-memory-dialog') as HTMLElement).backgroundColor,
    );
    expect(background).toBe('rgb(43, 43, 43)');

    await page.locator('[data-entity-id="entity-1"]').click();
    const detail = entityDetail(page);
    await expect(detail).toBeVisible({ timeout: 15_000 });
    const box = await detail.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeLessThanOrEqual(390);
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
    const world = page.locator('[data-fenix-perspective="world"]');
    const experience = page.locator('[data-fenix-perspective="experience"]');
    await world.focus();
    await page.keyboard.press('ArrowRight');
    await expect(experience).toBeFocused();
    await expect(experience).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-fenix-summary]')).toBeVisible({ timeout: 15_000 });
  });
});
