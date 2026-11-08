/**
 * 房间任务片段：任务面板、我的任务、新建任务、详情与消息卡片。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与其他片段共享作用域。
 * 只在打开房间、任务事件与列表刷新时读取；不轮询，不使用 innerHTML。
 * 任务入口都定位同一个 task_id；消息卡片不复制任务，也不解析正文生成新工作。
 */
export const CHAT_TASKS_SCRIPT = `
const taskToggleElement = document.getElementById('task-toggle');
const taskToggleLabelElement = document.getElementById('task-toggle-label');
const taskPopoverElement = document.getElementById('task-popover');
const taskListElement = document.getElementById('task-list');
const taskEmptyElement = document.getElementById('task-popover-empty');
const taskCloseElement = document.getElementById('task-popover-close');
const taskCreateButton = document.getElementById('task-create');
const taskCreateModal = document.getElementById('task-create-modal');
const taskCreateForm = document.getElementById('task-create-form');
const taskSourceHint = document.getElementById('task-source-hint');
const taskTitleInput = document.getElementById('task-title');
const taskDescriptionInput = document.getElementById('task-description');
const taskAcceptanceInput = document.getElementById('task-acceptance');
const taskAssigneeSelect = document.getElementById('task-assignee');
const taskReviewerSelect = document.getElementById('task-reviewer');
const taskDueInput = document.getElementById('task-due');
const taskFormError = document.getElementById('task-form-error');
const taskCreateCancel = document.getElementById('task-create-cancel');
const taskDetailModal = document.getElementById('task-detail-modal');
const taskDetailTitleElement = document.getElementById('task-detail-title');
const taskDetailStatusElement = document.getElementById('task-detail-status');
const taskDetailBodyElement = document.getElementById('task-detail-body');
const taskDetailActionsElement = document.getElementById('task-detail-actions');
const taskDetailClose = document.getElementById('task-detail-close');
const myTasksButton = document.getElementById('my-tasks');
const myTasksModal = document.getElementById('my-tasks-modal');
const myTasksListElement = document.getElementById('my-tasks-list');
const myTasksEmptyElement = document.getElementById('my-tasks-empty');
const myTasksClose = document.getElementById('my-tasks-close');
const TASK_STATUS_LABELS = {
  unassigned: '待领取',
  offered: '待接手',
  in_progress: '进行中',
  blocked: '受阻',
  submitted: '待验收',
  accepted: '已验收',
  failed: '失败',
  cancelled: '已取消',
  legacy_completed: '历史完成'
};
const TASK_STATUS_CLASSES = {
  unassigned: 'unassigned',
  offered: 'offered',
  in_progress: 'claimed',
  blocked: 'blocked',
  submitted: 'submitted',
  accepted: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  legacy_completed: 'done'
};
let roomTasks = [];
let roomTasksRoomId = null;
let roomTaskLoadSeq = 0;
let taskCardsByMessage = new Map();
// source_message_id -> task，避免每条消息在 roomTasks 上做线性 find。
let sourceTasksByMessage = new Map();
// 任务数据版本：变化时才重写对应消息的任务槽，未变化的消息直接跳过。
let taskMarkerVersion = 0;
// message_id -> 已渲染的 .msg 节点，loadOlder 后无需全表 querySelectorAll。
let taskMarkerNodes = new Map();
let taskDetailCurrent = null;
let taskDetailLoadSeq = 0;
let myTasksLoadSeq = 0;
let taskCreateSourceId = null;
let taskCreateParentId = null;
let taskCreateRoomId = null;
let taskSummary = new Map();
let tasksRefreshTimer = null;
let taskSummaryTimer = null;
let myTasksRefreshTimer = null;
let taskPopoverPinned = false;
let taskHideTimer = null;

function taskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] || String(status || '未知');
}

function taskStatusClass(status) {
  return TASK_STATUS_CLASSES[status] || 'unassigned';
}

function taskCanCreate() {
  return Boolean(room && room.capabilities && room.capabilities.create_task);
}

function taskTimeLabel(value) {
  if (!value) return '';
  return chatTime(value) || fullTime(value);
}

function taskSummaryCounts(tasks) {
  let done = 0;
  for (const task of tasks) {
    if (task.status === 'accepted' || task.status === 'legacy_completed') done += 1;
  }
  return { done: done, total: tasks.length };
}

function taskCountLabel(done, total) {
  return '任务 ' + done + '/' + total;
}

function taskRoomLabel(roomId) {
  if (room && room.room_id === roomId) {
    if (room.kind === 'group') return room.title || '群聊';
    return titleElement && titleElement.textContent ? titleElement.textContent : '单聊';
  }
  const entry = roomEntries.find(function (item) { return item.room_id === roomId; });
  return entry && entry.name ? entry.name : '会话';
}

function hideTaskPopover() {
  taskPopoverPinned = false;
  if (taskHideTimer) {
    clearTimeout(taskHideTimer);
    taskHideTimer = null;
  }
  if (taskPopoverElement) taskPopoverElement.hidden = true;
  if (taskToggleElement) taskToggleElement.setAttribute('aria-expanded', 'false');
}

function createTaskStatusBadge(taskOrStatus) {
  const status = typeof taskOrStatus === 'string' ? taskOrStatus : taskOrStatus.status;
  const badge = document.createElement('span');
  badge.className = 'task-status ' + taskStatusClass(status);
  badge.textContent = typeof taskOrStatus === 'string'
    ? taskStatusLabel(status)
    : (taskOrStatus.status_label || taskStatusLabel(status));
  return badge;
}

function taskItemElement(task) {
  const item = document.createElement('li');
  item.className = 'task-item';
  item.dataset.taskId = task.task_id;
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-label', '查看任务：' + task.title);
  const top = document.createElement('div');
  top.className = 'task-item-top';
  const title = document.createElement('span');
  title.className = 'task-desc';
  title.textContent = task.title;
  top.append(title, createTaskStatusBadge(task));
  appendTaskSubmissionBadge(top, task);
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const parts = [];
  const offeredName = task.assignment && task.assignment.status === 'offered'
    ? task.assignment.owner_name
    : null;
  parts.push(task.owner_name
    ? '负责人：' + task.owner_name
    : offeredName
      ? '待接手：' + offeredName
      : '待指派');
  parts.push('验收：' + task.reviewer_name);
  if (task.due_at) parts.push('期限：' + taskTimeLabel(task.due_at));
  meta.textContent = parts.join(' · ');
  const progressText = taskProgressSummary(task);
  if (progressText) {
    const progress = document.createElement('div');
    progress.className = 'task-meta task-progress-summary';
    progress.textContent = progressText;
    item.append(top, meta, progress);
  } else {
    item.append(top, meta);
  }
  item.addEventListener('click', function () {
    openTaskDetail(task.task_id).catch(function (error) {
      if (statusElement) statusElement.textContent = '读取任务失败：' + error.message;
    });
  });
  item.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    item.click();
  });
  return item;
}

function renderTaskList() {
  if (!taskListElement) return;
  taskListElement.replaceChildren();
  const hasTasks = roomTasksRoomId === activeRoomId && roomTasks.length > 0;
  if (taskEmptyElement) taskEmptyElement.hidden = hasTasks;
  if (!hasTasks) return;
  for (const task of roomTasks) taskListElement.append(taskItemElement(task));
}

function renderTaskRow() {
  const visible = Boolean(
    taskToggleElement &&
      activeRoomId &&
      (taskCanCreate() || (roomTasksRoomId === activeRoomId && roomTasks.length > 0))
  );
  if (taskToggleElement) taskToggleElement.hidden = !visible;
  if (taskToggleLabelElement) {
    const counts = activeRoomId ? taskSummary.get(activeRoomId) : null;
    taskToggleLabelElement.textContent = counts
      ? taskCountLabel(counts.done, counts.total)
      : '任务';
  }
  if (taskCreateButton) {
    taskCreateButton.hidden = !(activeRoomId && taskCanCreate());
  }
  if (!visible) hideTaskPopover();
  else if (taskPopoverElement && !taskPopoverElement.hidden) renderTaskList();
}

function openTaskPopover(pin) {
  if (
    !taskToggleElement ||
    !taskPopoverElement ||
    taskToggleElement.hidden ||
    roomTasksRoomId !== activeRoomId
  ) {
    return;
  }
  if (taskHideTimer) {
    clearTimeout(taskHideTimer);
    taskHideTimer = null;
  }
  if (pin) taskPopoverPinned = true;
  renderTaskList();
  taskPopoverElement.hidden = false;
  taskToggleElement.setAttribute('aria-expanded', 'true');
}

function resetTaskCards() {
  taskCardsByMessage = new Map();
  sourceTasksByMessage = new Map();
  taskMarkerVersion += 1;
  taskMarkerNodes = new Map();
  roomTasks = [];
  roomTasksRoomId = null;
}

/** 整表重建前清空节点索引；消息节点会随新 fragment 重新登记。 */
function resetTaskMarkerIndex() {
  taskMarkerNodes = new Map();
}

/** messageItem 构建节点时登记，任务同步按 message_id 精确命中。 */
function rememberTaskMarkerNode(messageId, node) {
  if (!messageId || !node) return;
  let nodes = taskMarkerNodes.get(messageId);
  if (!nodes) {
    nodes = new Set();
    taskMarkerNodes.set(messageId, nodes);
  }
  nodes.add(node);
}

function resetRoomTasks() {
  roomTaskLoadSeq += 1;
  resetTaskCards();
  hideTaskPopover();
  closeTaskDetail();
  closeTaskCreate();
  renderTaskRow();
}

/** 重连补读时让下一次房间刷新重新拉取任务，避免离线期间变更残留。 */
function invalidateRoomTasks() {
  roomTaskLoadSeq += 1;
  resetTaskCards();
  hideTaskPopover();
  renderTaskRow();
}

function applyTaskSummary(result) {
  if (!result || !Array.isArray(result.items)) return;
  const next = new Map();
  for (const entry of result.items) {
    if (!entry || typeof entry.room_id !== 'string') continue;
    next.set(entry.room_id, {
      total: Number(entry.total) || 0,
      done: Number(entry.done) || 0,
      pending: Number(entry.pending) || 0,
      claimed: Number(entry.claimed) || 0
    });
  }
  taskSummary = next;
  renderTaskRow();
  renderRooms();
}

async function loadTaskSummary() {
  const result = await callTool('network_task_summary', {});
  applyTaskSummary(result);
}

function scheduleTaskSummaryRefresh() {
  if (taskSummaryTimer) return;
  taskSummaryTimer = setTimeout(function () {
    taskSummaryTimer = null;
    loadTaskSummary().catch(function () {});
  }, WEB_REFRESH_DEBOUNCE_MS);
}

async function loadRoomTasks(roomId, epoch) {
  const seq = ++roomTaskLoadSeq;
  try {
    const result = await callTool(
      'network_task_list',
      { room_id: roomId },
      undefined,
      sessionSignal()
    );
    if (seq !== roomTaskLoadSeq || !isActiveRoom(roomId, epoch)) return;
    roomTasks = Array.isArray(result.tasks) ? result.tasks : [];
    roomTasksRoomId = roomId;
    taskCardsByMessage = new Map();
    sourceTasksByMessage = new Map();
    for (const task of roomTasks) {
      if (task.card_message_id) taskCardsByMessage.set(task.card_message_id, task);
      if (task.source_message_id) sourceTasksByMessage.set(task.source_message_id, task);
    }
    taskMarkerVersion += 1;
    const counts = taskSummaryCounts(roomTasks);
    const summary = taskSummary.get(roomId);
    taskSummary.set(roomId, {
      total: counts.total,
      done: counts.done,
      pending: summary ? summary.pending : 0,
      claimed: summary ? summary.claimed : 0
    });
    renderTaskRow();
    syncTaskCardMarkers(messagesElement);
    renderRooms();
  } catch (error) {
    if (isAbortError(error) || seq !== roomTaskLoadSeq || !isActiveRoom(roomId, epoch)) return;
    if (roomTasksRoomId !== roomId) resetTaskCards();
    renderTaskRow();
  }
}

function scheduleRoomTasksRefresh(roomId) {
  scheduleTaskSummaryRefresh();
  if (!roomId || roomId !== activeRoomId) {
    if (myTasksModal && !myTasksModal.hidden) scheduleMyTasksRefresh();
    return;
  }
  if (tasksRefreshTimer) clearTimeout(tasksRefreshTimer);
  tasksRefreshTimer = setTimeout(function () {
    tasksRefreshTimer = null;
    if (activeRoomId !== roomId) return;
    loadRoomTasks(roomId, roomEpoch);
    if (myTasksModal && !myTasksModal.hidden) scheduleMyTasksRefresh();
  }, WEB_REFRESH_DEBOUNCE_MS);
}

function renderTaskDetail(task) {
  taskDetailCurrent = task;
  if (taskDetailTitleElement) taskDetailTitleElement.textContent = task.title;
  if (taskDetailBodyElement) taskDetailBodyElement.replaceChildren();
  const statusValue = taskDetailRow('状态', taskStatusText(task));
  if (statusValue) statusValue.className = 'task-status ' + taskStatusClass(task.status);
  if (task.status === 'cancelled') {
    if (task.cancel_reason) taskDetailRow('取消原因', task.cancel_reason);
    if (task.cancelled_by_name) taskDetailRow('取消操作者', task.cancelled_by_name);
    const externalLabels = {
      confirmed: '操作者确认已停止（不是服务端强一致保证）',
      unknown: '未知或待核对',
      not_required: '不涉及外部执行'
    };
    if (task.external_stop_status) {
      taskDetailRow('外部执行', externalLabels[task.external_stop_status] || task.external_stop_status);
    }
  }
  appendTaskProgressDetail(task);
  appendTaskSubmissionDetail(task);
  taskDetailRow('创建者', task.created_by_name);
  taskDetailRow(
    '负责人',
    task.owner_name
      ? task.owner_name
      : task.assignment && task.assignment.status === 'offered'
        ? '待接手：' + (task.assignment.owner_name || task.assignment.owner_actor_id)
        : '待指派'
  );
  appendTaskReviewDetail(task);
  taskDetailRow('期限', task.due_at ? fullTime(task.due_at) : '无');
  taskDetailRow(
    '业务权威来源',
    task.business_authority === 'external'
      ? '外部任务' + (task.external_binding_id ? '（' + task.external_binding_id + '）' : '')
      : '站内任务'
  );
  taskDetailRow('更新时间', fullTime(task.updated_at));
  if (task.card_message_id) {
    const dd = taskDetailRow('任务卡片', '');
    if (dd) dd.append(taskMessageButton(task.card_message_id, '在聊天中查看'));
  }
  if (task.source_message_id) {
    const dd = taskDetailRow('来源消息', '');
    if (dd) dd.append(taskMessageButton(task.source_message_id, '在聊天中查看'));
  }
  const description = taskDetailRow('详细目标', task.description || '未填写');
  if (description) description.className = 'task-long-text';
  const acceptance = taskDetailRow('验收条件', task.acceptance_criteria || '未填写');
  if (acceptance) acceptance.className = 'task-long-text';
  if (task.attachments && task.attachments.length > 0) {
    const dd = taskDetailRow('附件', '');
    if (dd) {
      for (const attachment of task.attachments) {
        const link = document.createElement('a');
        link.href = '/f/' + encodeURIComponent(attachment.file_id);
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'task-attachment';
        link.textContent = attachment.label || attachment.file_id;
        dd.append(link);
      }
    }
  }
  renderTaskDetailActions(task);
  renderTaskTransferSection(task);
  renderTaskHandoffSection(task);
}

function renderTaskDetailActions(task) {
  if (!taskDetailActionsElement) return;
  taskDetailActionsElement.replaceChildren();
  const error = document.createElement('p');
  error.className = 'form-error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'row modal-actions';
  taskDetailActionsElement.append(error, actions);

  async function run(action, failureLabel) {
    actions.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
    error.textContent = '';
    try {
      const result = await action();
      let task = result.task;
      try {
        const latest = await callTool('network_task_get', { task_id: task.task_id });
        if (latest && latest.task) task = latest.task;
      } catch (refreshError) {
        // 写操作结果已带权威状态；读取失败时继续用写结果渲染。
      }
      renderTaskDetail(task);
      await loadTaskSummary().catch(function () {});
      if (activeRoomId === task.room_id) {
        loadRoomTasks(activeRoomId, roomEpoch);
      }
      syncTaskCardMarkers(messagesElement);
      return task;
    } catch (caught) {
      const code = caught && caught.code ? String(caught.code) : '';
      let message = failureLabel + '：' + (caught && caught.message ? caught.message : caught);
      if (
        code === 'CLAIM_CONFLICT' ||
        code === 'CONFLICT' ||
        code === 'ASSIGNMENT_STALE' ||
        code === 'REVIEW_STALE' ||
        code === 'VERSION_CONFLICT' ||
        code === 'REQUEST_EXPIRED'
      ) {
        try {
          const latest = await callTool('network_task_get', { task_id: task.task_id });
          renderTaskDetail(latest.task);
          const freshError = taskDetailActionsElement.querySelector('.form-error');
          const owner =
            latest.task.owner_name ||
            (latest.task.assignment && latest.task.assignment.owner_name) ||
            '';
          if (freshError) {
            freshError.textContent = message + (owner ? '；当前负责人：' + owner : '');
          }
          await loadTaskSummary().catch(function () {});
          if (activeRoomId === latest.task.room_id) {
            loadRoomTasks(activeRoomId, roomEpoch);
          }
          syncTaskCardMarkers(messagesElement);
          return null;
        } catch (refreshError) {
          message += '；刷新权威状态失败';
        }
      }
      error.textContent = message;
      actions.querySelectorAll('button').forEach(function (button) { button.disabled = false; });
      return null;
    }
  }

  if (task.can_offer && task.status === 'unassigned') {
    const select = document.createElement('select');
    select.className = 'task-offer-select';
    select.setAttribute('aria-label', '指派任务给成员');
    for (const member of members.values()) {
      if (identity && member.actor_id === identity.actor_id) continue;
      if (member.actor_id === task.reviewer_actor_id) continue;
      const option = document.createElement('option');
      option.value = member.actor_id;
      option.textContent = member.name;
      select.append(option);
    }
    const offer = document.createElement('button');
    offer.type = 'button';
    offer.textContent = '指派';
    offer.addEventListener('click', function () {
      if (!select.value) {
        error.textContent = '没有可指派的成员';
        return;
      }
      run(function () {
        return callTool('network_task_offer', {
          request_id: requestId('task_offer'),
          task_id: task.task_id,
          assignee_actor_id: select.value,
          expected_revision: task.revision
        });
      }, '指派失败');
    });
    actions.append(select, offer);
  }

  if (task.can_accept && task.assignment && task.assignment.status === 'offered') {
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = '接受任务';
    accept.addEventListener('click', function () {
      run(function () {
        return callTool('network_task_accept', {
          request_id: requestId('task_accept'),
          task_id: task.task_id,
          assignment_id: task.assignment.assignment_id,
          expected_revision: task.revision
        });
      }, '接受失败');
    });
    actions.append(accept);
  }

  if (task.can_decline && task.assignment && task.assignment.status === 'offered') {
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.className = 'task-cancel-reason';
    reason.maxLength = 300;
    reason.placeholder = '拒绝原因（可选）';
    reason.setAttribute('aria-label', '拒绝原因');
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = '拒绝任务';
    decline.addEventListener('click', function () {
      const args = {
        request_id: requestId('task_decline'),
        task_id: task.task_id,
        assignment_id: task.assignment.assignment_id,
        expected_revision: task.revision
      };
      if (reason.value.trim()) args.reason = reason.value.trim();
      run(function () {
        return callTool('network_task_decline', args);
      }, '拒绝失败');
    });
    actions.append(reason, decline);
  }

  if (task.can_claim) {
    const claim = document.createElement('button');
    claim.type = 'button';
    claim.textContent = '领取任务';
    claim.addEventListener('click', function () {
      run(function () {
        return callTool('network_task_claim', {
          request_id: requestId('task_claim'),
          task_id: task.task_id,
          expected_revision: task.revision
        });
      }, '领取失败');
    });
    actions.append(claim);
  }

  if (task.can_cancel) {
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.className = 'task-cancel-reason';
    reason.maxLength = 300;
    reason.placeholder = '取消原因';
    reason.setAttribute('aria-label', '取消原因');
    const externalStop = document.createElement('select');
    externalStop.className = 'task-cancel-reason task-cancel-stop';
    externalStop.setAttribute('aria-label', '外部执行停止状态');
    const stopOptions = [
      { value: 'unknown', label: '外部执行未确认停止' },
      { value: 'confirmed', label: '操作者确认已停止' },
      { value: 'not_required', label: '不涉及外部执行' }
    ];
    for (const option of stopOptions) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      externalStop.append(item);
    }
    externalStop.value =
      task.status === 'in_progress' || task.status === 'blocked' ? 'unknown' : 'not_required';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'danger';
    cancel.textContent = '取消任务';
    cancel.addEventListener('click', function () {
      if (!reason.value.trim()) {
        error.textContent = '请填写取消原因';
        return;
      }
      run(function () {
        return callTool('network_task_cancel', {
          request_id: requestId('task_cancel'),
          task_id: task.task_id,
          reason: reason.value.trim(),
          external_stop_status: externalStop.value,
          expected_revision: task.revision
        });
      }, '取消失败');
    });
    actions.append(reason, externalStop, cancel);
  }

  renderTaskProgressActions(task, actions, run, error);
  renderTaskRecoveryActions(task, actions, run, error);
  renderTaskSubmissionActions(task, actions, run, error);
  renderTaskReviewActions(task, actions, run, error);

  if (!actions.hasChildNodes()) {
    actions.remove();
  }
}

async function openTaskDetail(taskId) {
  const seq = ++taskDetailLoadSeq;
  const result = await callTool('network_task_get', { task_id: taskId });
  if (seq !== taskDetailLoadSeq) return;
  renderTaskDetail(result.task);
  if (taskDetailModal) taskDetailModal.hidden = false;
}

function closeTaskDetail() {
  taskDetailLoadSeq += 1;
  taskDetailCurrent = null;
  if (taskDetailModal) taskDetailModal.hidden = true;
  if (taskDetailActionsElement) taskDetailActionsElement.replaceChildren();
  if (taskDetailBodyElement) taskDetailBodyElement.replaceChildren();
}

function memberOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function populateTaskMemberSelects() {
  if (!taskAssigneeSelect || !taskReviewerSelect) return;
  taskAssigneeSelect.replaceChildren(memberOption('', '公开任务（成员可领取）'));
  taskReviewerSelect.replaceChildren();
  for (const member of members.values()) {
    if (!identity || member.actor_id !== identity.actor_id) {
      taskAssigneeSelect.append(memberOption(member.actor_id, member.name));
    }
    taskReviewerSelect.append(memberOption(member.actor_id, member.name));
  }
  if (identity) taskReviewerSelect.value = identity.actor_id;
}

function suggestedTaskTitle(sourceMessageId) {
  for (const item of currentItems) {
    if (item && item.message_id === sourceMessageId && item.preview) {
      return String(item.preview).replace(/\\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return '';
}

function openTaskCreate(options) {
  if (!activeRoomId || !taskCanCreate() || !taskCreateModal) return;
  const settings = options || {};
  taskCreateSourceId = settings.sourceMessageId || null;
  taskCreateParentId = settings.parentTaskId || null;
  taskCreateRoomId = activeRoomId;
  if (taskCreateForm) taskCreateForm.reset();
  if (taskFormError) taskFormError.textContent = '';
  populateTaskMemberSelects();
  if (taskSourceHint) {
    const hints = [];
    if (taskCreateSourceId) {
      hints.push('从消息创建：任务会关联该消息，引用或转发卡片不会复制任务。');
    }
    if (taskCreateParentId) {
      hints.push('作为父任务的追加工作创建；父任务保持已验收/已取消，不会被重新打开。');
    }
    taskSourceHint.hidden = hints.length === 0;
    taskSourceHint.textContent = hints.join(' ');
  }
  if (taskTitleInput) {
    taskTitleInput.value =
      settings.title || suggestedTaskTitle(taskCreateSourceId) || (taskCreateParentId ? '追加工作' : '');
  }
  taskCreateModal.hidden = false;
  if (taskTitleInput) taskTitleInput.focus();
}

function closeTaskCreate() {
  taskCreateSourceId = null;
  taskCreateParentId = null;
  taskCreateRoomId = null;
  if (taskCreateModal) taskCreateModal.hidden = true;
  if (taskFormError) taskFormError.textContent = '';
}

async function submitTaskCreate() {
  if (!taskCreateForm || !activeRoomId) return;
  if (taskCreateRoomId !== activeRoomId) {
    closeTaskCreate();
    return;
  }
  if (taskFormError) taskFormError.textContent = '';
  const title = taskTitleInput ? taskTitleInput.value.trim() : '';
  if (!title) {
    if (taskFormError) taskFormError.textContent = '请填写短标题';
    return;
  }
  const reviewer = taskReviewerSelect ? taskReviewerSelect.value : '';
  const assignee = taskAssigneeSelect ? taskAssigneeSelect.value : '';
  if (reviewer && assignee && reviewer === assignee) {
    if (taskFormError) taskFormError.textContent = '负责人和验收人不能是同一人';
    return;
  }
  const args = {
    request_id: requestId('task_create'),
    room_id: activeRoomId,
    title: title,
    reviewer_actor_id: reviewer || undefined
  };
  if (taskCreateSourceId) args.source_message_id = taskCreateSourceId;
  if (taskCreateParentId) args.parent_task_id = taskCreateParentId;
  if (taskDescriptionInput && taskDescriptionInput.value.trim()) {
    args.description = taskDescriptionInput.value;
  }
  if (taskAcceptanceInput && taskAcceptanceInput.value.trim()) {
    args.acceptance_criteria = taskAcceptanceInput.value;
  }
  if (assignee) args.assignee_actor_id = assignee;
  if (taskDueInput && taskDueInput.value) {
    const due = new Date(taskDueInput.value);
    if (Number.isNaN(due.getTime())) {
      if (taskFormError) taskFormError.textContent = '期限格式无效';
      return;
    }
    args.due_at = due.toISOString();
  }
  const submit = taskCreateForm.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const result = await callTool('network_task_create', args);
    closeTaskCreate();
    if (statusElement) statusElement.textContent = '任务已创建';
    await Promise.allSettled([loadTaskSummary(), loadRoomTasks(activeRoomId, roomEpoch)]);
    await openTaskDetail(result.task.task_id);
  } catch (error) {
    if (taskFormError) {
      taskFormError.textContent = '创建失败：' + (error && error.message ? error.message : error);
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

function appendMyTaskRow(task) {
  if (!myTasksListElement) return;
  const item = taskItemElement(task);
  const room = document.createElement('div');
  room.className = 'task-meta';
  room.textContent = taskRoomLabel(task.room_id);
  item.append(room);
  myTasksListElement.append(item);
}

async function loadMyTasks() {
  if (!myTasksModal || myTasksModal.hidden) return;
  const seq = ++myTasksLoadSeq;
  try {
    const result = await callTool('network_task_list', { scope: 'mine', limit: 100 });
    if (seq !== myTasksLoadSeq || !myTasksModal || myTasksModal.hidden) return;
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    if (myTasksListElement) myTasksListElement.replaceChildren();
    if (myTasksEmptyElement) myTasksEmptyElement.hidden = tasks.length > 0;
    for (const task of tasks) appendMyTaskRow(task);
  } catch (error) {
    if (myTasksEmptyElement) {
      myTasksEmptyElement.hidden = false;
      myTasksEmptyElement.textContent = '读取我的任务失败：' +
        (error && error.message ? error.message : error);
    }
  }
}

function openMyTasks() {
  if (!myTasksModal) return;
  myTasksModal.hidden = false;
  if (myTasksEmptyElement) {
    myTasksEmptyElement.textContent = '正在读取…';
    myTasksEmptyElement.hidden = false;
  }
  if (myTasksListElement) myTasksListElement.replaceChildren();
  loadMyTasks().catch(function () {});
}

function closeMyTasks() {
  myTasksLoadSeq += 1;
  if (myTasksModal) myTasksModal.hidden = true;
}

function scheduleMyTasksRefresh() {
  if (myTasksRefreshTimer) return;
  myTasksRefreshTimer = setTimeout(function () {
    myTasksRefreshTimer = null;
    if (myTasksModal && !myTasksModal.hidden) loadMyTasks().catch(function () {});
  }, WEB_REFRESH_DEBOUNCE_MS);
}

function taskConvertButton(messageId, preview) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-task-convert';
  button.textContent = '转为任务';
  button.addEventListener('click', function () {
    openTaskCreate({
      sourceMessageId: messageId,
      title: String(preview || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
    });
  });
  return button;
}

function syncTaskCardMarkers(container) {
  if (!container) return;
  if (container === messagesElement) updateMessagesLengthClass();
  const canCreate = taskCanCreate();
  // 没有任务且当前用户不能创建任务时，消息槽保持隐藏，无需遍历。
  if (taskCardsByMessage.size === 0 && sourceTasksByMessage.size === 0 && !canCreate) return;
  const nodes = container === messagesElement
    ? taskMarkerIndexedNodes()
    : container.querySelectorAll('.msg[data-message-id]');
  const suffix = ':' + taskMarkerVersion + ':' + (canCreate ? '1' : '0');
  for (const node of nodes) {
    const messageId = node.getAttribute('data-message-id');
    const slot = node.querySelector('.msg-task-slot');
    if (!messageId || !slot) continue;
    const cardTask = taskCardsByMessage.get(messageId);
    const sourceTask = sourceTasksByMessage.get(messageId);
    const signature =
      (cardTask ? cardTask.task_id : '') + '|' +
      (sourceTask ? sourceTask.task_id : '') + suffix;
    if (node.dataset.taskMarkerSignature === signature) continue;
    node.dataset.taskMarkerSignature = signature;
    slot.replaceChildren();
    slot.hidden = true;
    node.classList.remove('task-card-message');
    if (cardTask) {
      node.classList.add('task-card-message');
      const card = document.createElement('div');
      card.className = 'msg-task-card';
      card.append(createTaskStatusBadge(cardTask));
      appendTaskSubmissionBadge(card, cardTask);
      const title = document.createElement('span');
      title.className = 'msg-task-title';
      title.textContent = cardTask.title;
      card.append(title);
      const progressText = taskProgressSummary(cardTask);
      if (progressText) {
        const progress = document.createElement('span');
        progress.className = 'msg-task-progress';
        progress.textContent = progressText;
        card.append(progress);
      }
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'msg-task-open';
      open.textContent = '查看任务';
      open.addEventListener('click', function () {
        openTaskDetail(cardTask.task_id).catch(function (error) {
          if (statusElement) statusElement.textContent = '读取任务失败：' + error.message;
        });
      });
      card.append(open);
      slot.append(card);
      slot.hidden = false;
    } else if (sourceTask) {
      const link = document.createElement('div');
      link.className = 'msg-task-link';
      const label = document.createElement('span');
      label.textContent = '已转为任务：' + sourceTask.title;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'msg-task-open';
      open.textContent = '查看任务';
      open.addEventListener('click', function () {
        openTaskDetail(sourceTask.task_id).catch(function (error) {
          if (statusElement) statusElement.textContent = '读取任务失败：' + error.message;
        });
      });
      link.append(label, open);
      slot.append(link);
      slot.hidden = false;
    } else if (canCreate) {
      slot.append(taskConvertButton(messageId, node.dataset.messagePreview || ''));
      slot.hidden = false;
    }
  }
}

/** 只遍历本房间已登记的节点；已随旧 DOM 丢弃的节点跳过。 */
function taskMarkerIndexedNodes() {
  if (!messagesElement) return [];
  const nodes = [];
  for (const entry of taskMarkerNodes.values()) {
    for (const node of entry) {
      if (node.isConnected && messagesElement.contains(node)) nodes.push(node);
    }
  }
  return nodes;
}

if (taskToggleElement && taskPopoverElement) {
  taskToggleElement.addEventListener('mouseenter', function () {
    openTaskPopover(false);
  });
  taskToggleElement.addEventListener('mouseleave', function () {
    if (taskPopoverPinned) return;
    if (taskHideTimer) clearTimeout(taskHideTimer);
    taskHideTimer = setTimeout(function () {
      taskHideTimer = null;
      const focused = document.activeElement;
      const focusInside = Boolean(
        taskPopoverElement && focused && taskPopoverElement.contains(focused)
      );
      if (!taskPopoverElement.matches(':hover') && !focusInside) hideTaskPopover();
    }, 150);
  });
  taskToggleElement.addEventListener('focus', function () {
    openTaskPopover(false);
  });
  taskToggleElement.addEventListener('click', function (event) {
    event.preventDefault();
    if (taskPopoverPinned && !taskPopoverElement.hidden) hideTaskPopover();
    else openTaskPopover(true);
  });
  taskPopoverElement.addEventListener('mouseenter', function () {
    if (taskHideTimer) {
      clearTimeout(taskHideTimer);
      taskHideTimer = null;
    }
  });
  taskPopoverElement.addEventListener('mouseleave', function () {
    if (taskPopoverPinned) return;
    const focused = document.activeElement;
    if (!focused || !taskPopoverElement.contains(focused)) hideTaskPopover();
  });
  taskPopoverElement.addEventListener('focusout', function (event) {
    const next = event.relatedTarget;
    if (next && (taskPopoverElement.contains(next) || taskToggleElement.contains(next))) return;
    hideTaskPopover();
  });
  document.addEventListener('pointerdown', function (event) {
    if (taskPopoverElement.hidden) return;
    const target = event.target;
    if (
      target &&
      (taskPopoverElement.contains(target) || taskToggleElement.contains(target))
    ) {
      return;
    }
    hideTaskPopover();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || taskPopoverElement.hidden) return;
    // 先聚焦再关闭：focus 监听会重新打开，随后 hide 保证最终状态为关闭。
    taskToggleElement.focus();
    hideTaskPopover();
  });
  if (taskCloseElement) {
    taskCloseElement.addEventListener('click', function () {
      taskToggleElement.focus();
      hideTaskPopover();
    });
  }
}

if (taskCreateButton) {
  taskCreateButton.addEventListener('click', function () {
    openTaskCreate({});
  });
}
if (taskCreateForm) {
  taskCreateForm.addEventListener('submit', function (event) {
    event.preventDefault();
    submitTaskCreate().catch(function () {});
  });
}
if (taskCreateCancel) {
  taskCreateCancel.addEventListener('click', closeTaskCreate);
}
if (taskCreateModal) {
  taskCreateModal.addEventListener('click', function (event) {
    if (event.target === taskCreateModal) closeTaskCreate();
  });
}
if (taskDetailClose) taskDetailClose.addEventListener('click', closeTaskDetail);
if (taskDetailModal) {
  taskDetailModal.addEventListener('click', function (event) {
    if (event.target === taskDetailModal) closeTaskDetail();
  });
}
if (myTasksButton) myTasksButton.addEventListener('click', openMyTasks);
if (myTasksClose) myTasksClose.addEventListener('click', closeMyTasks);
if (myTasksModal) {
  myTasksModal.addEventListener('click', function (event) {
    if (event.target === myTasksModal) closeMyTasks();
  });
}
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  if (taskDetailModal && !taskDetailModal.hidden) {
    closeTaskDetail();
    return;
  }
  if (taskCreateModal && !taskCreateModal.hidden) {
    closeTaskCreate();
    return;
  }
  if (myTasksModal && !myTasksModal.hidden) closeMyTasks();
});
`;
