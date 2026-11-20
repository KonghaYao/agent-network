import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 标签页未读提示：标题前缀 + favicon 红点。
 *
 * 真实 MCP 身份/房间与真实 SSE：A 在浏览器里，B 用工具发消息触发会话列表
 * 失效。免打扰写在 A 的本地偏好（`agent-network-room-preferences-v1:<actor>`），
 * 不修改服务端数据。
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
            name: 'agent-network-e2e-tab-badge',
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
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
}

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

const TITLE_BASE = 'WeBots';
const TITLE_UNREAD = `(1) ${TITLE_BASE}`;

/**
 * 模拟“切到别处再回来”：先隐藏+失焦，再可见+聚焦。
 *
 * 标题与 favicon 的清零只依赖这两个事件的边沿，不写服务端已读。
 */
async function refocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    Reflect.deleteProperty(document, 'visibilityState');
  });
}

async function hasRedPixel(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return false;
    const image = new Image();
    image.src = link.href;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.drawImage(image, 0, 0, 64, 64);
    const { data } = context.getImageData(0, 0, 64, 64);
    for (let index = 0; index < data.length; index += 4) {
      if (data[index]! > 200 && data[index + 1]! < 120 && data[index + 2]! < 120) {
        return true;
      }
    }
    return false;
  });
}

test.describe('tab unread badge', () => {
  let base = '';
  let tokenA = '';
  let tokenB = '';
  let actorA = '';
  let mutedRoom = '';
  let loudRoom = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();

    const a = await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `Tab Badge A ${suffix}`,
      device_id: `e2e-${suffix}-tab-a`,
    });
    actorA = a.actor_id;
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `Tab Badge B ${suffix}`,
      device_id: `e2e-${suffix}-tab-b`,
    });

    const request = await callTool<ContactRequestResult>(base, tokenA, 'network_contact_request', {
      request_id: requestId('e2e_contact'),
      actor_id: b.actor_id,
    });
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
    mutedRoom = direct.room_id;

    const group = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_group'),
        kind: 'group',
        members: [b.actor_id],
        title: `Tab Badge 群聊 ${suffix}`,
      },
    );
    loudRoom = group.room.room_id;
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ token, actorId, roomId }) => {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
        // 免打扰只存在于当前浏览器：direct 会话静音，群聊保持提醒。
        localStorage.setItem(
          `agent-network-room-preferences-v1:${actorId}`,
          JSON.stringify({ [roomId]: { muted: true } }),
        );
      },
      { token: tokenA, actorId: actorA, roomId: mutedRoom },
    );
  });

  test('muted rooms stay silent, new messages badge the tab, refocus clears it', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${base}/`);
    const icon = page.locator('link[rel~="icon"]');
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    await expect(page.locator('.unread')).toHaveCount(0);
    await expect(page).toHaveTitle(TITLE_BASE);
    const baseIcon = await icon.getAttribute('href');
    expect(baseIcon).toMatch(/^\/pwa\/favicon-[0-9a-f]{12}\.svg$/);

    // 1. 只有静音会话有新消息：列表灰点出现，但标题与图标不变。
    const mutedBody = `静音消息 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: mutedRoom,
      body: mutedBody,
      invoke: [],
    });
    const mutedRow = page.locator(`#room-list a[data-room-id="${mutedRoom}"]`);
    await expect(mutedRow.locator('.unread.muted')).toBeVisible({ timeout: 10_000 });
    await expect(mutedRow.locator('.room-preview')).toContainText(mutedBody);
    await expect(page).toHaveTitle(TITLE_BASE);
    await expect(icon).toHaveAttribute('href', baseIcon ?? '');

    // 2. 未静音群聊有新消息：标题 (1)，favicon 变成带红点的 PNG。
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: loudRoom,
      body: `群聊消息 ${Date.now()}`,
      invoke: [],
    });
    await expect(page).toHaveTitle(TITLE_UNREAD, { timeout: 10_000 });
    await expect(icon).toHaveAttribute('href', /^data:image\/png;base64,/);
    expect(await hasRedPixel(page)).toBe(true);

    // 3. 回到可见且聚焦后清零；不写服务端已读。
    await refocus(page);
    await expect(page).toHaveTitle(TITLE_BASE);
    await expect(icon).toHaveAttribute('href', baseIcon ?? '');

    // 4. 清零后静音会话再来消息仍然不提示；未静音会话再来一条重新提示。
    const mutedAgain = `静音消息二 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: mutedRoom,
      body: mutedAgain,
      invoke: [],
    });
    await expect(mutedRow.locator('.room-preview')).toContainText(mutedAgain, { timeout: 10_000 });
    await expect(page).toHaveTitle(TITLE_BASE);

    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: loudRoom,
      body: `群聊消息二 ${Date.now()}`,
      invoke: [],
    });
    await expect(page).toHaveTitle(TITLE_UNREAD, { timeout: 10_000 });
    await expect(icon).toHaveAttribute('href', /^data:image\/png;base64,/);

    expect(errors).toEqual([]);
  });

  test('logged-out pages never show a tab badge', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('agent-network-logged-out', '1');
    });
    await page.goto(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page).toHaveTitle(TITLE_BASE);
    await expect(page.locator('link[rel~="icon"]')).toHaveAttribute(
      'href',
      /^\/pwa\/favicon-[0-9a-f]{12}\.svg$/,
    );
    expect(await hasRedPixel(page)).toBe(false);
  });
});
