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
let taskDetailCurrent = null;
let taskDetailLoadSeq = 0;
let myTasksLoadSeq = 0;
let taskCreateSourceId = null;
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

function createTaskStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = 'task-status ' + taskStatusClass(status);
  badge.textContent = taskStatusLabel(status);
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
  top.append(title, createTaskStatusBadge(task.status));
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
  item.append(top, meta);
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
  roomTasks = [];
  roomTasksRoomId = null;
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
    for (const task of roomTasks) {
      if (task.card_message_id) taskCardsByMessage.set(task.card_message_id, task);
    }
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

function taskDetailRow(label, value) {
  if (!taskDetailBodyElement) return null;
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  taskDetailBodyElement.append(dt, dd);
  return dd;
}

function taskMessageButton(messageId, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.textContent = label;
  button.addEventListener('click', function () {
    closeTaskDetail();
    closeMyTasks();
    scrollToTaskMessage(messageId);
  });
  return button;
}

function scrollToTaskMessage(messageId) {
  if (!messagesElement) return;
  const node = messagesElement.querySelector('[data-message-id="' + messageId + '"]');
  if (!node) {
    if (statusElement) statusElement.textContent = '该消息不在已加载的历史中';
    return;
  }
  node.scrollIntoView({ block: 'center' });
  node.classList.add('task-message-flash');
  setTimeout(function () { node.classList.remove('task-message-flash'); }, 1200);
}

function renderTaskDetail(task) {
  taskDetailCurrent = task;
  if (taskDetailTitleElement) taskDetailTitleElement.textContent = task.title;
  if (taskDetailBodyElement) taskDetailBodyElement.replaceChildren();
  const statusValue = taskDetailRow('状态', taskStatusLabel(task.status));
  if (statusValue) statusValue.className = 'task-status ' + taskStatusClass(task.status);
  taskDetailRow('创建者', task.created_by_name);
  taskDetailRow(
    '负责人',
    task.owner_name
      ? task.owner_name
      : task.assignment && task.assignment.status === 'offered'
        ? '待接手：' + (task.assignment.owner_name || task.assignment.owner_actor_id)
        : '待指派'
  );
  taskDetailRow('验收人', task.reviewer_name);
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
      renderTaskDetail(result.task);
      await loadTaskSummary().catch(function () {});
      if (activeRoomId === result.task.room_id) {
        loadRoomTasks(activeRoomId, roomEpoch);
      }
      syncTaskCardMarkers(messagesElement);
      return result.task;
    } catch (caught) {
      error.textContent = failureLabel + '：' + (caught && caught.message ? caught.message : caught);
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

  if (task.can_claim) {
    const claim = document.createElement('button');
    claim.type = 'button';
    claim.textContent = '领取任务';
    claim.addEventListener('click', function () {
      run(function () {
        return callTool('network_task_claim', {
          request_id: requestId('task_claim'),
          task_id: task.task_id
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
          reason: reason.value.trim()
        });
      }, '取消失败');
    });
    actions.append(reason, cancel);
  }

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
  taskCreateRoomId = activeRoomId;
  if (taskCreateForm) taskCreateForm.reset();
  if (taskFormError) taskFormError.textContent = '';
  populateTaskMemberSelects();
  if (taskSourceHint) {
    taskSourceHint.hidden = !taskCreateSourceId;
    taskSourceHint.textContent = taskCreateSourceId
      ? '从消息创建：任务会关联该消息，引用或转发卡片不会复制任务。'
      : '';
  }
  if (taskTitleInput) {
    taskTitleInput.value = settings.title || suggestedTaskTitle(taskCreateSourceId);
  }
  taskCreateModal.hidden = false;
  if (taskTitleInput) taskTitleInput.focus();
}

function closeTaskCreate() {
  taskCreateSourceId = null;
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
  const canCreate = taskCanCreate();
  const nodes = container.querySelectorAll('.msg[data-message-id]');
  for (const node of nodes) {
    const messageId = node.getAttribute('data-message-id');
    const slot = node.querySelector('.msg-task-slot');
    if (!messageId || !slot) continue;
    slot.replaceChildren();
    slot.hidden = true;
    node.classList.remove('task-card-message');
    const cardTask = taskCardsByMessage.get(messageId);
    const sourceTask = roomTasks.find(function (task) {
      return task.source_message_id === messageId;
    });
    if (cardTask) {
      node.classList.add('task-card-message');
      const card = document.createElement('div');
      card.className = 'msg-task-card';
      card.append(createTaskStatusBadge(cardTask.status));
      const title = document.createElement('span');
      title.className = 'msg-task-title';
      title.textContent = cardTask.title;
      card.append(title);
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
