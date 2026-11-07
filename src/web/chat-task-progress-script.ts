/**
 * 任务业务状态的进度展示与负责人操作。
 *
 * 与 `chat-tasks-script.ts` 拼进同一个 `<script>` 共享作用域；拆出只为控制
 * 单文件行数。状态文案优先使用服务端返回的 `status_label` /
 * `status_hint` / `progress`，前端不维护第二套状态表；delivery 状态不会在
 * 这里映射成业务状态。
 */

export const CHAT_TASK_PROGRESS_SCRIPT = `
function taskStatusText(task) {
  if (task && task.status_label) return String(task.status_label);
  return taskStatusLabel(task && task.status ? task.status : task);
}

function taskProgressSummary(task) {
  const progress = task && task.progress;
  if (!progress) return '';
  const parts = [];
  if (typeof progress.percent === 'number') parts.push(progress.percent + '%');
  const note = progress.blocked_reason || progress.note;
  if (note) {
    const text = String(note).replace(/\\s+/g, ' ').trim();
    parts.push(text.length > 60 ? text.slice(0, 60) + '…' : text);
  }
  return parts.join(' · ');
}

function taskProgressBarElement(progress) {
  const wrap = document.createElement('div');
  wrap.className = 'task-progress';
  const percent = progress && typeof progress.percent === 'number'
    ? Math.max(0, Math.min(100, progress.percent))
    : null;
  if (percent !== null) {
    const bar = document.createElement('div');
    bar.className = 'task-progress-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent));
    const fill = document.createElement('div');
    fill.className = 'task-progress-fill';
    fill.style.width = percent + '%';
    bar.append(fill);
    wrap.append(bar);
  }
  const meta = document.createElement('div');
  meta.className = 'task-progress-meta';
  const parts = [];
  if (progress && progress.status_label) parts.push(progress.status_label);
  if (progress && progress.actor_name) parts.push(progress.actor_name);
  if (progress && progress.created_at) parts.push(taskTimeLabel(progress.created_at));
  meta.textContent = parts.join(' · ');
  if (meta.textContent) wrap.append(meta);
  return wrap;
}

function appendTaskProgressDetail(task) {
  if (task.status_hint) {
    const hint = taskDetailRow('状态说明', task.status_hint);
    if (hint) hint.className = 'task-status-hint';
  }
  if (task.status === 'blocked' && task.blocked_reason) {
    const reason = taskDetailRow('阻塞原因', task.blocked_reason);
    if (reason) reason.className = 'task-long-text task-block-reason';
  }
  const progress = task.progress;
  if (progress) {
    const dd = taskDetailRow('最新进度', '');
    if (dd) {
      dd.append(taskProgressBarElement(progress));
      if (progress.percent === null && progress.note) {
        const note = document.createElement('div');
        note.className = 'task-progress-note';
        note.textContent = progress.note;
        dd.append(note);
      }
    }
  }
  if (task.progress_history && task.progress_history.length > 0) {
    const dd = taskDetailRow('进度历史', '');
    if (dd) {
      const list = document.createElement('ul');
      list.className = 'task-progress-history';
      for (const entry of task.progress_history) {
        const item = document.createElement('li');
        const head = document.createElement('span');
        head.className = 'task-progress-history-head';
        const bits = ['r' + entry.revision];
        if (entry.percent !== null && entry.percent !== undefined) bits.push(entry.percent + '%');
        bits.push(entry.prior_status_label + ' → ' + entry.status_label);
        head.textContent = bits.join(' · ');
        item.append(head);
        if (entry.note) {
          const note = document.createElement('div');
          note.className = 'task-progress-note';
          note.textContent = entry.note;
          item.append(note);
        }
        if (entry.blocked_reason) {
          const reason = document.createElement('div');
          reason.className = 'task-progress-note task-block-reason';
          reason.textContent = '阻塞：' + entry.blocked_reason;
          item.append(reason);
        }
        const meta = document.createElement('div');
        meta.className = 'task-progress-meta';
        meta.textContent = [entry.actor_name, taskTimeLabel(entry.created_at)]
          .filter(Boolean)
          .join(' · ');
        if (meta.textContent) item.append(meta);
        list.append(item);
      }
      dd.append(list);
    }
  }
}

function taskProgressInput(placeholder, className, maxLength) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-cancel-reason ' + (className || '');
  input.maxLength = maxLength || 2000;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  return input;
}

function renderTaskProgressActions(task, actions, run, error) {
  if (task.can_report_progress) {
    const note = taskProgressInput('进度说明（可选）', 'task-progress-note-input');
    const percent = document.createElement('input');
    percent.type = 'number';
    percent.min = '0';
    percent.max = '100';
    percent.step = '1';
    percent.className = 'task-cancel-reason task-progress-percent-input';
    percent.placeholder = '进度 %';
    percent.setAttribute('aria-label', '进度百分比');
    const report = document.createElement('button');
    report.type = 'button';
    report.textContent = '更新进度';
    report.addEventListener('click', function () {
      const value = note.value.trim();
      const percentValue = percent.value.trim();
      if (!value && !percentValue) {
        error.textContent = '请填写进度说明或进度百分比';
        return;
      }
      const args = {
        request_id: requestId('task_progress'),
        task_id: task.task_id,
        assignment_id: task.assignment ? task.assignment.assignment_id : undefined,
        assignment_version: task.assignment ? task.assignment.assignment_version : undefined,
        expected_revision: task.revision
      };
      if (value) args.note = value;
      if (percentValue) args.percent = Number(percentValue);
      run(function () {
        return callTool('network_task_progress', args);
      }, '更新进度失败');
    });
    actions.append(note, percent, report);
  }

  if (task.can_block) {
    const reason = taskProgressInput('阻塞原因', 'task-block-input', 1000);
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'danger';
    block.textContent = '报告阻塞';
    block.addEventListener('click', function () {
      if (!reason.value.trim()) {
        error.textContent = '请填写阻塞原因';
        return;
      }
      run(function () {
        return callTool('network_task_block', {
          request_id: requestId('task_block'),
          task_id: task.task_id,
          reason: reason.value.trim(),
          assignment_id: task.assignment ? task.assignment.assignment_id : undefined,
          assignment_version: task.assignment ? task.assignment.assignment_version : undefined,
          expected_revision: task.revision
        });
      }, '报告阻塞失败');
    });
    actions.append(reason, block);
  }

  if (task.can_resume) {
    const note = taskProgressInput('恢复说明（可选）', 'task-resume-input');
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.textContent = '恢复执行';
    resume.addEventListener('click', function () {
      const args = {
        request_id: requestId('task_resume'),
        task_id: task.task_id,
        assignment_id: task.assignment ? task.assignment.assignment_id : undefined,
        assignment_version: task.assignment ? task.assignment.assignment_version : undefined,
        expected_revision: task.revision
      };
      if (note.value.trim()) args.note = note.value.trim();
      run(function () {
        return callTool('network_task_resume', args);
      }, '恢复执行失败');
    });
    actions.append(note, resume);
  }
}
`;
