import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';
import { semanticColor } from './fixtures/semantic-colors';

/**
 * 4B-6 Home e2e：`bun run test:e2e` 直接运行 React 页面。
 */

interface SidebarAccountGeometry {
  sidebar: { left: number; right: number; width: number; scrollWidth: number; clientWidth: number };
  brandColor: string;
  account: {
    left: number;
    right: number;
    width: number;
    height: number;
    scrollWidth: number;
    clientWidth: number;
  };
  avatar: { width: number; height: number };
  nameToActions: number;
  actions: {
    left: number;
    right: number;
    top: number;
    width: number;
    height: number;
    scrollWidth: number;
    clientWidth: number;
  };
  buttons: { id: string; left: number; right: number; top: number; height: number }[];
  actionRows: number;
  docOverflow: number;
}

async function readBrandColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const brand = document.querySelector<HTMLElement>('.brand-row h1');
    return brand ? getComputedStyle(brand).color : '';
  });
}

async function readSidebarAccountGeometry(page: Page): Promise<SidebarAccountGeometry> {
  await expect(page.locator('.account-actions #new-agent')).toBeVisible();
  return page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`缺少元素：${selector}`);
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    };
    const buttons = [...document.querySelectorAll<HTMLElement>('.account-actions > button')].map(
      (button) => {
        const rect = button.getBoundingClientRect();
        return {
          id: button.id,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          height: rect.height,
        };
      },
    );
    const brand = document.querySelector<HTMLElement>('.brand-row h1');
    if (!brand) throw new Error('缺少品牌字标');
    const name = document.querySelector<HTMLElement>('#account-name');
    if (!name) throw new Error('缺少账号名称');
    const actions = read('.account-actions');
    return {
      sidebar: read('.sidebar'),
      brandColor: getComputedStyle(brand).color,
      account: read('.account'),
      avatar: read('.account-avatar'),
      nameToActions: actions.top - name.getBoundingClientRect().bottom,
      actions,
      buttons,
      actionRows: new Set(buttons.map((button) => Math.round(button.top))).size,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
}

async function callTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-e2e',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string; data?: { code?: string } };
    result?: ToolEnvelope;
  };
  if (payload.error) {
    throw new Error(payload.error.message ?? 'MCP 调用失败');
  }
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
  name: string;
}

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

