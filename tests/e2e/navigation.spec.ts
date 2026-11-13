import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 站内导航必须走客户端路由：保留真实 `href`，但普通左键不能重新请求
 * document，也不能重建 `window`。修饰键与中键仍交给浏览器默认行为。
 */

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
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface InviteResult {
  invite_key: string | null;
}

const TOKEN_KEY = 'agent-network-token';

async function seedToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    },
    { key: TOKEN_KEY, value: token },
  );
}

interface WindowSnapshot {
  timeOrigin: number;
  navigationEntries: number;
}

async function markWindow(page: Page): Promise<WindowSnapshot> {
  return page.evaluate(() => {
    (window as typeof window & { __clientNavMarker?: string }).__clientNavMarker = 'kept';
    return {
      timeOrigin: performance.timeOrigin,
      navigationEntries: performance.getEntriesByType('navigation').length,
    };
  });
}

async function expectSameDocument(page: Page, before: WindowSnapshot): Promise<void> {
  const marker = await page.evaluate(
    () => (window as typeof window & { __clientNavMarker?: string }).__clientNavMarker,
  );
  const after = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    navigationEntries: performance.getEntriesByType('navigation').length,
  }));
  expect(marker).toBe('kept');
  expect(after.timeOrigin).toBe(before.timeOrigin);
  expect(after.navigationEntries).toBe(before.navigationEntries);
}

function trackDocumentActivity(page: Page): {
  documentRequests: string[];
  loadEvents: string[];
} {
  const documentRequests: string[] = [];
  const loadEvents: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });
  page.on('load', () => loadEvents.push(page.url()));
  return { documentRequests, loadEvents };
}

