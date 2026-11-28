import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { baseUrl, callTool, createComponentRoom, login, requestId } from './fixtures/components';
import { semanticColor } from './fixtures/semantic-colors';

async function room(page: Page, ready = true) {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await callTool(base, fixture.tokenA, 'network_room_announcement_set', {
    request_id: requestId('s07_announcement'), room_id: fixture.roomId,
    announcement: '公告摘要\n' + '超长公告换行\n'.repeat(60), expected_announcement_revision: 1,
  });
  await login(page, base, fixture.tokenA);
  await page.goto(`${base}/c/${fixture.roomId}`);
  await expect(page.locator('#title')).toContainText(fixture.roomTitle);
  if (ready) await expect(page.locator('#room-announcement-info')).toHaveAttribute('data-tooltip-backend', 'lenso');
  return fixture;
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

async function announcementClosed(page: Page) {
  await expect(page.locator('#room-announcement-popover')).toHaveCount(0);
  await expect(page.locator('#room-announcement')).toHaveCount(0);
  await expect(page.locator('#room-announcement-info')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#room-announcement-info')).not.toHaveAttribute('aria-controls');
}

for (const width of [1280, 390]) {
  test(`公告 ${width} / ${width === 390 ? '暗色' : '浅色'}：overflow、几何、外点/Esc 与焦点`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    await room(page);
    await announcementClosed(page);
    const trigger = page.locator('#room-announcement-info');
    await trigger.focus();
    await trigger.hover();
    await expect(page.locator('[role="tooltip"]')).toBeVisible();
    await announcementClosed(page);
    // 真实 header 裁剪，不能只检查浮层的 bounding box。
    await trigger.evaluate((node) => { node.closest('header')!.style.overflow = 'hidden'; });
    await trigger.click();
    const popup = page.locator('#room-announcement-popover');
    await expect(popup).toHaveAttribute('data-popover-backend', 'lenso');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trigger).toHaveAttribute('aria-controls', 'room-announcement-popover');
    await expect(page.locator('#room-announcement')).toHaveCount(1);
    await geometry(page, popup, width);
    await expect(popup.locator('.spa-popover-text')).toContainText('公告摘要');
    expect(await popup.locator('.spa-popover-text').evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-wrap');
    expect(await popup.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      await semanticColor(page, '--wx-panel'),
    );
    const audit = await new AxeBuilder({ page }).include('#room-announcement-popover').analyze();
    expect(audit.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([]);
    expect(await popup.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + 20, rect.bottom - 15));
    })).toBe(true);
    await expect(page.locator('#room-announcement-edit')).toBeFocused();
    expect(await popup.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await popup.evaluate((node) => { node.scrollTop = 100; });
    expect(await popup.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    const portal = await popup.elementHandle();
    await trigger.click();
    await announcementClosed(page);
    expect(await portal!.evaluate((node) => node.isConnected)).toBe(false);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(popup).toBeVisible();
    await page.keyboard.press('Escape');
    await announcementClosed(page);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(popup).toBeVisible();
    await page.locator('#title').click();
    await announcementClosed(page);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.locator('#room-announcement-edit').click();
    await expect(page.locator('#announcement-modal')).toBeVisible();
    await expect(page.locator('#announcement-input')).toBeFocused();
  });
}

test('非管理员只读公告：默认收起、无编辑入口、关闭归还焦点', async ({ page }) => {
  const fixture = await room(page);
  const base = await baseUrl();
  await login(page, base, fixture.tokenB);
  await page.reload();
  const trigger = page.locator('#room-announcement-info');
  await expect(trigger).toHaveAttribute('data-tooltip-backend', 'lenso');
  await announcementClosed(page);
  await trigger.click();
  const popup = page.locator('#room-announcement-popover');
  await expect(popup.locator('#room-announcement')).toContainText('公告摘要');
  await expect(popup.locator('#room-announcement-edit')).toHaveCount(0);
  const close = popup.getByRole('button', { name: '关闭', exact: true });
  await expect(close).toBeFocused();
  await close.click();
  await announcementClosed(page);
  await expect(trigger).toBeFocused();
});

test('浏览器后退到已缓存房间：上一个房间的公告浮层不残留', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await callTool(base, fixture.tokenA, 'network_room_announcement_set', {
    request_id: requestId('s07_back_b'), room_id: fixture.roomId,
    announcement: 'B 房间公告', expected_announcement_revision: 1,
  });
  const titleA = `后退缓存群 ${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const created = await callTool<{ room: { room_id: string } }>(base, fixture.tokenA, 'network_room_create', {
    request_id: requestId('s07_back_room'), kind: 'group', title: titleA, members: [fixture.actorB],
  });
  const roomA = created.room.room_id;
  await callTool(base, fixture.tokenA, 'network_room_announcement_set', {
    request_id: requestId('s07_back_a'), room_id: roomA,
    announcement: 'A 房间公告', expected_announcement_revision: 1,
  });

  await login(page, base, fixture.tokenA);
  // B 先进入历史与查询缓存；从 B 客户端跳转到 A，再后退回到 B，页面不重载。
  await page.goto(`${base}/c/${fixture.roomId}`);
  await expect(page.locator('#title')).toContainText(fixture.roomTitle);
  const linkA = page.locator(`#room-list a.room-item[href="/c/${encodeURIComponent(roomA)}"]`);
  await expect(linkA).toBeVisible();
  await linkA.click();
  await expect(page.locator('#title')).toContainText(titleA);
  await expect(page.locator('#room-announcement-info')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#room-announcement-info').click();
  await expect(page.locator('#room-announcement-popover')).toContainText('A 房间公告');

  await page.goBack();
  await expect(page.locator('#title')).toContainText(fixture.roomTitle);
  await announcementClosed(page);
  await expect(page.locator('#room-announcement-popover')).toHaveCount(0);
  await expect(page.locator('#room-announcement-info')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#room-announcement-info').click();
  await expect(page.locator('#room-announcement-popover')).toContainText('B 房间公告');
});

test('announcement 真实 index 延迟：打开不换壳，关闭重开升级', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = 0;
    await page.route('**/assets/index-*.js', async (route) => { intercepted++; await gate; await route.continue(); });
    try {
      await room(page, false);
      const trigger = page.locator('#room-announcement-info');
      const popup = page.locator('#room-announcement-popover');
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

  test('announcement 真实 index 阻断：fallback 外点/Esc 与焦点仍可用', async ({ page }) => {
    let intercepted = 0;
    await page.route('**/assets/index-*.js', async (route) => { intercepted++; await route.abort(); });
    await room(page, false);
    const trigger = page.locator('#room-announcement-info');
    const popup = page.locator('#room-announcement-popover');
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
