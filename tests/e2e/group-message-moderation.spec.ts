import { expect, test, type Browser, type Page } from '@playwright/test';

import { baseUrl, callTool, login, requestId } from './fixtures/components';
import { expectNoHorizontalOverflow } from './fixtures/task-layout';

interface ModerationRoom {
  tokenOwner: string;
  tokenMember: string;
  tokenAdmin: string;
  actorOwner: string;
  actorMember: string;
  actorAdmin: string;
  roomId: string;
  roomTitle: string;
}

interface RoomDetailForTest {
  members: {
    actor_id: string;
    role: 'owner' | 'admin' | 'member';
    role_revision: number;
  }[];
}

async function registerHuman(base: string, suffix: string, label: string) {
  const token = crypto.randomUUID();
  const result = await callTool<{ actor_id: string }>(base, token, 'network_register', {
    request_id: requestId('e2e_mod_reg'),
    kind: 'human',
    name: `群管 ${label} ${suffix}`,
    device_id: `e2e-mod-${suffix}-${label}`,
  });
  return { token, actorId: result.actor_id };
}

async function befriend(base: string, fromToken: string, targetActor: string) {
  const requested = await callTool<{ request: { contact_request_id: string } }>(
    base,
    fromToken,
    'network_contact_request',
    { request_id: requestId('e2e_mod_contact'), actor_id: targetActor },
  );
  return requested.request.contact_request_id;
}

async function createModerationRoom(base: string): Promise<ModerationRoom> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const owner = await registerHuman(base, suffix, 'owner');
  const member = await registerHuman(base, suffix, 'member');
  const admin = await registerHuman(base, suffix, 'admin');

  const toMember = await befriend(base, owner.token, member.actorId);
  await callTool(base, member.token, 'network_contact_request_respond', {
    request_id: requestId('e2e_mod_contact'),
    contact_request_id: toMember,
    action: 'accept',
  });
  const toAdmin = await befriend(base, owner.token, admin.actorId);
  await callTool(base, admin.token, 'network_contact_request_respond', {
    request_id: requestId('e2e_mod_contact'),
    contact_request_id: toAdmin,
    action: 'accept',
  });

  const roomTitle = `群管前端 ${suffix}`;
  const created = await callTool<{ room: { room_id: string } }>(
    base,
    owner.token,
    'network_room_create',
    {
      request_id: requestId('e2e_mod_group'),
      kind: 'group',
      title: roomTitle,
      members: [member.actorId, admin.actorId],
    },
  );
  const roomId = created.room.room_id;
  const detail = await callTool<RoomDetailForTest>(base, owner.token, 'network_room_get', {
    room_id: roomId,
  });
  const adminMember = detail.members.find((entry) => entry.actor_id === admin.actorId);
  if (!adminMember) throw new Error('管理员成员缺失');
  await callTool(base, owner.token, 'network_room_role_set', {
    request_id: requestId('e2e_mod_role'),
    room_id: roomId,
    actor_id: admin.actorId,
    role: 'admin',
    expected_role_revision: adminMember.role_revision,
  });

  return {
    tokenOwner: owner.token,
    tokenMember: member.token,
    tokenAdmin: admin.token,
    actorOwner: owner.actorId,
    actorMember: member.actorId,
    actorAdmin: admin.actorId,
    roomId,
    roomTitle,
  };
}

async function sendMessage(
  base: string,
  token: string,
  roomId: string,
  body: string,
): Promise<string> {
  const sent = await callTool<{ message: { message_id: string } }>(
    base,
    token,
    'network_message_send',
    {
      request_id: requestId('e2e_mod_send'),
      client_message_id: requestId('e2e_mod_cm'),
      room_id: roomId,
      invoke: [],
      body,
    },
  );
  return sent.message.message_id;
}

async function pinMessage(
  base: string,
  token: string,
  roomId: string,
  messageId: string,
  pinned = true,
): Promise<void> {
  await callTool(base, token, 'network_room_message_pin', {
    request_id: requestId('e2e_mod_pin'),
    room_id: roomId,
    message_id: messageId,
    pinned,
  });
}

