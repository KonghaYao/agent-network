import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseUrl, callTool, createComponentRoom, login, requestId } from './fixtures/components';

async function room(page: Page, ready = true) {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await callTool(base, fixture.tokenA, 'network_room_announcement_set', {
    request_id: requestId('s07_announcement'), room_id: fixture.roomId,
    announcement: '公告摘要\n' + '超长公告换行'.repeat(30), expected_announcement_revision: 1,
  });
  const sent = await callTool<{ message: { message_id: string } }>(base, fixture.tokenA, 'network_message_send', {
    request_id: requestId('s07_send'), client_message_id: requestId('s07_client'),
    room_id: fixture.roomId, body: 'Task 预览正文\n' + '滚动内容'.repeat(80), invoke: [],
  });
  const rootId = sent.message.message_id;
  await callTool(base, fixture.tokenA, 'network_task_mark', {
    request_id: requestId('s07_mark'), room_id: fixture.roomId, message_id: rootId,
  });
  for (let index = 0; index < 3; index++) {
    await callTool(base, fixture.tokenB, 'network_message_send', {
      request_id: requestId('s07_reply'), client_message_id: requestId('s07_client'),
      room_id: fixture.roomId, task_root_id: rootId, body: `回复 ${index}：滚动内容`, invoke: [],
    });
  }
  await login(page, base, fixture.tokenA);
  await page.goto(`${base}/c/${fixture.roomId}`);
  await expect(page.locator('#title')).toContainText(fixture.roomTitle);
  if (ready) await expect(page.locator('#room-announcement-info')).toHaveAttribute('data-tooltip-backend', 'lenso');
  return { ...fixture, rootId };
}

async function geometry(page: Page, popup: Locator, width: number) {
  await expect(popup).toBeVisible();
  await expect.poll(async () => popup.evaluate((node) => getComputedStyle(node).transform)).toBe('none');
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(11);
  expect(box.x + box.width).toBeLessThanOrEqual(width - 11);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await popup.evaluate((node) => node.parentElement === document.body)).toBe(true);
  expect(await popup.evaluate((node) => node.matches(':popover-open'))).toBe(false);
  expect(await popup.evaluate((node) => Number(getComputedStyle(node).zIndex))).toBeLessThan(100000);
}

for (const width of [1280, 390]) {
  test(`公告 ${width} / ${width === 390 ? '暗色' : '浅色'}：overflow、几何、外点/Esc 与焦点`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    await room(page);
    const trigger = page.locator('#room-announcement-info');
    // 真实 header 裁剪，不能只检查浮层的 bounding box。
    await trigger.evaluate((node) => { node.closest('header')!.style.overflow = 'hidden'; });
    await trigger.click();
    const popup = page.locator('#room-announcement-popover');
    await expect(popup).toHaveAttribute('data-popover-backend', 'lenso');
    await geometry(page, popup, width);
    await expect(popup.locator('.spa-popover-text')).toContainText('公告摘要');
    expect(await popup.locator('.spa-popover-text').evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-wrap');
    expect(await popup.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      await page.locator('#task-dock-panel').evaluate((node) => getComputedStyle(node).backgroundColor),
    );
    const audit = await new AxeBuilder({ page }).include('#room-announcement-popover').analyze();
    expect(audit.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([]);
    expect(await popup.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + 20, rect.bottom - 15));
    })).toBe(true);
    await expect(page.locator('#room-announcement-edit')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('#body').click();
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('#room-announcement-edit').click();
    await expect(page.locator('#announcement-modal')).toBeVisible();
    await expect(page.locator('#announcement-input')).toBeFocused();
  });
}

test('Task hover 延迟、不抢焦点、移入保持、pinned、外点判定与 Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const fixture = await room(page);
  await page.locator('#task-dock-toggle').click();
  const trigger = page.locator('.task-dock-item-trigger');
  const popup = page.locator(`#task-preview-${fixture.rootId}`);
  await page.locator('#body').focus();
  await trigger.hover();
  await page.waitForTimeout(120);
  await expect(popup).toHaveCount(0);
  await expect(popup).toHaveAttribute('data-popover-backend', 'lenso');
  await expect(page.locator('#body')).toBeFocused();
  await geometry(page, popup, 1280);
  await popup.hover();
  await page.waitForTimeout(250);
  await expect(popup).toBeVisible();
  await page.locator('#title').hover();
  await page.waitForTimeout(60);
  await expect(popup).toBeVisible();
  await expect(popup).toHaveCount(0);
  await trigger.hover();
  await expect(popup).toBeVisible();
  await trigger.click();
  await page.locator('#title').hover();
  await page.waitForTimeout(300);
  await expect(popup).toBeVisible();
  await popup.locator('.task-preview-text').click();
  await expect(page.locator('#task-dock-panel')).toBeVisible();
  await expect(popup).toHaveClass(/task-preview-popover/);
  await page.locator('#title').click();
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(popup.locator('.task-preview-recent').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('#task-dock-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#task-dock-panel')).toBeHidden();
});

test('Task 390 暗色：点按、滚动与外部点击', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const fixture = await room(page);
  await page.locator('#task-dock-toggle').click();
  const trigger = page.locator('.task-dock-item-trigger');
  await trigger.click();
  const popup = page.locator(`#task-preview-${fixture.rootId}`);
  await geometry(page, popup, 390);
  expect(await popup.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
    await page.locator('#task-dock-panel').evaluate((node) => getComputedStyle(node).backgroundColor),
  );
  expect(await popup.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await popup.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  expect(await popup.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const action = popup.locator('.task-preview-all');
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.locator('#title').click();
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const kind of ['announcement', 'task'] as const) {
  test(`${kind} 真实 index 延迟：打开不换壳，关闭重开升级`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = 0;
    await page.route('**/assets/index-*.js', async (route) => { intercepted++; await gate; await route.continue(); });
    try {
      const fixture = await room(page, false);
      if (kind === 'task') await page.locator('#task-dock-toggle').click();
      const trigger = page.locator(kind === 'task' ? '.task-dock-item-trigger' : '#room-announcement-info');
      const popup = page.locator(kind === 'task' ? `#task-preview-${fixture.rootId}` : '#room-announcement-popover');
      await trigger.click();
      await expect(popup).toHaveAttribute('data-popover-backend', 'fallback');
      const original = await popup.elementHandle();
      release();
      await expect(page.locator('#send')).toHaveAttribute('data-lenso-slot', 'button');
      expect(intercepted).toBeGreaterThan(0);
      await expect(popup).toHaveAttribute('data-popover-backend', 'fallback');
      expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(popup).toHaveAttribute('data-popover-backend', 'lenso');
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    } finally { release(); }
  });

  test(`${kind} 真实 index 阻断：fallback 外点/Esc 与焦点仍可用`, async ({ page }) => {
    let intercepted = 0;
    await page.route('**/assets/index-*.js', async (route) => { intercepted++; await route.abort(); });
    const fixture = await room(page, false);
    if (kind === 'task') await page.locator('#task-dock-toggle').click();
    const trigger = page.locator(kind === 'task' ? '.task-dock-item-trigger' : '#room-announcement-info');
    const popup = page.locator(kind === 'task' ? `#task-preview-${fixture.rootId}` : '#room-announcement-popover');
    await trigger.click();
    await expect(popup).toHaveAttribute('data-popover-backend', 'fallback');
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('#title').click();
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(intercepted).toBeGreaterThan(0);
  });
}
