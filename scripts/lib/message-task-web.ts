/**
 * 消息式 Task / Trace 浏览器验收（阶段 3）。
 *
 * 覆盖设计稿场景 1、2、10、11、12、13、14：起点摘要、Agent 起点、无表单
 * 标记/取消、按根聚合搜索、命中处理消息定位、长 Trace 分页、切房/草稿、
 * 撤回与权限边界。全部通过真实 HTTP + Playwright，不替换成功响应。
 */

import type { Browser, BrowserContext, Page } from 'playwright';

import { check, checkEqual } from './harness';

interface Actor {
  actor_id: string;
  agent_session_id?: string | null;
  name: string;
}

interface MessageSendView {
  message: { message_id: string };
}

export interface MessageTaskWebDeps {
  browser: Browser;
  base: string;
  allErrors: string[];
  rawTool: <T>(token: string, name: string, args: Record<string, unknown>) => Promise<T>;
}

const IGNORED_CONSOLE = ['Failed to load resource', 'net::ERR_'];
const DRAFT_TEXT = 'Trace 草稿保留';

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function watchPage(page: Page, allErrors: string[]): void {
  page.on('pageerror', (error) => {
    allErrors.push(`message-task pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((part) => text.includes(part))) return;
    allErrors.push(`message-task console: ${text}`);
  });
}

async function makeContext(
  browser: Browser,
  base: string,
  token: string,
  allErrors: string[],
  viewport = { width: 1280, height: 800 },
  options: { colorScheme?: 'dark' | 'light'; hasTouch?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, ...options });
  await context.addInitScript(
    (value: string) => {
      try {
        localStorage.setItem('agent-network-token', value);
      } catch {
        // 浏览器拒绝存储时页面会提示重新初始化；验收不需要额外处理。
      }
    },
    token,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  watchPage(page, allErrors);
  return { context, page };
}

async function rawBefriend(
  rawTool: MessageTaskWebDeps['rawTool'],
  requesterToken: string,
  targetToken: string,
  target: { actor_id?: string; agent_session_id?: string },
): Promise<void> {
  const requested = await rawTool<{
    status: string;
    request: { contact_request_id: string } | null;
  }>(requesterToken, 'network_contact_request', {
    request_id: id('contact_request'),
    ...(target.actor_id
      ? { actor_id: target.actor_id }
      : { agent_session_id: target.agent_session_id }),
  });
  if (requested.status === 'accepted') return;
  if (!requested.request) throw new Error(`好友申请未进入 pending: ${requested.status}`);
  await rawTool(targetToken, 'network_contact_request_respond', {
    request_id: id('contact_accept'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

async function acceptInvites(
  rawTool: MessageTaskWebDeps['rawTool'],
  token: string,
  roomId: string,
): Promise<void> {
  const listing = await rawTool<{
    items: { invitation_id: string; room_id: string; can_respond: boolean }[];
  }>(token, 'network_room_invite_get', { limit: 100 });
  for (const item of listing.items) {
    if (item.room_id !== roomId || !item.can_respond) continue;
    await rawTool(token, 'network_room_invite_respond', {
      request_id: id('invite'),
      invitation_id: item.invitation_id,
      action: 'accept',
    });
  }
}

async function sendMessage(
  rawTool: MessageTaskWebDeps['rawTool'],
  token: string,
  roomId: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await rawTool<MessageSendView>(token, 'network_message_send', {
    request_id: id('msg'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    body,
    ...extra,
  });
  return result.message.message_id;
}

async function markTask(
  rawTool: MessageTaskWebDeps['rawTool'],
  token: string,
  roomId: string,
  messageId: string,
): Promise<void> {
  await rawTool(token, 'network_task_mark', {
    request_id: id('task_mark'),
    room_id: roomId,
    message_id: messageId,
  });
}

async function waitRoom(page: Page, roomId: string, title: string): Promise<void> {
  await page.waitForURL(`**/c/${roomId}`);
  await page.waitForFunction(
    ({ expected }: { expected: string }) => {
      const heading = document.getElementById('title');
      const body = document.getElementById('chat-body');
      return Boolean(heading && heading.textContent === expected && body &&
        body.getAttribute('aria-busy') === 'false');
    },
    { expected: title },
  );
}

function messageNode(page: Page, messageId: string) {
  return page.locator(`#messages [data-message-id="${messageId}"]`);
}

async function waitForTaskBar(page: Page, messageId: string): Promise<void> {
  await page.waitForFunction(
    (value: string) => {
      const node = document.querySelector(`#messages [data-message-id="${value}"]`);
      const bar = node ? node.querySelector('.task-bar') : null;
      return Boolean(bar && bar.querySelector('.task-bar-count'));
    },
    messageId,
  );
}

async function openMessageAction(page: Page, messageId: string, label: string): Promise<void> {
  const node = messageNode(page, messageId);
  await node.scrollIntoViewIfNeeded();
  await node.hover();
  await node.locator('.message-actions-trigger').click();
  const menu = page.locator('#message-action-menu');
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitem', { name: label }).click();
  await menu.waitFor({ state: 'detached' }).catch(() => undefined);
}

async function waitToast(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (expected: string) => {
      const toast = document.getElementById('toast');
      return Boolean(toast && !toast.hidden && (toast.textContent ?? '').includes(expected));
    },
    text,
  );
}

async function openTraceFromBar(page: Page, messageId: string): Promise<void> {
  const bar = page.locator(`#messages [data-message-id="${messageId}"] .task-bar`);
  await bar.click();
  await page.locator('#task-trace-drawer').waitFor({ state: 'visible' });
  await page.waitForFunction(
    `document.querySelectorAll('#task-trace-items .task-trace-item').length > 0`,
  );
}

async function closeTrace(page: Page): Promise<void> {
  if (await page.locator('#task-trace-drawer').isVisible()) {
    await page.locator('#task-trace-close').click();
  }
  await page.locator('#task-trace-drawer').waitFor({ state: 'hidden' });
}

async function traceItemCount(page: Page): Promise<number> {
  return page.locator('#task-trace-items .task-trace-item').count();
}

async function waitTraceCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected: number) =>
      document.querySelectorAll('#task-trace-items .task-trace-item').length >= expected,
    count,
  );
}

