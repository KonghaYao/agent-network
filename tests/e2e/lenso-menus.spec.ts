import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let base: string, token: string, group: string, direct: string, message: string, agentId: string;
const request = () => ({ request_id: `menus_${crypto.randomUUID().replaceAll('-', '')}` });
async function tool<T>(auth: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name,
      authorization: `Bearer ${auth}`,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: {
      name, arguments: args, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'lenso-menus', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } }),
  });
  const payload = await response.json() as { error?: unknown; result?: {
    isError?: boolean; structuredContent?: T; content?: { text?: string }[];
  } };
  if (payload.error || payload.result?.isError) throw new Error(`工具失败：${name}`);
  return payload.result?.structuredContent ?? JSON.parse(payload.result?.content?.[0]?.text ?? 'null') as T;
}
async function login(page: Page, room = group, ready = true) {
  await page.addInitScript((auth) => localStorage.setItem('agent-network-token', auth), token);
  await page.goto(`${base}/c/${room}`);
  await expect(page.locator('#title')).toBeVisible();
  if (ready) await expect(page.locator('#room-menu-toggle')).toHaveAttribute('data-lenso-slot', 'menu-trigger');
}
const trigger = (page: Page) => page.locator(`[data-message-id="${message}"] .message-actions-trigger`);
interface MenuMetrics {
  fontSize: string;
  lineHeight: number;
  minHeight: number;
  height: number;
  borders: string[];
}
async function menuMetrics(page: Page, popup: string, item: string): Promise<MenuMetrics> {
  return page.evaluate(({ popup, item }) => {
    const popupNode = document.querySelector<HTMLElement>(popup);
    const itemNode = document.querySelector<HTMLElement>(item);
    if (!popupNode || !itemNode) throw new Error(`菜单未渲染：${popup} / ${item}`);
    const itemStyle = getComputedStyle(itemNode);
    const popupStyle = getComputedStyle(popupNode);
    return {
      fontSize: itemStyle.fontSize,
      lineHeight: parseFloat(itemStyle.lineHeight),
      minHeight: parseFloat(itemStyle.minHeight),
      height: itemNode.offsetHeight,
      borders: [
        popupStyle.borderTopWidth, popupStyle.borderRightWidth,
        popupStyle.borderBottomWidth, popupStyle.borderLeftWidth,
      ],
    };
  }, { popup, item });
}
function expectMenuMetrics(metrics: MenuMetrics): void {
  expect(metrics.fontSize).toBe('13px');
  expect(metrics.lineHeight).toBeCloseTo(13 * 1.4, 1);
  expect(metrics.minHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.height).toBeGreaterThanOrEqual(44);
  expect(metrics.borders).toEqual(['0px', '0px', '0px', '0px']);
}
async function expectDangerColor(page: Page, item: string): Promise<void> {
  const colors = await page.evaluate((item) => {
    const node = document.querySelector<HTMLElement>(item);
    if (!node) throw new Error(`危险项未渲染：${item}`);
    const probe = document.createElement('span');
    probe.style.color = 'var(--wx-danger-text)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(node).color, expected };
  }, item);
  expect(colors.actual).toBe(colors.expected);
}

interface RimState {
  lens: boolean;
  lensDisplay: string;
  lensWidth: number;
  lensHeight: number;
  canvasDisplays: string[];
  shadow: string;
}

/** 读取菜单内 Lenso glass 图层与 live-rim canvas 的实际状态。 */
async function rimState(page: Page, popup: string): Promise<RimState> {
  return page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) throw new Error(`菜单未渲染：${selector}`);
    const lens = root.querySelector<HTMLElement>('[data-material-lens]');
    const lensStyle = lens ? getComputedStyle(lens) : null;
    const rect = lens?.getBoundingClientRect();
    const canvases = [...root.querySelectorAll<HTMLCanvasElement>('canvas[data-lenso-live-rim]')];
    return {
      lens: Boolean(lens),
      lensDisplay: lensStyle?.display ?? '',
      lensWidth: rect?.width ?? 0,
      lensHeight: rect?.height ?? 0,
      canvasDisplays: canvases.map((canvas) => getComputedStyle(canvas).display),
      shadow:
        lensStyle && lensStyle.boxShadow !== 'none'
          ? lensStyle.boxShadow
          : getComputedStyle(root).boxShadow,
    };
  }, popup);
}

