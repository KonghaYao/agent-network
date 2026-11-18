import { expect, test, type Page, type Route } from '@playwright/test';
import { getTopModalShell, registerModalShell } from '../../src/web/app/modal-shell';
import { readFileSync } from 'node:fs';

let base: string;
const request = () => ({ request_id: `s04_${crypto.randomUUID().replaceAll('-', '')}` });
async function tool<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name, authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: {
      name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 's04-alerts', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  });
  const payload = await response.json() as { error?: unknown; result: { isError?: boolean; structuredContent?: T; content?: { text: string }[] } };
  if (payload.error || payload.result.isError) throw new Error(`工具失败：${name}`);
  return payload.result.structuredContent ?? JSON.parse(payload.result.content?.[0]?.text ?? 'null') as T;
}

async function fixture(page: Page, ready = true, member = false) {
  const token = crypto.randomUUID();
  const peerToken = crypto.randomUUID();
  const owner = await tool<{ actor_id: string }>(token, 'network_register', { ...request(), kind: 'human', name: 'S04 owner' });
  const peer = await tool<{ actor_id: string }>(peerToken, 'network_register', { ...request(), kind: 'human', name: 'S04 peer' });
  const invitation = await tool<{ request: { contact_request_id: string } }>(token, 'network_contact_request', { ...request(), actor_id: peer.actor_id });
  await tool(peerToken, 'network_contact_request_respond', { ...request(), contact_request_id: invitation.request.contact_request_id, action: 'accept' });
  // 退群用 peer 作群主，Members 移除流程则由浏览器用户作群主。
  const group = (await tool<{ room: { room_id: string } }>(member ? peerToken : token, 'network_room_create', {
    ...request(), kind: 'group', title: 'S04 alerts', members: [member ? owner.actor_id : peer.actor_id],
  })).room.room_id;
  const message = (await tool<{ message: { message_id: string } }>(token, 'network_message_send', {
    ...request(), client_message_id: crypto.randomUUID(), room_id: group, body: 'S04 task', invoke: [],
  })).message.message_id;
  await tool(token, 'network_task_mark', { ...request(), room_id: group, message_id: message });
  await tool(token, 'network_room_monitor_set', { ...request(), room_id: group, url: `${base}/health` });
  await page.addInitScript((auth) => {
    if (sessionStorage.getItem('s04-seeded')) return;
    localStorage.setItem('agent-network-token', auth);
    sessionStorage.setItem('s04-seeded', '1');
  }, token);
  await page.goto(`${base}/c/${group}`);
  await expect(page.locator('#title')).toBeVisible();
  if (ready) await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
  return { token, group };
}

async function confirm(page: Page) {
  if (!(await page.locator('#monitor-pane').isVisible())) await page.locator('#monitor-toggle').click();
  await page.locator('#monitor-clear').click();
}
async function lenso(page: Page, id: string, message: string) {
  const dialog = page.locator(`#${id}`);
  await expect(dialog).toHaveAttribute('data-lenso-slot', 'alert-dialog-popup');
  await expect(dialog).toHaveAttribute('data-alert-shell', 'lenso');
  await expect(dialog).toHaveAttribute('role', 'alertdialog');
  await expect(dialog).toHaveAttribute('aria-describedby', message);
  await expect(dialog).toHaveAccessibleName(/.+/);
  await expect(page.locator(`#${message}`)).not.toHaveText('');
  expect(await dialog.evaluate((node) => node.matches(':popover-open') || Boolean(node.closest(':popover-open')))).toBe(true);
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  return dialog;
}
async function close(page: Page, mode: string, cancel: string) {
  if (mode === 'cancel') await page.locator(`#${cancel}`).click();
  else if (mode === 'escape') await page.keyboard.press('Escape');
  else await page.locator('.spa-dialog-overlay').last().click({ position: { x: 4, y: 4 } });
}
async function fail(route: Route, message: string) {
  const body = route.request().postDataJSON() as { id: unknown };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id,
    result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INTERNAL', message }) }] } }) });
}

test.beforeAll(() => { base = process.env.E2E_BASE_URL ?? JSON.parse(readFileSync('.e2e/server.json', 'utf8')).base; });

test('Modal shell 注册表：顶层优先、关闭回退、非顶层卸载与幂等清理', () => {
  expect(getTopModalShell()).toBeNull();
  const parent = registerModalShell('radix');
  const child = registerModalShell('lenso');
  expect(getTopModalShell()).toBe('lenso');
  child();
  expect(getTopModalShell()).toBe('radix');
  const next = registerModalShell('lenso');
  parent(); parent();
  expect(getTopModalShell()).toBe('lenso');
  next();
  expect(getTopModalShell()).toBeNull();
});

