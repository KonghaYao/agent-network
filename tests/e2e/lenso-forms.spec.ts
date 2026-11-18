import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { baseUrl, callTool, createComponentRoom, login, requestId } from './fixtures/components';

let base: string;

test.beforeAll(async () => { base = await baseUrl(); });

async function setup(page: Page) {
  const fixture = await createComponentRoom(base);
  await login(page, base, fixture.tokenA);
  return fixture;
}

async function labelled(page: Page, id: string, name: string, fallback: boolean) {
  const label = page.locator(`label[for="${id}"]`);
  await expect(label).toHaveText(name);
  await expect(label).toHaveAttribute('data-lenso-slot', fallback ? 'label-fallback' : 'label');
  await expect(page.locator(`#${id}`)).toHaveAccessibleName(name);
  await label.click();
  await expect(page.locator(`#${id}`)).toBeFocused();
}

async function touchTarget(locator: Locator) {
  await expect.poll(() => locator.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
}

async function singleColumn(page: Page, dialog: Locator) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

async function accessible(page: Page, selector: string) {
  const result = await new AxeBuilder({ page }).include(selector).analyze();
  expect(result.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))).toEqual([]);
}

for (const fallback of [false, true]) {
  const backend = fallback ? 'fallback' : 'Lenso';

  test(`Members Checkbox ${backend}：390 暗色、整行/Space、状态与提交 payload`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    if (fallback) await page.route('**/assets/index-*.js', (route) => route.abort());
    const fixture = await setup(page);
    const { tokenA, actorB, roomId, nameB } = fixture;
    // 保留好友关系，只从群里移除，候选列表必须仍可将其加回。
    await callTool(base, tokenA, 'network_room_members_update', {
      request_id: requestId('forms_remove'), room_id: roomId, remove: [actorB],
    });
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#members-button')).toBeVisible();
    if (!fallback) await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
    await page.locator('#members-button').click();
    const dialog = page.locator('#members-modal');
    const row = dialog.locator('.contact-choice').filter({ hasText: nameB });
    const checkbox = dialog.getByRole('checkbox', { name: new RegExp(nameB) });
    await expect(checkbox).not.toBeChecked();
    await expect(row).toBeVisible();
    await touchTarget(row);
    await singleColumn(page, dialog);
    if (!fallback) {
      await expect(checkbox).toHaveAttribute('data-lenso-slot', 'checkbox');
      await expect(checkbox).toHaveJSProperty('tagName', 'BUTTON');
    }
    const identity = await checkbox.elementHandle();
    await row.locator('.contact-name').click();
    await expect(checkbox).toBeChecked();
    await expect(page.locator('#members-selection')).toHaveText('已选 1 人');
    await checkbox.focus();
    await checkbox.press('Space');
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('#members-selection')).toHaveText('未选择');
    await expect(page.locator('#members-add')).toBeDisabled();
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    expect(await checkbox.evaluate((node, original) => node === original, identity)).toBe(true);
    await labelled(page, 'members-invite-days', '有效天数', fallback);
    await labelled(page, 'members-invite-uses', '可加入次数', fallback);
    await accessible(page, '#members-modal');
    const submitted = page.waitForRequest((req) => req.headers()['mcp-name'] === 'network_room_members_update');
    await page.locator('#members-add').click();
    const args = (await submitted).postDataJSON().params.arguments;
    expect(args).toEqual({ request_id: expect.any(String), room_id: roomId, add: [actorB] });
    await expect(page.locator('#members-current')).toContainText(nameB);
    await expect(row).toHaveCount(0);
  });

  test(`GroupCreate ${backend}：内联列表、过滤/上下/Enter、chips 与 RHF payload`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    if (fallback) await page.route('**/assets/index-*.js', (route) => route.abort());
    const { nameB, actorB } = await setup(page);
    await page.goto(`${base}/`);
    await expect(page.locator('#new-group')).toBeVisible();
    if (!fallback) await expect(page.locator('#room-search')).toHaveAttribute('data-lenso-slot', 'search-field-input');
    await page.locator('#new-group').click();
    const dialog = page.locator('#group-modal');
    await labelled(page, 'group-name-input', '群名（可选）', fallback);
    await labelled(page, 'group-search', '添加成员', fallback);
    const search = page.getByRole('combobox', { name: '添加成员' });
    const option = page.getByRole('option', { name: `${nameB} 人`, exact: true });
    const list = page.locator('#group-contacts [role="listbox"]');
    await expect(list).toBeVisible();
    await expect(option).toBeVisible();
    await touchTarget(option);
    await singleColumn(page, dialog);
    if (!fallback) {
      await expect(search).toHaveAttribute('data-lenso-slot', 'input');
      await expect(list).toHaveAttribute('data-lenso-slot', 'list-root');
    }
    const identity = await search.elementHandle();
    await search.fill('不存在的候选');
    await expect(option).toHaveCount(0);
    await expect(list).toBeVisible();
    await expect(page.locator('#group-contacts')).toContainText('没有匹配的好友');
    await search.fill(nameB);
    await search.press('ArrowDown');
    await search.press('ArrowDown');
    await expect(search).toHaveAttribute('aria-activedescendant', await option.getAttribute('id') ?? '');
    await search.press('ArrowUp');
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(page.locator('#group-selection .spa-chip')).toHaveCount(1);
    await expect(search).toHaveValue('');
    await expect(list).toBeVisible();
    await page.getByRole('button', { name: `移除 ${nameB}` }).click();
    await expect(page.locator('#group-selection .spa-chip')).toHaveCount(0);
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('#group-contacts-count')).toHaveText('已选 1 人');
    const title = `R 表单 ${Date.now()}`;
    await page.locator('#group-name-input').fill(title);
    expect(await search.evaluate((node, original) => node === original, identity)).toBe(true);
    await accessible(page, '#group-modal');
    const submitted = page.waitForRequest((req) => req.headers()['mcp-name'] === 'network_room_create');
    await page.locator('#group-create').click();
    expect((await submitted).postDataJSON().params.arguments).toEqual({
      request_id: expect.any(String), kind: 'group', members: [actorB], title,
    });
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/c\/[^/]+$/);
  });
  test(`Contact policy ${backend}：Label 关联选择器与可访问名`, async ({ page }) => {
    if (fallback) await page.route('**/assets/index-*.js', (route) => route.abort());
    const { roomId } = await setup(page);
    await page.goto(`${base}/c/${roomId}`);
    if (!fallback) await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
    await page.locator('#contact-requests').click();
    await page.locator('#contact-tab-more').click();
    await expect(page.locator('label[for="contact-policy-select"]')).toHaveAttribute('data-lenso-slot', fallback ? 'label-fallback' : 'label');
    await expect(page.locator('#contact-policy-select')).toHaveAccessibleName('我的接收策略');
  });

  test(`Transfer ${backend}：接受后的凭据 Label 与警告关联`, async ({ page }) => {
    if (fallback) await page.route('**/assets/index-*.js', (route) => route.abort());
    const { tokenA, tokenB, actorB } = await createComponentRoom(base);
    const agent = await callTool<{ actor_id: string; token: string }>(base, tokenA, 'network_agent_create', {
      request_id: requestId('forms_agent'), name: 'R Transfer Agent',
    });
    const contact = await callTool<{ request: { contact_request_id: string } | null }>(base, tokenB, 'network_contact_request', {
      request_id: requestId('forms_contact'), actor_id: agent.actor_id,
    });
    if (contact.request) await callTool(base, tokenA, 'network_contact_request_respond', {
      request_id: requestId('forms_contact'), contact_request_id: contact.request.contact_request_id, action: 'accept',
    });
    await callTool(base, tokenA, 'network_agent_transfer_propose', {
      request_id: requestId('forms_transfer'), actor_id: agent.actor_id, to_manager_id: actorB,
    });
    const direct = await callTool<{ room: { room_id: string } }>(base, tokenB, 'network_room_create', {
      request_id: requestId('forms_direct'), kind: 'direct', members: [agent.actor_id],
    });
    await login(page, base, tokenB);
    await page.goto(`${base}/c/${direct.room.room_id}`);
    if (!fallback) await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-transfer').click();
    await page.locator('#transfer-accept').click();
    await expect(page.locator('label[for="transfer-token"]')).toHaveAttribute('data-lenso-slot', fallback ? 'label-fallback' : 'label');
    await expect(page.locator('#transfer-token')).toHaveAccessibleName('新 MCP URL');
    await expect(page.locator('#transfer-token')).toHaveAttribute('aria-describedby', 'transfer-token-warning');
    // 凭据内容只在浏览器内判断非空，不进入失败日志。
    expect(await page.locator('#transfer-token').evaluate((node) => (node as HTMLInputElement).value.length > 0)).toBe(true);
    await page.locator('#transfer-close').click();
    await expect(page.locator('#transfer-token')).toHaveCount(0);
  });
}

