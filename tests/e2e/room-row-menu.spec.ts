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

function listScrollTop(page: Page): Promise<number> {
  return page.locator('.sidebar-list').evaluate((element) => element.scrollTop);
}

async function setListScrollTop(page: Page, top: number): Promise<void> {
  await page.locator('.sidebar-list').evaluate((element, value) => {
    element.scrollTop = value;
  }, top);
  await expect.poll(() => listScrollTop(page)).toBe(top);
}

function rowIds(page: Page): Promise<(string | null)[]> {
  return page
    .locator('#room-list .room-item')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-room-id')));
}

/** 返回当前完整落在侧栏可视区域内的第一个会话行 id。 */
function visibleRowId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.sidebar-list');
    if (!list) return null;
    const bounds = list.getBoundingClientRect();
    for (const item of document.querySelectorAll<HTMLElement>('#room-list .room-item')) {
      const rect = item.getBoundingClientRect();
      if (rect.top >= bounds.top + 4 && rect.bottom <= bounds.bottom - 4) {
        return item.dataset.roomId ?? null;
      }
    }
    return null;
  });
}

function bodyPointerEvents(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).pointerEvents);
}

function expectScrollNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 两个矩形是否有面积重叠；贴边不算。 */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test.describe('会话行右键与长按菜单', () => {
  // 复现报告使用 1280×800；移动端 describe 会覆盖该 viewport。
  test.use({ viewport: { width: 1280, height: 800 } });

  let base = '';
  let tokenA = '';
  let actorB = '';
  let actorC = '';
  let directAB = '';
  let directAC = '';
  let fillerRoomIds: string[] = [];
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

    // 至少 12 个默认可见的 direct 会话；16 行才能在 800px 高视口里
    // 留出真实的 300px 滚动空间，避免 scrollBefore=0 让断言退化。
    const fillerActorIds: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      const token = crypto.randomUUID();
      const filler = await callTool<{ actor_id: string }>(base, token, 'network_register', {
        request_id: requestId('e2e_reg'),
        kind: 'human',
        name: `行菜单好友 ${suffix} ${index}`,
        device_id: `e2e-row-menu-${suffix}-f${index}`,
      });
      fillerActorIds.push(filler.actor_id);
      await contact(base, tokenA, token, filler.actor_id);
    }

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
    const fillerPeers = new Set(fillerActorIds);
    fillerRoomIds = rooms.items
      .filter(
        (entry) => entry.kind === 'direct' && fillerPeers.has(entry.peer?.actor_id ?? ''),
      )
      .map((entry) => entry.room_id);
    if (!directAB || !directAC || fillerRoomIds.length !== fillerActorIds.length) {
      throw new Error('好友通过后未生成完整的 direct 会话');
    }

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
    await expect(page.locator('#room-list .room-item')).toHaveCount(16);
    const ac = row(page, directAC);
    const ab = row(page, directAB);
    await expect(ac).toBeVisible();
    await expect(ab).toBeVisible();
    const scrollBefore = await listScrollTop(page);
    const bodyPointerBefore = await bodyPointerEvents(page);
    expect(bodyPointerBefore).toBe('auto');
    const initialIds = (await rowIds(page)).filter((id): id is string => id !== null);
    expect(initialIds).toHaveLength(16);
    expect(initialIds.slice(0, 2)).toEqual([directAC, directAB]);

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
    // 不依赖 body 锁实现：打开后键盘可以进入可操作条目。
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1);

    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(Math.abs((menuBox?.x ?? 0) - clickX)).toBeLessThan(120);
    expect(Math.abs((menuBox?.y ?? 0) - clickY)).toBeLessThan(120);

    await page.locator('#room-row-menu-pin').click();
    await expect(menu).toBeHidden();
    await expect(ab.locator('.room-pref-label')).toHaveText('置顶');
    await expect
      .poll(() => rowIds(page))
      .toEqual([directAB, directAC, ...initialIds.slice(2)]);
    await expect.poll(() => bodyPointerEvents(page)).toBe('auto');

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
    // 菜单 portal 关闭后不改变侧栏滚动位置，也不残留指针锁。
    expectScrollNear(await listScrollTop(page), scrollBefore);
    await expect.poll(() => bodyPointerEvents(page)).toBe('auto');

    // 菜单关闭后客户端导航仍正常，且不残留遮罩/焦点陷阱。
    await ab.click();
    await expect(page).toHaveURL(`${base}/c/${directAB}`);
    await expect(page.locator('#composer')).toBeVisible();
  });

  test('非零滚动下置顶、免打扰与 Escape 保持侧栏位置和焦点', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item')).toHaveCount(16);
    const initialIds = (await rowIds(page)).filter((id): id is string => id !== null);
    expect(initialIds.slice(0, 2)).toEqual([directAC, directAB]);
    const list = page.locator('.sidebar-list');
    const menu = page.locator('#room-row-menu');

    const metrics = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.scrollHeight - metrics.clientHeight).toBeGreaterThan(300);
    await setListScrollTop(page, 300);
    expect(await bodyPointerEvents(page)).toBe('auto');

    // 置顶当前可见行：行移动到顶部后 scrollTop 必须保持 300。
    const pinnedId = await visibleRowId(page);
    expect(pinnedId).not.toBeNull();
    const pinnedRow = row(page, pinnedId as string);
    await pinnedRow.click({ button: 'right', position: { x: 60, y: 24 } });
    await expect(menu).toBeVisible();
    await expect(page.locator('#room-row-menu-pin')).toBeVisible();
    await page.keyboard.press('End');
    await expect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1);

    await page.locator('#room-row-menu-pin').click();
    await expect(menu).toBeHidden();
    await expect(pinnedRow.locator('.room-pref-label')).toHaveText('置顶');
    await expect
      .poll(() => rowIds(page))
      .toEqual([
        pinnedId,
        directAC,
        directAB,
        ...initialIds.slice(2).filter((id) => id !== pinnedId),
      ]);
    // 置顶把行移到顶部后，浏览器不得因焦点归还把它滚回顶部。
    await expect.poll(() => listScrollTop(page)).toBeGreaterThanOrEqual(299);
    await expect(pinnedRow).toBeFocused();
    expectScrollNear(await listScrollTop(page), 300);
    await expect.poll(() => bodyPointerEvents(page)).toBe('auto');

    // Escape 关闭同样保持滚动与焦点。
    const escapeId = await visibleRowId(page);
    expect(escapeId).not.toBeNull();
    const escapeRow = row(page, escapeId as string);
    await escapeRow.click({ button: 'right', position: { x: 60, y: 24 } });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(escapeRow).toBeFocused();
    expectScrollNear(await listScrollTop(page), 300);
    await expect.poll(() => bodyPointerEvents(page)).toBe('auto');

    // 免打扰不重排，也不得改变滚动与焦点。
    const muteId = await visibleRowId(page);
    expect(muteId).not.toBeNull();
    const mutedRow = row(page, muteId as string);
    await mutedRow.click({ button: 'right', position: { x: 60, y: 24 } });
    await expect(menu).toBeVisible();
    await page.locator('#room-row-menu-mute').click();
    await expect(menu).toBeHidden();
    await expect(mutedRow.locator('.room-pref-label')).toHaveText('免打扰');
    await expect(mutedRow).toBeFocused();
    expectScrollNear(await listScrollTop(page), 300);
    await expect.poll(() => bodyPointerEvents(page)).toBe('auto');
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

  for (const fail of [false, true]) {
    test(`真实 Lenso chunk ${fail ? '失败' : '延迟'}：fallback 打开周期节点与焦点不切换`, async ({ page }) => {
      let release!: () => void;
      const gate = new Promise<void>((done) => { release = done; });
      let intercepted = 0;
      await page.route('**/assets/index-*.js', async (route) => {
        intercepted++;
        if (fail) await route.abort('failed');
        else { await gate; await route.continue(); }
      });
      try {
        await page.goto(`${base}/`);
        const ab = row(page, directAB);
        await expect(ab).toBeVisible();
        await ab.click({ button: 'right' });
        const menu = page.locator('#room-row-menu');
        await expect(menu).toHaveAttribute('data-lenso-slot', 'context-menu-fallback');
        await expect(page.locator('#room-row-menu-report')).toBeVisible();
        await page.keyboard.press('ArrowDown');
        const identity = await menu.evaluateHandle((node) => ({ node, focus: document.activeElement }));
        expect(intercepted).toBeGreaterThan(0);
        release();
        if (!fail) await expect(page.locator('#new-agent')).toHaveAttribute('data-lenso-slot', 'button');
        await expect(menu).toHaveAttribute('data-lenso-slot', 'context-menu-fallback');
        expect(await identity.evaluate(({ node, focus }) => node.isConnected && focus === document.activeElement)).toBe(true);
        await page.keyboard.press('Tab');
        await expect(menu).toBeHidden();
        await expect(ab).toBeFocused();
        await ab.press('ContextMenu');
        await expect(menu).toBeVisible();
        const outside = await row(page, directAC).boundingBox();
        await page.mouse.click(outside!.x + 20, outside!.y + 20);
        await expect(menu).toBeHidden();
        await expect(page).toHaveURL(`${base}/`);
        await expect(ab).toBeFocused();
        await ab.press('ContextMenu');
        await expect(menu).toBeVisible();
        if (!fail) expect(await menu.evaluate((node) => node.matches(':popover-open'))).toBe(true);
        await page.locator('#room-row-menu-mute').click();
        await expect(ab.locator('.room-pref-label')).toHaveText('免打扰');
      } finally { release(); }
    });
  }

  test('外部点击只关闭菜单，不穿透导航；暗色 390 下菜单在视口内', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${base}/`);
    const ab = row(page, directAB);
    await expect(ab).toBeVisible();
    await ab.press('ContextMenu');
    const menu = page.locator('#room-row-menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(page.locator('#room-row-menu-delete-friend')).toHaveClass(/danger/);
    await page.mouse.click(370, 750);
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(`${base}/`);
    await expect(ab).toBeFocused();
  });

  for (const fallback of [false, true]) {
    for (const width of [1280, 390]) {
      test(`异步详情保持焦点与底部边界：${fallback ? 'fallback' : 'Lenso'} ${width} 暗色`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark' });
        let aborted = 0;
        if (fallback) await page.route('**/assets/index-*.js', async (route) => {
          aborted++;
          await route.abort('failed');
        });
        let release!: () => void;
        const gate = new Promise<void>((done) => { release = done; });
        await page.route('**/mcp', async (route) => {
          if (route.request().headers()['mcp-name'] === 'network_room_get') await gate;
          await route.continue();
        });
        try {
          await page.goto(`${base}/`);
          await expect(page.locator('#room-list .room-item')).toHaveCount(16);
          if (!fallback) await expect(page.locator('#new-agent')).toHaveAttribute('data-lenso-slot', 'button');
          const target = page.locator('#room-list a[data-room-id]').last();
          await target.scrollIntoViewIfNeeded();
          await target.click({ button: 'right', position: { x: 50, y: 48 } });
          const menu = page.locator('#room-row-menu');
          await expect(page.locator('#room-row-menu-loading')).toBeVisible();
          if (fallback) {
            expect(aborted).toBeGreaterThan(0);
            await expect(menu).toHaveAttribute('data-lenso-slot', 'context-menu-fallback');
          } else expect(await menu.evaluate((node) => node.matches(':popover-open'))).toBe(true);
          await page.keyboard.press('ArrowDown');
          await expect(page.locator('#room-row-menu-pin')).toBeFocused();
          release();
          const danger = page.locator('#room-row-menu-delete-friend');
          await expect(danger).toBeVisible();
          await expect(page.locator('#room-row-menu-pin')).toBeFocused();
          await page.keyboard.press('ArrowDown');
          await expect(page.locator('#room-row-menu-mute')).toBeFocused();
          await expect.poll(() => menu.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(836);
          expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(8);
          // 翻转/定位都必须让出整个触发行：公告中的底部行覆盖回归由这里兜底。
          await expect.poll(async () => {
            const rowBox = await target.boundingBox();
            const menuBox = await menu.boundingBox();
            return Boolean(rowBox && menuBox && !overlaps(rowBox, menuBox));
          }).toBe(true);
          const rowBox = await target.boundingBox();
          const menuBox = await menu.boundingBox();
          expect(rowBox).not.toBeNull();
          expect(menuBox).not.toBeNull();
          expect(overlaps(rowBox as Box, menuBox as Box)).toBe(false);
          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(target).toBeFocused();

          await target.press('ContextMenu');
          // 模拟焦点落到 body，文档级导航与 Tab 仍须工作。
          await menu.evaluate(() => (document.activeElement as HTMLElement).blur());
          await page.keyboard.press('End');
          await expect(danger).toBeFocused();
          await page.keyboard.press('Home');
          await expect(page.locator('#room-row-menu-pin')).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(menu).toBeHidden();
          await expect(target).toBeFocused();

          await target.press('ContextMenu');
          if (fallback) {
            // 缩小到不足以容纳全部内容，验证滚动而不是仅验证翻转。
            await page.setViewportSize({ width, height: 180 });
            await expect.poll(() => menu.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
            await expect.poll(() => menu.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(172);
          }
          await danger.scrollIntoViewIfNeeded();
          await expect(danger).toBeInViewport();
          await danger.click();
          await expect(menu).toBeHidden();
          await page.setViewportSize({ width, height: 844 });
          await expect(page.locator('#confirm-dialog-title')).toHaveText('删除好友');
          await page.locator('#confirm-dialog-cancel').click();
        } finally { release(); }
      });
    }
  }

  test('详情未到时禁用项不可选；消息键盘菜单归还焦点', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] === 'network_room_get') await gate;
      await route.continue();
    });
    try {
      await page.goto(`${base}/`);
      const ab = row(page, directAB);
      await expect(ab).toBeVisible();
      await expect(page.locator('#new-agent')).toHaveAttribute('data-lenso-slot', 'button');
      await ab.press('ContextMenu');
      const loading = page.locator('#room-row-menu-loading');
      await expect(loading).toHaveAttribute('aria-disabled', 'true');
      await loading.click({ force: true });
      await expect(page.locator('#room-row-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(ab).toBeFocused();
    } finally { release(); }
    await page.unrouteAll({ behavior: 'wait' });
    await page.goto(`${base}/c/${directAB}`);
    const message = page.locator('#messages .msg').first();
    await expect(message).toBeVisible();
    await message.focus();
    await message.press('Shift+F10');
    await expect(page.locator('#message-context-menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#message-context-menu [role="menuitem"]:focus')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.locator('#message-context-menu')).toBeHidden();
    await expect(message).toBeFocused();
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
