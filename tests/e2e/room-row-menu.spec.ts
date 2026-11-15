import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 会话行右键 / 移动端长按菜单。
 *
 * 与 home.spec 一样用真实 MCP 工具建两个好友单聊和一个群聊；页面断言只走
 * 浏览器交互。置顶、免打扰写浏览器本地偏好，不修改服务端数据；复制群信息
 * 使用真实剪贴板；不执行删除好友/拉黑等破坏性动作。
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
            name: 'agent-network-e2e-room-row-menu',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
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

async function contact(
  base: string,
  requesterToken: string,
  targetToken: string,
  actorId: string,
): Promise<void> {
  const request = await callTool<{ request: { contact_request_id: string } | null }>(
    base,
    requesterToken,
    'network_contact_request',
    { request_id: requestId('e2e_contact'), actor_id: actorId },
  );
  const contactRequestId = request.request?.contact_request_id;
  if (!contactRequestId) throw new Error('好友申请未创建');
  await callTool(base, targetToken, 'network_contact_request_respond', {
    request_id: requestId('e2e_contact'),
    contact_request_id: contactRequestId,
    action: 'accept',
  });
}

async function login(page: Page, token: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('agent-network-token', value);
      localStorage.removeItem('agent-network-logged-out');
    } catch {
      // 浏览器禁用存储时由页面错误态兜底。
    }
  }, token);
}

function row(page: Page, roomId: string) {
  return page.locator(`#room-list a[data-room-id="${roomId}"]`);
}

