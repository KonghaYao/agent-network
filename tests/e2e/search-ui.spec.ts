import { expect, test, type Page } from '@playwright/test';

import {
  baseUrl,
  callTool,
  login,
  requestId,
} from './fixtures/components';

/**
 * 会话历史搜索 UI：模式/范围、防抖竞态、高亮、快捷键、锚点跳转与返回最新。
 *
 * 后端复用真实 `network_message_search` / `network_history_list`；只有
 * scan_limited 与旧响应竞态用请求级 route 注入，其余都走真实工具。
 */

interface RoomsPage {
  items: {
    room_id: string;
    kind: 'direct' | 'group';
    peer?: { actor_id: string } | null;
  }[];
}

interface RoomDetailPage {
  room: { room_id: string; my_last_read_seq: string };
}

let base = '';
let tokenA = '';
let tokenB = '';
let actorB = '';
let directRoomId = '';
let groupRoomId = '';
let groupTitle = '';
let suffix = '';

const token = (name: string) => `${name}${suffix}`;

function request(prefix: string) {
  return requestId(`e2e_search_ui_${prefix}`);
}

async function send(
  auth: string,
  roomId: string,
  body: string,
): Promise<string> {
  const result = await callTool<{ message: { message_id: string } }>(
    base,
    auth,
    'network_message_send',
    {
      request_id: request('send'),
      client_message_id: request('cm'),
      room_id: roomId,
      body,
      invoke: [],
    },
  );
  return result.message.message_id;
}

async function register(name: string, auth: string, device: string) {
  return callTool<{ actor_id: string }>(base, auth, 'network_register', {
    request_id: request('reg'),
    kind: 'human',
    name,
    device_id: device,
  });
}

async function openRoom(page: Page, roomId: string) {
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#message-search-button')).toBeVisible();
}

async function openSearch(page: Page) {
  await page.locator('#message-search-button').click();
  await expect(page.locator('#message-search-dialog')).toBeVisible();
  await expect(page.locator('#message-search-input')).toBeFocused();
}

async function searchNow(page: Page, query: string) {
  await page.locator('#message-search-input').fill(query);
  await page.locator('#message-search-form button[type=submit]').click();
}

async function selectMode(page: Page, label: '精确' | '模糊') {
  await page.locator('#message-search-dialog').getByRole('radio', { name: label }).click();
}