/** canvas 只能被隐藏，不能连带隐藏玻璃层；fallback 不应出现 rim canvas。 */
async function expectLiveRimHidden(page: Page, popup: string, lenso: boolean): Promise<void> {
  if (lenso) {
    await expect
      .poll(async () => (await rimState(page, popup)).canvasDisplays.length)
      .toBeGreaterThan(0);
  }
  const state = await rimState(page, popup);
  expect(state.canvasDisplays.every((display) => display === 'none')).toBe(true);
  expect(state.shadow).not.toBe('none');
  if (lenso) {
    expect(state.lens).toBe(true);
    expect(state.lensDisplay).not.toBe('none');
    expect(state.lensWidth).toBeGreaterThan(0);
    expect(state.lensHeight).toBeGreaterThan(0);
  } else {
    expect(state.lens).toBe(false);
  }
}

async function modalContract(page: Page, id: string, menu: string) {
  const dialog = page.locator(`#${id}`);
  await expect(dialog).toBeVisible();
  await expect(page.locator(`#${menu}`)).toBeHidden();
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await expect.poll(() => dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30);
    return node.contains(hit);
  })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test.beforeAll(async () => {
  base = process.env.E2E_BASE_URL ?? JSON.parse(readFileSync(resolve('.e2e/server.json'), 'utf8')).base;
  token = crypto.randomUUID();
  await tool(token, 'network_register', { ...request(), kind: 'human', name: 'Menu owner' });
  const agent = await tool<{ actor_id: string }>(token, 'network_agent_create', { ...request(), name: 'Menu Agent' });
  agentId = agent.actor_id;
  group = (await tool<{ room: { room_id: string } }>(token, 'network_room_create', {
    ...request(), kind: 'group', title: 'Menu group', members: [agent.actor_id],
  })).room.room_id;
  direct = (await tool<{ room: { room_id: string } }>(token, 'network_room_create', {
    ...request(), kind: 'direct', members: [agent.actor_id],
  })).room.room_id;
  message = (await tool<{ message: { message_id: string } }>(token, 'network_message_send', {
    ...request(), room_id: group, body: 'Menu message', client_message_id: crypto.randomUUID(), invoke: [],
  })).message.message_id;
});

