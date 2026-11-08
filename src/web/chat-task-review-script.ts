/**
 * D07 验收片段：逐项验收、退回当前版本、改派验收人与关联任务入口。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与任务片段共享作用域。
 * 验收清单按 `acceptance_criteria` 的行生成，勾选结果为提交时的显式证据；
 * 有未通过项时只允许退回，不把“部分通过”写成 accepted。所有写操作都带
 * `submission_id`、版本与任务 revision，旧版本或旧验收人由服务端拒绝。
 */
import { LIMITS } from '../contracts/limits';

export const CHAT_TASK_REVIEW_SCRIPT = `
const taskReviewModal = document.getElementById('task-review-modal');
const taskReviewForm = document.getElementById('task-review-form');
const taskReviewSummary = document.getElementById('task-review-summary');
const taskReviewChecklist = document.getElementById('task-review-checklist');
const taskReviewError = document.getElementById('task-review-error');
const taskReviewCancel = document.getElementById('task-review-cancel');
const taskReviewClose = document.getElementById('task-review-close');
let taskReviewTask = null;

function taskReviewChecklistLines(task) {
  const text = String(task && task.acceptance_criteria ? task.acceptance_criteria : '');
  const lines = text
    .split(/\\r?\\n/)
    .map(function (line) { return line.replace(/^\\s*(?:[-*•]|\\d+[.、)])\\s*/, '').trim(); })
    .filter(function (line) { return line.length > 0; });
  return lines.length > 0 ? lines : ['整体交付符合任务描述、验收条件与既有约束'];
}

function taskReviewChecklistRow(item) {
  const row = document.createElement('li');
  row.className = 'task-review-item';
  const choice = document.createElement('label');
  choice.className = 'task-review-check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  const text = document.createElement('span');
  text.className = 'task-review-item-text';
  text.textContent = item;
  choice.append(checkbox, text);
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'task-review-note';
  note.maxLength = ${LIMITS.taskReviewChecklistItemBytes};
  note.placeholder = '该项核对备注（可选）';
  note.setAttribute('aria-label', '验收备注：' + item);
  row.append(choice, note);
  return row;
}

function closeTaskReview() {
  taskReviewTask = null;
  if (taskReviewModal) taskReviewModal.hidden = true;
  if (taskReviewError) taskReviewError.textContent = '';
}

function openTaskReview(task) {
  if (!taskReviewModal || !taskReviewForm || !task) return;
  if (!task.can_accept_review || !task.current_submission) return;
  taskReviewTask = task;
  taskReviewForm.reset();
  if (taskReviewError) taskReviewError.textContent = '';
  if (taskReviewChecklist) {
    taskReviewChecklist.replaceChildren();
    for (const item of taskReviewChecklistLines(task)) {
      taskReviewChecklist.append(taskReviewChecklistRow(item));
    }
  }
  if (taskReviewSummary) {
    const submission = task.current_submission;
    taskReviewSummary.textContent =
      '成果 v' + submission.version +
      (task.owner_name ? ' · 提交人：' + task.owner_name : '') +
      (submission.submitted_at ? ' · ' + taskSubmissionTime(submission.submitted_at) : '');
  }
  taskReviewModal.hidden = false;
  const first = taskReviewChecklist
    ? taskReviewChecklist.querySelector('input[type="checkbox"]')
    : null;
  if (first) first.focus();
}

function collectTaskReviewChecklist() {
  const checklist = [];
  if (!taskReviewChecklist) return checklist;
  for (const row of taskReviewChecklist.querySelectorAll('.task-review-item')) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    const text = row.querySelector('.task-review-item-text');
    const note = row.querySelector('.task-review-note');
    if (!text) continue;
    const entry = { item: text.textContent, passed: !!(checkbox && checkbox.checked) };
    if (note && note.value.trim()) entry.note = note.value.trim();
    checklist.push(entry);
  }
  return checklist;
}

async function submitTaskReview(event) {
  if (event) event.preventDefault();
  if (!taskReviewForm || !taskReviewTask) return;
  const task = taskReviewTask;
  if (!task.current_submission) {
    closeTaskReview();
    return;
  }
  if (taskReviewError) taskReviewError.textContent = '';
  const checklist = collectTaskReviewChecklist();
  if (checklist.length === 0) {
    if (taskReviewError) taskReviewError.textContent = '验收清单为空，请刷新任务后重试';
    return;
  }
  if (checklist.some(function (entry) { return !entry.passed; })) {
    if (taskReviewError) {
      taskReviewError.textContent = '存在未通过的验收项；请使用退回并说明具体原因，不能验收通过。';
    }
    return;
  }
  const submit = taskReviewForm.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const result = await callTool('network_task_review_accept', {
      request_id: requestId('task_review_accept'),
      task_id: task.task_id,
      submission_id: task.current_submission.submission_id,
      version: task.current_submission.version,
      checklist: checklist,
      expected_revision: task.revision
    });
    closeTaskReview();
    if (statusElement) statusElement.textContent = '已验收通过';
    renderTaskDetail(result.task);
    await loadTaskSummary().catch(function () {});
    if (activeRoomId === result.task.room_id) {
      loadRoomTasks(activeRoomId, roomEpoch);
    }
    syncTaskCardMarkers(messagesElement);
  } catch (error) {
    if (taskReviewError) {
      taskReviewError.textContent = '验收失败：' +
        (error && error.message ? error.message : error);
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

function taskReviewLinkButton(label, taskId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.textContent = label;
  button.addEventListener('click', function () {
    openTaskDetail(taskId).catch(function (error) {
      if (statusElement) {
        statusElement.textContent = '读取关联任务失败：' +
          (error && error.message ? error.message : error);
      }
    });
  });
  return button;
}

function appendTaskReviewDetail(task) {
  if (!task) return;
  const reviewer = taskDetailRow('验收人', '');
  if (reviewer) {
    reviewer.append(task.reviewer_name || task.reviewer_actor_id || '未指定');
    if (task.reviewer_available === false) {
      const warning = document.createElement('span');
      warning.className = 'task-review-warning';
      warning.textContent = ' · 已离开群聊或被禁用，需由创建者/管理员改派';
      reviewer.append(warning);
    }
  }
  if (task.parent_task_id) {
    const row = taskDetailRow('父任务', '');
    if (row) row.append(taskReviewLinkButton('查看父任务', task.parent_task_id));
  }
  if (task.related_task_id) {
    const row = taskDetailRow('关联任务', '');
    if (row) row.append(taskReviewLinkButton('查看关联任务', task.related_task_id));
  }
}

function renderTaskReviewActions(task, actions, run, error) {
  if (!task || !actions) return;
  if (task.can_accept_review && task.current_submission) {
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'primary';
    accept.textContent = '验收通过 v' + task.current_submission.version;
    accept.addEventListener('click', function () {
      openTaskReview(task);
    });
    actions.append(accept);
  }
  if (task.can_set_reviewer) {
    const select = document.createElement('select');
    select.className = 'task-reviewer-select';
    select.setAttribute('aria-label', '改派验收人');
    let hasOption = false;
    let currentOption = null;
    for (const member of members.values()) {
      if (member.actor_id === task.owner_actor_id) continue;
      const option = document.createElement('option');
      option.value = member.actor_id;
      option.textContent = member.name;
      if (member.actor_id === task.reviewer_actor_id) currentOption = option;
      select.append(option);
      hasOption = true;
    }
    if (hasOption) {
      if (currentOption) select.value = currentOption.value;
      const assign = document.createElement('button');
      assign.type = 'button';
      assign.textContent = '改派验收人';
      assign.addEventListener('click', function () {
        if (!select.value) {
          error.textContent = '没有可改派的成员';
          return;
        }
        run(function () {
          return callTool('network_task_reviewer_set', {
            request_id: requestId('task_reviewer_set'),
            task_id: task.task_id,
            reviewer_actor_id: select.value,
            expected_revision: task.revision
          });
        }, '改派验收人失败');
      });
      actions.append(select, assign);
    }
  }
  if (taskCanCreate() && (task.status === 'accepted' || task.status === 'cancelled')) {
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.textContent = '追加任务';
    follow.addEventListener('click', function () {
      openTaskCreate({ parentTaskId: task.task_id });
    });
    actions.append(follow);
  }
}

if (taskReviewForm) taskReviewForm.addEventListener('submit', submitTaskReview);
if (taskReviewCancel) taskReviewCancel.addEventListener('click', closeTaskReview);
if (taskReviewClose) taskReviewClose.addEventListener('click', closeTaskReview);
`;