function searchDialog(page: Page) {
  return page.locator('dialog').filter({ hasText: '搜索聊天记录' });
}

async function ensureSearch(page: Page) {
  let dialog = searchDialog(page);
  if ((await dialog.count()) === 0 || !(await dialog.isVisible())) {
    await page.locator('button[aria-label="搜索聊天记录"]').click();
    dialog = searchDialog(page);
    await dialog.waitFor({ state: 'visible' });
  }
  return dialog;
}

async function runSearch(page: Page, query: string, taskOnly: boolean): Promise<void> {
  const dialog = await ensureSearch(page);
  if (taskOnly) await dialog.locator('[data-task-only]').check();
  else await dialog.locator('[data-task-only]').uncheck();
  await dialog.locator('input[type="search"]').fill(query);
  await dialog.locator('form[data-search] button[type="submit"]').click();
  await page.waitForFunction(
    ({ task, expected }: { task: boolean; expected: string }) => {
      const dialogs = Array.from(document.querySelectorAll('dialog')).filter(
        (item) => (item as HTMLDialogElement).open && (item.textContent ?? '').includes('搜索聊天记录'),
      );
      const dialog = dialogs[0];
      if (!dialog) return false;
      if ((dialog as HTMLElement).dataset.resultQuery !== expected) return false;
      const status = dialog.querySelector('[data-status]')?.textContent ?? '';
      const rows = dialog.querySelectorAll(task ? '.task-search-result' : '[data-results] button');
      return rows.length > 0 || status.includes('没有') || status.includes('失败');
    },
    { task: taskOnly, expected: `${taskOnly ? 'task' : 'message'}:${query}` },
  );
}