for (const fallback of [false, true]) {
  for (const width of [1280, 390]) {
    test(`${fallback ? 'fallback 阻断' : 'Lenso'} ${width} 暗色：键盘、外点、危险项及 Menu → Modal`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark' });
      let intercepted = 0;
      if (fallback) await page.route('**/assets/index-*.js', (route) => { intercepted++; return route.abort(); });
      await login(page, group, !fallback);
      const toggle = page.locator('#room-menu-toggle'), menu = page.locator('#room-menu');
      await toggle.focus();
      await page.keyboard.press('ArrowDown');
      await expect(menu).toHaveAttribute('data-lenso-slot', fallback ? 'menu-fallback' : 'menu-popup');
      expectMenuMetrics(await menuMetrics(page, '#room-menu', '#room-menu-pin'));
      await expectLiveRimHidden(page, '#room-menu', !fallback);
      await expectDangerColor(page, '#room-menu-dissolve');
      await expect(page.locator('#room-menu-copy-prompt')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('#room-menu-pin')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toBeHidden();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await expect(page.locator('#room-menu-pin')).toHaveText('取消置顶');
      const box = (await menu.boundingBox())!, head = (await toggle.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(head.y + head.height);
      const colors = await page.locator('#room-menu-pin').evaluate((node) => {
        const panel = document.createElement('span');
        panel.style.backgroundColor = 'var(--wx-panel)';
        document.body.append(panel);
        const result = [getComputedStyle(node).color, getComputedStyle(panel).backgroundColor];
        panel.remove();
        return result;
      });
      const channels = colors.map((color) => color.match(/\d+/gu)!.slice(0, 3).map(Number));
      expect(channels[0]!.every((channel) => channel > 150)).toBe(true);
      expect(channels[1]!.every((channel) => channel < 120)).toBe(true);
      await expect(page.locator('#room-menu-dissolve')).toHaveClass(/danger/);
      await expect(page.locator('#room-menu-leave-group')).toHaveClass(/danger/);
      await expect(page.locator('#room-menu-members')).toHaveCount(0);
      await expect(menu.locator('.room-menu-sep')).toHaveCount(2);
      await page.keyboard.press('Escape');
      await expect(toggle).toBeFocused();
      await toggle.click();
      await page.locator('#title').click();
      await expect(menu).toBeHidden();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await page.locator('#room-menu-rename').click();
      await modalContract(page, 'room-rename-dialog', 'room-menu');
      await expect(toggle).toBeFocused();
      await trigger(page).click();
      await expect(page.locator('#message-action-menu')).toHaveAttribute('data-lenso-slot', fallback ? 'menu-fallback' : 'menu-popup');
      expectMenuMetrics(await menuMetrics(page, '#message-action-menu', '#message-action-task'));
      await expectLiveRimHidden(page, '#message-action-menu', !fallback);
      await expect(page.locator('#message-action-task')).toHaveText('标记为 Task');
      await expect(page.locator('#message-action-recall')).toHaveClass(/danger/);
      await expect(page.locator('#message-action-memory')).toHaveCount(0);
      await page.locator('#message-action-forward').focus();
      await page.keyboard.press('Space');
      await modalContract(page, 'forward-modal', 'message-action-menu');
      await expect(trigger(page)).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('#message-action-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger(page)).toBeFocused();
      if (fallback) expect(intercepted).toBeGreaterThan(0);
    });
  }
}

for (const kind of ['room', 'message'] as const) {
  test(`${kind}：延迟真实 index chunk，打开不换壳，关闭重开升级`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let intercepted = 0;
    await page.route('**/assets/index-*.js', async (route) => { intercepted++; await gate; await route.continue(); });
    try {
      await login(page, group, false);
      const toggle = kind === 'room' ? page.locator('#room-menu-toggle') : trigger(page);
      const menu = page.locator(kind === 'room' ? '#room-menu' : '#message-action-menu');
      await toggle.click();
      await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-fallback');
      await menu.evaluate((node) => { (window as unknown as { menuNode: Element }).menuNode = node; });
      const first = menu.getByRole('menuitem').first();
      await first.focus();
      release();
      await expect(page.locator('#new-group')).toHaveAttribute('data-lenso-slot', 'button');
      expect(intercepted).toBeGreaterThan(0);
      expect(await menu.evaluate((node) => node === (window as unknown as { menuNode: Element }).menuNode)).toBe(true);
      await expect(first).toBeFocused();
      await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-fallback');
      await page.keyboard.press('Escape');
      await toggle.click();
      await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-popup');
      await expectLiveRimHidden(page, kind === 'room' ? '#room-menu' : '#message-action-menu', true);
    } finally { release(); }
  });
}

for (const fallback of [false, true]) {
  test(`${fallback ? 'fallback' : 'Lenso'}：只读消息及群菜单保持权限条件`, async ({ page }) => {
    const roomId = (await tool<{ room: { room_id: string } }>(token, 'network_room_create', {
      ...request(), kind: 'group', title: 'Read only menu', members: [agentId],
    })).room.room_id;
    await tool(token, 'network_message_send', {
      ...request(), room_id: roomId, body: 'Read only', client_message_id: crypto.randomUUID(), invoke: [],
    });
    await tool(token, 'network_room_dissolve', { ...request(), room_id: roomId });
    if (fallback) await page.route('**/assets/index-*.js', (route) => route.abort());
    await login(page, roomId, !fallback);
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-announcement')).toBeVisible();
    for (const id of ['rename', 'leave-group', 'dissolve', 'transfer', 'archive']) {
      await expect(page.locator(`#room-menu-${id}`)).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    await page.locator('.message-actions-trigger').first().click();
    await expect(page.locator('#message-action-copy')).toBeVisible();
    await expect(page.locator('#message-action-forward')).toBeVisible();
    for (const id of ['task', 'quote', 'recall', 'memory']) {
      await expect(page.locator(`#message-action-${id}`)).toHaveCount(0);
    }
  });
}

for (const room of ['group', 'direct'] as const) {
  test(`${room}：头部与行菜单共用 ID 后缀、文案、条件及危险项`, async ({ page }) => {
    const roomId = room === 'group' ? group : direct;
    await login(page, roomId);
    await page.locator('#room-menu-toggle').click();
    const snapshot = (selector: string) => page.locator(`${selector} [role=menuitem]`).evaluateAll((items) => items.map((node) => ({
      id: node.id.replace(/^room-(row-)?menu-/u, ''), text: node.textContent,
      disabled: node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('disabled'),
      danger: node.classList.contains('danger'),
    })));
    const header = await snapshot('#room-menu');
    await page.keyboard.press('Escape');
    await page.getByRole('radio', { name: room === 'group' ? '群聊' : 'Agent', exact: true }).click();
    await page.locator(`#room-list a[data-room-id="${roomId}"]`).click({ button: 'right' });
    await expect(page.locator('#room-row-menu-copy-prompt')).toBeVisible();
    await expect.poll(async () => (await snapshot('#room-row-menu')).filter((entry) => entry.id !== 'members')).toEqual(header);
    if (room === 'group') await expect(page.locator('#room-row-menu-members')).toBeVisible();
  });
}
