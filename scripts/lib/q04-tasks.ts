/**
 * Q04 任务生命周期：从消息建任务 → 接受 → 进度/阻塞/恢复 → 交接 →
 * 提交 → 退回 → 重新提交 → 验收通过；另含取消、失权冲突、执行未知、
 * failed 重试与交接包授权。
 *
 * failed 状态无法从 UI 自然到达，仅用 SQL 夹具注入 status=failed，
 * 后续“重试”仍走真实详情面板与 network_task_retry。
 */

import type { Browser, Page } from 'playwright';

import {
  acceptRoomInvites,
  check,
  checkEqual,
  makeContext,
  newRequestId,
  rawTool,
  screenshot,
  waitMessageText,
  waitRoom,
  waitText,
  withDb,
  type RoomView,
} from './q04-harness';
import type { Q04State } from './q04-fixture';

interface TaskView {
  task: {
    task_id: string;
    room_id: string;
    title: string;
    status: string;
    revision: number;
    owner_actor_id: string | null;
    owner_name?: string;
    reviewer_actor_id?: string | null;
    source_message_id?: string | null;
    blocked_reason?: string | null;
    current_submission?: {
      submission_id: string;
      version: number;
      status: string;
    } | null;
    assignment?: {
      assignment_id: string;
      assignment_version: number;
      status?: string;
    } | null;
    progress?: { percent: number | null; note: string } | null;
  };
}

async function taskByTitle(state: Q04State, roomId: string, title: string): Promise<TaskView['task']> {
  const page = await rawTool<{ tasks: TaskView['task'][] }>(state.tokens.u1, 'network_task_list', {
    room_id: roomId,
    limit: 100,
  });
  const task = page.tasks.find((item) => item.title === title);
  if (!task) throw new Error(`未找到任务 ${title}`);
  return task;
}

async function openTask(page: Page, title: string): Promise<void> {
  if (await page.locator('#task-detail-modal').isVisible()) {
    await page.locator('#task-detail-close').click();
    await page.locator('#task-detail-modal').waitFor({ state: 'hidden' });
  }
  await page.waitForFunction(
    `(() => {
      const toggle = document.getElementById('task-toggle');
      const label = document.getElementById('task-toggle-label');
      return Boolean(toggle && !toggle.hidden && label && /任务 \\d+\\/\\d+/.test(label.textContent || ''));
    })()`,
  );
  if (await page.locator('#task-popover').isHidden()) {
    // 任务摘要与房间任务列表是两个独立读取；列表未就绪时 openTaskPopover
    // 会安全地不打开。重复触发真实开关，直到房间任务加载完成。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await page.locator('#task-popover').isVisible()) break;
      await page.locator('#task-toggle').click();
      await page.waitForTimeout(150);
    }
    await page.locator('#task-popover').waitFor({ state: 'visible' });
  }
  const item = page.locator('#task-list .task-item').filter({ hasText: title }).first();
  await item.waitFor();
  await item.click();
  await page.locator('#task-detail-modal').waitFor({ state: 'visible' });
}

async function closeTaskDetails(page: Page): Promise<void> {
  if (await page.locator('#task-detail-modal').isVisible()) {
    await page.locator('#task-detail-close').click();
    await page.locator('#task-detail-modal').waitFor({ state: 'hidden' });
  }
}

async function createTaskViaApi(
  state: Q04State,
  input: {
    title: string;
    assignee?: string;
    reviewer?: string;
    description?: string;
    acceptance_criteria?: string;
    source_message_id?: string;
  },
): Promise<TaskView['task']> {
  const result = await rawTool<TaskView>(state.tokens.u1, 'network_task_create', {
    request_id: newRequestId('q04_task_create'),
    room_id: state.rooms.main,
    title: input.title,
    ...(input.assignee ? { assignee_actor_id: input.assignee } : {}),
    ...(input.reviewer ? { reviewer_actor_id: input.reviewer } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.acceptance_criteria ? { acceptance_criteria: input.acceptance_criteria } : {}),
    ...(input.source_message_id ? { source_message_id: input.source_message_id } : {}),
  });
  return result.task;
}