async function selectScope(page: Page, label: '当前会话' | '全部会话') {
  await page.locator('#message-search-dialog').getByRole('radio', { name: label }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('会话历史搜索 UI', () => {
  test.beforeAll(async () => {
    base = await baseUrl();
    suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    const nameA = `搜索 A ${suffix}`;
    const nameB = `搜索 B ${suffix}`;
    groupTitle = `搜索群 ${suffix}`;
    await register(nameA, tokenA, `e2e-search-ui-${suffix}-a`);
    const peer = await register(nameB, tokenB, `e2e-search-ui-${suffix}-b`);
    actorB = peer.actor_id;

    const contact = await callTool<{ request: { contact_request_id: string } }>(
      base,
      tokenA,
      'network_contact_request',
      { request_id: request('contact'), actor_id: actorB },
    );
    await callTool(base, tokenB, 'network_contact_request_respond', {
      request_id: request('contact_respond'),
      contact_request_id: contact.request.contact_request_id,
      action: 'accept',
    });
    const rooms = await callTool<RoomsPage>(base, tokenA, 'network_rooms_list', {
      limit: 50,
    });
    const direct = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === actorB,
    );
    if (!direct) throw new Error('好友通过后未生成 direct 会话');
    directRoomId = direct.room_id;

    const created = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: request('group'),
        kind: 'group',
        title: groupTitle,
        members: [actorB],
      },
    );
    groupRoomId = created.room.room_id;

    // 旧目标：首屏 50 条之外，必须走 anchor 窗口。
    await send(tokenA, directRoomId, `${token('oldtarget')} 这是更早的历史目标消息`);
    // 填充消息，把 oldtarget 推出首屏。
    await Promise.all(
      Array.from({ length: 56 }, (_, index) =>
        send(tokenA, directRoomId, `填充消息 ${index} ${suffix}`),
      ),
    );
    await send(tokenB, directRoomId, `${token('livetarget')} 当前页可定位消息`);
    await Promise.all([
      send(tokenA, directRoomId, `${token('multi')} 第一条`),
      send(tokenB, directRoomId, `${token('multi')} 第二条`),
      send(tokenA, directRoomId, `${token('multi')} 第三条`),
    ]);
    await send(tokenA, directRoomId, `${token('case')} CaseSensitive Highlight`);
    await send(tokenA, directRoomId, `alpha beta gamma ${token('fuzzy')}`);
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        send(tokenA, directRoomId, `${token('loadmore')} 分页 ${index}`),
      ),
    );
    await send(tokenB, groupRoomId, `${token('global')} 群聊里的全局搜索结果`);
  });

  test.beforeEach(async ({ page }) => {
    await login(page, base, tokenA);
  });

  test('模式与范围控件：精确/模糊、当前/全部，全部会话禁用只看任务', async ({ page }) => {
    await openRoom(page, directRoomId);
    await openSearch(page);
    await expect(page.locator('#message-search-controls')).toBeVisible();
    await expect(
      page.locator('#message-search-dialog').getByRole('radio', { name: '精确' }),
    ).toBeVisible();
    await expect(
      page.locator('#message-search-dialog').getByRole('radio', { name: '模糊' }),
    ).toBeVisible();
    await expect(
      page.locator('#message-search-dialog').getByRole('radio', { name: '当前会话' }),
    ).toBeVisible();
    await expect(
      page.locator('#message-search-dialog').getByRole('radio', { name: '全部会话' }),
    ).toBeVisible();

    await selectScope(page, '全部会话');
    await expect(page.locator('[data-task-only]')).toBeDisabled();
    await expect(page.locator('#message-search-task-note')).toHaveText('全部会话不支持只看任务');

    await selectScope(page, '当前会话');
    await expect(page.locator('[data-task-only]')).toBeEnabled();
    await expect(page.locator('#message-search-task-note')).toHaveCount(0);
  });

  test('防抖自动搜索、命中高亮与空态', async ({ page }) => {
    await openRoom(page, directRoomId);
    await openSearch(page);
    // 不点击提交，只输入；300ms 防抖后自动请求。
    await page.locator('#message-search-input').fill(token('case').toLowerCase());
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(1, {
      timeout: 10_000,
    });
    const mark = page.locator('#message-search-results .message-search-mark').first();
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(token('case'));
    await expect(page.locator('#message-search-status')).toContainText('已找到 1 条消息');

    await searchNow(page, token('none'));
    await expect(page.locator('#message-search-status')).toHaveText('没有找到匹配消息');
    await expect(page.locator('#message-search-empty')).toHaveText('没有找到匹配消息');
  });

  test('切换模糊模式后命中保序字符，精确模式不命中', async ({ page }) => {
    await openRoom(page, directRoomId);
    await openSearch(page);
    await searchNow(page, 'alphagamma');
    await expect(page.locator('#message-search-status')).toHaveText('没有找到匹配消息');

    await selectMode(page, '模糊');
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.locator('#message-search-results .message-search-mark')).toHaveCount(2);
    await expect(page.locator('#message-search-mode-help')).toContainText('字符按顺序出现');
  });

  test('全部会话显示房间名与类型，切回当前会话不串结果', async ({ page }) => {
    await openRoom(page, directRoomId);
    await openSearch(page);
    await searchNow(page, token('global'));
    await expect(page.locator('#message-search-status')).toHaveText('没有找到匹配消息');
    await selectScope(page, '全部会话');
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(1, {
      timeout: 10_000,
    });
    const row = page.locator('#message-search-results .message-search-result').first();
    await expect(row.locator('.message-search-room')).toHaveText(groupTitle);
    await expect(row.locator('.message-search-kind')).toHaveText('群聊');
    await expect(row.locator('.message-search-mark')).toHaveText(token('global'));

    await selectScope(page, '当前会话');
    await expect(page.locator('#message-search-status')).toHaveText('没有找到匹配消息');
  });

  test('加载更多：首屏 25 条后可继续加载', async ({ page }) => {
    await openRoom(page, directRoomId);
    await openSearch(page);
    await searchNow(page, token('loadmore'));
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(25, {
      timeout: 10_000,
    });
    await expect(page.locator('#message-search-more')).toHaveText('加载更多');
    await page.locator('#message-search-more').click();
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(30);
  });

  test('旧响应丢弃：新查询先返回后，被挂起的旧响应不得覆盖', async ({ page }) => {
    const oldQuery = token('loadmore');
    const newQuery = token('multi');
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_message_search') {
        await route.continue();
        return;
      }
      let query = '';
      try {
        const body = JSON.parse(request.postData() ?? '{}') as {
          params?: { arguments?: { query?: string } };
        };
        query = body.params?.arguments?.query ?? '';
      } catch {
        // 非 JSON 请求交回服务端处理。
      }
      if (query === oldQuery) await oldGate;
      await route.continue().catch(() => undefined);
    });

    await openRoom(page, directRoomId);
    await openSearch(page);
    await searchNow(page, oldQuery);
    // 旧请求还挂在路由上；立即输入新查询。
    await page.locator('#message-search-input').fill(newQuery);
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(3, {
      timeout: 10_000,
    });
    await expect(page.locator('#message-search-results .message-search-mark').first()).toHaveText(
      newQuery,
    );
    releaseOld();
    await page.waitForTimeout(500);
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(3);
    await expect(page.locator('#message-search-results')).not.toContainText(oldQuery);
  });

  test('Ctrl/Cmd+F、上下条导航与 Esc 关闭', async ({ page }) => {
    await openRoom(page, directRoomId);
    await page.keyboard.press('Control+f');
    await expect(page.locator('#message-search-dialog')).toBeVisible();
    await expect(page.locator('#message-search-input')).toBeFocused();

    await searchNow(page, token('multi'));
    const rows = page.locator('#message-search-results .message-search-result');
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'true');

    await page.locator('#message-search-input').press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(rows.nth(1)).toHaveCSS('outline-style', 'solid');
    await page.locator('#message-search-input').press('Shift+Enter');
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'true');

    await page.keyboard.press('Escape');
    await expect(page.locator('#message-search-dialog')).toHaveCount(0);
    await expect(page.locator('#message-search-button')).toBeFocused();
  });
});
