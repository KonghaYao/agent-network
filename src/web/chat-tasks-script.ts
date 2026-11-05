/**
 * 房间任务片段：聊天头部进度、任务浮层与侧栏 badge。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与其他片段共享作用域。
 * 只在打开房间、任务事件与列表刷新时读取；不轮询，不使用 innerHTML。
 */
export const CHAT_TASKS_SCRIPT = `
const taskToggleElement = document.getElementById('task-toggle');
const taskToggleLabelElement = document.getElementById('task-toggle-label');
const taskPopoverElement = document.getElementById('task-popover');
const taskListElement = document.getElementById('task-list');
const taskEmptyElement = document.getElementById('task-popover-empty');
const taskCloseElement = document.getElementById('task-popover-close');
const TASK_STATUS_LABELS = {
  pending: '待领取',
  claimed: '进行中',
  done: '已完成',
  failed: '失败'
};
let roomTasks = [];
let roomTasksRoomId = null;
let roomTasksTotal = 0;
let roomTasksDone = 0;
let roomTaskLoadSeq = 0;
let taskSummary = new Map();
let tasksRefreshTimer = null;
let taskSummaryTimer = null;
let taskPopoverPinned = false;
let taskHideTimer = null;

function taskCountLabel(done, total) {
  return '任务 ' + done + '/' + total;
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

function renderTaskList() {
  if (!taskListElement) return;
  taskListElement.replaceChildren();
  const hasTasks = roomTasksRoomId === activeRoomId && roomTasks.length > 0;
  if (taskEmptyElement) taskEmptyElement.hidden = hasTasks;
  if (!hasTasks) return;
  for (const task of roomTasks) {
    const item = document.createElement('li');
    item.className = 'task-item';
    item.dataset.taskId = task.task_id;
    const top = document.createElement('div');
    top.className = 'task-item-top';
    const description = document.createElement('span');
    description.className = 'task-desc';
    description.textContent = String(task.description || '');
    const status = document.createElement('span');
    const statusKey = TASK_STATUS_LABELS[task.status] ? task.status : 'pending';
    status.className = 'task-status ' + statusKey;
    status.textContent = TASK_STATUS_LABELS[statusKey];
    top.append(description, status);
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const assignee = task.assignee_name ? '领取：' + task.assignee_name : '未领取';
    const creator = task.created_by_name ? ' · 创建：' + task.created_by_name : '';
    meta.textContent = assignee + creator;
    item.append(top, meta);
    if (task.result) {
      const result = document.createElement('p');
      result.className = 'task-result' + (task.status === 'failed' ? ' failed' : '');
      result.textContent = (task.status === 'failed' ? '错误：' : '结果：') + task.result;
      item.append(result);
    }
    taskListElement.append(item);
  }
}

function renderTaskRow() {
  const visible = Boolean(
    taskToggleElement &&
      activeRoomId &&
      roomTasksRoomId === activeRoomId &&
      roomTasksTotal > 0
  );
  if (taskToggleElement) taskToggleElement.hidden = !visible;
  if (taskToggleLabelElement) {
    taskToggleLabelElement.textContent = taskCountLabel(roomTasksDone, roomTasksTotal);
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

function resetRoomTasks() {
  roomTaskLoadSeq += 1;
  roomTasks = [];
  roomTasksRoomId = null;
  roomTasksTotal = 0;
  roomTasksDone = 0;
  hideTaskPopover();
  renderTaskRow();
}

/** 重连补读时让下一次房间刷新重新拉取任务，避免离线期间变更残留。 */
function invalidateRoomTasks() {
  roomTaskLoadSeq += 1;
  roomTasks = [];
  roomTasksRoomId = null;
  roomTasksTotal = 0;
  roomTasksDone = 0;
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
      done: Number(entry.done) || 0
    });
  }
  taskSummary = next;
  const active = activeRoomId ? next.get(activeRoomId) : null;
  if (active && roomTasksRoomId === activeRoomId) {
    roomTasksTotal = active.total;
    roomTasksDone = active.done;
    renderTaskRow();
  }
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
      'network_task_list_get',
      { room_id: roomId },
      undefined,
      sessionSignal()
    );
    if (seq !== roomTaskLoadSeq || !isActiveRoom(roomId, epoch)) return;
    roomTasks = Array.isArray(result.tasks) ? result.tasks : [];
    roomTasksRoomId = roomId;
    roomTasksTotal = Number(result.total) || roomTasks.length;
    roomTasksDone = Number(result.done) || 0;
    taskSummary.set(roomId, { total: roomTasksTotal, done: roomTasksDone });
    renderTaskRow();
    renderRooms();
  } catch (error) {
    if (isAbortError(error) || seq !== roomTaskLoadSeq || !isActiveRoom(roomId, epoch)) return;
    if (roomTasksRoomId !== roomId) {
      roomTasks = [];
      roomTasksRoomId = roomId;
      roomTasksTotal = 0;
      roomTasksDone = 0;
    }
    renderTaskRow();
  }
}

function scheduleRoomTasksRefresh(roomId) {
  scheduleTaskSummaryRefresh();
  if (!roomId || roomId !== activeRoomId) return;
  if (tasksRefreshTimer) clearTimeout(tasksRefreshTimer);
  tasksRefreshTimer = setTimeout(function () {
    tasksRefreshTimer = null;
    if (activeRoomId !== roomId) return;
    loadRoomTasks(roomId, roomEpoch);
  }, WEB_REFRESH_DEBOUNCE_MS);
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
`;