async function acceptTaskViaApi(
  state: Q04State,
  task: TaskView['task'],
  token = state.tokens.u2,
): Promise<void> {
  await rawTool(token, 'network_task_accept', {
    request_id: newRequestId('q04_task_accept'),
    task_id: task.task_id,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    expected_revision: task.revision,
  });
}

export async function runTaskUiHiddenAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 任务 UI 已按产品决定整体隐藏');
  const { context, page } = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    [],
  );
  try {
    await page.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(page, state.rooms.main, 'Q04 主验收群');
    checkEqual('Q04 任务切换隐藏', await page.locator('#task-toggle').isVisible(), false);
    checkEqual('Q04 我的任务隐藏', await page.locator('#my-tasks').isVisible(), false);
    checkEqual('Q04 新建任务隐藏', await page.locator('#task-create').isVisible(), false);
    checkEqual(
      'Q04 转为任务隐藏',
      await page.locator('#messages .msg-task-convert').count(),
      0,
    );
    checkEqual(
      'Q04 任务卡片隐藏',
      await page.locator('#messages .msg-task-card:visible, #messages .msg-task-link:visible').count(),
      0,
    );
  } finally {
    await context.close();
  }
}

export async function runTaskAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 任务：消息转任务、接受、进度、交接、提交、退回、验收');
  const creatorContext = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  const workerContext = await makeContext(
    browser,
    state.tokens.u2,
    { width: 1280, height: 900 },
    state.errors,
  );
  const reviewerContext = await makeContext(
    browser,
    state.tokens.u3,
    { width: 1280, height: 900 },
    state.errors,
  );
  const creator = creatorContext.page;
  const worker = workerContext.page;
  const reviewer = reviewerContext.page;
  const title = 'Q04 验收报告任务';
  try {
    await creator.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    const sourceText = `Q04 任务来源消息 ${Date.now()}`;
    await creator.fill('#body', sourceText);
    await creator.locator('#send').click();
    await waitMessageText(creator, sourceText);
    await creator.waitForFunction(`document.querySelectorAll('#messages .msg-outbox').length === 0`);

    const sourceMessage = creator
      .locator('#messages .msg')
      .filter({ hasText: sourceText })
      .first();
    await sourceMessage.hover();
    checkEqual(
      '消息不再显示转为任务入口',
      await sourceMessage.locator('.msg-task-convert').count(),
      0,
    );
    checkEqual('群头部不再显示新建任务', await creator.locator('#task-create').isVisible(), false);
    const sourceMessageId = await sourceMessage.getAttribute('data-message-id');
    const created = await createTaskViaApi(state, {
      title,
      assignee: state.actors.u2.actor_id,
      reviewer: state.actors.u3.actor_id,
      description: '生成 Q04 验收报告并给出证据',
      acceptance_criteria: '报告可打开；验收清单逐项通过',
      source_message_id: sourceMessageId ?? undefined,
    });
    await creator.reload();
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    await openTask(creator, title);
    let task = await taskByTitle(state, state.rooms.main, title);
    check('API 建任务绑定来源消息', Boolean(task.source_message_id), task);
    checkEqual('API 建任务进入待接手', task.status, 'offered');
    checkEqual('API 建任务任务 ID 一致', task.task_id, created.task_id);
    await closeTaskDetails(creator);

    // U2 接受并更新进度、报告阻塞、恢复。
    await worker.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(worker, state.rooms.main, 'Q04 主验收群');
    await openTask(worker, title);
    await worker.locator('#task-detail-actions button').filter({ hasText: '接受任务' }).click();
    await worker.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '进行中'`,
    );
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('UI 接受后服务端 in_progress', task.status, 'in_progress');
    await screenshot(worker, 'q04-task-accepted-light-1280');
    await worker
      .locator('#task-detail-actions input[aria-label="进度说明（可选）"]')
      .fill('Q04 已完成资料收集');
    await worker.locator('#task-detail-actions input[aria-label="进度百分比"]').fill('55');
    await worker.locator('#task-detail-actions button').filter({ hasText: '更新进度' }).click();
    await worker.waitForFunction(
      `(() => {
        const bar = document.querySelector('#task-detail-body .task-progress-bar');
        return Boolean(bar && bar.getAttribute('aria-valuenow') === '55');
      })()`,
    );
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('UI 进度写入 55%', task.progress?.percent, 55);
    await worker
      .locator('#task-detail-actions input[aria-label="阻塞原因"]')
      .fill('Q04 等待外部材料');
    await worker.locator('#task-detail-actions button').filter({ hasText: '报告阻塞' }).click();
    await worker.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '受阻'`,
    );
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('UI 报告阻塞后 blocked', task.status, 'blocked');
    checkEqual('UI 阻塞原因持久化', task.blocked_reason, 'Q04 等待外部材料');
    await screenshot(worker, 'q04-task-blocked-light-1280');
    await worker
      .locator('#task-detail-actions input[aria-label="恢复说明（可选）"]')
      .fill('Q04 材料已到');
    await worker.locator('#task-detail-actions button').filter({ hasText: '恢复执行' }).click();
    await worker.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '进行中'`,
    );
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('UI 恢复后 in_progress', task.status, 'in_progress');

    // U2 发起交接给 U1，U1 在详情接受。
    await worker.locator('#task-transfer-panel select.task-transfer-target').selectOption(
      state.actors.u1.actor_id,
    );
    await worker.locator('#task-transfer-panel .task-transfer-note-input').fill('Q04 交接说明');
    await worker.locator('#task-transfer-panel button').filter({ hasText: '发起交接' }).click();
    await waitText(worker, '#task-transfer-panel', '待接受');
    const proposal = await rawTool<{ transfers: { transfer_id: string; status: string }[] }>(
      state.tokens.u1,
      'network_task_transfer_list',
      { task_id: task.task_id, limit: 20 },
    );
    check(
      '交接提议待接受',
      proposal.transfers.some((item) => item.status === 'pending'),
      proposal.transfers,
    );
    await closeTaskDetails(worker);

    await creator.reload();
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    await openTask(creator, title);
    await creator.locator('#task-transfer-panel button').filter({ hasText: '接受交接' }).click();
    await creator.waitForFunction(
      `document.querySelectorAll('#task-transfer-panel .task-transfer-badge-pending').length === 0`,
    );
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('接受交接后负责人为 U1', task.owner_actor_id, state.actors.u1.actor_id);
    checkEqual('接受交接后 assignment_version=2', task.assignment?.assignment_version, 2);
    await screenshot(creator, 'q04-task-transferred-light-1280');

    // 交接包：跨范围材料先 omitted，UI 授权后 available。
    const sourceRoom = await rawTool<RoomView>(state.tokens.u1, 'network_room_create', {
      request_id: newRequestId('q04_handoff_room'),
      kind: 'group',
      title: 'Q04 交接源范围',
      members: [state.actors.u2.actor_id, state.actors.u3.actor_id],
    });
    state.rooms.handoff = sourceRoom.room.room_id;
    await acceptRoomInvites(state.tokens.u2, state.rooms.handoff);
    await acceptRoomInvites(state.tokens.u3, state.rooms.handoff);
    const handoffMessage = await rawTool<{ message: { message_id: string } }>(
      state.tokens.u1,
      'network_message_send',
      {
        request_id: newRequestId('q04_handoff_message'),
        client_message_id: crypto.randomUUID(),
        room_id: state.rooms.handoff,
        body: 'Q04 跨范围交接材料',
      },
    );
    task = await taskByTitle(state, state.rooms.main, title);
    if (!task.assignment) throw new Error('交接后缺少 assignment');
    const pack = await rawTool<{ pack: { pack_id: string; version: number; context_ready: boolean } }>(
      state.tokens.u1,
      'network_task_handoff_pack_create',
      {
        request_id: newRequestId('q04_handoff_pack'),
        task_id: task.task_id,
        assignment_id: task.assignment.assignment_id,
        assignment_version: task.assignment.assignment_version,
        expected_revision: task.revision,
        goal: 'Q04 交接包验收',
        completed: ['生成版本化交接包'],
        current_result: { summary: '等待跨范围材料授权' },
        next_steps: ['授权源范围消息'],
        source_room_id: state.rooms.handoff,
        items: [
          {
            kind: 'message',
            ref: handoffMessage.message.message_id,
            label: '跨范围交接材料',
            source_room_id: state.rooms.handoff,
            required: true,
          },
        ],
      },
    );
    checkEqual('交接包首版 v1', pack.pack.version, 1);
    checkEqual('交接包初始不完整', pack.pack.context_ready, false);
    await openTask(creator, title);
    await creator.waitForFunction(
      `(() => {
        const panel = document.getElementById('task-handoff-panel');
        return Boolean(panel && panel.innerText.includes('v1') && panel.innerText.includes('未授权'));
      })()`,
    );
    await creator
      .locator('#task-handoff-panel button')
      .filter({ hasText: '授权给接任者' })
      .click();
    await creator.waitForFunction(
      `(() => {
        const panel = document.getElementById('task-handoff-panel');
        return Boolean(panel && panel.querySelector('.task-handoff-item-available') &&
          panel.querySelector('.task-handoff-readiness-ready'));
      })()`,
    );
    const packAfter = await rawTool<{ pack: { context_ready: boolean; items: { status: string }[] } }>(
      state.tokens.u1,
      'network_task_handoff_pack_get',
      { task_id: task.task_id },
    );
    checkEqual('UI 授权后交接包完整', packAfter.pack.context_ready, true);
    checkEqual('UI 授权后引用可用', packAfter.pack.items[0]?.status, 'available');

    // 提交 v1。
    await creator.locator('#task-detail-actions button').filter({ hasText: '提交成果' }).click();
    await creator.locator('#task-submit-modal').waitFor({ state: 'visible' });
    await creator.fill('#task-submit-summary', 'Q04 成果 v1 摘要');
    await creator.fill('#task-submit-evidence', 'Q04 证据：真实浏览器操作');
    await creator.locator('#task-submit-form button[type="submit"]').click();
    await creator.locator('#task-submit-modal').waitFor({ state: 'hidden' });
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('提交后任务 submitted', task.status, 'submitted');
    checkEqual('提交版本 v1', task.current_submission?.version, 1);
    await screenshot(creator, 'q04-task-submitted-light-1280');
    await closeTaskDetails(creator);

    // 验收人退回 v1，任务回到新 assignment 的 in_progress。
    await reviewer.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(reviewer, state.rooms.main, 'Q04 主验收群');
    await openTask(reviewer, title);
    await reviewer.locator('#task-detail-actions input[aria-label="退回原因"]').fill('Q04 缺少复核命令');
    await reviewer.locator('#task-detail-actions button').filter({ hasText: '退回 v1' }).click();
    await reviewer.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '进行中'`,
    );
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('退回后任务 in_progress', task.status, 'in_progress');
    checkEqual('退回后旧提交 returned', task.current_submission?.status, 'returned');
    checkEqual('退回后 assignment_version=3', task.assignment?.assignment_version, 3);
    await closeTaskDetails(reviewer);

    // 重新提交 v2。
    await creator.reload();
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    await openTask(creator, title);
    await creator.locator('#task-detail-actions button').filter({ hasText: '提交成果' }).click();
    await creator.locator('#task-submit-modal').waitFor({ state: 'visible' });
    await creator.fill('#task-submit-summary', 'Q04 成果 v2 摘要');
    await creator.fill('#task-submit-evidence', 'Q04 证据：复核命令与截图');
    await creator.locator('#task-submit-form button[type="submit"]').click();
    await creator.locator('#task-submit-modal').waitFor({ state: 'hidden' });
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('重新提交版本 v2', task.current_submission?.version, 2);
    checkEqual('重新提交后 submitted', task.status, 'submitted');
    await closeTaskDetails(creator);

    // 验收：未通过项不能通过；逐项勾选后 accepted。
    await reviewer.reload();
    await waitRoom(reviewer, state.rooms.main, 'Q04 主验收群');
    await openTask(reviewer, title);
    await reviewer.locator('#task-detail-actions button').filter({ hasText: /验收通过 v2/u }).click();
    await reviewer.locator('#task-review-modal').waitFor({ state: 'visible' });
    const firstCheckbox = reviewer.locator('#task-review-checklist input[type="checkbox"]').first();
    await firstCheckbox.uncheck();
    await reviewer.locator('#task-review-form button[type="submit"]').click();
    await reviewer.waitForFunction(
      `(document.getElementById('task-review-error').textContent || '').includes('未通过')`,
    );
    check('存在未通过项时禁止验收通过', true);
    await firstCheckbox.check();
    await reviewer.locator('#task-review-form button[type="submit"]').click();
    await reviewer.locator('#task-review-modal').waitFor({ state: 'hidden' });
    task = await taskByTitle(state, state.rooms.main, title);
    checkEqual('逐项验收后任务 accepted', task.status, 'accepted');
    checkEqual('验收绑定 v2', task.current_submission?.status, 'accepted');
    await screenshot(reviewer, 'q04-task-review-accepted-light-1280');
    await closeTaskDetails(reviewer);

    // 取消：必须填写原因；成功后服务端 cancelled。
    const cancelTask = await createTaskViaApi(state, {
      title: 'Q04 取消任务',
      reviewer: state.actors.u3.actor_id,
    });
    await creator.reload();
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    await openTask(creator, cancelTask.title);
    await creator.locator('#task-detail-actions button').filter({ hasText: '取消任务' }).click();
    await waitText(creator, '#task-detail-actions .form-error', '请填写取消原因');
    await creator.locator('#task-detail-actions input[aria-label="取消原因"]').fill('Q04 主动取消');
    await creator.locator('#task-detail-actions button').filter({ hasText: '取消任务' }).click();
    await creator.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '已取消'`,
    );
    const cancelled = await taskByTitle(state, state.rooms.main, cancelTask.title);
    checkEqual('取消后服务端 cancelled', cancelled.status, 'cancelled');
    await closeTaskDetails(creator);

    // 领取冲突：详情已加载后被 Agent 抢单，网页领取必须显示真实负责人。
    const conflictTask = await createTaskViaApi(state, {
      title: 'Q04 领取冲突任务',
      reviewer: state.actors.u3.actor_id,
    });
    await creator.reload();
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    await openTask(creator, conflictTask.title);
    // 断开实时刷新，让页面保留旧 revision，领取必然与 U2 的成功领取冲突。
    await creator.evaluate(`(() => { window.__failStreams = true; window.__abortStream(); })()`);
    await rawTool(state.tokens.u2, 'network_task_claim', {
      request_id: newRequestId('q04_conflict_claim'),
      task_id: conflictTask.task_id,
    });
    await creator.locator('#task-detail-actions button').filter({ hasText: '领取任务' }).click();
    await creator.waitForFunction(
      `(() => {
        const error = document.querySelector('#task-detail-actions .form-error');
        return Boolean(error && error.innerText.includes(${JSON.stringify(state.actors.u2.name)}));
      })()`,
    );
    await creator.evaluate(`window.__failStreams = false;`);
    const conflictActual = await taskByTitle(state, state.rooms.main, conflictTask.title);
    checkEqual('冲突后服务端负责人不变', conflictActual.owner_actor_id, state.actors.u2.actor_id);
    await closeTaskDetails(creator);
    await rawTool(state.tokens.u1, 'network_task_cancel', {
      request_id: newRequestId('q04_conflict_cancel'),
      task_id: conflictTask.task_id,
      reason: '冲突用例结束',
    });

    // 执行未知 → 对账恢复。
    const unknownTask = await createTaskViaApi(state, {
      title: 'Q04 执行未知任务',
      assignee: state.actors.u2.actor_id,
      reviewer: state.actors.u1.actor_id,
    });
    await acceptTaskViaApi(state, unknownTask);
    await worker.reload();
    await waitRoom(worker, state.rooms.main, 'Q04 主验收群');
    await openTask(worker, unknownTask.title);
    await worker.locator('#task-detail-actions input[aria-label="外部 action_id"]').fill('q04-action-1');
    await worker.locator('#task-detail-actions input[aria-label="结果未知原因"]').fill('Q04 响应丢失');
    await worker.locator('#task-detail-actions button').filter({ hasText: '标记执行未知' }).click();
    await worker.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '受阻'`,
    );
    const unknownState = await taskByTitle(state, state.rooms.main, unknownTask.title);
    checkEqual('执行未知后 blocked', unknownState.status, 'blocked');
    checkEqual('执行未知原因保留', unknownState.blocked_reason, 'execution_unknown');
    await worker.locator('#task-detail-actions input[aria-label="待对账 action_id"]').fill('q04-action-1');
    await worker.locator('#task-detail-actions select[aria-label="对账结论"]').selectOption('not_executed');
    await worker
      .locator('#task-detail-actions input[aria-label="查询或人工结论证据"]')
      .fill('Q04 查询确认未执行');
    await worker.locator('#task-detail-actions button').filter({ hasText: '记录对账结论' }).click();
    await worker.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '进行中'`,
    );
    const resolved = await taskByTitle(state, state.rooms.main, unknownTask.title);
    checkEqual('对账未执行后恢复 in_progress', resolved.status, 'in_progress');
    await closeTaskDetails(worker);
    await rawTool(state.tokens.u1, 'network_task_cancel', {
      request_id: newRequestId('q04_unknown_cancel'),
      task_id: unknownTask.task_id,
      reason: '未知用例结束',
    });

    // failed 重试：SQL 仅注入终态，重试仍走 UI + network_task_retry。
    const retryTask = await createTaskViaApi(state, {
      title: 'Q04 重试任务',
      assignee: state.actors.u2.actor_id,
      reviewer: state.actors.u1.actor_id,
    });
    await acceptTaskViaApi(state, retryTask);
    withDb(state.dbPath, (db) => {
      db.prepare(
        "UPDATE tasks SET status = 'failed', revision = revision + 1, updated_at = ? WHERE task_id = ?",
      ).run(Date.now(), retryTask.task_id);
    });
    await creator.reload();
    await waitRoom(creator, state.rooms.main, 'Q04 主验收群');
    await openTask(creator, retryTask.title);
    await creator.locator('#task-detail-actions input[aria-label="重试原因"]').fill('Q04 失败后重试');
    await creator
      .locator('#task-detail-actions select[aria-label="重新指派给"]')
      .selectOption(state.actors.u2.actor_id);
    await creator.locator('#task-detail-actions button').filter({ hasText: '重试任务' }).click();
    await creator.waitForFunction(
      `document.querySelector('#task-detail-body .task-status')?.textContent === '待接手'`,
    );
    const retried = await taskByTitle(state, state.rooms.main, retryTask.title);
    checkEqual('failed 重试后 offered', retried.status, 'offered');
    checkEqual('failed 重试递增 assignment_version', retried.assignment?.assignment_version, 2);
    await closeTaskDetails(creator);
    await rawTool(state.tokens.u1, 'network_task_cancel', {
      request_id: newRequestId('q04_retry_cancel'),
      task_id: retryTask.task_id,
      reason: '重试用例结束',
    });
  } finally {
    await creatorContext.context.close();
    await workerContext.context.close();
    await reviewerContext.context.close();
  }
}
