import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  createIdentity,
  degrees,
  expectedCenterColor,
  graphCalls,
  heatColor,
  hoverPoint,
  installStub,
  login,
  openConstellation,
  openMemoryDialog,
  readPoints,
  requestedConstellationChunk,
  sampleCenterColors,
  setDebugPoints,
  shot,
  smallFixture,
  trackRequests,
  waitForGraphCall,
  XSS_ENTITY,
  type Fixture,
  type MemoryCall,
  type SuiteIdentity,
} from './fixtures/memory-constellation';

/**
 * Fenix 星座图移植验收（3 节点与 390 暗色）：
 * 真实 Chromium、真实 MCP 身份/房间；只替换记忆只读工具的响应。
 */

test.describe('Fenix 星座图移植', () => {
  let identity: SuiteIdentity;
  let fixture: Fixture;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('3 节点/2 边：绘制、热度、hover 隔离、标签、tooltip 防 XSS、缩放拖拽全屏', async ({
    page,
  }) => {
    fixture = smallFixture();
    const calls: MemoryCall[] = [];
    const assets = trackRequests(page);
    await installStub(page, fixture, calls, {
      actorName: identity.agentName,
      actorId: identity.agentId,
    });
    await login(page, identity.base, identity.token);
    await openMemoryDialog(page, identity.directRoom);

    // 打开弹窗只加载概览；星座图 chunk 必须等到点击 Tab 才请求。
    await expect(page.locator('#memory-stat-nodes')).toHaveText('3');
    expect(requestedConstellationChunk(assets)).toBe(false);
    const canvas = await openConstellation(page);
    expect(requestedConstellationChunk(assets)).toBe(true);

    // UI 默认选择（全部类型 / 120 节点）必须原样进入工具参数。
    const initialGraph = await waitForGraphCall(calls, (call) => call.args.limit === 120);
    expect(initialGraph.args).toEqual({ actor_id: identity.agentId, limit: 120 });

    await expect(canvas).toHaveAttribute('data-node-count', '3');
    await expect(canvas).toHaveAttribute('data-edge-count', '2');
    await expect(canvas).toHaveAttribute('data-dpr', /^(1|2)\.00$/u);
    await expect(canvas).toHaveAttribute('data-visible-count', '3');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('节点 3');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('边 2');

    const heatStyle = await page
      .locator('#memory-graph-canvas-heat .memory-graph-heat-bar')
      .getAttribute('style');
    expect(heatStyle).toContain('rgb(56, 130, 220)');
    expect(heatStyle).toContain('rgb(170, 130, 200)');
    expect(heatStyle).toContain('rgb(240, 100, 60)');

    const legendText = (await page.locator('.memory-graph-legend').textContent()) ?? '';
    expect(legendText).toContain('semantic');
    expect(legendText).toContain('entity');
    const semanticSwatch = await page
      .locator('.memory-graph-legend li', { hasText: 'semantic' })
      .locator('.memory-graph-swatch')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(semanticSwatch).toBe('rgb(0, 116, 217)');

    // 实际画布像素：每个节点中心应是热度色按节点透明度覆盖背景后的颜色。
    const points = await readPoints(canvas);
    const { map: degreeMap, max: maxDegree } = degrees(fixture);
    const expected = fixture.nodes.map((node) => {
      const degree = degreeMap.get(node.id) ?? 0;
      return {
        id: node.id,
        rgb: expectedCenterColor(heatColor(Math.sqrt(degree / maxDegree)), degree),
      };
    });
    const sampled = await sampleCenterColors(page, points, expected);
    expect(sampled.mismatches).toEqual([]);
    expect(sampled.buckets).toContain('warm');

    await expect(canvas).toHaveAttribute('data-label-count', /^[1-9]\d*$/u);
    await expect(canvas).toHaveAttribute('data-label-mode', 'inline');
    await shot(page, '3-nodes-light');

    // hover 中间节点：只画它的 2 条邻边，tooltip 只显示类型/日期/实体/连接数。
    const pointA = points.find((point) => point.id === 'mem-a')!;
    await hoverPoint(page, canvas, pointA);
    await expect(canvas).toHaveAttribute('data-hover-id', 'mem-a');
    await expect(canvas).toHaveAttribute('data-links-drawn', '2');
    await expect(canvas).toHaveAttribute('data-label-mode', 'card');
    const tooltip = page.locator('.memory-graph-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('经历');
    await expect(tooltip).toContainText('2 条连接');
    await expect(tooltip).toContainText('2026-10-01');
    await expect(tooltip).toContainText('alpha');
    await expect(tooltip).toContainText(XSS_ENTITY);
    await expect(tooltip).toContainText('[已隐藏]');
    await expect(tooltip.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

    // hover 叶子节点：只画 1 条邻边。
    const pointB = points.find((point) => point.id === 'mem-b')!;
    await hoverPoint(page, canvas, pointB);
    await expect(canvas).toHaveAttribute('data-hover-id', 'mem-b');
    await expect(canvas).toHaveAttribute('data-links-drawn', '1');
    await expect(tooltip).toContainText('1 条连接');
    await shot(page, '3-nodes-hover');

    // 移出画布后 tooltip 与 hover 都清空。
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await expect(canvas).toHaveAttribute('data-hover-id', '');

    // 逐点 JSON 只在测试 flag 打开时写入生产 DOM；flag 关闭后重绘即移除。
    await setDebugPoints(page, false);
    await page.locator('#memory-graph-canvas-zoom-in').click();
    await expect(canvas).toHaveAttribute('data-zoom', '1.25');
    await expect(canvas).not.toHaveAttribute('data-node-points', /.+/u);
    await setDebugPoints(page, true);
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(canvas).toHaveAttribute('data-node-points', /.+/u);

    // 缩放：按钮精确到 125%，两次到 156% 后进入卡片标签；滚轮改变倍数；重置回 100%。
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
    await page.locator('#memory-graph-canvas-zoom-in').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('125%');
    await expect(canvas).toHaveAttribute('data-zoom', '1.25');
    await page.locator('#memory-graph-canvas-zoom-in').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('156%');
    await expect(canvas).toHaveAttribute('data-label-mode', 'card');
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const wheelOffsetX = 40;
    const wheelOffsetY = 20;
    await page.mouse.move(
      box!.x + box!.width / 2 + wheelOffsetX,
      box!.y + box!.height / 2 + wheelOffsetY,
    );
    await page.mouse.wheel(0, -200);
    await expect(page.locator('.memory-graph-zoom')).not.toHaveText('100%');
    // 光标锚定：缩放后光标下的世界点保持不动，pan = offset × (1 - ratio)。
    const wheelZoom = Number(await canvas.getAttribute('data-zoom'));
    expect(
      Math.abs(
        Number(await canvas.getAttribute('data-pan-x')) - wheelOffsetX * (1 - wheelZoom),
      ),
    ).toBeLessThan(1.5);
    expect(
      Math.abs(
        Number(await canvas.getAttribute('data-pan-y')) - wheelOffsetY * (1 - wheelZoom),
      ),
    ).toBeLessThan(1.5);
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');

    // 拖拽平移：data-pan-x 真正变化，且不误开详情。
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20);
    await page.mouse.up();
    expect(Number(await canvas.getAttribute('data-pan-x'))).toBeGreaterThan(30);
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);

    // 全屏：覆盖视口，Esc 退出且不关闭记忆弹窗。
    await page.locator('#memory-graph-canvas-fullscreen').click();
    const fullscreenButton = page.locator('#memory-graph-canvas-fullscreen');
    await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'true');
    const fullscreen = page.locator('.memory-graph.is-fullscreen');
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen.locator('.memory-graph-legend-overlay')).toContainText('semantic');
    await expect(fullscreen.locator('.memory-graph-legend-overlay')).toContainText('entity');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.memory-graph') !== null),
    ).toBe(true);
    const fullscreenBox = await fullscreen.boundingBox();
    expect(fullscreenBox).not.toBeNull();
    expect(fullscreenBox!.x).toBeLessThanOrEqual(1);
    expect(fullscreenBox!.y).toBeLessThanOrEqual(1);
    expect(fullscreenBox!.width).toBeGreaterThanOrEqual(1279);
    await shot(page, '3-nodes-fullscreen');
    await page.keyboard.press('Escape');
    await expect(page.locator('.memory-graph.is-fullscreen')).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
    await expect(page.locator('#memory-graph-canvas-fullscreen')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // 点击节点中心打开既有 MemoryDetail。
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(canvas).toHaveAttribute('data-zoom', '1.00');
    const freshPoints = await readPoints(canvas);
    const freshA = freshPoints.find((point) => point.id === 'mem-a')!;
    await hoverPoint(page, canvas, freshA);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('#memory-tab-constellation')).toBeFocused();

    await page.mouse.move(0, 0);
    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);

    // 改选类型与节点上限后，新请求必须携带同样的参数，且不擅自附带 q。
    await page.selectOption('#memory-graph-type-filter', 'experience');
    await page.selectOption('#memory-graph-limit', '20');
    const filteredGraph = await waitForGraphCall(
      calls,
      (call) => call.args.type === 'experience' && call.args.limit === 20,
    );
    expect(filteredGraph.args).toEqual({
      actor_id: identity.agentId,
      limit: 20,
      type: 'experience',
    });
    expect(graphCalls(calls).some((call) => 'q' in call.args)).toBe(false);
  });

  test('390 暗色：无横向溢出、tooltip 深色、全屏、表格 Enter 与 axe', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    fixture = smallFixture();
    const calls: MemoryCall[] = [];
    await installStub(page, fixture, calls, {
      actorName: identity.agentName,
      actorId: identity.agentId,
    });
    await login(page, identity.base, identity.token);
    await openMemoryDialog(page, identity.directRoom);
    const canvas = await openConstellation(page);

    await expect(page.locator('.memory-graph')).toHaveAttribute('data-theme', 'dark');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    // 390 只隐藏星座图提示；实体共现图仍保留自己的操作提示。
    expect(
      await page
        .locator('#memory-constellation .memory-graph-hint')
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe('none');

    const corner = await page.evaluate(() => {
      const element = document.getElementById('memory-graph-canvas') as HTMLCanvasElement;
      const context = element.getContext('2d')!;
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    });
    expect(corner[0]).toBeLessThan(30);
    expect(corner[1]).toBeLessThan(30);
    expect(corner[2]).toBeLessThan(30);

    for (const selector of [
      '#memory-graph-canvas-hud',
      '#memory-graph-canvas-heat',
      '.memory-graph-controls',
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(845);
    }

    const points = await readPoints(canvas);
    await hoverPoint(page, canvas, points.find((point) => point.id === 'mem-a')!);
    const tooltip = page.locator('.memory-graph-tooltip');
    await expect(tooltip).toBeVisible();
    expect(
      await tooltip.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(43, 43, 43)');
    await shot(page, '390-dark-hover');
    await page.mouse.move(0, 0);

    await page.locator('#memory-graph-canvas-fullscreen').click();
    await expect(page.locator('.memory-graph.is-fullscreen')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.memory-graph.is-fullscreen')).toHaveCount(0);

    await page.locator('#memory-graph-list tbody tr').first().locator('button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    const detail = await page.locator('.memory-detail-column').boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(845);
    await page.locator('#memory-detail-close').click();

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);

    // 实体图复用同一样式，但提示不能被星座图的 390 规则波及。
    await page.locator('#memory-tab-entities').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });
    await page.locator('#memory-entities-view-graph').click();
    const entityCanvas = page.locator('#memory-entity-graph-canvas');
    await expect(entityCanvas).toBeVisible({ timeout: 15_000 });
    await expect(entityCanvas).toHaveAttribute('data-node-count', '2');
    await expect(page.locator('#memory-entities .memory-graph-hint')).toBeVisible();
  });
});