async function markTask(
  base: string,
  token: string,
  roomId: string,
  messageId: string,
): Promise<void> {
  await callTool(base, token, 'network_task_mark', {
    request_id: requestId('e2e_mod_task'),
    room_id: roomId,
    message_id: messageId,
  });
}

interface RoomReadState {
  room: {
    head_seq: string;
    my_last_read_seq: string;
  };
}

async function readRoomState(
  base: string,
  token: string,
  roomId: string,
): Promise<RoomReadState> {
  return callTool<RoomReadState>(base, token, 'network_room_get', { room_id: roomId });
}

async function openRoom(
  browser: Browser,
  base: string,
  token: string,
  roomId: string,
  options: { width?: number; height?: number; dark?: boolean } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext(
    options.width && options.height
      ? { viewport: { width: options.width, height: options.height } }
      : undefined,
  );
  const page = await context.newPage();
  await login(page, base, token);
  if (options.dark) await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('#composer')).toBeVisible();
  return { page, close: () => context.close() };
}

function messageNode(page: Page, messageId: string) {
  return page.locator(`[data-message-id="${messageId}"]`).first();
}

async function openMessageMenu(page: Page, messageId: string): Promise<void> {
  await expect(page.locator('#message-action-menu')).toHaveCount(0);
  const node = messageNode(page, messageId);
  await node.scrollIntoViewIfNeeded();
  await node.getByRole('button', { name: '消息操作', exact: true }).click();
  await expect(page.locator('#message-action-menu')).toHaveCount(1);
  await expect(page.locator('#message-action-menu')).toBeVisible();
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('#message-action-menu')).toHaveCount(0);
}

/** 通过真实 Composer 发送，确保本机留存“发送成功”的原文副本。 */
async function sendFromComposer(page: Page, body: string): Promise<string> {
  await page.fill('#body', body);
  await page.press('#body', 'Enter');
  const row = page.locator('#messages [data-message-id]', { hasText: body }).last();
  await expect(row).toBeVisible();
  const messageId = await row.getAttribute('data-message-id');
  if (!messageId) throw new Error('发送后缺少 message_id');
  return messageId;
}

async function recallOwnMessage(page: Page, messageId: string): Promise<void> {
  await openMessageMenu(page, messageId);
  await page.locator('#message-action-recall').click();
  await page.locator('#confirm-dialog-ok').click();
  await expect(
    page.locator(`li.msg-system.msg-recalled[data-message-id="${messageId}"]`),
  ).toBeVisible();
}