test.describe('SPA Home', () => {

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let actorA = '';
  let nameA = '';
  let nameB = '';
  let roomId = '';
  let groupId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    nameA = `E2E A ${suffix}`;
    nameB = `E2E B ${suffix}`;

    const a = await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameA,
      device_id: `e2e-${suffix}-a`,
    });
    actorA = a.actor_id;
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameB,
      device_id: `e2e-${suffix}-b`,
    });
    const request = await callTool<ContactRequestResult>(
      base,
      tokenA,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: b.actor_id },
    );
    const contactRequestId = request.request?.contact_request_id;
    if (!contactRequestId) throw new Error('好友申请未创建');
    await callTool(base, tokenB, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });

    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 50 });
    const direct = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === b.actor_id,
    );
    if (!direct) throw new Error('好友通过后未生成 direct 会话');
    roomId = direct.room_id;

    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: 'E2E 初始未读消息',
      invoke: [],
    });

    const group = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_group'),
        kind: 'group',
        members: [b.actor_id],
        title: `E2E 群聊 ${suffix}`,
      },
    );
    groupId = group.room.room_id;
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, tokenA);
  });

  test('renders rooms, unread state, search and account', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#room-search')).toBeVisible();
    await expect(page.locator('.search-box [data-lenso-slot="search-field"]')).toHaveCount(1);
    const searchInput = await page.locator('#room-search').boundingBox();
    expect(searchInput?.height ?? 0).toBeGreaterThanOrEqual(30);
    expect(searchInput?.height ?? 0).toBeLessThanOrEqual(32);
    const searchHit = await page.locator('.search-box').boundingBox();
    expect(searchHit?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    await expect(page.locator('#room-list .room-name')).toHaveText(nameB);
    await expect(page.locator('#room-list .unread')).toHaveCount(1);
    await expect(page.locator('#account-name')).toHaveText(nameA);
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#composer')).toHaveCount(0);

    await page.fill('#room-search', '不存在的会话');
    await expect(page.locator('#room-list-status')).toHaveText('没有匹配的会话');
    await expect(page.locator('#room-list .room-item')).toHaveCount(0);
    await page.press('#room-search', 'Escape');
    await expect(page.locator('#room-search')).toHaveValue('');
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);

    // 组合输入中的 Escape 交给 IME 取消候选，不能清空已输入内容。
    await page.fill('#room-search', '周末');
    await page.evaluate(() => {
      const input = document.getElementById('room-search') as HTMLInputElement;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
      );
    });
    await expect(page.locator('#room-search')).toHaveValue('周末');
    await page.evaluate(() => {
      document
        .getElementById('room-search')
        ?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await page.press('#room-search', 'Escape');
    await expect(page.locator('#room-search')).toHaveValue('');

    expect(errors).toEqual([]);
  });

  test('brand wordmark uses the accessible blue token, not the logo green', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('.brand-row h1')).toHaveText('WeBots');
    // React 水合会替换 SSR 工具栏，用页面内查询避开旧节点。
    await expect
      .poll(() => readBrandColor(page))
      .toBe(await semanticColor(page, '--lenso-tint-text', 'color'));
    expect(await readBrandColor(page)).not.toBe('rgb(7, 193, 96)');
  });

  test('account block stays compact inside the sidebar at 240, 300 and 480', async ({ page }) => {
    await page.goto(`${base}/`);
    for (const { width, maxHeight } of [
      // 69a4770 的三档用户块高度为 115/81/81px；收紧后写死目标上限。
      { width: 240, maxHeight: 100 },
      { width: 300, maxHeight: 62 },
      { width: 480, maxHeight: 62 },
    ]) {
      await page.evaluate((sidebarWidth) => {
        localStorage.setItem(
          'agent-network-ui-v1',
          JSON.stringify({
            state: { homeLayout: null, sidebarWidth },
            version: 1,
          }),
        );
      }, width);
      await page.reload();
      await expect(page.locator('.account')).toBeVisible();
      await expect
        .poll(() =>
          page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBeCloseTo(width, 0);

      const geometry = await readSidebarAccountGeometry(page);
      expect(geometry.docOverflow, `sidebar ${width}`).toBeLessThanOrEqual(0);
      expect(geometry.account.height, `用户块高度 @ ${width}`).toBeLessThanOrEqual(maxHeight);
      // 名称行被 Lenso 的 36px min-height 撑高过，这里守住文本底到操作行顶的间距。
      expect(geometry.nameToActions, `名字底到操作行顶 @ ${width}`).toBeGreaterThanOrEqual(0);
      expect(geometry.nameToActions, `名字底到操作行顶 @ ${width}`).toBeLessThanOrEqual(4);
      expect(geometry.avatar.width, `头像宽度 @ ${width}`).toBeGreaterThanOrEqual(32);
      expect(geometry.avatar.width, `头像宽度 @ ${width}`).toBeLessThanOrEqual(36);
      expect(geometry.avatar.height, `头像高度 @ ${width}`).toBeGreaterThanOrEqual(32);
      expect(geometry.avatar.height, `头像高度 @ ${width}`).toBeLessThanOrEqual(36);
      expect(geometry.sidebar.scrollWidth, `sidebar ${width}`).toBeLessThanOrEqual(
        geometry.sidebar.clientWidth + 1,
      );
      expect(geometry.account.left, `sidebar ${width}`).toBeGreaterThanOrEqual(
        geometry.sidebar.left - 0.5,
      );
      expect(geometry.account.right, `sidebar ${width}`).toBeLessThanOrEqual(
        geometry.sidebar.right + 0.5,
      );
      expect(geometry.actions.right, `sidebar ${width}`).toBeLessThanOrEqual(
        geometry.sidebar.right + 0.5,
      );
      expect(geometry.actions.scrollWidth, `sidebar ${width}`).toBeLessThanOrEqual(
        geometry.actions.clientWidth + 1,
      );
      // 操作行按内容收窄，不铺满整条侧栏。
      expect(geometry.actions.width, `sidebar ${width}`).toBeLessThan(geometry.account.width);
      expect(geometry.buttons.map((button) => button.id)).toEqual([
        'new-agent',
        'device-handoff',
        'memory-open',
        'archived-agents',
        'logout',
      ]);
      for (const button of geometry.buttons) {
        expect(button.height, `${button.id} @ ${width}`).toBeGreaterThanOrEqual(32);
        expect(button.left, `${button.id} @ ${width}`).toBeGreaterThanOrEqual(
          geometry.sidebar.left - 0.5,
        );
        expect(button.right, `${button.id} @ ${width}`).toBeLessThanOrEqual(
          geometry.sidebar.right + 0.5,
        );
      }
      if (width === 240) {
        expect(geometry.actionRows, '240 下操作行换行而不是横向溢出').toBeGreaterThan(1);
      }
    }
  });

  test('account buttons keep a visible keyboard focus ring', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#new-agent')).toBeVisible();
    await page.evaluate(() => document.getElementById('new-agent')?.focus());
    const focus = await page.evaluate(() => {
      const element = document.getElementById('new-agent');
      if (!element) throw new Error('缺少新建 Agent 按钮');
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focus.outlineStyle).not.toBe('none');
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  });

  test('keeps the 44px search hit area focusable', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-search')).toBeVisible();

    const activeId = () => page.evaluate(() => document.activeElement?.id ?? '');
    const blur = () =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const box = await page.locator('.search-box').boundingBox();
    if (!box) throw new Error('搜索命中区不可见');
    // 外层 44px 命中区的 padding（32px 控件之外）。
    await page.mouse.click(box.x + 4, box.y + 3);
    expect(await activeId()).toBe('room-search');
    await blur();

    // 搜索图标仍应把焦点交给输入框。
    await page.locator('.search-box [data-lenso-slot="search-field-search-icon"]').click();
    expect(await activeId()).toBe('room-search');
    await blur();

    // Group 自身空白（不在 input/button 上）也要聚焦。
    const blank = await page.evaluate(() => {
      const group = document.querySelector('.search-box [data-lenso-slot="search-field-group"]');
      if (!(group instanceof HTMLElement)) return null;
      const rect = group.getBoundingClientRect();
      for (let x = rect.left + 1; x < rect.right - 1; x += 1) {
        for (let y = rect.top + 1; y < rect.bottom - 1; y += 1) {
          if (document.elementFromPoint(x, y) === group) return { x, y };
        }
      }
      return null;
    });
    if (!blank) throw new Error('未找到 SearchField.Group 的空白命中区');
    await page.mouse.click(blank.x, blank.y);
    expect(await activeId()).toBe('room-search');
    await blur();

    await page.locator('#room-search').click();
    expect(await activeId()).toBe('room-search');
  });

  test('search retains the focused input and IME selection when Lenso arrives', async ({ page, context }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/assets/index-*.js', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      const input = page.locator('#room-search');
      await input.fill('abcd');
      await input.evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 2));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: '周', selectionStart: 1, selectionEnd: 1 });
      await expect(input).toHaveValue('ab周cd');
      const original = await input.elementHandle();
      release();
      await expect(page.locator('#new-group')).toHaveAttribute('data-lenso-slot', 'button');
      expect(await original!.evaluate((node) => node === document.activeElement)).toBe(true);
      await cdp.send('Input.insertText', { text: '周末' });
      await page.keyboard.type('e');
      await expect(input).toHaveValue('ab周末ecd');
      await page.keyboard.press('Tab');
      await expect(input).not.toBeFocused();
      await expect(page.locator('.search-box [data-lenso-slot="search-field"]')).toBeVisible();
      await expect(input).toHaveValue('ab周末ecd');
    } finally {
      release();
    }
  });

  test('keeps IME composition text when Escape cancels search', async ({ page, context }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-search')).toBeVisible();
    // 等 Lenso 完成动态替换后再进入组合输入，避免节点换新丢掉候选。
    await expect(
      page.locator('.search-box [data-lenso-slot="search-field"]'),
    ).toHaveCount(1);
    await page.fill('#room-search', '保留');
    await page.locator('#room-search').focus();

    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: '周末',
      selectionStart: 2,
      selectionEnd: 2,
    });
    await expect(page.locator('#room-search')).toHaveValue('保留周末');

    // 真实 CDP 组合输入中的 Escape 必须阻止 type=search 的原生清空。
    await page.keyboard.press('Escape');
    await expect(page.locator('#room-search')).toHaveValue('保留周末');

    // 结束组合后，普通 Escape 仍应清空。
    await cdp.send('Input.insertText', { text: '周末' });
    await expect(page.locator('#room-search')).toHaveValue('保留周末');
    await page.keyboard.press('Escape');
    await expect(page.locator('#room-search')).toHaveValue('');
  });

  test('renders contact link failure as danger alert text', async ({ page }) => {
    await page.goto(`${base}/#friend=invalid-link-token`);
    const banner = page.locator('#contact-link-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toHaveAttribute('aria-live', 'polite');
    await expect(banner).toHaveAttribute('data-error', '1');
    await expect(banner).toHaveAttribute('data-lenso-slot', 'alert-root');
    await expect(banner).toContainText('好友链接');

    const description = banner.locator('[data-lenso-slot="alert-description"]');
    expect(await description.evaluate((node) => getComputedStyle(node).fontSize)).toBe('13px');
    expect(await description.evaluate((node) => getComputedStyle(node).color)).toBe(
      await semanticColor(page, '--wx-unread', 'color'),
    );
  });

  test('shows category unread badges and preference labels', async ({ page }) => {
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: `E2E 徽标未读 ${Date.now()}`,
      invoke: [],
    });

    await page.goto(`${base}/`);
    const row = page.locator(`#room-list a[data-room-id="${roomId}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.unread')).toHaveAttribute('aria-label', '未读');
    await expect(page.locator('#room-filter-friend .room-filter-unread')).toHaveText('1');
    await expect(page.locator('#room-filter-agent .room-filter-unread')).toHaveCount(0);
    await expect(page.locator('#room-filter-group .room-filter-unread')).toHaveCount(0);
    await expect(page.locator('#room-filter-unread-status')).toHaveText(/好友 1 个会话未读/);

    await page.evaluate(
      ({ actorId, targetRoomId }) => {
        localStorage.setItem(
          `agent-network-room-preferences-v1:${actorId}`,
          JSON.stringify({ [targetRoomId]: { pinned: true, muted: true } }),
        );
      },
      { actorId: actorA, targetRoomId: roomId },
    );
    await page.reload();
    const updated = page.locator(`#room-list a[data-room-id="${roomId}"]`);
    await expect(updated.locator('.room-pref-label')).toHaveText('置顶 · 免打扰');
    await expect(updated.locator('.unread')).toHaveClass(/muted/);
    await expect(updated.locator('.unread')).toHaveAttribute('aria-label', '未读，消息免打扰');
    await expect(page.locator('#room-filter-friend .room-filter-unread')).toHaveCount(0);
  });

  test('stream notification refreshes the list without a reload', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    await page.evaluate(() => {
      window.sessionStorage.setItem('__homeMarker', '1');
    });

    const body = `E2E 实时消息 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body,
      invoke: [],
    });

    await expect(page.locator('#room-list .room-preview')).toContainText('E2E 实时消息', {
      timeout: 10_000,
    });
    expect(await page.evaluate(() => window.sessionStorage.getItem('__homeMarker'))).toBe('1');
  });

  test('backs off across unacknowledged streams and recovers on the next ack', async ({ page }) => {
    const starts: number[] = [];
    await page.route('**/mcp', async route => {
      if (route.request().headers()['mcp-method'] !== 'subscriptions/listen') {
        await route.continue();
        return;
      }
      starts.push(performance.now());
      if (starts.length <= 2) {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
        return;
      }
      await route.continue();
    });
    await page.goto(base);
    await expect.poll(() => starts.length, { timeout: 12_000 }).toBe(3);
    const minimumSecondDelay = 2 * LIMITS.reconnectBaseMs * (1 - LIMITS.reconnectJitterRatio);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(minimumSecondDelay - 20);
    await expect(page.getByLabel('实时连接已断开，正在重试…')).toHaveCount(0);
    const body = 'E2E 退避重连后的消息';
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body,
      invoke: [],
    });
    await expect(page.locator('#room-list .room-preview')).toContainText(body);
  });

  test('clicking a room opens the chat page', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.locator(`#room-list a[href="/c/${roomId}"]`).click();
    await expect(page).toHaveURL(`${base}/c/${roomId}`);
    await expect(page.locator('body')).toHaveClass(/page-room/);
    await expect(page.locator('#composer')).toBeVisible();
  });

  test('clicking a conversation row is a client-side navigation', async ({ page }) => {
    const documentRequests: string[] = [];
    const loadEvents: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentRequests.push(request.url());
    });
    page.on('load', () => loadEvents.push(page.url()));

    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item').first()).toBeVisible();
    await page.locator('#room-filter-group').click();
    const row = page.locator(`#room-list a[data-room-id="${groupId}"]`);
    await expect(row).toBeVisible();

    const before = await page.evaluate(() => {
      (window as typeof window & { __roomNavMarker?: string }).__roomNavMarker = 'kept';
      return {
        timeOrigin: performance.timeOrigin,
        navigationEntries: performance.getEntriesByType('navigation').length,
      };
    });
    documentRequests.length = 0;
    loadEvents.length = 0;

    await row.click();

    await expect(page).toHaveURL(`${base}/c/${groupId}`);
    await expect(page.locator('body')).toHaveClass(/page-room/);
    await expect(page.locator('#composer')).toBeVisible();

    // A full document navigation replaces `window` and starts a new
    // performance timeline; a client-side route keeps both.
    expect(
      await page.evaluate(
        () => (window as typeof window & { __roomNavMarker?: string }).__roomNavMarker,
      ),
    ).toBe('kept');
    const after = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      navigationEntries: performance.getEntriesByType('navigation').length,
    }));
    expect(after.timeOrigin).toBe(before.timeOrigin);
    expect(after.navigationEntries).toBe(before.navigationEntries);
    expect(documentRequests).toEqual([]);
    expect(loadEvents).toEqual([]);
  });

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('home stays single column', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator('#room-search')).toBeVisible();
      const searchHit = await page.locator('.search-box').boundingBox();
      expect(searchHit?.height ?? 0).toBeGreaterThanOrEqual(44);
      await expect(page.locator('.search-box [data-lenso-slot="search-field"]')).toBeVisible();
      const searchInput = await page.locator('#room-search').boundingBox();
      expect(searchInput?.height ?? 0).toBeGreaterThanOrEqual(30);
      expect(searchInput?.height ?? 0).toBeLessThanOrEqual(32);
      await expect(page.locator('#empty-state')).toBeHidden();
    });

    test('account block fits the single column', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('.account')).toBeVisible();
      await expect(page.locator('#empty-state')).toBeHidden();
      const geometry = await readSidebarAccountGeometry(page);
      expect(geometry.docOverflow).toBeLessThanOrEqual(0);
      expect(geometry.brandColor).toBe(await semanticColor(page, '--lenso-tint-text', 'color'));
      expect(geometry.account.left).toBeGreaterThanOrEqual(geometry.sidebar.left - 0.5);
      expect(geometry.account.right).toBeLessThanOrEqual(geometry.sidebar.right + 0.5);
      expect(geometry.actions.right).toBeLessThanOrEqual(geometry.sidebar.right + 0.5);
      expect(geometry.actions.scrollWidth).toBeLessThanOrEqual(geometry.actions.clientWidth + 1);
      for (const button of geometry.buttons) {
        expect(button.height, button.id).toBeGreaterThanOrEqual(32);
        expect(button.right, button.id).toBeLessThanOrEqual(geometry.sidebar.right + 0.5);
      }
    });
  });

  test.describe('mobile touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('account actions keep 44px touch targets', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('.account')).toBeVisible();
      const geometry = await readSidebarAccountGeometry(page);
      expect(geometry.docOverflow).toBeLessThanOrEqual(0);
      expect(geometry.nameToActions).toBeLessThanOrEqual(4);
      expect(geometry.avatar.width).toBe(44);
      expect(geometry.avatar.height).toBe(44);
      for (const button of geometry.buttons) {
        expect(button.height, button.id).toBeGreaterThanOrEqual(44);
        expect(button.right, button.id).toBeLessThanOrEqual(geometry.sidebar.right + 0.5);
      }
    });
  });

  test.describe('dark mode', () => {
    test.use({ colorScheme: 'dark' });

    test('reuses the dark sidebar tokens', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('.sidebar')).toBeVisible();
      const background = await page
        .locator('.sidebar')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).toBe(await semanticColor(page, '--lenso-background-secondary'));
      const chatBackground = await page
        .locator('.chat-pane')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(chatBackground).toBe(await semanticColor(page, '--lenso-background-primary'));
      const search = page.locator('.search-box [data-lenso-slot="search-field-group"]');
      await expect(search).toHaveCount(1);
      expect(await search.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
        await semanticColor(page, '--wx-search'),
      );
      const brandColor = await readBrandColor(page);
      expect(brandColor).toBe(await semanticColor(page, '--lenso-tint-text', 'color'));
      expect(brandColor).not.toBe('rgb(7, 193, 96)');
    });
  });
});
