/**
 * Q04 Agent 管理：新建（夹具已走 UI）、认领（MCP 明确入口）、停用/归档、
 * 管理权交接、旧管理者失权、旧 token 失效与在途任务 blocked。
 */

import type { Browser, Page } from 'playwright';

import {
  check,
  checkEqual,
  makeContext,
  newRequestId,
  rawTool,
  rawToolError,
  roomLink,
  sleep,
  waitRoom,
  waitText,
  type RoomView,
} from './q04-harness';
import type { Q04State } from './q04-fixture';

function parseTokenFromMcpUrl(value: string): string {
  try {
    const token = new URL(value).searchParams.get('token');
    if (token) return token;
  } catch {
    // 相对 URL 回退
  }
  const match = value.match(/[?&]token=([^&]+)/u);
  if (!match) throw new Error('交接面板未返回 token');
  return decodeURIComponent(match[1]!);
}

async function acceptDialogOnce(page: Page): Promise<string> {
  return new Promise((resolve) => {
    page.once('dialog', async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
}

export async function runAgentAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 Agent 管理：停用/归档、管理权交接、旧凭据失效');
  const managerContext = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    const page = managerContext.page;
    await page.goto(`${state.base}/`);
    await page.locator('#room-list .room-item').first().waitFor();
    await page.locator('#room-filter-agent').click();

    // 停用 B3：确认框、菜单状态与服务端凭据失效。
    await page.locator(roomLink(state.rooms.directU1B3)).click({ button: 'right' });
    await page.locator('#room-menu').waitFor({ state: 'visible' });
    checkEqual('direct Agent 菜单显示停用', await page.locator('#room-menu-toggle-disabled').isVisible(), true);
    const disablePromise = acceptDialogOnce(page);
    await page.locator('#room-menu-toggle-disabled').click();
    const disableCopy = await disablePromise;
    check(
      '停用确认说明任务不会被标记完成',
      disableCopy.includes('待处理任务不会标记完成') || disableCopy.includes('未完成任务'),
      disableCopy,
    );
    await waitText(page, '#toast', '已停用');
    const disabledCredential = await rawToolError(state.tokens.b3, 'network_me', {});
    check(
      '停用后旧 token 被拒绝或降权',
      ['CREDENTIAL_INVALID', 'ACTOR_DISABLED', 'PERMISSION_DENIED'].includes(disabledCredential.code),
      disabledCredential,
    );
    const disabledWrite = await rawToolError(state.tokens.b3, 'network_message_send', {
      request_id: newRequestId('q04_disabled_send'),
      client_message_id: crypto.randomUUID(),
      room_id: state.rooms.directU1B3,
      body: 'Q04 停用后不应发送',
    });
    check(
      '停用后写入被拒绝',
      ['ACTOR_DISABLED', 'CREDENTIAL_INVALID', 'PERMISSION_DENIED'].includes(disabledWrite.code),
      disabledWrite,
    );

    // 启用回来再归档，验证两个状态入口。
    if (await page.locator('#room-menu').isHidden()) {
      await page.locator(roomLink(state.rooms.directU1B3)).click({ button: 'right' });
      await page.locator('#room-menu').waitFor({ state: 'visible' });
    }
    const enablePromise = null;
    await page.locator('#room-menu-toggle-disabled').click();
    void enablePromise;
    await waitText(page, '#toast', '已启用');
    if (await page.locator('#room-menu').isHidden()) {
      await page.locator(roomLink(state.rooms.directU1B3)).click({ button: 'right' });
      await page.locator('#room-menu').waitFor({ state: 'visible' });
    }
    await page.locator('#room-menu-archive').click();
    await waitText(page, '#toast', '已归档');
    await page.locator('#archived-agents').click();
    await page.locator('#archive-popover').waitFor({ state: 'visible' });
    await page.waitForFunction(
      `(() => Array.from(document.querySelectorAll('#archive-popover-list .archive-item'))
        .some((node) => node.innerText.includes(${JSON.stringify(state.actors.b3.name)})))()`,
    );
    check('归档后出现在已归档 Agents 浮层', true);
    await page.locator('#archive-popover-close').click();

    // B1 任务在途时交接管理权给 U3。
    const b1Task = await rawTool<{ task: { task_id: string; assignment: { assignment_id: string } | null } }>(
      state.tokens.u1,
      'network_task_create',
      {
        request_id: newRequestId('q04_b1_task'),
        room_id: state.rooms.main,
        title: 'Q04 Agent 在途任务',
        assignee_actor_id: state.actors.b1.actor_id,
        reviewer_actor_id: state.actors.u3.actor_id,
      },
    );
    await rawTool(state.tokens.b1, 'network_task_accept', {
      request_id: newRequestId('q04_b1_task_accept'),
      task_id: b1Task.task.task_id,
      ...(b1Task.task.assignment ? { assignment_id: b1Task.task.assignment.assignment_id } : {}),
    });
    await page.locator('#room-filter-agent').click();
    await page.locator(roomLink(state.rooms.directU1B1)).click({ button: 'right' });
    await page.locator('#room-menu').waitFor({ state: 'visible' });
    checkEqual('direct Agent 菜单显示管理权交接', await page.locator('#room-menu-transfer').isVisible(), true);
    await page.locator('#room-menu-transfer').click();
    await page.locator('#transfer-modal').waitFor({ state: 'visible' });
    await page.waitForFunction(`document.getElementById('transfer-loading').hidden === true`);
    await page.waitForFunction(
      `document.querySelector('#transfer-successors input[value="${state.actors.u3.actor_id}"]') !== null`,
    );
    await page.evaluate(
      `(() => {
        const input = document.querySelector('#transfer-successors input[value="${state.actors.u3.actor_id}"]');
        if (!input) throw new Error('successor missing');
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await page.locator('#transfer-propose').click();
    await waitText(page, '#transfer-status', '已发起交接');

    const successorContext = await makeContext(
      browser,
      state.tokens.u3,
      { width: 1280, height: 900 },
      state.errors,
    );
    try {
      const successor = successorContext.page;
      await successor.goto(`${state.base}/`);
      await successor.locator('#room-list').waitFor();
      await successor.evaluate(
        (actorId) => (window as unknown as { openTransferDialog: (id: string) => void }).openTransferDialog(actorId),
        state.actors.b1.actor_id,
      );
      await successor.locator('#transfer-modal').waitFor({ state: 'visible' });
      await successor.waitForFunction(`document.getElementById('transfer-loading').hidden === true`);
      await successor.waitForFunction(`document.getElementById('transfer-accept').hidden === false`);
      const acceptPromise = acceptDialogOnce(successor);
      await successor.locator('#transfer-accept').click();
      const acceptCopy = await acceptPromise;
      check(
        '接受交接确认说明旧管理者失权、旧 token 失效',
        acceptCopy.includes('原管理者立即失权') && acceptCopy.includes('旧运行 token 失效'),
        acceptCopy,
      );
      await successor.waitForFunction(`document.getElementById('transfer-token-panel').hidden === false`);
      const newMcpUrl = await successor.locator('#transfer-token').inputValue();
      const newToken = parseTokenFromMcpUrl(newMcpUrl);
      check('交接后一次性展示新 MCP URL', newMcpUrl.includes('/mcp?token='));
      await successor.locator('#transfer-close').click();
      checkEqual('关闭后 DOM 清除新 token', await successor.locator('#transfer-token').inputValue(), '');

      const newIdentity = await rawTool<{ actor_id: string; name: string }>(newToken, 'network_me', {});
      checkEqual('新 token 仍是同一个 Agent', newIdentity.actor_id, state.actors.b1.actor_id);
      const oldToken = await rawToolError(state.tokens.b1, 'network_me', {});
      checkEqual('旧运行 token 立即失效', oldToken.code, 'CREDENTIAL_INVALID');
      const oldManager = await rawToolError(state.tokens.u1, 'network_agent_management_get', {
        actor_id: state.actors.b1.actor_id,
      });
      checkEqual('旧管理者读取管理关系被拒绝', oldManager.code, 'PERMISSION_DENIED');
      const oldManagerDisable = await rawToolError(state.tokens.u1, 'network_agent_disable', {
        request_id: newRequestId('q04_old_manager_disable'),
        actor_id: state.actors.b1.actor_id,
      });
      check(
        '旧管理者不能停用 Agent',
        ['PERMISSION_DENIED', 'NOT_FOUND'].includes(oldManagerDisable.code),
        oldManagerDisable,
      );
      const newManager = await rawTool<{ my_role: string }>(
        state.tokens.u3,
        'network_agent_management_get',
        { actor_id: state.actors.b1.actor_id },
      );
      checkEqual('接任者成为 manager', newManager.my_role, 'manager');
      const blockedTask = await rawTool<{
        task: { status: string; blocked_reason: string | null; owner_actor_id: string | null };
      }>(state.tokens.u1, 'network_task_get', { task_id: b1Task.task.task_id });
      checkEqual('交接后在途任务 blocked', blockedTask.task.status, 'blocked');
      checkEqual('交接后任务解除负责人', blockedTask.task.owner_actor_id, null);
      checkEqual('交接阻塞原因 management_transferred', blockedTask.task.blocked_reason, 'management_transferred');
    } finally {
      await successorContext.context.close();
    }
    await page.locator('#transfer-close').click();

    // 停用/归档后服务端状态对账（B3）。
    const managed = await rawTool<{ items: { actor_id: string; status?: string; archived?: boolean }[] }>(
      state.tokens.u1,
      'network_agents_managed_list',
      { limit: 100 },
    );
    check(
      '默认管理列表隐藏归档 Agent',
      !managed.items.some((item) => item.actor_id === state.actors.b3.actor_id),
      managed.items,
    );
    const managedWithArchived = await rawTool<{
      items: { actor_id: string; status?: string; archived?: boolean }[];
    }>(state.tokens.u1, 'network_agents_managed_list', { limit: 100, include_archived: true });
    const b3State = managedWithArchived.items.find(
      (item) => item.actor_id === state.actors.b3.actor_id,
    );
    check(
      'include_archived 管理列表可见归档 Agent 且带状态',
      b3State?.archived === true,
      b3State,
    );
    await sleep(50);
  } finally {
    await managerContext.context.close();
  }
}
