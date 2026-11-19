import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function tool<T>(name: string, args: Record<string, unknown>, token: string): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name, authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: {
      name, arguments: { request_id: crypto.randomUUID(), ...args },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 's08', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  });
  const payload = await response.json() as { result: { isError?: boolean; structuredContent?: T; content?: { text: string }[] } };
  expect(payload.result.isError).not.toBe(true);
  return payload.result.structuredContent ?? JSON.parse(payload.result.content?.[0]?.text ?? 'null');
}

let base: string;
test.beforeAll(() => { base = process.env.E2E_BASE_URL ?? JSON.parse(readFileSync('.e2e/server.json', 'utf8')).base; });

async function home(page: Page, ready = true) {
  const token = crypto.randomUUID();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'network_register', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'network_register', arguments: { request_id: crypto.randomUUID(), kind: 'human', name: 'Tooltip owner' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 's08', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  });
  expect(response.ok).toBe(true);
  await page.addInitScript((auth) => localStorage.setItem('agent-network-token', auth), token);
  await page.goto(base);
  const trigger = page.locator('#new-group');
  await expect(page.locator('#account-name')).toHaveText('Tooltip owner');
  if (ready) await expect(trigger).toHaveAttribute('data-tooltip-backend', 'lenso');
  return trigger;
}