test.describe.serial('群主消息管理前端', () => {
  let base = '';

  test.beforeAll(async () => {
    base = await baseUrl();
  });

  test('owner 菜单显示撤回与置顶，并确认撤回文案', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const ownerMessage = await sendMessage(base, room.tokenOwner, room.roomId, 'owner 自己的消息');
    const memberMessage = await sendMessage(
      base,
      room.tokenMember,
      room.roomId,
      'member 的待管理消息',
    );
    const { page, close } = await openRoom(browser, base, room.tokenOwner, room.roomId);
    try {
      await openMessageMenu(page, memberMessage);
      await expect(page.locator('#message-action-recall')).toBeVisible();
      await expect(page.locator('#message-action-pin')).toBeVisible();
      await closeMenu(page);

      await openMessageMenu(page, ownerMessage);
      await expect(page.locator('#message-action-recall')).toBeVisible();
      await expect(page.locator('#message-action-pin')).toBeVisible();
      await page.locator('#message-action-recall').click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await expect(page.locator('#confirm-dialog-message')).toContainText(
        '未完成的 Agent 工作会取消',
      );
      await page.locator('#confirm-dialog-cancel').click();
      await expect(page.locator('#confirm-dialog')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('admin 与 member 不出现他人消息的撤回/置顶', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const ownerMessage = await sendMessage(base, room.tokenOwner, room.roomId, 'owner 的公共消息');
    await sendMessage(base, room.tokenMember, room.roomId, 'member 自己的消息');

    const member = await openRoom(browser, base, room.tokenMember, room.roomId);
    try {
      await openMessageMenu(member.page, ownerMessage);
      await expect(member.page.locator('#message-action-recall')).toHaveCount(0);
      await expect(member.page.locator('#message-action-pin')).toHaveCount(0);
      await expect(member.page.locator('#message-action-unpin')).toHaveCount(0);
      await closeMenu(member.page);
    } finally {
      await member.close();
    }

    const admin = await openRoom(browser, base, room.tokenAdmin, room.roomId);
    try {
      await openMessageMenu(admin.page, ownerMessage);
      await expect(admin.page.locator('#message-action-recall')).toHaveCount(0);
      await expect(admin.page.locator('#message-action-pin')).toHaveCount(0);
      await closeMenu(admin.page);
    } finally {
      await admin.close();
    }
  });

  test('置顶三条后第四条禁用，取消一条后恢复', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const ids: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      ids.push(await sendMessage(base, room.tokenOwner, room.roomId, `置顶候选 ${index}`));
    }
    const { page, close } = await openRoom(browser, base, room.tokenOwner, room.roomId);
    try {
      for (const id of ids.slice(0, 3)) {
        await openMessageMenu(page, id);
        await page.locator('#message-action-pin').click();
        await expect(page.locator(`[data-pinned-unpin-id="${id}"]`)).toBeVisible();
      }
      await expect(page.locator('#pinned-messages')).toHaveAttribute('data-pinned-count', '3');

      await openMessageMenu(page, ids[3]!);
      const fourth = page.locator('#message-action-pin');
      await expect(fourth).toContainText('最多置顶 3 条');
      await expect(fourth).toHaveAttribute('aria-disabled', 'true');
      await closeMenu(page);

      await page.locator(`[data-pinned-unpin-id="${ids[0]}"]`).click();
      await expect(page.locator('#pinned-messages')).toHaveAttribute('data-pinned-count', '2');
      await openMessageMenu(page, ids[3]!);
      await expect(page.locator('#message-action-pin')).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await page.locator('#message-action-pin').click();
      await expect(page.locator('#pinned-messages')).toHaveAttribute('data-pinned-count', '3');
    } finally {
      await close();
    }
  });

  test('头部置顶区定位已加载与未加载消息', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const old = await sendMessage(base, room.tokenOwner, room.roomId, '最早的历史置顶消息');
    await pinMessage(base, room.tokenOwner, room.roomId, old);
    for (let index = 1; index <= 55; index += 1) {
      await sendMessage(base, room.tokenOwner, room.roomId, `历史填充 ${index}`);
    }
    const recent = await sendMessage(base, room.tokenOwner, room.roomId, '最近的可置顶消息');
    await pinMessage(base, room.tokenOwner, room.roomId, recent);

    const { page, close } = await openRoom(browser, base, room.tokenOwner, room.roomId);
    try {
      await expect(page.locator('#pinned-messages')).toHaveAttribute('data-pinned-count', '2');
      await page.locator(`[data-pinned-message-id="${recent}"]`).click();
      await expect(messageNode(page, recent)).toHaveAttribute('data-search-active', 'true');

      await page.locator(`[data-pinned-message-id="${old}"]`).click();
      await expect(page.locator('#search-navigation-bar')).toBeVisible();
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'true');
      await expect(messageNode(page, old)).toBeVisible();
      await page.locator('#search-return-latest').click();
      await expect(page.locator('#search-navigation-bar')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('owner 撤回他人置顶消息后显示墓碑并移除置顶', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const target = await sendMessage(base, room.tokenMember, room.roomId, '需要被撤回的成员消息');
    await pinMessage(base, room.tokenOwner, room.roomId, target);
    const { page, close } = await openRoom(browser, base, room.tokenOwner, room.roomId);
    try {
      await expect(page.locator(`[data-pinned-unpin-id="${target}"]`)).toBeVisible();
      await openMessageMenu(page, target);
      await page.locator('#message-action-recall').click();
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('#status')).toContainText('消息已撤回');
      await expect(page.locator(`li.msg-system.msg-recalled[data-message-id="${target}"]`)).toBeVisible();
      await expect(page.locator('#pinned-messages')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('pin/unpin/recall 事件刷新详情且不滚动到底', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const pinned = await sendMessage(base, room.tokenOwner, room.roomId, '事件置顶消息');
    const recalled = await sendMessage(base, room.tokenOwner, room.roomId, '事件撤回消息');
    for (let index = 1; index <= 20; index += 1) {
      await sendMessage(base, room.tokenOwner, room.roomId, `事件填充 ${index}`);
    }
    const { page, close } = await openRoom(browser, base, room.tokenMember, room.roomId);
    try {
      await page.locator('#messages').evaluate((element) => {
        element.scrollTop = 0;
      });
      const before = await page.locator('#messages').evaluate((element) => element.scrollTop);

      await pinMessage(base, room.tokenOwner, room.roomId, pinned);
      await expect(page.locator(`[data-pinned-unpin-id="${pinned}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-pinned-message-id="${pinned}"]`)).toBeVisible();
      const afterPin = await page.locator('#messages').evaluate((element) => element.scrollTop);
      expect(afterPin).toBeLessThanOrEqual(before + 4);

      await pinMessage(base, room.tokenOwner, room.roomId, pinned, false);
      await expect(page.locator('#pinned-messages')).toHaveCount(0);

      await callTool(base, room.tokenOwner, 'network_message_recall', {
        request_id: requestId('e2e_mod_recall'),
        message_id: recalled,
      });
      await expect(
        page.locator(`li.msg-system.msg-recalled[data-message-id="${recalled}"]`),
      ).toBeVisible();
      const afterRecall = await page.locator('#messages').evaluate((element) => element.scrollTop);
      expect(afterRecall).toBeLessThanOrEqual(before + 4);
    } finally {
      await close();
    }
  });

  test('独立 anchor 窗口收到远端撤回后重读墓碑且不滚底/不推进已读', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const old = await sendMessage(base, room.tokenOwner, room.roomId, '旧窗口待撤回消息');
    await pinMessage(base, room.tokenOwner, room.roomId, old);
    for (let index = 1; index <= 55; index += 1) {
      await sendMessage(base, room.tokenOwner, room.roomId, `锚点填充 ${index}`);
    }
    const { page, close } = await openRoom(browser, base, room.tokenMember, room.roomId);
    try {
      await page.locator(`[data-pinned-message-id="${old}"]`).click();
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'true');
      await expect(messageNode(page, old)).toBeVisible();

      // anchor 打开期间制造未读：撤回时 read < head，才能验证不会顺带推进已读。
      for (let index = 1; index <= 3; index += 1) {
        await sendMessage(base, room.tokenOwner, room.roomId, `锚点期间新消息 ${index}`);
      }
      await expect
        .poll(async () => {
          const state = await readRoomState(base, room.tokenMember, room.roomId);
          return Number(state.room.head_seq) - Number(state.room.my_last_read_seq);
        })
        .toBeGreaterThan(0);
      const before = await readRoomState(base, room.tokenMember, room.roomId);

      await callTool(base, room.tokenOwner, 'network_message_recall', {
        request_id: requestId('e2e_mod_recall'),
        message_id: old,
      });
      // 服务端不接受已撤回消息作为 anchor；页面丢弃旧窗口回到最新页，
      // 不能继续展示旧正文缓存。
      await expect(page.locator('#search-navigation-bar')).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'false');
      await expect(messageNode(page, old)).toHaveCount(0);
      await expect(page.locator('#messages')).not.toContainText('旧窗口待撤回消息');
      await expect(page.locator('#pinned-messages')).toHaveCount(0);

      // 等过滚动已读延迟，确认没有延迟滚底或 mark_read。
      await page.waitForTimeout(900);
      const scroll = await page.locator('#messages').evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      }));
      expect(scroll.max).toBeGreaterThan(0);
      expect(scroll.top).toBeLessThan(scroll.max);
      const after = await readRoomState(base, room.tokenMember, room.roomId);
      expect(after.room.my_last_read_seq).toBe(before.room.my_last_read_seq);
      expect(Number(after.room.my_last_read_seq)).toBeLessThan(Number(after.room.head_seq));
    } finally {
      await close();
    }
  });

  test('anchor 内撤回 Task 消息刷新 Dock，普通消息不请求 Task', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const taskRoot = await sendMessage(base, room.tokenOwner, room.roomId, '锚点 Task 待撤回消息');
    await markTask(base, room.tokenOwner, room.roomId, taskRoot);
    await pinMessage(base, room.tokenOwner, room.roomId, taskRoot);
    const ordinary = await sendMessage(base, room.tokenOwner, room.roomId, '锚点普通待撤回消息');
    await pinMessage(base, room.tokenOwner, room.roomId, ordinary);
    for (let index = 1; index <= 55; index += 1) {
      await sendMessage(base, room.tokenOwner, room.roomId, `锚点 Task 填充 ${index}`);
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, base, room.tokenMember);
    const counts = { history: 0, task: 0 };
    await page.route('**/mcp', async (route) => {
      const name = route.request().headers()['mcp-name'];
      if (name === 'network_history_list') counts.history += 1;
      if (name === 'network_task_list') counts.task += 1;
      await route.continue();
    });
    const initialTaskList = page
      .waitForResponse(
        (response) => response.request().headers()['mcp-name'] === 'network_task_list',
      )
      .catch(() => undefined);
    await page.goto(`${base}/c/${room.roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await initialTaskList;
    // 等首屏 ack 与任务查询稳定后再开始计数。
    await page.waitForTimeout(1000);

    try {
      await page.locator(`[data-pinned-message-id="${taskRoot}"]`).click();
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'true');
      await expect(messageNode(page, taskRoot)).toBeVisible();
      counts.history = 0;
      counts.task = 0;

      await callTool(base, room.tokenOwner, 'network_message_recall', {
        request_id: requestId('e2e_mod_recall'),
        message_id: taskRoot,
      });
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'false');
      await expect(page.locator('#messages')).not.toContainText('锚点 Task 待撤回消息');
      await expect.poll(() => counts.task, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(counts.history).toBe(0);

      // Dock 不再保留旧 preview，而是服务端返回的墓碑。
      await expect(page.locator('#task-dock-toggle')).toBeVisible();
      await page.locator('#task-dock-toggle').click();
      await expect(page.locator('.task-dock-preview')).toContainText('此消息已撤回');

      // 普通 anchor 消息撤回只丢弃窗口，不触发 Task 请求。
      counts.history = 0;
      counts.task = 0;
      await page.locator(`[data-pinned-message-id="${ordinary}"]`).click();
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'true');
      await expect(messageNode(page, ordinary)).toBeVisible();
      counts.history = 0;
      counts.task = 0;

      await callTool(base, room.tokenOwner, 'network_message_recall', {
        request_id: requestId('e2e_mod_recall'),
        message_id: ordinary,
      });
      await expect(page.locator('#messages')).toHaveAttribute('data-search-anchored', 'false');
      await expect(page.locator('#messages')).not.toContainText('锚点普通待撤回消息');
      await page.waitForTimeout(800);
      expect(counts.history).toBe(0);
      expect(counts.task).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('撤回只重读受影响窗口，Task 消息才刷新 Task 列表', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const ordinary = await sendMessage(base, room.tokenOwner, room.roomId, '普通待撤回消息');
    const taskRoot = await sendMessage(base, room.tokenOwner, room.roomId, 'Task 待撤回消息');
    await markTask(base, room.tokenOwner, room.roomId, taskRoot);

    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, base, room.tokenMember);
    const counts = { history: 0, task: 0 };
    await page.route('**/mcp', async (route) => {
      const name = route.request().headers()['mcp-name'];
      if (name === 'network_history_list') counts.history += 1;
      if (name === 'network_task_list') counts.task += 1;
      await route.continue();
    });
    const initialTaskList = page
      .waitForResponse(
        (response) => response.request().headers()['mcp-name'] === 'network_task_list',
      )
      .catch(() => undefined);
    await page.goto(`${base}/c/${room.roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await initialTaskList;
    // 等首屏 ack 与任务查询稳定后再开始计数。
    await page.waitForTimeout(1000);
    counts.history = 0;
    counts.task = 0;

    try {
      await callTool(base, room.tokenOwner, 'network_message_recall', {
        request_id: requestId('e2e_mod_recall'),
        message_id: ordinary,
      });
      await expect(
        page.locator(`li.msg-system.msg-recalled[data-message-id="${ordinary}"]`),
      ).toBeVisible();
      await page.waitForTimeout(800);
      expect(counts.history).toBe(1);
      expect(counts.task).toBe(0);

      counts.history = 0;
      counts.task = 0;
      await callTool(base, room.tokenOwner, 'network_message_recall', {
        request_id: requestId('e2e_mod_recall'),
        message_id: taskRoot,
      });
      await expect(
        page.locator(`li.msg-system.msg-recalled[data-message-id="${taskRoot}"]`),
      ).toBeVisible();
      await page.waitForTimeout(800);
      expect(counts.history).toBe(1);
      expect(counts.task).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  test('服务端拒绝第 4 条置顶时菜单错误可见', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const ids: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      ids.push(await sendMessage(base, room.tokenOwner, room.roomId, `服务端上限 ${index}`));
    }
    for (const id of ids.slice(0, 3)) {
      await pinMessage(base, room.tokenOwner, room.roomId, id);
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, base, room.tokenOwner);
    // 只让页面看到两条置顶，模拟期间其他标签页新增第三条后的过期视图。
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== 'network_room_get') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const payload = (await response.json()) as {
        result?: { structuredContent?: { pinned_messages?: unknown[] } };
      };
      const pins = payload.result?.structuredContent?.pinned_messages;
      if (Array.isArray(pins)) payload.result!.structuredContent!.pinned_messages = pins.slice(0, 2);
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`${base}/c/${room.roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    try {
      await expect(page.locator('#pinned-messages')).toHaveAttribute('data-pinned-count', '2');
      await openMessageMenu(page, ids[3]!);
      await page.locator('#message-action-pin').click();
      await expect(page.locator('#status')).toContainText('置顶失败');
      await expect(page.locator('#status')).toContainText('最多置顶 3 条');
    } finally {
      await context.close();
    }
  });

  test('契约不兼容时置顶区取消置顶禁用并提示', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const pinned = await sendMessage(base, room.tokenOwner, room.roomId, '不兼容时的置顶消息');
    await pinMessage(base, room.tokenOwner, room.roomId, pinned);

    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, base, room.tokenOwner);
    await page.route('**/web-version.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          deploymentId: 'r-e2e-incompatible',
          buildId: `sha256:${'f'.repeat(64)}`,
          minWebContract: 2,
          maxWebContract: 2,
        }),
      }),
    );
    await page.route('**/c/**', async (route) => {
      if (route.request().resourceType() !== 'document') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const html = await response.text();
      const release = JSON.stringify({
        buildId: `sha256:${'a'.repeat(64)}`,
        webContract: 1,
      });
      await route.fulfill({
        response,
        body: html.replace(
          '</head>',
          `<script type="application/json" id="web-release">${release}</script></head>`,
        ),
      });
    });

    try {
      await page.goto(`${base}/c/${room.roomId}`);
      await expect(page.locator('#composer')).toBeVisible();
      await expect(page.locator('#pwa-update-notice')).toBeVisible({ timeout: 10_000 });
      const unpin = page.locator(`[data-pinned-unpin-id="${pinned}"]`);
      await expect(unpin).toBeVisible();
      await expect(unpin).toBeDisabled();
      await expect(unpin).toHaveAttribute(
        'title',
        '当前页面与服务器版本不兼容，请先更新后再取消置顶',
      );
    } finally {
      await context.close();
    }
  });

  test('390 暗色置顶区可键盘定位并收起展开', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const first = await sendMessage(base, room.tokenOwner, room.roomId, '窄屏置顶一');
    const second = await sendMessage(base, room.tokenOwner, room.roomId, '窄屏置顶二');
    await pinMessage(base, room.tokenOwner, room.roomId, first);
    await pinMessage(base, room.tokenOwner, room.roomId, second);
    const { page, close } = await openRoom(browser, base, room.tokenMember, room.roomId, {
      width: 390,
      height: 844,
      dark: true,
    });
    try {
      await expect(page.locator('#pinned-messages')).toBeVisible();
      await expectNoHorizontalOverflow(page.locator('#pinned-messages'));
      const locate = page.locator(`[data-pinned-message-id="${first}"]`);
      await expect(locate).toHaveCSS('min-height', '44px');
      await locate.focus();
      await page.keyboard.press('Enter');
      await expect(messageNode(page, first)).toHaveAttribute('data-search-active', 'true');

      const toggle = page.locator('#pinned-toggle');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#pinned-list')).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
      await expect(page.locator('#pinned-list')).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    } finally {
      await close();
    }
  });

  test('本人撤回后可用行内按钮重新编辑，其他成员没有入口', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const member = await openRoom(browser, base, room.tokenMember, room.roomId);
    const owner = await openRoom(browser, base, room.tokenOwner, room.roomId);
    try {
      const body = `可重新编辑 ${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const messageId = await sendFromComposer(member.page, body);
      await recallOwnMessage(member.page, messageId);

      const reedit = member.page.locator(`[data-reedit-message-id="${messageId}"]`);
      await expect(reedit).toBeVisible();
      await expect(reedit).toHaveText('重新编辑');

      // 右键菜单提供同名入口。
      await member.page
        .locator(`li.msg-system.msg-recalled[data-message-id="${messageId}"]`)
        .click({ button: 'right' });
      const menuItem = member.page.locator('#message-action-reedit');
      await expect(menuItem).toBeVisible();
      await expect(menuItem).toHaveText('重新编辑');
      await member.page.keyboard.press('Escape');
      await expect(menuItem).toHaveCount(0);

      // 同一房间的其他成员能看到墓碑，但没有本地原文入口。
      await expect(
        owner.page.locator(`li.msg-system.msg-recalled[data-message-id="${messageId}"]`),
      ).toBeVisible();
      await expect(owner.page.locator(`[data-reedit-message-id="${messageId}"]`)).toHaveCount(0);

      await reedit.click();
      await expect(member.page.locator('#body')).toHaveValue(body);
      await expect(member.page.locator('#body')).toBeFocused();
      const caret = await member.page.locator('#body').evaluate((element) => {
        const area = element as HTMLTextAreaElement;
        return {
          start: area.selectionStart,
          end: area.selectionEnd,
          length: area.value.length,
        };
      });
      expect(caret).toEqual({ start: body.length, end: body.length, length: body.length });
      // 不自动发送；恢复成功后入口消失。
      await expect(member.page.locator('#messages')).not.toContainText(body);
      await expect(reedit).toHaveCount(0);
    } finally {
      await member.close();
      await owner.close();
    }
  });

  test('输入框非空时重新编辑先确认，取消不改输入', async ({ browser }) => {
    const room = await createModerationRoom(base);
    const { page, close } = await openRoom(browser, base, room.tokenMember, room.roomId);
    try {
      const body = `待替换原文 ${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const messageId = await sendFromComposer(page, body);
      await recallOwnMessage(page, messageId);
      const reedit = page.locator(`[data-reedit-message-id="${messageId}"]`);
      await expect(reedit).toBeVisible();

      const draft = '正在写的草稿';
      await page.fill('#body', draft);
      await reedit.click();
      await expect(page.locator('#confirm-dialog')).toBeVisible();
      await expect(page.locator('#confirm-dialog-message')).toHaveText(
        '用撤回的消息替换当前输入？',
      );
      await page.locator('#confirm-dialog-cancel').click();
      await expect(page.locator('#confirm-dialog')).toHaveCount(0);
      await expect(page.locator('#body')).toHaveValue(draft);
      await expect(reedit).toBeVisible();

      // 右键菜单走同一确认与替换逻辑。
      await page
        .locator(`li.msg-system.msg-recalled[data-message-id="${messageId}"]`)
        .click({ button: 'right' });
      await page.locator('#message-action-reedit').click();
      await expect(page.locator('#confirm-dialog-message')).toHaveText(
        '用撤回的消息替换当前输入？',
      );
      await page.locator('#confirm-dialog-ok').click();
      await expect(page.locator('#body')).toHaveValue(body);
      await expect(page.locator('#body')).toBeFocused();
      await expect(reedit).toHaveCount(0);
      await expect(page.locator('#messages')).not.toContainText(body);
    } finally {
      await close();
    }
  });
});