test('GroupCreate 慢加载：编辑期间不换壳、不丢值，错误保持关联', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const loading = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route('**/assets/index-*.js', async (route) => { arrived(); await held; await route.continue(); });
  const { nameB } = await setup(page);
  await page.goto(`${base}/`);
  await loading;
  await page.locator('#new-group').click();
  const dialog = page.locator('#group-modal');
  const search = page.locator('#group-search');
  await search.fill(nameB);
  const original = await search.elementHandle();
  const shell = await dialog.elementHandle();
  release();
  await expect(page.locator('#room-search')).toHaveAttribute('data-lenso-slot', 'search-field-input');
  expect(await search.evaluate((node, previous) => node === previous, original)).toBe(true);
  expect(await dialog.evaluate((node, previous) => node === previous, shell)).toBe(true);
  await expect(search).toHaveValue(nameB);
  await expect(search).toBeFocused();
  await expect(page.locator('label[for="group-search"]')).toHaveAttribute('data-lenso-slot', 'label-fallback');
  await page.locator('#group-create').click();
  await expect(search).toHaveAttribute('aria-describedby', 'group-members-error');
  await expect(search).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#group-members-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#group-members-error')).not.toBeEmpty();
  await page.getByRole('option', { name: new RegExp(nameB) }).click();
  await expect(page.locator('#group-members-error')).toHaveCount(0);
});