for (const delayed of [true, false]) {
  test(`页面 confirm：${delayed ? '慢加载到达不换壳、重开升级' : '阻断真实 chunk、fallback 可操作'}`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let intercepted = 0;
    await page.route('**/assets/index-*.js', async (route) => {
      intercepted++;
      if (delayed) { await gate; await route.continue(); }
      else await route.abort('failed');
    });
    try {
      await fixture(page, false);
      await confirm(page);
      const dialog = page.locator('#confirm-dialog');
      await expect(dialog).toHaveAttribute('data-alert-shell', 'radix');
      await dialog.evaluate((node) => {
        (window as unknown as { __alertNodes: Element[] }).__alertNodes = [node, ...node.querySelectorAll('button')];
      });
      expect(intercepted).toBeGreaterThan(0);
      if (delayed) {
        release();
        await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
        await expect(dialog).toHaveAttribute('data-alert-shell', 'radix');
        expect(await page.evaluate(() => (window as unknown as { __alertNodes: Element[] }).__alertNodes.every((node) => node.isConnected))).toBe(true);
      }
      await page.locator('#confirm-dialog-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('#monitor-clear')).toBeFocused();
      await confirm(page);
      await expect(dialog).toHaveAttribute('data-alert-shell', delayed ? 'lenso' : 'radix');
      await page.locator('#confirm-dialog-ok').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('#monitor-url')).toHaveValue('');
    } finally { release(); }
  });
}

for (const name of ['Logout', 'LeaveRoom', 'TaskComplete']) {
  test(`${name}：延迟模块的 lease 与焦点不丢失，关闭重开升级`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    await page.route('**/assets/index-*.js', async (route) => { await gate; await route.continue(); });
    try {
      await fixture(page, false);
      if (name === 'Logout') await page.goto(`${base}/`);
      const id = name === 'Logout' ? 'logout-modal' : name === 'LeaveRoom' ? 'leave-dialog' : 'task-complete-dialog';
      const cancel = name === 'Logout' ? 'logout-cancel' : name === 'LeaveRoom' ? 'leave-cancel' : 'task-complete-cancel';
      const open = async () => {
        if (name === 'Logout') await page.locator('#logout').click();
        else if (name === 'LeaveRoom') {
          await page.locator('#room-menu-toggle').click();
          await page.locator('#room-menu-leave-group').click();
        } else {
          if (!(await page.locator('.task-dock-complete').isVisible())) await page.locator('#task-dock-toggle').click();
          await page.locator('.task-dock-complete').click();
        }
      };
      await open();
      const dialog = page.locator(`#${id}`);
      await expect(dialog).toHaveAttribute('data-alert-shell', 'radix');
      await page.locator(`#${cancel}`).focus();
      const node = await dialog.elementHandle();
      release();
      const ready = name === 'Logout' ? '#new-group' : '#message-search-button';
      await expect(page.locator(ready)).toHaveAttribute('data-lenso-slot', 'button');
      expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(dialog).toHaveAttribute('data-alert-shell', 'radix');
      await expect(page.locator(`#${cancel}`)).toBeFocused();
      await page.locator(`#${cancel}`).click();
      await expect(dialog).toHaveCount(0);
      await open();
      await expect(dialog).toHaveAttribute('data-lenso-slot', 'alert-dialog-popup');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally { release(); }
  });
}

for (const task of [true, false]) {
  test(`${task ? 'TaskComplete' : 'LeaveRoom'}：真实请求阻塞、busy、错误原位与重试结算`, async ({ page }) => {
    await fixture(page, true, !task);
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let attempts = 0;
    const requestIds: string[] = [];
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== (task ? 'network_task_complete' : 'network_room_leave')) return route.continue();
      attempts++;
      requestIds.push(route.request().postDataJSON().params.arguments.request_id);
      if (attempts === 1) { await gate; await fail(route, 'S04 注入失败'); }
      else await route.continue();
    });
    try {
      if (task) {
        await page.locator('#task-dock-toggle').click();
        await page.locator('.task-dock-complete').click();
      } else {
        await page.locator('#room-menu-toggle').click();
        await page.locator('#room-menu-leave-group').click();
      }
      const id = task ? 'task-complete-dialog' : 'leave-dialog';
      const prefix = task ? 'task-complete' : 'leave';
      const dialog = await lenso(page, id, `${prefix}-message`);
      await page.locator(`#${prefix}-confirm`).click();
      await expect(page.locator(`#${prefix}-confirm`)).toBeDisabled();
      await expect(page.locator(`#${prefix}-confirm`)).toHaveText(task ? '完成中…' : '正在退出…');
      await expect(dialog).toBeVisible();
      if (task) {
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await expect(page.locator('#task-complete-cancel')).toBeDisabled();
      }
      release();
      await expect(page.locator(task ? '#task-complete-error' : '#leave-status')).toContainText('S04 注入失败');
      await expect(dialog).toBeVisible();
      await page.locator(`#${prefix}-confirm`).click();
      await expect(dialog).toHaveCount(0);
      expect(attempts).toBe(2);
      if (task) {
        expect(requestIds[0]).toBe(requestIds[1]);
        await expect(page.locator('#task-dock-toggle')).toBeFocused();
        await expect(page.locator('#task-dock-count')).toHaveText('0');
      } else await expect(page).toHaveURL(`${base}/`);
    } finally { release(); }
  });
}