async function closeSearch(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    if (typeof messageSearchDialog !== 'undefined' && messageSearchDialog) messageSearchDialog.close();
  })()`);
}

async function taskSearchResultCount(page: Page): Promise<number> {
  return searchDialog(page).locator('.task-search-result').count();
}

export async function runMessageTaskWebAcceptance(deps: MessageTaskWebDeps): Promise<void> {
  const { browser, base, allErrors, rawTool } = deps;
  console.log('· 消息式 Task 摘要与 Trace');

  const humanToken = crypto.randomUUID();
  const human = await rawTool<Actor>(humanToken, 'network_register', {
    request_id: id('reg'),
    kind: 'human',
    name: 'Task Trace 人类',
  });
  const agentSpecs = ['Tibo', '维护员', 'Codex Task', 'Gemini Task'];
  const agents: { token: string; actor: Actor }[] = [];
  for (const name of agentSpecs) {
    const token = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const actor = await rawTool<Actor>(token, 'network_register', {
      request_id: id('reg'),
      kind: 'agent',
      name,
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await rawBefriend(rawTool, humanToken, token, {
      agent_session_id: actor.agent_session_id ?? undefined,
    });
    agents.push({ token, actor });
  }

  const roomA = (
    await rawTool<{ room: { room_id: string } }>(humanToken, 'network_room_create', {
      request_id: id('room'),
      kind: 'group',
      title: '消息 Task 验收群',
      members: agents.map((agent) => agent.actor.actor_id),
    })
  ).room.room_id;
  const roomB = (
    await rawTool<{ room: { room_id: string } }>(humanToken, 'network_room_create', {
      request_id: id('room'),
      kind: 'group',
      title: '长 Trace 验收群',
      members: [agents[0]!.actor.actor_id],
    })
  ).room.room_id;
  const roomC = (
    await rawTool<{ room: { room_id: string } }>(humanToken, 'network_room_create', {
      request_id: id('room'),
      kind: 'group',
      title: '切房验收群',
      members: [agents[1]!.actor.actor_id],
    })
  ).room.room_id;
  for (const agent of agents) {
    await acceptInvites(rawTool, agent.token, roomA);
  }
  await acceptInvites(rawTool, agents[0]!.token, roomB);
  await acceptInvites(rawTool, agents[1]!.token, roomC);

  // 房间 A：摘要、无表单标记、搜索、撤回与切房。
  const r1 = await sendMessage(rawTool, humanToken, roomA, '请修复聊天切换问题');
  await markTask(rawTool, agents[0]!.token, roomA, r1);
  await markTask(rawTool, agents[1]!.token, roomA, r1);
  const aReply = await sendMessage(rawTool, agents[0]!.token, roomA, 'Tibo 已接取，开始定位聊天切换。', {
    reply_to: r1,
    task_root_id: r1,
  });
  const bReply = await sendMessage(rawTool, agents[1]!.token, roomA, '维护员已接取，补充复现步骤。', {
    reply_to: r1,
    task_root_id: r1,
  });
  const source = await sendMessage(rawTool, humanToken, roomA, '原始日志：切换房间时消息列表闪动。');
  const pRef = await sendMessage(rawTool, agents[0]!.token, roomA, '根据原始日志定位到聊天切换问题。', {
    reply_to: source,
    task_root_id: r1,
  });
  const pUnique = await sendMessage(rawTool, agents[1]!.token, roomA, '独特处理命中词ZXQ，用于搜索定位。', {
    reply_to: r1,
    task_root_id: r1,
  });
  const hRecalled = await sendMessage(rawTool, humanToken, roomA, '即将撤回的处理消息，只用于撤回展示。', {
    reply_to: r1,
    task_root_id: r1,
  });

  const r2 = await sendMessage(rawTool, agents[0]!.token, roomA, '请维护员处理这份修复清单');
  await markTask(rawTool, agents[0]!.token, roomA, r2);
  await sendMessage(rawTool, humanToken, roomA, '收到，我补充一项。', {
    reply_to: r2,
    task_root_id: r2,
  });

  const r3 = await sendMessage(rawTool, humanToken, roomA, '搜索验收关键词 起点');
  await markTask(rawTool, humanToken, roomA, r3);
  await sendMessage(rawTool, agents[0]!.token, roomA, '搜索验收关键词 处理一', {
    reply_to: r3,
    task_root_id: r3,
  });
  await sendMessage(rawTool, agents[1]!.token, roomA, '搜索验收关键词 处理二', {
    reply_to: r3,
    task_root_id: r3,
  });

  const r6 = await sendMessage(rawTool, humanToken, roomA, '四个 Agent 参与的任务');
  await markTask(rawTool, humanToken, roomA, r6);
  for (const agent of agents) {
    await sendMessage(rawTool, agent.token, roomA, `${agent.actor.name} 参与处理`, {
      reply_to: r6,
      task_root_id: r6,
    });
  }

  const fresh = await sendMessage(rawTool, humanToken, roomA, '这条消息稍后由界面标记为 Task');
  const r5 = await sendMessage(rawTool, humanToken, roomA, '由另一位成员取消的 Task');
  await markTask(rawTool, humanToken, roomA, r5);

  // 房间 B：长 Trace，第 40 条处理消息用于 focus 定位。
  const r4 = await sendMessage(rawTool, humanToken, roomB, '长 Trace 起点');
  await markTask(rawTool, humanToken, roomB, r4);
  let longFocus = '';
  for (let index = 1; index <= 52; index += 1) {
    const messageId = await sendMessage(rawTool, agents[0]!.token, roomB, `长 Trace 处理 ${index}`, {
      reply_to: r4,
      task_root_id: r4,
    });
    if (index === 40) longFocus = messageId;
  }
  await sendMessage(rawTool, humanToken, roomC, '另一个房间的消息');

  const { context, page } = await makeContext(browser, base, humanToken, allErrors);
  try {
    await page.goto(`${base}/c/${roomA}`);
    await waitRoom(page, roomA, '消息 Task 验收群');
    await waitForTaskBar(page, r1);

    // 场景 1/2：起点摘要、Agent 起点、头像顺序与 +N。
    const r1Bar = messageNode(page, r1).locator('.task-bar');
    const r1Text = (await r1Bar.innerText()) ?? '';
    check(
      '起点摘要显示预览与消息数',
      r1Text.includes('请修复聊天切换问题') && r1Text.includes('7 消息'),
      r1Text,
    );
    checkEqual('起点摘要只显示两个参与 Agent', await r1Bar.locator('.task-avatar').count(), 2);
    const avatarTitles = await r1Bar.locator('.task-avatar').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('title')),
    );
    checkEqual('参与 Agent 按首次参与顺序', avatarTitles.join(','), 'Tibo,维护员');
    checkEqual('两个 Agent 不显示 +N', await r1Bar.locator('.task-bar-more').count(), 0);
    await waitForTaskBar(page, r2);
    checkEqual(
      'Agent 消息也能成为 Task 起点',
      await messageNode(page, r2).getAttribute('data-sender-kind'),
      'agent',
    );
    await waitForTaskBar(page, r6);
    const r6Bar = messageNode(page, r6).locator('.task-bar');
    checkEqual('四个参与 Agent 只显示前三个头像', await r6Bar.locator('.task-avatar').count(), 3);
    checkEqual('第四个 Agent 折叠为 +1', await r6Bar.locator('.task-bar-more').textContent(), '+1');
    checkEqual('旧任务头部入口已移除', await page.locator('#task-toggle').count(), 0);
    checkEqual('旧新建任务入口已移除', await page.locator('#task-create').count(), 0);
    checkEqual('旧我的任务入口已移除', await page.locator('#my-tasks').count(), 0);
    checkEqual('旧任务弹窗不再渲染', await page.locator('#task-create-modal').count(), 0);

    // 场景 1：菜单直接标记，无表单；再次打开可取消。
    checkEqual('普通消息初始没有摘要行', await messageNode(page, fresh).locator('.task-bar').count(), 0);
    await openMessageAction(page, fresh, '标记为 Task');
    await waitToast(page, '已标记为 Task');
    await waitForTaskBar(page, fresh);
    checkEqual('标记后没有打开创建表单', await page.locator('dialog[open]').count(), 0);
    check(
      '标记后摘要行立即出现',
      await messageNode(page, fresh).locator('.task-bar').isVisible(),
    );
    await openMessageAction(page, fresh, '取消 Task');
    await waitToast(page, '已取消 Task 标记');
    await page.waitForFunction(
      (messageId: string) => {
        const node = document.querySelector(`#messages [data-message-id="${messageId}"]`);
        return Boolean(node && !node.querySelector('.task-bar'));
      },
      fresh,
    );
    check(
      '取消 Task 后原消息仍在',
      ((await messageNode(page, fresh).innerText()) ?? '').includes('这条消息稍后由界面标记为 Task'),
    );

    // 失败要有提示：处理消息已属于另一个 Task，标记返回 CONFLICT。
    await openMessageAction(page, pRef, '标记为 Task');
    await waitToast(page, '标记失败');
    checkEqual('冲突时不新增摘要行', await messageNode(page, pRef).locator('.task-bar').count(), 0);

    // 另一位成员取消：事件只更新摘要行，不产生未读。
    await waitForTaskBar(page, r5);
    await rawTool(humanToken, 'network_task_unmark', {
      request_id: id('task_unmark'),
      room_id: roomA,
      message_id: r5,
    });
    await page.waitForFunction(
      (messageId: string) => {
        const node = document.querySelector(`#messages [data-message-id="${messageId}"]`);
        return Boolean(node && !node.querySelector('.task-bar'));
      },
      r5,
    );
    check('其他成员取消后摘要行即时消失', true);

    // 场景 10/14：Trace 角色、引用来源与回到聊天定位。
    await openTraceFromBar(page, r1);
    checkEqual('Trace 标题显示起点预览', await page.locator('#task-trace-title').textContent(), '请修复聊天切换问题');
    const metaText = (await page.locator('#task-trace-meta').textContent()) ?? '';
    check('Trace 头部显示消息数与参与数', metaText.includes('7 条消息') && metaText.includes('2 个 Agent'));
    checkEqual('Trace 起点角色', await page.locator('#task-trace-items .task-trace-role-root').count(), 1);
    checkEqual('Trace 引用来源标为引用', await page.locator('#task-trace-items .task-trace-role-reference').count(), 1);
    const traceIds = await page.locator('#task-trace-items .task-trace-item').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-message-id')),
    );
    for (const expected of [r1, aReply, bReply, source, pRef, pUnique, hRecalled]) {
      check(`Trace 包含消息 ${expected.slice(-6)}`, traceIds.includes(expected));
    }
    await page.locator(`#task-trace-items .task-trace-item[data-message-id="${source}"]`).click();
    await page.locator('#task-trace-drawer').waitFor({ state: 'hidden' });
    await page.waitForFunction(
      (messageId: string) => {
        const node = document.querySelector(`#messages [data-message-id="${messageId}"]`);
        return Boolean(node && node.classList.contains('task-message-flash'));
      },
      source,
    );
    check('点击引用来源回到原聊天位置', true);

    // 场景 14：撤回处理消息后 Trace 显示撤回系统行。
    await rawTool(humanToken, 'network_message_recall', {
      request_id: id('recall'),
      message_id: hRecalled,
    });
    await page.waitForFunction(
      (messageId: string) => Boolean(
        document.querySelector(`#messages [data-message-id="${messageId}"].msg-recalled`),
      ),
      hRecalled,
    );
    await waitForTaskBar(page, r1);
    await openTraceFromBar(page, r1);
    const recalledItem = page.locator(
      `#task-trace-items .task-trace-item[data-message-id="${hRecalled}"]`,
    );
    check('撤回消息在 Trace 中保留定位', await recalledItem.count(), 1);
    check(
      '撤回消息不显示正文',
      ((await recalledItem.innerText()) ?? '').includes('此消息已撤回'),
    );
    await closeTrace(page);

    // 场景 11：Task 搜索按起点聚合；点击定位命中处理消息。
    await runSearch(page, '搜索验收关键词', true);
    checkEqual('同一 Task 多条命中只显示一个摘要', await taskSearchResultCount(page), 1);
    const searchRowText = (await searchDialog(page).locator('.task-search-result').first().innerText()) ?? '';
    check(
      'Task 搜索摘要显示命中数与消息数',
      searchRowText.includes('命中 3 条') && searchRowText.includes('3 消息'),
      searchRowText,
    );
    await searchDialog(page).locator('.task-search-result').first().click();
    await page.locator('#task-trace-drawer').waitFor({ state: 'visible' });
    await page.waitForFunction(
      `document.querySelectorAll('#task-trace-items .task-trace-item.is-focus').length === 1`,
    );
    check('Task 搜索命中处理消息可直接定位', true);
    await closeTrace(page);

    // 场景 10：命中处理消息的 focus_message_id。
    await runSearch(page, '独特处理命中词ZXQ', true);
    checkEqual('唯一处理命中只返回一个 Task', await taskSearchResultCount(page), 1);
    await searchDialog(page).locator('.task-search-result').first().click();
    await page.waitForFunction(
      (messageId: string) => {
        const focus = document.querySelector('#task-trace-items .task-trace-item.is-focus');
        return Boolean(focus && focus.getAttribute('data-message-id') === messageId);
      },
      pUnique,
    );
    checkEqual(
      'Trace 焦点定位到命中处理消息',
      await page.locator('#task-trace-items .task-trace-item.is-focus').getAttribute('data-message-id'),
      pUnique,
    );
    await closeTrace(page);

    // 普通消息搜索保持不变。
    await runSearch(page, '原始日志', false);
    checkEqual('普通搜索不渲染 Task 摘要', await taskSearchResultCount(page), 0);
    check(
      '普通搜索仍返回消息结果',
      (await searchDialog(page).locator('[data-results] button').count()) >= 1,
    );
    await closeSearch(page);

    // 场景 13：收起 Trace 保留聊天位置与草稿；切房不串数据。
    await page.locator('#body').fill(DRAFT_TEXT);
    // 先把起点摘要滚入视口，再记录位置；打开 Trace 不应再改变聊天滚动。
    await messageNode(page, r1).locator('.task-bar').scrollIntoViewIfNeeded();
    const scrollBefore = (await page.evaluate(
      `document.getElementById('messages').scrollTop`,
    )) as number;
    await openTraceFromBar(page, r1);
    await closeTrace(page);
    checkEqual('收起 Trace 后草稿保留', await page.locator('#body').inputValue(), DRAFT_TEXT);
    const scrollAfter = (await page.evaluate(
      `document.getElementById('messages').scrollTop`,
    )) as number;
    check('收起 Trace 后聊天位置保留', Math.abs(scrollAfter - scrollBefore) <= 24, {
      before: scrollBefore,
      after: scrollAfter,
    });

    await openTraceFromBar(page, r1);
    await page.evaluate((targetRoom: string) => {
      const scope = globalThis as unknown as {
        navigateTo: (path: string, options?: Record<string, unknown>) => void;
      };
      scope.navigateTo('/c/' + encodeURIComponent(targetRoom));
    }, roomC);
    await waitRoom(page, roomC, '切房验收群');
    checkEqual('切房自动关闭 Trace', await page.locator('#task-trace-drawer').isVisible(), false);
    checkEqual(
      '切房后 Trace 不保留上一房间消息',
      await page.locator('#task-trace-items .task-trace-item').count(),
      0,
    );
    checkEqual('切房后不渲染上一房间摘要', await page.locator('#messages .task-bar').count(), 0);

    await page.goto(`${base}/c/${roomA}`);
    await waitRoom(page, roomA, '消息 Task 验收群');
    checkEqual('切回房间恢复输入草稿', await page.locator('#body').inputValue(), DRAFT_TEXT);
    await waitForTaskBar(page, r1);
    check('切回房间摘要行仍按房间隔离', await messageNode(page, r1).locator('.task-bar').isVisible());

    // 场景 13：长 Trace 分页；focus 两侧游标。
    await page.goto(`${base}/c/${roomB}`);
    await waitRoom(page, roomB, '长 Trace 验收群');
    await runSearch(page, '长 Trace 起点', true);
    checkEqual('长 Trace 起点搜索只返回一个 Task', await taskSearchResultCount(page), 1);
    await searchDialog(page).locator('.task-search-result').first().click();
    await page.locator('#task-trace-drawer').waitFor({ state: 'visible' });
    await waitTraceCount(page, 50);
    checkEqual('长 Trace 首页只加载 50 条', await traceItemCount(page), 50);
    checkEqual('长 Trace 首页显示加载更晚', await page.locator('#task-trace-newer').isVisible(), true);
    await page.locator('#task-trace-newer').click();
    await waitTraceCount(page, 53);
    checkEqual('长 Trace 分页加载全部 53 条', await traceItemCount(page), 53);
    await closeTrace(page);
    await closeSearch(page);

    await runSearch(page, '长 Trace 处理 40', true);
    checkEqual('命中间处理消息只返回一个 Task', await taskSearchResultCount(page), 1);
    await searchDialog(page).locator('.task-search-result').first().click();
    await page.waitForFunction(
      (messageId: string) => {
        const focus = document.querySelector('#task-trace-items .task-trace-item.is-focus');
        return Boolean(focus && focus.getAttribute('data-message-id') === messageId);
      },
      longFocus,
    );
    checkEqual(
      '长 Trace focus 定位到第 40 条处理消息',
      await page.locator('#task-trace-items .task-trace-item.is-focus').getAttribute('data-message-id'),
      longFocus,
    );
    checkEqual('focus 模式显示加载更早', await page.locator('#task-trace-older').isVisible(), true);
    await page.locator('#task-trace-older').click();
    await waitTraceCount(page, 53);
    checkEqual('focus 模式可向更早分页', await traceItemCount(page), 53);
    await page.locator(
      `#task-trace-items .task-trace-item[data-message-id="${longFocus}"]`,
    ).click();
    await page.locator('#task-trace-drawer').waitFor({ state: 'hidden' });
    await page.waitForFunction(
      (messageId: string) => {
        const node = document.querySelector(`#messages [data-message-id="${messageId}"]`);
        return Boolean(node && node.classList.contains('task-message-flash'));
      },
      longFocus,
    );
    check('点击 Trace 消息回到聊天', true);
    await closeSearch(page);

    // 移动端暗色：单栏、无横向溢出、44px 触控目标、抽屉全屏。
    const mobile = await makeContext(
      browser,
      base,
      humanToken,
      allErrors,
      { width: 390, height: 844 },
      { colorScheme: 'dark', hasTouch: true },
    );
    try {
      const mobilePage = mobile.page;
      await mobilePage.goto(`${base}/c/${roomA}`);
      await waitRoom(mobilePage, roomA, '消息 Task 验收群');
      await waitForTaskBar(mobilePage, r1);
      const barMetrics = (await mobilePage.evaluate(
        (messageId: string) => {
          const bar = document.querySelector(
            `#messages [data-message-id="${messageId}"] .task-bar`,
          );
          const sidebar = document.querySelector('.sidebar');
          const rect = bar ? bar.getBoundingClientRect() : null;
          return {
            height: rect ? rect.height : 0,
            view: window.innerWidth,
            doc: document.documentElement.scrollWidth,
            sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : '',
            bodyClass: document.body.className,
          };
        },
        r1,
      )) as {
        height: number;
        view: number;
        doc: number;
        sidebarDisplay: string;
        bodyClass: string;
      };
      check('移动端 Task 摘要触控高度 >=44', barMetrics.height >= 44, barMetrics);
      check(
        '移动端 Task 页面单栏且不横向溢出',
        barMetrics.sidebarDisplay === 'none' &&
          barMetrics.doc <= barMetrics.view &&
          barMetrics.bodyClass.includes('page-room'),
        barMetrics,
      );
      await mobilePage.locator(`#messages [data-message-id="${r1}"] .task-bar`).click();
      await mobilePage.locator('#task-trace-drawer').waitFor({ state: 'visible' });
      const drawerMetrics = (await mobilePage.evaluate(`(() => {
        const card = document.querySelector('#task-trace-drawer .task-trace-card');
        const close = document.getElementById('task-trace-close');
        if (!card || !close) return null;
        const cardBox = card.getBoundingClientRect();
        const closeBox = close.getBoundingClientRect();
        return {
          width: cardBox.width,
          view: window.innerWidth,
          doc: document.documentElement.scrollWidth,
          background: getComputedStyle(card).backgroundColor,
          closeWidth: closeBox.width,
          closeHeight: closeBox.height
        };
      })()`)) as {
        width: number;
        view: number;
        doc: number;
        background: string;
        closeWidth: number;
        closeHeight: number;
      } | null;
      check('移动端 Trace 全屏且不横向溢出', Boolean(drawerMetrics) &&
        drawerMetrics!.width <= drawerMetrics!.view + 1 &&
        drawerMetrics!.doc <= drawerMetrics!.view, drawerMetrics);
      checkEqual('移动端暗色 Trace 使用暗色面板', drawerMetrics?.background, 'rgb(43, 43, 43)');
      check('移动端 Trace 关闭按钮 >=44px', Boolean(drawerMetrics) &&
        drawerMetrics!.closeWidth >= 44 && drawerMetrics!.closeHeight >= 44, drawerMetrics);
      await closeTrace(mobilePage);
    } finally {
      await mobile.context.close();
    }

    // 场景 14：非成员不能通过 Task 摘要窥视房间消息。
    const outsiderToken = crypto.randomUUID();
    await rawTool(outsiderToken, 'network_register', {
      request_id: id('reg'),
      kind: 'human',
      name: 'Task 外部人类',
    });
    const outsider = await makeContext(browser, base, outsiderToken, allErrors);
    try {
      await outsider.page.goto(`${base}/c/${roomA}`);
      await outsider.page.locator('#chat-error').waitFor({ state: 'visible', timeout: 15_000 });
      const errorText = (await outsider.page.locator('#chat-error-text').textContent()) ?? '';
      check(
        '非成员无法打开房间 Task',
        errorText.includes('不在') ||
          errorText.includes('成员') ||
          errorText.includes('会话') ||
          errorText.includes('NOT_MEMBER'),
        errorText,
      );
      checkEqual('非成员页面没有摘要行', await outsider.page.locator('#messages .task-bar').count(), 0);
    } finally {
      await outsider.context.close();
    }
  } finally {
    await context.close();
  }
}