test.describe('会话行右键与长按菜单', () => {
  let base = '';
  let tokenA = '';
  let actorB = '';
  let actorC = '';
  let directAB = '';
  let directAC = '';
  let groupId = '';
  let groupTitle = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const tokenC = crypto.randomUUID();
    groupTitle = `行菜单群 ${suffix}`;

    await callTool<{ actor_id: string }>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `行菜单 A ${suffix}`,
      device_id: `e2e-row-menu-${suffix}-a`,
    });
    const b = await callTool<{ actor_id: string }>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `行菜单 B ${suffix}`,
      device_id: `e2e-row-menu-${suffix}-b`,
    });
    actorB = b.actor_id;
    const c = await callTool<{ actor_id: string }>(base, tokenC, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `行菜单 C ${suffix}`,
      device_id: `e2e-row-menu-${suffix}-c`,
    });
    actorC = c.actor_id;

    await contact(base, tokenA, tokenB, actorB);
    await contact(base, tokenA, tokenC, actorC);

    const rooms = await callTool<{
      items: {
        room_id: string;
        kind: string;
        peer?: { actor_id?: string; name?: string } | null;
      }[];
    }>(base, tokenA, 'network_rooms_list', { limit: 50 });
    directAB =
      rooms.items.find((entry) => entry.kind === 'direct' && entry.peer?.actor_id === actorB)
        ?.room_id ?? '';
    directAC =
      rooms.items.find((entry) => entry.kind === 'direct' && entry.peer?.actor_id === actorC)
        ?.room_id ?? '';
    if (!directAB || !directAC) throw new Error('好友通过后未生成两个 direct 会话');

    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: directAB,
      body: '行菜单较早消息',
      invoke: [],
    });
    // 会话排序按最后消息时间；留出毫秒差，确保 AC 初始排在 AB 前。
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    await callTool(base, tokenC, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: directAC,
      body: '行菜单较新消息',
      invoke: [],
    });

    const group = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_group'),
        kind: 'group',
        members: [actorB, actorC],
        title: groupTitle,
      },
    );
    groupId = group.room.room_id;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: groupId,
      body: '行菜单群消息',
      invoke: [],
    });
    // 保持 A 未读，供免打扰灰点断言。
  });

  test.beforeEach(async ({ page }) => {
    await login(page, tokenA);
  });

  test('桌面右键在行附近打开菜单，置顶重排、免打扰立即生效', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item')).toHaveCount(2);
    const ac = row(page, directAC);
    const ab = row(page, directAB);
    await expect(ac).toBeVisible();
    await expect(ab).toBeVisible();

    await expect
      .poll(async () =>
        page
          .locator('#room-list .room-item')
          .evaluateAll((items) => items.map((item) => item.getAttribute('data-room-id'))),
      )
      .toEqual([directAC, directAB]);

    const rowBox = await ab.boundingBox();
    expect(rowBox).not.toBeNull();
    const clickX = Math.round((rowBox?.x ?? 0) + 60);
    const clickY = Math.round((rowBox?.y ?? 0) + 24);
    await ab.click({ button: 'right', position: { x: 60, y: 24 } });

    const menu = page.locator('#room-row-menu');
    await expect(menu).toBeVisible();
    await expect(page.locator('#room-row-menu-pin')).toBeVisible();
    await expect(page.locator('#room-row-menu-mute')).toBeVisible();
    expect(page.url()).toBe(`${base}/`);

    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(Math.abs((menuBox?.x ?? 0) - clickX)).toBeLessThan(120);
    expect(Math.abs((menuBox?.y ?? 0) - clickY)).toBeLessThan(120);

    await page.locator('#room-row-menu-pin').click();
    await expect(menu).toBeHidden();
    await expect(ab.locator('.room-pref-label')).toHaveText('置顶');
    await expect
      .poll(async () =>
        page
          .locator('#room-list .room-item')
          .evaluateAll((items) => items.map((item) => item.getAttribute('data-room-id'))),
      )
      .toEqual([directAB, directAC]);

    await ab.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(page.locator('#room-row-menu-report')).toBeVisible();
    await expect(page.locator('#room-row-menu-block')).toBeVisible();
    await expect(page.locator('#room-row-menu-delete-friend')).toBeVisible();
    await page.locator('#room-row-menu-mute').click();
    await expect(menu).toBeHidden();
    await expect(ab.locator('.room-pref-label')).toHaveText('置顶 · 免打扰');
    await expect(ab.locator('.unread')).toHaveClass(/muted/);
    await expect(ab.locator('.unread')).toHaveAttribute('aria-label', '未读，消息免打扰');

    // 菜单关闭后客户端导航仍正常，且不残留遮罩/焦点陷阱。
    await ab.click();
    await expect(page).toHaveURL(`${base}/c/${directAB}`);
    await expect(page.locator('#composer')).toBeVisible();
  });

  test('群聊行菜单复用复制群信息动作', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${base}/`);
    await page.locator('#room-filter-group').click();
    const group = row(page, groupId);
    await expect(group).toBeVisible();

    await group.click({ button: 'right' });
    await expect(page.locator('#room-row-menu')).toBeVisible();
    await page.locator('#room-row-menu-members').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#members-modal')).toBeHidden();

    await group.click({ button: 'right' });
    await expect(page.locator('#room-row-menu')).toBeVisible();
    const copy = page.locator('#room-row-menu-copy-prompt');
    await expect(copy).toHaveText('复制群信息');
    await copy.click();

    await expect(page.locator('#contact-link-banner')).toContainText('已复制群信息');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain(groupTitle);
    expect(clipboard).toContain(groupId);
  });

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('长按 500ms 打开菜单且不导航；短按与滑动仍进入会话', async ({ page }) => {
      await page.goto(`${base}/`);
      const ab = row(page, directAB);
      await expect(ab).toBeVisible();

      // 短按仍按普通链接进入会话。
      await ab.click();
      await expect(page).toHaveURL(`${base}/c/${directAB}`);
      await page.goto(`${base}/`);
      await expect(ab).toBeVisible();

      const box = await ab.boundingBox();
      const point = { x: Math.round((box?.x ?? 0) + 80), y: Math.round((box?.y ?? 0) + 24) };

      // 滑动超过容差视为滚动，不打开菜单。
      await ab.dispatchEvent('pointerdown', {
        pointerType: 'touch',
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      });
      await ab.dispatchEvent('pointermove', {
        pointerType: 'touch',
        clientX: point.x + 24,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      });
      await page.waitForTimeout(650);
      await expect(page.locator('#room-row-menu')).toBeHidden();
      await ab.dispatchEvent('pointerup', {
        pointerType: 'touch',
        clientX: point.x + 24,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      });

      // 滑动取消菜单后，普通点击仍进入会话。
      await ab.click();
      await expect(page).toHaveURL(`${base}/c/${directAB}`);
      await page.goto(`${base}/`);
      await expect(ab).toBeVisible();
      const longBox = await ab.boundingBox();
      const longPoint = {
        x: Math.round((longBox?.x ?? 0) + 80),
        y: Math.round((longBox?.y ?? 0) + 24),
      };

      // 长按 500ms 打开同一菜单；随后补发的 click 不导航。
      await ab.dispatchEvent('pointerdown', {
        pointerType: 'touch',
        clientX: longPoint.x,
        clientY: longPoint.y,
        bubbles: true,
        cancelable: true,
      });
      await page.waitForTimeout(650);
      await expect(page.locator('#room-row-menu')).toBeVisible();
      await expect(page.locator('#room-row-menu-pin')).toBeVisible();
      await ab.dispatchEvent('pointerup', {
        pointerType: 'touch',
        clientX: longPoint.x,
        clientY: longPoint.y,
        bubbles: true,
        cancelable: true,
      });
      await page.evaluate((roomId) => {
        document
          .querySelector(`#room-list a[data-room-id="${roomId}"]`)
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }, directAB);
      await expect(page).toHaveURL(`${base}/`);

      await page.keyboard.press('Escape');
      await expect(page.locator('#room-row-menu')).toBeHidden();

      // 长按抑制不能泄漏到后续键盘激活。
      await ab.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${base}/c/${directAB}`);
    });
  });

  test('Shift+F10 打开同一菜单，Esc 后焦点回到会话行', async ({ page }) => {
    await page.goto(`${base}/`);
    const ab = row(page, directAB);
    await expect(ab).toBeVisible();
    await ab.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.locator('#room-row-menu')).toBeVisible();
    await expect(page.locator('#room-row-menu-pin')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#room-row-menu')).toBeHidden();
    await expect(ab).toBeFocused();
  });
});
