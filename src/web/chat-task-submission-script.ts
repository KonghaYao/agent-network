/**
 * D06 成果提交片段：详情版本、提交表单、提交历史与退回入口。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与任务片段共享作用域。
 * 所有文本用 textContent 写入；材料只列房间已绑定文件，提交后由服务端复核
 * 可见性并冻结 sha256/size/mime。外链只作为提交者声明的证据，不抓取。
 */
import { LIMITS } from '../contracts/limits';

export const CHAT_TASK_SUBMISSION_SCRIPT = `
const taskSubmitModal = document.getElementById('task-submit-modal');
const taskSubmitForm = document.getElementById('task-submit-form');
const taskSubmitSummary = document.getElementById('task-submit-summary');
const taskSubmitMaterialsStatus = document.getElementById('task-submit-materials-status');
const taskSubmitMaterials = document.getElementById('task-submit-materials');
const taskSubmitLinks = document.getElementById('task-submit-links');
const taskSubmitAddLink = document.getElementById('task-submit-add-link');
const taskSubmitCommitSha = document.getElementById('task-submit-commit-sha');
const taskSubmitEvidence = document.getElementById('task-submit-evidence');
const taskSubmitKnownLimits = document.getElementById('task-submit-known-limits');
const taskSubmitError = document.getElementById('task-submit-error');
const taskSubmitCancel = document.getElementById('task-submit-cancel');
const taskSubmitClose = document.getElementById('task-submit-close');
const TASK_SUBMISSION_STATUS_LABELS = {
  pending: '待验收',
  accepted: '已验收',
  returned: '已退回',
  superseded: '已被替代'
};
let taskSubmitTask = null;
let taskSubmitRoomId = null;
let taskSubmitMaterialsSeq = 0;
let taskSubmissionHistorySeq = 0;

function taskSubmissionStatusLabel(status) {
  return TASK_SUBMISSION_STATUS_LABELS[status] || String(status || '未知');
}

function taskSubmissionTime(value) {
  return value ? taskTimeLabel(value) : '';
}

function taskSubmissionBadge(task) {
  if (!task || !task.current_submission) return null;
  const current = task.current_submission;
  const badge = document.createElement('span');
  badge.className = 'task-submission-version' +
    (current.status === 'pending' ? ' pending' : '');
  badge.textContent = 'v' + current.version;
  badge.title = '当前成果 v' + current.version + ' · ' +
    taskSubmissionStatusLabel(current.status) +
    (current.submitted_at ? ' · ' + taskSubmissionTime(current.submitted_at) : '');
  return badge;
}

function appendTaskSubmissionBadge(container, task) {
  const badge = taskSubmissionBadge(task);
  if (container && badge) container.append(badge);
}

function appendTaskSubmissionDetail(task) {
  if (!task || !task.current_submission) return;
  const current = task.current_submission;
  const dd = taskDetailRow('当前成果', '');
  if (dd) {
    const badge = document.createElement('span');
    badge.className = 'task-submission-version' +
      (current.status === 'pending' ? ' pending' : '');
    badge.textContent = 'v' + current.version + ' · ' +
      taskSubmissionStatusLabel(current.status);
    dd.append(badge);
    const time = taskSubmissionTime(current.submitted_at);
    if (time) {
      const meta = document.createElement('span');
      meta.className = 'task-submission-time';
      meta.textContent = ' · ' + time;
      dd.append(meta);
    }
  }
  const history = taskDetailRow('提交历史', '');
  if (history) loadTaskSubmissionHistory(task, history);
}

async function loadTaskSubmissionHistory(task, target) {
  const seq = ++taskSubmissionHistorySeq;
  target.textContent = '正在读取…';
  try {
    const result = await callTool('network_task_submission_list', {
      task_id: task.task_id,
      limit: 20
    });
    if (
      seq !== taskSubmissionHistorySeq ||
      !taskDetailCurrent ||
      taskDetailCurrent.task_id !== task.task_id
    ) {
      return;
    }
    const submissions = Array.isArray(result.submissions) ? result.submissions : [];
    target.replaceChildren();
    if (submissions.length === 0) {
      target.textContent = '暂无提交';
      return;
    }
    const list = document.createElement('ul');
    list.className = 'task-submission-history';
    for (const submission of submissions) {
      const item = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'task-submission-history-head';
      head.textContent = 'v' + submission.version + ' · ' +
        taskSubmissionStatusLabel(submission.status) +
        ' · ' + taskSubmissionTime(submission.submitted_at);
      item.append(head);
      if (submission.summary) {
        const summary = document.createElement('div');
        summary.className = 'task-submission-history-summary';
        summary.textContent = submission.summary;
        item.append(summary);
      }
      if (submission.review && submission.review.reason) {
        const review = document.createElement('div');
        review.className = 'task-submission-history-review';
        review.textContent = '退回原因：' + submission.review.reason;
        item.append(review);
      }
      list.append(item);
      if (submission.review && submission.review.checklist) {
        for (const entry of submission.review.checklist) {
          const checklist = document.createElement('div');
          checklist.className = 'task-submission-history-checklist' +
            (entry.passed ? '' : ' failed');
          checklist.textContent = (entry.passed ? '✓ ' : '✗ ') + entry.item +
            (entry.note ? ' — ' + entry.note : '');
          item.append(checklist);
        }
      }
    }
    target.append(list);
  } catch (error) {
    if (seq !== taskSubmissionHistorySeq) return;
    target.textContent = '读取提交历史失败：' +
      (error && error.message ? error.message : error);
  }
}

function renderTaskSubmissionActions(task, actions, run, error) {
  if (!task || !actions) return;
  if (task.can_submit) {
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'primary';
    submit.textContent = '提交成果';
    submit.addEventListener('click', function () {
      openTaskSubmit(task);
    });
    actions.append(submit);
  }
  if (task.can_return && task.current_submission) {
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.className = 'task-cancel-reason';
    reason.maxLength = 300;
    reason.placeholder = '退回原因（必填，需可行动）';
    reason.setAttribute('aria-label', '退回原因');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'danger';
    back.textContent = '退回 v' + task.current_submission.version;
    back.addEventListener('click', function () {
      if (!reason.value.trim()) {
        error.textContent = '请填写退回原因';
        return;
      }
      run(function () {
        return callTool('network_task_review_return', {
          request_id: requestId('task_review_return'),
          task_id: task.task_id,
          submission_id: task.current_submission.submission_id,
          version: task.current_submission.version,
          reason: reason.value.trim(),
          expected_revision: task.revision
        });
      }, '退回失败');
    });
    actions.append(reason, back);
  }
}

function closeTaskSubmit() {
  taskSubmitMaterialsSeq += 1;
  taskSubmitTask = null;
  taskSubmitRoomId = null;
  if (taskSubmitModal) taskSubmitModal.hidden = true;
  if (taskSubmitError) taskSubmitError.textContent = '';
}

async function openTaskSubmit(task) {
  if (!taskSubmitModal || !taskSubmitForm || !task) return;
  if (task.status !== 'in_progress' || !task.can_submit) return;
  taskSubmitTask = task;
  taskSubmitRoomId = task.room_id;
  taskSubmitForm.reset();
  if (taskSubmitLinks) taskSubmitLinks.replaceChildren();
  if (taskSubmitMaterials) taskSubmitMaterials.replaceChildren();
  if (taskSubmitError) taskSubmitError.textContent = '';
  addTaskSubmitLinkRow();
  taskSubmitModal.hidden = false;
  if (taskSubmitSummary) taskSubmitSummary.focus();
  await loadTaskSubmitMaterials(task.room_id);
}

function taskSubmitMaterialRow(file) {
  const item = document.createElement('li');
  item.className = 'task-submit-material';
  const choice = document.createElement('label');
  choice.className = 'task-submit-material-choice';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = file.file_id;
  const name = document.createElement('span');
  name.className = 'task-submit-material-name';
  name.textContent = file.name;
  const meta = document.createElement('span');
  meta.className = 'task-submit-material-meta';
  meta.textContent = (file.mime_type || '文件') + ' · ' + String(file.size) + ' B' +
    (file.retained ? ' · 已保留' : '');
  choice.append(checkbox, name, meta);
  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'task-submit-material-label';
  label.maxLength = 200;
  label.placeholder = '材料标签（可选）';
  label.setAttribute('aria-label', '材料标签：' + file.name);
  item.append(choice, label);
  return item;
}

async function loadTaskSubmitMaterials(roomId) {
  if (!taskSubmitMaterials || !taskSubmitMaterialsStatus) return;
  const seq = ++taskSubmitMaterialsSeq;
  taskSubmitMaterials.replaceChildren();
  taskSubmitMaterialsStatus.textContent = '正在读取房间文件…';
  try {
    const result = await callTool('network_room_file_list', {
      room_id: roomId,
      limit: 100
    });
    if (
      seq !== taskSubmitMaterialsSeq ||
      !taskSubmitModal ||
      taskSubmitModal.hidden ||
      taskSubmitRoomId !== roomId
    ) {
      return;
    }
    const files = Array.isArray(result.items) ? result.items : [];
    if (files.length === 0) {
      taskSubmitMaterialsStatus.textContent =
        '房间没有已绑定文件；请先在聊天中上传并绑定文件，或只用外链/证据提交。';
      return;
    }
    taskSubmitMaterialsStatus.textContent =
      '选择要冻结到该版本的文件（最多 ' + ${LIMITS.taskSubmissionMaterialsMax} + ' 个）。';
    for (const file of files) taskSubmitMaterials.append(taskSubmitMaterialRow(file));
  } catch (error) {
    if (seq !== taskSubmitMaterialsSeq) return;
    taskSubmitMaterialsStatus.textContent = '读取房间文件失败：' +
      (error && error.message ? error.message : error);
  }
}

function addTaskSubmitLinkRow() {
  if (!taskSubmitLinks) return;
  if (taskSubmitLinks.children.length >= ${LIMITS.taskSubmissionLinksMax}) {
    if (taskSubmitError) taskSubmitError.textContent = '外链数量已达上限';
    return;
  }
  const row = document.createElement('div');
  row.className = 'task-submit-link-row';
  const url = document.createElement('input');
  url.type = 'url';
  url.className = 'task-submit-link-url';
  url.placeholder = 'https://…';
  url.setAttribute('aria-label', '外链 URL');
  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'task-submit-link-title';
  title.placeholder = '标题（可选）';
  title.setAttribute('aria-label', '外链标题');
  const version = document.createElement('input');
  version.type = 'text';
  version.className = 'task-submit-link-version';
  version.placeholder = '目标版本（可选）';
  version.setAttribute('aria-label', '外链目标版本');
  const digest = document.createElement('input');
  digest.type = 'text';
  digest.className = 'task-submit-link-digest';
  digest.placeholder = '摘要/校验值（可选）';
  digest.setAttribute('aria-label', '外链摘要或校验值');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link-btn';
  remove.textContent = '移除';
  remove.addEventListener('click', function () { row.remove(); });
  row.append(url, title, version, digest, remove);
  taskSubmitLinks.append(row);
}

function collectTaskSubmitMaterials() {
  const materials = [];
  if (!taskSubmitMaterials) return materials;
  for (const item of taskSubmitMaterials.querySelectorAll('.task-submit-material')) {
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (!checkbox || !checkbox.checked) continue;
    const label = item.querySelector('.task-submit-material-label');
    const material = { file_id: checkbox.value };
    if (label && label.value.trim()) material.label = label.value.trim();
    materials.push(material);
  }
  return materials;
}

function collectTaskSubmitLinks() {
  const links = [];
  if (!taskSubmitLinks) return links;
  for (const row of taskSubmitLinks.querySelectorAll('.task-submit-link-row')) {
    const url = row.querySelector('.task-submit-link-url');
    const title = row.querySelector('.task-submit-link-title');
    const version = row.querySelector('.task-submit-link-version');
    const digest = row.querySelector('.task-submit-link-digest');
    const values = {
      url: url ? url.value.trim() : '',
      title: title ? title.value.trim() : '',
      version: version ? version.value.trim() : '',
      digest: digest ? digest.value.trim() : ''
    };
    if (!values.url) {
      if (values.title || values.version || values.digest) {
        throw new Error('请填写外链 URL，或移除只填了标题/版本的行');
      }
      continue;
    }
    const link = { url: values.url, availability: 'unverified' };
    if (values.title) link.title = values.title;
    if (values.version) link.version = values.version;
    if (values.digest) link.digest = values.digest;
    links.push(link);
  }
  return links;
}

async function submitTaskSubmission(event) {
  if (event) event.preventDefault();
  if (!taskSubmitForm || !taskSubmitTask) return;
  const task = taskSubmitTask;
  if (taskSubmitRoomId !== task.room_id) {
    closeTaskSubmit();
    return;
  }
  if (taskSubmitError) taskSubmitError.textContent = '';
  const summary = taskSubmitSummary ? taskSubmitSummary.value.trim() : '';
  if (!summary) {
    if (taskSubmitError) taskSubmitError.textContent = '请填写成果摘要';
    return;
  }
  let materials;
  let links;
  try {
    materials = collectTaskSubmitMaterials();
    links = collectTaskSubmitLinks();
  } catch (error) {
    if (taskSubmitError) taskSubmitError.textContent = error.message;
    return;
  }
  const evidenceText = taskSubmitEvidence ? taskSubmitEvidence.value : '';
  const evidence = evidenceText
    .split('\\n')
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; });
  const commitSha = taskSubmitCommitSha ? taskSubmitCommitSha.value.trim() : '';
  const knownLimits = taskSubmitKnownLimits ? taskSubmitKnownLimits.value.trim() : '';
  if (
    materials.length === 0 &&
    links.length === 0 &&
    evidence.length === 0 &&
    !commitSha
  ) {
    if (taskSubmitError) {
      taskSubmitError.textContent =
        '请至少提供材料、外链、验证证据或实现提交 SHA 中的一项';
    }
    return;
  }
  const args = {
    request_id: requestId('task_submit'),
    task_id: task.task_id,
    summary: summary,
    expected_revision: task.revision
  };
  if (materials.length > 0) args.materials = materials;
  if (links.length > 0) args.links = links;
  if (evidence.length > 0) args.evidence = evidence;
  if (commitSha) args.commit_sha = commitSha;
  if (knownLimits) args.known_limits = knownLimits;
  if (task.assignment) {
    args.assignment_id = task.assignment.assignment_id;
    args.assignment_version = task.assignment.assignment_version;
  }
  const submit = taskSubmitForm.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const result = await callTool('network_task_submit', args);
    closeTaskSubmit();
    if (statusElement) statusElement.textContent = '成果已提交，等待验收';
    renderTaskDetail(result.task);
    await loadTaskSummary().catch(function () {});
    if (activeRoomId === result.task.room_id) {
      loadRoomTasks(activeRoomId, roomEpoch);
    }
    syncTaskCardMarkers(messagesElement);
  } catch (error) {
    if (taskSubmitError) {
      taskSubmitError.textContent = '提交失败：' +
        (error && error.message ? error.message : error);
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

if (taskSubmitForm) taskSubmitForm.addEventListener('submit', submitTaskSubmission);
if (taskSubmitCancel) taskSubmitCancel.addEventListener('click', closeTaskSubmit);
if (taskSubmitClose) taskSubmitClose.addEventListener('click', closeTaskSubmit);
if (taskSubmitAddLink) taskSubmitAddLink.addEventListener('click', addTaskSubmitLinkRow);
`;
