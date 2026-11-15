import { expect, test } from '@playwright/test';

import {
  createIdentity,
  degrees,
  graphCalls,
  heatColor,
  hoverPoint,
  installStub,
  largeFixture,
  login,
  openConstellation,
  openMemoryDialog,
  readPoints,
  sampleCenterColors,
  sampleNodePalette,
  shot,
  waitForGraphCall,
  type MemoryCall,
  type SuiteIdentity,
} from './fixtures/memory-constellation';

/**
 * Fenix 星座图移植验收（120 节点 / 600 边）：
 * 真实 Chromium、真实 MCP 身份/房间；只替换记忆只读工具的响应。
 */

test.describe('Fenix 星座图移植（大图）', () => {
  let identity: SuiteIdentity;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('120 节点/600 边：热度像素、HUD、按需绘制与标签覆盖', async ({ page }) => {
    const fixture = largeFixture();
    expect(fixture.nodes).toHaveLength(120);
    expect(fixture.edges).toHaveLength(600);
    const calls: MemoryCall[] = [];
    await installStub(page, fixture, calls, {
      actorName: identity.agentName,
      actorId: identity.agentId,
    });
    await login(page, identity.base, identity.token);
    await openMemoryDialog(page, identity.directRoom);
    const canvas = await openConstellation(page);

    // 默认 120 节点 / 全部类型：limit 必须进入请求，type 与 q 不得凭空出现。
    const initialGraph = await waitForGraphCall(calls, (call) => call.args.limit === 120);
    expect(initialGraph.args).toEqual({ actor_id: identity.agentId, limit: 120 });
    expect(graphCalls(calls).some((call) => 'q' in call.args)).toBe(false);

    await expect(canvas).toHaveAttribute('data-node-count', '120');
    await expect(canvas).toHaveAttribute('data-edge-count', '600');
    await expect(canvas).toHaveAttribute('data-visible-count', '120');
    await expect(canvas).toHaveAttribute('data-links-drawn', '600');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('节点 120');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('边 600');
    // 100% 下按度数优先放置行内标签；目标 10–24 个且不重叠。
    await expect(canvas).toHaveAttribute('data-label-mode', 'inline');
    const labelCount = Number(await canvas.getAttribute('data-label-count'));
    expect(labelCount).toBeGreaterThanOrEqual(10);
    expect(labelCount).toBeLessThanOrEqual(24);
    expect(Number(await canvas.getAttribute('data-dpr'))).toBeLessThanOrEqual(2);

    // 120 节点一帧的实际绘制耗时（首次绘制后的稳定帧）。
    await page.waitForTimeout(150);
    const paintMs = Number(await canvas.getAttribute('data-paint-ms'));
    expect(paintMs).toBeGreaterThan(0);
    expect(paintMs).toBeLessThan(500);

    // 120 节点布局很密，中心可能被上层节点/光晕覆盖；这里验证所有节点
    // 中心附近确实出现热度色带的三段颜色，并单独校验色带端点值。
    const points = await readPoints(canvas);
    const palette = await sampleNodePalette(page, points);
    expect(palette.sampled).toBeGreaterThan(100);
    expect(palette.buckets).toEqual(expect.arrayContaining(['blue', 'purple', 'warm']));
    const sampled = await sampleCenterColors(page, points, [], 'hue');
    expect(sampled.width).toBeGreaterThan(0);
    expect(sampled.histogram.blue).toBeGreaterThan(50);
    expect(sampled.histogram.purple).toBeGreaterThan(50);
    expect(sampled.histogram.warm).toBeGreaterThan(50);
    expect(heatColor(0)).toBe('rgb(56,130,220)');
    expect(heatColor(0.5)).toBe('rgb(170,130,200)');
    expect(heatColor(1)).toBe('rgb(240,100,60)');
    await shot(page, '120-nodes-light');

    const { map: degreeMap } = degrees(fixture);

    // hover 只画该节点邻边：links-drawn 等于它的度数，而不是全图 600。
    const hub = points.find((point) => point.id === 'n1')!;
    await hoverPoint(page, canvas, hub);
    await expect(canvas).toHaveAttribute('data-hover-id', 'n1');
    await expect(canvas).toHaveAttribute('data-links-drawn', String(degreeMap.get('n1')));
    await expect(page.locator('.memory-graph-tooltip')).toContainText(
      `${degreeMap.get('n1')} 条连接`,
    );
    await shot(page, '120-nodes-hover');
    await page.mouse.move(0, 0);

    // 没有持续 RAF：稳定后等待 400ms，绘制计数不增长。
    await page.waitForTimeout(200);
    const paintCount = Number(await canvas.getAttribute('data-paint-count'));
    await page.waitForTimeout(400);
    expect(Number(await canvas.getAttribute('data-paint-count'))).toBe(paintCount);

    // 放大到 >150% 后进入卡片标签。
    for (let step = 0; step < 4; step += 1) {
      await page.locator('#memory-graph-canvas-zoom-in').click();
    }
    await expect(page.locator('.memory-graph-zoom')).toHaveText('244%');
    await expect(canvas).toHaveAttribute('data-label-mode', 'card');
    expect(Number(await canvas.getAttribute('data-label-count'))).toBeGreaterThan(0);
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
  });
});