test('页面 confirm：真实 Lenso、ids、取消/Esc/背板、true/false、危险项与还焦', async ({ page }) => {
  await fixture(page);
  let clears = 0;
  page.on('request', (req) => { if (req.headers()['mcp-name'] === 'network_room_monitor_set') clears++; });
  for (const mode of ['cancel', 'escape', 'backdrop']) {
    await confirm(page);
    const dialog = await lenso(page, 'confirm-dialog', 'confirm-dialog-message');
    await expect(dialog).toHaveClass(/modal-card spa-dialog-content confirm-card/);
    await expect(page.locator('#confirm-dialog-title')).toHaveText('清除网址');
    await expect(page.locator('#confirm-dialog-ok')).toHaveClass(/danger/);
    await close(page, mode, 'confirm-dialog-cancel');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#monitor-clear')).toBeFocused();
    expect(clears).toBe(0);
  }
  await confirm(page);
  await page.locator('#confirm-dialog-ok').click();
  await expect(page.locator('#confirm-dialog')).toHaveCount(0);
  await expect(page.locator('#monitor-url')).toHaveValue('');
  expect(clears).toBe(1);
});

for (const parent of ['Members', 'ContactRequests']) {
  test(`${parent}：Radix confirm 取消不误关父层且还焦`, async ({ page }) => {
    await fixture(page);
    const members = parent === 'Members';
    await page.locator(members ? '#members-button' : '#contact-requests').click();
    const dialog = page.locator(members ? '#members-modal' : '#contact-modal');
    await expect(dialog).toHaveAttribute('data-modal-shell', 'radix');
    if (!members) {
      await page.locator('#contact-tab-more').click();
      await page.locator('#contact-link-create').click();
      await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
    }
    const trigger = members ? page.getByRole('button', { name: '移除 S04 peer' })
      : page.locator('#contact-link-list').getByRole('button', { name: /撤销好友链接/ }).first();
    for (const mode of ['cancel']) {
      await trigger.click();
      await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'radix');
      await expect(page.locator('#confirm-dialog')).not.toHaveAttribute('data-lenso-slot');
      await expect(page.locator('#confirm-dialog-cancel')).toBeFocused();
      await close(page, mode, 'confirm-dialog-cancel');
      await expect(page.locator('#confirm-dialog')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(trigger).toBeFocused();
    }
    await page.keyboard.press('Escape');
    // 注销父层后下一次 confirm 恢复 Lenso。
    await confirm(page);
    await lenso(page, 'confirm-dialog', 'confirm-dialog-message');
  });
}

test('Logout：Lenso 确认后只清理本机状态，不发业务写请求', async ({ page }) => {
  await fixture(page);
  await page.goto(`${base}/`);
  await expect(page.locator('#logout')).toHaveAttribute('data-lenso-slot', 'button');
  await page.locator('#logout').click();
  await lenso(page, 'logout-modal', 'logout-message');
  const writes: string[] = [];
  page.on('request', (req) => {
    const name = req.headers()['mcp-name'];
    if (name && /logout|revoke/.test(name)) writes.push(name);
  });
  await page.locator('#logout-confirm').click();
  await expect(page.locator('#logged-out-start')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('agent-network-token') === null)).toBe(true);
  expect(writes).toEqual([]);
});

for (const width of [1280, 390]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${width} ${colorScheme}：Logout/Leave/TaskComplete 几何、焦点、Esc/背板与卸载`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      await fixture(page);
      const cases = [
        { id: 'leave-dialog', message: 'leave-message', cancel: 'leave-cancel', trigger: '#room-menu-toggle', open: async () => {
          await page.locator('#room-menu-toggle').click(); await page.locator('#room-menu-leave-group').click();
        } },
        { id: 'task-complete-dialog', message: 'task-complete-message', cancel: 'task-complete-cancel', trigger: '.task-dock-complete', open: async () => {
          if (!(await page.locator('.task-dock-complete').isVisible())) await page.locator('#task-dock-toggle').click();
          await page.locator('.task-dock-complete').click();
        } },
        { id: 'logout-modal', message: 'logout-message', cancel: 'logout-cancel', trigger: '#logout', open: async () => {
          if (!page.url().endsWith('/')) {
            await page.goto(`${base}/`); await expect(page.locator('#logout')).toHaveAttribute('data-lenso-slot', 'button');
          }
          await page.locator('#logout').click();
        } },
      ];
      for (const item of cases) {
        for (const mode of ['cancel', 'escape', 'backdrop']) {
          await item.open();
          const dialog = await lenso(page, item.id, item.message);
          const box = await dialog.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(2);
          for (const button of await dialog.locator('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          await close(page, mode, item.cancel);
          await expect(dialog).toHaveCount(0);
          await expect(page.locator(item.trigger)).toBeFocused();
        }
      }
    });
  }
}
