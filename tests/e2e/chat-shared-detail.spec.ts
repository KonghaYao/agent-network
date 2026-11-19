import { expect, test } from '@playwright/test';

import { baseUrl, callTool, createComponentRoom, login, requestId } from './fixtures/components';

const VIEWPORTS = [
  { width: 1280, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
] as const;

for (const colorScheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`聊天/侧栏细节 ${viewport.width}px ${colorScheme}`, async ({ page }) => {
      const base = await baseUrl();
      const { tokenA, roomId, roomTitle } = await createComponentRoom(base);
      const longText = `长消息不溢出 ${'长文本'.repeat(260)}`;
      await callTool(base, tokenA, 'network_message_send', {
        request_id: requestId('shared_detail'),
        client_message_id: requestId('shared_detail'),
        room_id: roomId,
        body: longText,
        invoke: [],
      });
      await login(page, base, tokenA);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}/`);

      if (viewport.mobile) {
        await expect(page.locator('body')).toHaveClass(/page-home/u);
        await expect(page.locator('.chat-pane:not(.empty-pane)')).toBeHidden();
      }
      const row = page.locator('#room-list .room-item').filter({ hasText: roomTitle }).first();
      await expect(row).toBeVisible();
      const rowBox = await row.boundingBox();
      expect(rowBox?.height).toBeGreaterThanOrEqual(44);
      await expect(row).toHaveCSS('border-width', '0px');
      await expect(row).toHaveCSS('box-shadow', 'none');

      const newGroup = page.locator('#new-group');
      await expect(newGroup).toHaveCSS('width', '32px');
      await expect(newGroup).toHaveCSS('height', '32px');
      expect(await newGroup.evaluate((element) => getComputedStyle(element, '::after').height)).toBe('44px');

      const search = page.locator('#room-search');
      const searchBox = await search.boundingBox();
      expect(searchBox?.height).toBeCloseTo(32, 0);
      expect(await page.locator('.search-box').evaluate((element) => element.getBoundingClientRect().height))
        .toBeGreaterThanOrEqual(44);
      await search.focus();
      await expect(page.locator('.search-box [data-lenso-slot="search-field-group"]'))
        .toHaveCSS('border-radius', '8px');

      if (!viewport.mobile) {
        await expect(row).toHaveCSS('height', '64px');
      }
      await row.click();
      await expect(page.locator('#composer')).toBeVisible();
      await expect(page.locator('#body')).toHaveJSProperty('tagName', 'TEXTAREA');
      await expect(page.locator('#composer-file-input')).toHaveAttribute('type', 'file');
      await expect(page.locator('#composer-file-input')).toBeHidden();
      const textarea = await page.locator('#body').evaluate((element) => ({
        tag: element.tagName,
        role: element.getAttribute('role'),
        id: element.id,
      }));
      expect(textarea).toEqual({ tag: 'TEXTAREA', role: 'combobox', id: 'body' });
      await page.locator('#body').fill('@');
      await expect(page.locator('#mention-picker')).toBeVisible();
      await expect(page.locator('#mention-picker')).toHaveAttribute('role', 'listbox');
      await page.keyboard.press('Escape');

      const bubbles = page.locator('#messages .bubble');
      const bubble = bubbles.filter({ hasText: '长消息不溢出' }).last();
      await expect(bubble).toBeVisible();
      await expect(bubble).toHaveCSS('font-size', '15px');
      await expect(bubble).toHaveCSS('line-height', '22px');
      await expect(bubble).toHaveCSS('border-radius', '8px');
      await expect(bubble).toHaveCSS('border-width', '0px');
      await expect(bubble).toHaveCSS('box-shadow', 'none');
      await expect(page.locator('#body')).toHaveCSS('border-radius', '8px');
      await expect(page.locator('#body')).toHaveCSS('min-height', '38px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(viewport.width);
    });
  }
}