test('hover 延迟、portal、本地层级、Esc 与原生 title 互斥', async ({ page }) => {
  const trigger = await home(page);
  await trigger.hover();
  await page.waitForTimeout(250);
  await expect(page.locator('[data-app-tooltip]')).toHaveCount(0);
  await expect(page.getByRole('tooltip')).toHaveText('新建群聊');
  await expect(trigger).not.toHaveAttribute('title');
  await expect(trigger).toHaveAccessibleName('新建群聊');
  const popup = page.getByRole('tooltip');
  expect(await popup.evaluate((node) => node.parentElement === document.body)).toBe(true);
  expect(await popup.evaluate((node) => Number(getComputedStyle(node).zIndex))).toBeLessThan(100000);
  expect(await popup.evaluate((node) => node.matches(':popover-open'))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(popup).toHaveCount(0);
});

test('focus 打开、blur 关闭，焦点与 hover 切换只保留一个提示', async ({ page }) => {
  const trigger = await home(page);
  await trigger.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.locator('#room-search').focus();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  // 第一个触发器仍持有焦点时 hover 另一个：新提示打开前先关闭旧提示。
  await trigger.focus();
  await expect(page.getByRole('tooltip')).toHaveText('新建群聊');
  await page.locator('#contact-requests').hover();
  await expect(page.getByRole('tooltip')).toContainText('添加好友');
  await expect(page.getByRole('tooltip')).toHaveCount(1);
  await page.mouse.move(600, 400);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('真实 index chunk 阻断仍保留原生提示与交互', async ({ page }) => {
  let blocked = 0;
  await page.route('**/assets/index-*.js', async (route) => { blocked++; await route.abort(); });
  const trigger = await home(page, false);
  await expect(trigger).toHaveAttribute('title', '新建群聊');
  await trigger.hover();
  await page.waitForTimeout(650);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(page.locator('[data-app-tooltip]')).toHaveCount(0);
  expect(blocked).toBeGreaterThan(0);
  await trigger.click();
  await expect(page.locator('#group-modal')).toBeVisible();
});

test('真实 index chunk 慢加载不切换当前 fallback 周期，下一次交互升级', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let intercepted = 0;
  await page.route('**/assets/index-*.js', async (route) => { intercepted++; await gate; await route.continue(); });
  const trigger = await home(page, false);
  await trigger.hover();
  await page.waitForTimeout(550);
  await expect(trigger).toHaveAttribute('title', '新建群聊');
  release();
  await expect(page.locator('#new-agent')).toHaveAttribute('data-lenso-slot', 'button');
  expect(intercepted).toBeGreaterThan(0);
  await expect(trigger).toHaveAttribute('data-tooltip-backend', 'fallback');
  await expect(trigger).toHaveAttribute('title', '新建群聊');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.mouse.move(600, 400);
  await trigger.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(trigger).not.toHaveAttribute('title');
});

test('390px 暗色、可访问名与原命中区不变', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const trigger = await home(page);
  await trigger.focus();
  const popup = page.getByRole('tooltip');
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(trigger).toHaveAccessibleName('新建群聊');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect(page.locator('#group-modal')).toBeVisible();
});

test('会话行与监控五个提示保留语义、安全说明及确认框还焦', async ({ page }) => {
  const token = crypto.randomUUID();
  const peerToken = crypto.randomUUID();
  const owner = await tool<{ actor_id: string }>('network_register', { kind: 'human', name: 'S08 human' }, token);
  const peer = await tool<{ actor_id: string }>('network_register', { kind: 'human', name: 'S08 agent' }, peerToken);
  const request = await tool<{ request: { contact_request_id: string } }>('network_contact_request', { actor_id: peer.actor_id }, token);
  await tool('network_contact_request_respond', { contact_request_id: request.request.contact_request_id, action: 'accept' }, peerToken);
  const created = await tool<{ room: { room_id: string } }>('network_room_create', {
    kind: 'group', title: 'Audit Group', members: [peer.actor_id],
  }, token);
  await tool('network_message_send', {
    client_message_id: crypto.randomUUID(),
    room_id: created.room.room_id, body: 'audit message body', invoke: [],
  }, peerToken);
  await page.addInitScript((auth) => localStorage.setItem('agent-network-token', auth), token);
  await page.goto(base);
  // 图标宿主不使用 hint 回填名称，调用处的显式 aria-label 必须继续生效。
  for (const [id, label] of [
    ['account-rename', '编辑姓名'],
    ['archived-agents', '已归档 Agents'],
    ['logout', '退出登录'],
    ['contact-requests', '添加好友'],
  ] as const) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(label);
  }
  await page.locator('#room-filter-group').click();
  const row = page.locator(`#room-list [data-room-id="${created.room.room_id}"]`);
  await expect(row).toHaveAttribute('data-tooltip-backend', 'lenso');
  // hint 只作为描述，不覆盖由未读、时间与预览派生的内容名称。
  const name = /^未读 Audit Group \d{2}:\d{2} audit message body$/;
  await expect(row).not.toHaveAttribute('aria-label');
  await expect(row).toHaveAccessibleName(name);
  await row.hover();
  await expect(page.getByRole('tooltip')).toHaveText('右键或长按打开会话操作');
  for (const { width, scheme } of [
    { width: 1280, scheme: 'light' as const },
    { width: 1280, scheme: 'dark' as const },
    { width: 390, scheme: 'light' as const },
    { width: 390, scheme: 'dark' as const },
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(600, 400);
    await row.hover();
    const popup = page.locator('[data-app-tooltip]');
    await expect(popup).toBeVisible();
    const visual = await popup.evaluate((root) => {
      const style = getComputedStyle(root);
      const rect = root.getBoundingClientRect();
      const parse = (value: string) => value.match(/[\d.]+/g)!.map(Number);
      const [r, g, b, alpha = 1] = parse(style.backgroundColor);
      const [tr, tg, tb] = parse(style.color);
      const luminance = (red: number, green: number, blue: number) => {
        const channel = (value: number) => {
          const normalized = value / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
      };
      const foreground = luminance(tr!, tg!, tb!);
      const background = luminance(r!, g!, b!);
      return { width: rect.width, left: rect.left, right: rect.right,
        fontSize: style.fontSize, alpha,
        contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        materialDisplays: [...root.querySelectorAll(':scope > [data-lenso-slot="tooltip-material"]')]
          .map((layer) => getComputedStyle(layer).display) };
    });
    expect(visual.width).toBeLessThanOrEqual(240);
    expect(visual.fontSize).toBe('12px');
    expect(visual.alpha).toBe(1);
    expect(visual.contrast).toBeGreaterThanOrEqual(4.5);
    expect(visual.materialDisplays.every((display) => display === 'none')).toBe(true);
    expect(visual.left).toBeGreaterThanOrEqual(0);
    expect(visual.right).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/roomrow-tooltip-${width}-${scheme}.png` });
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await page.mouse.move(600, 400);
    await row.hover();
    await expect(popup).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect(popup).toHaveCount(0);
  }
  await expect(row).toHaveAccessibleName(name);
  await expect(row).not.toHaveAttribute('aria-label');
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.move(600, 400);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await row.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  const describedBy = (await row.getAttribute('aria-describedby'))?.split(/\s+/) ?? [];
  const tooltipId = await page.locator('[data-app-tooltip]').getAttribute('id');
  expect(tooltipId).toBeTruthy();
  expect(describedBy).toContain(tooltipId);
  await page.keyboard.press('Escape');
  await page.goto(`${base}/c/${created.room.room_id}`);
  // 消息气泡的 hint 只是时间，适配器不得据此合成 aria-label，也不能盖住正文快照。
  const bubble = page.locator('#messages .msg .bubble', { hasText: 'audit message body' }).first();
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAttribute('data-tooltip-backend', 'lenso');
  await expect(bubble).not.toHaveAttribute('aria-label');
  await expect(bubble).toHaveAccessibleName('');
  await expect(bubble).toMatchAriaSnapshot('- text: audit message body');
  await bubble.hover();
  const timePopup = page.getByRole('tooltip');
  await expect(timePopup).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  const bubbleDescribedBy = (await bubble.getAttribute('aria-describedby'))?.split(/\s+/) ?? [];
  expect(bubbleDescribedBy).toContain(await timePopup.getAttribute('id'));
  await expect(bubble).toHaveAccessibleName('');
  await expect(bubble).toMatchAriaSnapshot('- text: audit message body');
  await page.keyboard.press('Escape');
  await page.locator('#monitor-toggle').click();
  for (const [id, hint, name] of [
    ['monitor-save', '保存网页地址（Enter）', '保存网页地址'],
    ['monitor-clear', '清除网页地址', '清除网页地址'],
    ['monitor-external', 'iframe 未加 sandbox', '新标签页打开网页；仅限可信地址，iframe 未加 sandbox，同源页面可读取本页登录凭据'],
    ['monitor-refresh', '刷新网页（重新读取地址）', '刷新网页'],
    ['monitor-close', '关闭网页监控', '关闭网页监控'],
  ] as const) {
    const trigger = page.locator(`#${id}`);
    await trigger.focus();
    await expect(page.getByRole('tooltip')).toContainText(hint);
    await expect(trigger).not.toHaveAttribute('title');
    await expect(trigger).toHaveAccessibleName(name);
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('#monitor-frame')).toHaveAttribute('title', /网页内容/);
  await page.locator('#monitor-clear').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-dialog-cancel').click();
  await expect(page.locator('#monitor-clear')).toBeFocused();
  expect(owner.actor_id).not.toBe(peer.actor_id);
});

test('离开取消延迟，已打开提示在 hover 离开后卸载', async ({ page }) => {
  const trigger = await home(page);
  await trigger.hover();
  await page.waitForTimeout(150);
  await page.mouse.move(600, 400);
  await page.waitForTimeout(550);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await trigger.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.mouse.move(600, 400);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('本地提示不进入 top layer 或遮盖 Lenso Modal', async ({ page }) => {
  const trigger = await home(page);
  await trigger.hover();
  const popup = page.getByRole('tooltip');
  await expect(popup).toBeVisible();
  await page.locator('#new-agent').evaluate((node: HTMLButtonElement) => node.click());
  const modal = page.locator('#new-agent-modal');
  await expect(modal).toHaveAttribute('data-lenso-slot', 'modal-popup');
  // Modal 打开会使原触发器失焦；提示可卸载，也可留在本地层，但不能进入 top layer。
  expect(await page.locator('[data-app-tooltip]').evaluateAll((nodes) => nodes.every((node) => !node.matches(':popover-open')))).toBe(true);
  expect(await modal.evaluate((node) => node.matches(':popover-open'))).toBe(true);
  await page.locator('#new-agent-name').fill('提示不能阻挡输入');
  await expect(page.locator('#new-agent-name')).toBeFocused();
});

test('无 hover 触屏点击不留下 tooltip', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    const trigger = await home(page);
    await trigger.tap();
    await page.waitForTimeout(650);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.locator('#group-modal')).toBeVisible();
    await expect(trigger).toHaveAccessibleName('新建群聊');
  } finally { await context.close(); }
});
