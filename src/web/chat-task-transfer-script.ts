/**
 * 任务交接：待处理提议、发起/接受/拒绝/撤回入口。
 *
 * 与 `chat-tasks-script.ts` 拼进同一个 `<script>` 共享作用域；拆出只为控制
 * 单文件行数。权限由服务端返回的 `can_accept` / `can_reject` / `can_cancel`
 * 决定，前端只对“发起交接”做与服务端同口径的展示性判断；最终仍以工具
 * 返回的错误码为准。接受交接不改变任务状态，只更换负责人。
 */

export const CHAT_TASK_TRANSFER_SCRIPT = `
let taskTransferLoadSeq = 0;
const TASK_TRANSFER_STATUS_LABELS = {
  pending: '待接受',
  accepted: '已接受',
  rejected: '已拒绝',
  cancelled: '已撤回',
  expired: '已过期'
};

function taskTransferStatusLabel(transfer) {
  const status = transfer && transfer.effective_status
    ? transfer.effective_status
    : transfer && transfer.status;
  return TASK_TRANSFER_STATUS_LABELS[status] || String(status || '未知');
}

function taskTransferStatusClass(transfer) {
  const status = transfer && transfer.effective_status
    ? transfer.effective_status
    : transfer && transfer.status;
  return status || 'pending';
}

function taskTransferCanPropose(task) {
  if (!task || !identity || !room || room.room_id !== task.room_id) return false;
  if (task.status !== 'in_progress' && task.status !== 'blocked') return false;
  if (!task.assignment || task.assignment.status !== 'active') return false;
  if (task.assignment.owner_actor_id !== task.owner_actor_id) return false;
  if (task.created_by === identity.actor_id) return true;
  if (task.owner_actor_id === identity.actor_id) return true;
  return room.my_role === 'owner' || room.my_role === 'admin';
}

function taskTransferTargets(task) {
  const result = [];
  for (const member of members.values()) {
    if (!identity || member.actor_id === identity.actor_id) continue;
    if (member.actor_id === task.owner_actor_id) continue;
    if (member.actor_id === task.reviewer_actor_id) continue;
    result.push(member);
  }
  return result;
}

function taskTransferError(panel) {
  return panel ? panel.querySelector('.task-transfer-error') : null;
}

async function resetTaskAfterTransfer(task) {
  try {
    await openTaskDetail(task.task_id);
  } catch (error) {
    // 写操作已成功；详情刷新失败时保留当前面板，由下一次打开恢复。
  }
  await loadTaskSummary().catch(function () {});
  if (activeRoomId === task.room_id) {
    loadRoomTasks(activeRoomId, roomEpoch);
  }
  syncTaskCardMarkers(messagesElement);
}

async function runTaskTransfer(panel, task, action, failureLabel) {
  const buttons = panel.querySelectorAll('button');
  buttons.forEach(function (button) { button.disabled = true; });
  const error = taskTransferError(panel);
  if (error) error.textContent = '';
  try {
    await action();
    await resetTaskAfterTransfer(task);
  } catch (caught) {
    const code = caught && caught.code ? String(caught.code) : '';
    const message = failureLabel + '：' + (caught && caught.message ? caught.message : caught);
    if (
      code === 'ASSIGNMENT_STALE' ||
      code === 'VERSION_CONFLICT' ||
      code === 'CONFLICT' ||
      code === 'REQUEST_EXPIRED' ||
      code === 'IDEMPOTENCY_CONFLICT' ||
      code === 'TOKEN_NOT_REPLAYABLE'
    ) {
      await resetTaskAfterTransfer(task);
      const freshError = document.getElementById('task-transfer-panel') &&
        taskTransferError(document.getElementById('task-transfer-panel'));
      if (freshError) freshError.textContent = message;
      return;
    }
    buttons.forEach(function (button) { button.disabled = false; });
    if (error) error.textContent = message;
  }
}

function taskTransferItem(task, transfer, panel) {
  const item = document.createElement('li');
  const statusClass = taskTransferStatusClass(transfer);
  item.className = 'task-transfer-item task-transfer-' + statusClass;

  const head = document.createElement('div');
  head.className = 'task-transfer-head';
  const title = document.createElement('strong');
  title.textContent =
    (transfer.from_owner_name || transfer.from_owner_actor_id || '当前负责人') +
    ' → ' +
    (transfer.to_actor_name || transfer.to_actor_id);
  const badge = document.createElement('span');
  badge.className = 'task-transfer-badge task-transfer-badge-' + statusClass;
  badge.textContent = taskTransferStatusLabel(transfer);
  head.append(title, badge);
  item.append(head);

  const meta = document.createElement('div');
  meta.className = 'task-transfer-meta';
  const bits = [];
  const proposer = transfer.requested_by_name || transfer.requested_by;
  if (proposer) bits.push('发起人：' + proposer);
  if (transfer.effective_status === 'pending') {
    bits.push('有效期至 ' + fullTime(transfer.expires_at));
  } else if (transfer.responded_at) {
    bits.push('处理时间 ' + fullTime(transfer.responded_at));
  } else {
    bits.push('创建于 ' + fullTime(transfer.created_at));
  }
  meta.textContent = bits.join(' · ');
  item.append(meta);

  if (transfer.note) {
    const note = document.createElement('div');
    note.className = 'task-transfer-note';
    note.textContent = transfer.note;
    item.append(note);
  }

  if (!transfer.can_accept && !transfer.can_reject && !transfer.can_cancel) {
    return item;
  }

  const controls = document.createElement('div');
  controls.className = 'row modal-actions task-transfer-actions';
  let reason = null;
  if (transfer.can_reject || transfer.can_cancel) {
    reason = document.createElement('input');
    reason.type = 'text';
    reason.className = 'task-cancel-reason task-transfer-reason';
    reason.maxLength = 300;
    reason.placeholder = '原因（可选）';
    reason.setAttribute('aria-label', '交接处理原因');
  }

  if (transfer.can_accept) {
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = '接受交接';
    accept.addEventListener('click', function () {
      const args = {
        request_id: requestId('task_transfer_accept'),
        transfer_id: transfer.transfer_id,
        expected_revision: task.revision
      };
      if (transfer.from_assignment_version) {
        args.from_assignment_version = transfer.from_assignment_version;
      }
      runTaskTransfer(panel, task, function () {
        return callTool('network_task_transfer_accept', args);
      }, '接受交接失败');
    });
    controls.append(accept);
  }

  if (transfer.can_reject) {
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger';
    reject.textContent = '拒绝交接';
    reject.addEventListener('click', function () {
      const args = {
        request_id: requestId('task_transfer_reject'),
        transfer_id: transfer.transfer_id
      };
      if (reason && reason.value.trim()) args.reason = reason.value.trim();
      runTaskTransfer(panel, task, function () {
        return callTool('network_task_transfer_reject', args);
      }, '拒绝交接失败');
    });
    controls.append(reject);
  }

  if (transfer.can_cancel) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '撤回提议';
    cancel.addEventListener('click', function () {
      const args = {
        request_id: requestId('task_transfer_cancel'),
        transfer_id: transfer.transfer_id
      };
      if (reason && reason.value.trim()) args.reason = reason.value.trim();
      runTaskTransfer(panel, task, function () {
        return callTool('network_task_transfer_cancel', args);
      }, '撤回交接失败');
    });
    controls.append(cancel);
  }

  if (reason) controls.append(reason);
  item.append(controls);
  return item;
}

function taskTransferProposeForm(task, panel) {
  const form = document.createElement('div');
  form.className = 'task-transfer-propose';

  const select = document.createElement('select');
  select.className = 'task-offer-select task-transfer-target';
  select.setAttribute('aria-label', '选择接任者');
  const targets = taskTransferTargets(task);
  for (const member of targets) {
    const option = document.createElement('option');
    option.value = member.actor_id;
    option.textContent = member.name;
    select.append(option);
  }

  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'task-cancel-reason task-transfer-note-input';
  note.maxLength = 2000;
  note.placeholder = '交接说明（可选）';
  note.setAttribute('aria-label', '交接说明');

  const propose = document.createElement('button');
  propose.type = 'button';
  propose.textContent = '发起交接';
  propose.addEventListener('click', function () {
    if (targets.length === 0) {
      const error = taskTransferError(panel);
      if (error) error.textContent = '没有可接任的成员';
      return;
    }
    const args = {
      request_id: requestId('task_transfer_propose'),
      task_id: task.task_id,
      to_actor_id: select.value,
      expected_revision: task.revision
    };
    if (task.assignment) {
      args.assignment_id = task.assignment.assignment_id;
      args.assignment_version = task.assignment.assignment_version;
    }
    if (note.value.trim()) args.note = note.value.trim();
    runTaskTransfer(panel, task, function () {
      return callTool('network_task_transfer_propose', args);
    }, '发起交接失败');
  });

  form.append(select, note, propose);
  return form;
}

function taskTransferPanelElement() {
  const panel = document.createElement('section');
  panel.className = 'task-transfer-panel';
  panel.id = 'task-transfer-panel';
  panel.setAttribute('aria-label', '任务交接');
  const heading = document.createElement('h3');
  heading.className = 'task-transfer-title';
  heading.textContent = '任务交接';
  const error = document.createElement('p');
  error.className = 'task-transfer-error';
  error.setAttribute('role', 'alert');
  const body = document.createElement('div');
  body.className = 'task-transfer-body';
  panel.append(heading, error, body);
  return panel;
}

async function renderTaskTransferSection(task) {
  if (!taskDetailActionsElement || !task) return;
  const previous = taskDetailActionsElement.querySelector('.task-transfer-panel');
  if (previous) previous.remove();
  const panel = taskTransferPanelElement();
  taskDetailActionsElement.append(panel);
  const body = panel.querySelector('.task-transfer-body');
  const seq = ++taskTransferLoadSeq;

  let transfers = [];
  try {
    const result = await callTool('network_task_transfer_list', { task_id: task.task_id });
    if (seq !== taskTransferLoadSeq) return;
    transfers = Array.isArray(result.transfers) ? result.transfers : [];
  } catch (caught) {
    if (seq !== taskTransferLoadSeq) return;
    const message = caught && caught.message ? caught.message : caught;
    panel.remove();
    if (taskTransferCanPropose(task)) {
      const fallback = taskTransferPanelElement();
      fallback.querySelector('.task-transfer-error').textContent = '读取交接状态失败：' + message;
      fallback.querySelector('.task-transfer-body').append(taskTransferProposeForm(task, fallback));
      taskDetailActionsElement.append(fallback);
    }
    return;
  }

  const hasPending = transfers.some(function (transfer) {
    return transfer.effective_status === 'pending';
  });
  const proposeAllowed = taskTransferCanPropose(task) && !hasPending;
  if (transfers.length === 0 && !proposeAllowed) {
    panel.remove();
    return;
  }

  if (transfers.length > 0) {
    const list = document.createElement('ul');
    list.className = 'task-transfer-list';
    for (const transfer of transfers) {
      list.append(taskTransferItem(task, transfer, panel));
    }
    body.append(list);
  } else {
    const empty = document.createElement('p');
    empty.className = 'task-transfer-empty';
    empty.textContent = '暂无交接提议';
    body.append(empty);
  }

  if (proposeAllowed) {
    if (taskTransferTargets(task).length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-transfer-empty';
      empty.textContent = '没有可接任的成员';
      body.append(empty);
    } else {
      body.append(taskTransferProposeForm(task, panel));
    }
  }
}
`;