test.describe('SPA internal client navigation', () => {
  let base = '';
  let ownerToken = '';
  let friendToken = '';
  let roomId = '';
  let agentToken = '';
  let agentSession = '';
  let shareVisitorToken = '';
  let inviteKey = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    ownerToken = crypto.randomUUID();
    friendToken = crypto.randomUUID();
    agentToken = crypto.randomUUID();
    shareVisitorToken = crypto.randomUUID();
    agentSession = `sess_e2e_nav_${suffix}`;

    await callTool<Registered>(base, ownerToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `E2E 导航主人 ${suffix}`,
      device_id: `e2e-nav-owner-${suffix}`,
    });
    const friend = await callTool<Registered>(base, friendToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `E2E 导航好友 ${suffix}`,
      device_id: `e2e-nav-friend-${suffix}`,
    });
    const request = await callTool<ContactRequestResult>(
      base,
      ownerToken,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: friend.actor_id },
    );
    const contactRequestId = request.request?.contact_request_id;
    if (!contactRequestId) throw new Error('好友申请未创建');
    await callTool(base, friendToken, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });
    const rooms = await callTool<RoomList>(base, ownerToken, 'network_rooms_list', { limit: 50 });
    const direct = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === friend.actor_id,
    );
    if (!direct) throw new Error('好友通过后未生成 direct 会话');
    roomId = direct.room_id;

    const agent = await callTool<Registered>(base, agentToken, 'network_register', {
      request_id: requestId('e2e_reg_agent'),
      kind: 'agent',
      name: `E2E 导航分享 Agent ${suffix}`,
      agent_session_id: agentSession,
    });
    const visitor = await callTool<Registered>(base, shareVisitorToken, 'network_register', {
      request_id: requestId('e2e_reg_visitor'),
      kind: 'human',
      name: `E2E 导航访客 ${suffix}`,
      device_id: `e2e-nav-visitor-${suffix}`,
    });
    const agentRequest = await callTool<ContactRequestResult>(
      base,
      agentToken,
      'network_contact_request',
      { request_id: requestId('e2e_contact_agent'), actor_id: visitor.actor_id },
    );
    const agentRequestId = agentRequest.request?.contact_request_id;
    if (!agentRequestId) throw new Error('Agent 好友申请未创建');
    await callTool(base, shareVisitorToken, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact_agent'),
      contact_request_id: agentRequestId,
      action: 'accept',
    });

    const group = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('e2e_group'),
        kind: 'group',
        members: [agent.actor_id],
        title: `E2E 导航群 ${suffix}`,
      },
    );
    const invite = await callTool<InviteResult>(base, ownerToken, 'network_room_invite_create', {
      request_id: requestId('e2e_invite'),
      room_id: group.room.room_id,
    });
    inviteKey = invite.invite_key ?? '';
    expect(inviteKey.length).toBeGreaterThanOrEqual(16);
  });

  test.describe('mobile chat header', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('back link keeps the document and returns home', async ({ page }) => {
      await seedToken(page, ownerToken);
      await page.goto(`${base}/c/${roomId}`);
      await expect(page.locator('#composer')).toBeVisible();
      await expect(page.locator('#back')).toHaveAttribute('href', '/');

      const activity = trackDocumentActivity(page);
      const before = await markWindow(page);
      activity.documentRequests.length = 0;
      activity.loadEvents.length = 0;

      await page.locator('#back').click();

      await expect(page).toHaveURL(`${base}/`);
      await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
      await expectSameDocument(page, before);
      expect(activity.documentRequests).toEqual([]);
      expect(activity.loadEvents).toEqual([]);
    });
  });

  test('chat error back link keeps the document and returns home', async ({ page }) => {
    await seedToken(page, ownerToken);
    await page.goto(`${base}/c/rm_missing_${crypto.randomUUID().replaceAll('-', '')}`);
    await expect(page.locator('#chat-error')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#chat-error-back')).toHaveAttribute('href', '/');

    const activity = trackDocumentActivity(page);
    const before = await markWindow(page);
    activity.documentRequests.length = 0;
    activity.loadEvents.length = 0;

    await page.locator('#chat-error-back').click();

    await expect(page).toHaveURL(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expectSameDocument(page, before);
    expect(activity.documentRequests).toEqual([]);
    expect(activity.loadEvents).toEqual([]);
  });

  test('share success enters the direct room without a document reload', async ({ page }) => {
    await seedToken(page, shareVisitorToken);
    await page.goto(`${base}/a/${encodeURIComponent(agentSession)}`);
    await expect(page.locator('body[data-spa-route="share"]')).toBeVisible();
    await expect(page.locator('#add')).toBeEnabled();

    const activity = trackDocumentActivity(page);
    const before = await markWindow(page);
    activity.documentRequests.length = 0;
    activity.loadEvents.length = 0;

    await page.locator('#add').click();

    await expect(page).toHaveURL(new RegExp(`${base.replaceAll('/', '\\/')}\\/c\\/`));
    await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
    await expect(page.locator('#composer')).toBeVisible();
    await expectSameDocument(page, before);
    expect(activity.documentRequests).toEqual([]);
    expect(activity.loadEvents).toEqual([]);
  });

  test('join success enters the group without a document reload', async ({ page }) => {
    await page.goto(`${base}/j/${inviteKey}`);
    await expect(page.locator('body[data-spa-route="join"]')).toBeVisible();
    await expect(page.locator('#join-action')).toBeEnabled({ timeout: 10_000 });

    const activity = trackDocumentActivity(page);
    const before = await markWindow(page);
    activity.documentRequests.length = 0;
    activity.loadEvents.length = 0;

    await page.locator('#join-action').click();

    await expect(page).toHaveURL(new RegExp(`${base.replaceAll('/', '\\/')}\\/c\\/`));
    await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
    await expect(page.locator('#composer')).toBeVisible();
    await expectSameDocument(page, before);
    expect(activity.documentRequests).toEqual([]);
    expect(activity.loadEvents).toEqual([]);
  });

  test('credential-invalid pair link is a client-side navigation', async ({ page }) => {
    await seedToken(page, crypto.randomUUID());
    await page.goto(`${base}/`);
    await expect(page.locator('#credential-invalid-pair')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#credential-invalid-pair')).toHaveAttribute('href', '/pair');

    const activity = trackDocumentActivity(page);
    const before = await markWindow(page);
    activity.documentRequests.length = 0;
    activity.loadEvents.length = 0;

    await page.locator('#credential-invalid-pair').click();

    await expect(page).toHaveURL(`${base}/pair`);
    await expect(page.locator('body[data-spa-route="pair"]')).toBeVisible();
    await expectSameDocument(page, before);
    expect(activity.documentRequests).toEqual([]);
    expect(activity.loadEvents).toEqual([]);
  });

  test.describe('native link behavior', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('middle click opens a new tab and leaves the current page in place', async ({
      page,
      context,
    }) => {
      await seedToken(page, ownerToken);
      await page.goto(`${base}/c/${roomId}`);
      await expect(page.locator('#composer')).toBeVisible();
      const before = await markWindow(page);

      const popupPromise = context.waitForEvent('page');
      await page.locator('#back').click({ button: 'middle' });
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');

      expect(new URL(popup.url()).pathname).toBe('/');
      await expect(page).toHaveURL(`${base}/c/${roomId}`);
      await expectSameDocument(page, before);
      await popup.close();
    });
  });
});
