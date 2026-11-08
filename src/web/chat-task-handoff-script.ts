/**
 * 任务交接上下文包：版本切换、缺项展示与跨范围授权入口。
 *
 * 与 `chat-tasks-script.ts` 拼进同一个 `<script>` 共享作用域；拆出只为控制
 * 单文件行数。包是否可读、哪些引用可用、能否授权与请求补充全部以服务端
 * 返回为准（`can_authorize` / `can_request_more` / item.status），前端只做
 * 展示。跨范围未授权项不生成 URL，重新读取后才反映授权、撤回、删除或
 * 失权变化；本脚本不缓存包内容。
 */

export const CHAT_TASK_HANDOFF_SCRIPT = `
let taskHandoffLoadSeq = 0;
const TASK_HANDOFF_KIND_LABELS = {
  message: '消息',
  file: '文件',
  branch: '分支',
  commit: '提交',
  test: '测试',
  submission: '成果版本'
};
const TASK_HANDOFF_STATUS_LABELS = {
  available: '可用',
  missing: '缺失',
  omitted: '未授权'
};

function taskHandoffCanManage(task) {
  if (!task || !identity || !room) return false;
  if (task.room_id !== room.room_id) return false;
  if (task.status !== 'in_progress' && task.status !== 'blocked') return false;
  if (!task.assignment || task.assignment.status !== 'active') return false;
  return task.assignment.owner_actor_id === identity.actor_id &&
    task.owner_actor_id === identity.actor_id;
}

function taskHandoffError(panel) {
  return panel ? panel.querySelector('.task-handoff-error') : null;
}

function taskHandoffPanel() {
  const panel = document.createElement('section');
  panel.className = 'task-handoff-panel';
  panel.id = 'task-handoff-panel';
  panel.setAttribute('aria-label', '交接上下文包');
  const heading = document.createElement('h3');
  heading.className = 'task-handoff-title';
  heading.textContent = '交接上下文包';
  const error = document.createElement('p');
  error.className = 'task-handoff-error';
  error.setAttribute('role', 'alert');
  const body = document.createElement('div');
  body.className = 'task-handoff-body';
  panel.append(heading, error, body);
  return panel;
}

function taskHandoffBlock(title, text) {
  const block = document.createElement('div');
  block.className = 'task-handoff-block';
  const heading = document.createElement('div');
  heading.className = 'task-handoff-block-title';
  heading.textContent = title;
  const value = document.createElement('div');
  value.className = 'task-handoff-block-text';
  value.textContent = text;
  block.append(heading, value);
  return block;
}

function taskHandoffListBlock(title, items) {
  if (!items || items.length === 0) return null;
  const block = document.createElement('div');
  block.className = 'task-handoff-block';
  const heading = document.createElement('div');
  heading.className = 'task-handoff-block-title';
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'task-handoff-list';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  block.append(heading, list);
  return block;
}

function taskHandoffVersionBar(task, pack) {
  const bar = document.createElement('div');
  bar.className = 'task-handoff-versions';
  const label = document.createElement('span');
  label.className = 'task-handoff-version-label';
  label.textContent = '版本';
  bar.append(label);
  const versions = Array.isArray(pack.versions) && pack.versions.length > 0
    ? pack.versions
    : [pack.version];
  for (const version of versions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-handoff-version' +
      (version === pack.version ? ' task-handoff-version-active' : '');
    button.textContent = 'v' + version;
    button.setAttribute('aria-pressed', version === pack.version ? 'true' : 'false');
    button.addEventListener('click', function () {
      if (version === pack.version) return;
      renderTaskHandoffSection(task, version);
    });
    bar.append(button);
  }
  return bar;
}

function taskHandoffStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = 'task-handoff-badge task-handoff-badge-' + status;
  badge.textContent = TASK_HANDOFF_STATUS_LABELS[status] || String(status);
  return badge;
}

function taskHandoffItem(task, pack, item, panel) {
  const li = document.createElement('li');
  li.className = 'task-handoff-item task-handoff-item-' + item.status;

  const head = document.createElement('div');
  head.className = 'task-handoff-item-head';
  const title = document.createElement('strong');
  title.textContent = (TASK_HANDOFF_KIND_LABELS[item.kind] || item.kind) +
    '：' + (item.label || item.ref);
  head.append(title, taskHandoffStatusBadge(item.status));
  li.append(head);

  const meta = [];
  if (item.source_scope === 'external') meta.push('跨范围引用');
  if (item.required) meta.push('必需');
  if (item.authorized_by_name) {
    meta.push('授权人：' + item.authorized_by_name);
  } else if (item.revoked_at) {
    meta.push('授权已撤回');
  }
  if (meta.length > 0) {
    const metaLine = document.createElement('div');
    metaLine.className = 'task-handoff-item-meta';
    metaLine.textContent = meta.join(' · ');
    li.append(metaLine);
  }

  if (item.summary) {
    const summary = document.createElement('div');
    summary.className = 'task-handoff-item-text';
    summary.textContent = item.summary;
    li.append(summary);
  }

  if (item.file) {
    const file = document.createElement('div');
    file.className = 'task-handoff-item-text';
    const bits = [item.file.name, item.file.mime_type, String(item.file.size) + ' B'];
    file.textContent = bits.join(' · ');
    const url = item.file.download_url || item.file.public_url;
    if (url) {
      const link = document.createElement('a');
      link.className = 'task-handoff-file';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '打开文件';
      file.append(' ', link);
    }
    li.append(file);
  }

  if (item.message) {
    const message = document.createElement('div');
    message.className = 'task-handoff-item-text';
    message.textContent = '摘要：' + item.message.preview;
    li.append(message);
  }

  if (item.submission) {
    const submission = document.createElement('div');
    submission.className = 'task-handoff-item-text';
    submission.textContent = '成果版本 v' + item.submission.version +
      '（' + item.submission.status + '）';
    li.append(submission);
  }

  if (item.reason) {
    const reason = document.createElement('div');
    reason.className = 'task-handoff-item-reason';
    reason.textContent = item.reason;
    li.append(reason);
  }

  const canAuthorize = pack.can_authorize && taskHandoffCanManage(task) &&
    item.source_scope === 'external' &&
    (item.kind === 'message' || item.kind === 'file');
  if (canAuthorize) {
    const actions = document.createElement('div');
    actions.className = 'row modal-actions task-handoff-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.authorized ? '撤回授权' : '授权给接任者';
    button.addEventListener('click', function () {
      runTaskHandoffAuthorize(panel, task, pack, item, item.authorized ? 'revoke' : 'grant');
    });
    actions.append(button);
    li.append(actions);
  }

  return li;
}

function taskHandoffMissingBlock(title, gaps) {
  if (!gaps || gaps.length === 0) return null;
  const block = document.createElement('div');
  block.className = 'task-handoff-block';
  const heading = document.createElement('div');
  heading.className = 'task-handoff-block-title';
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'task-handoff-list';
  for (const gap of gaps) {
    const li = document.createElement('li');
    li.textContent = (TASK_HANDOFF_KIND_LABELS[gap.kind] || gap.kind) +
      '：' + (gap.label || gap.ref) +
      (gap.required ? '（必需）' : '') + ' — ' + gap.reason;
    list.append(li);
  }
  block.append(heading, list);
  return block;
}

function taskHandoffRequestBlock(task, pack, panel, body) {
  if (!pack.can_request_more) return;
  if (!taskHandoffCanManage(task) && !pack.viewer_is_successor) return;
  const form = document.createElement('div');
  form.className = 'task-handoff-request-form';
  const input = document.createElement('textarea');
  input.className = 'task-handoff-request-note';
  input.rows = 2;
  input.maxLength = 2000;
  input.placeholder = '说明缺少哪些上下文（必填）';
  input.setAttribute('aria-label', '补充上下文说明');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '请求补充上下文';
  button.addEventListener('click', function () {
    runTaskHandoffRequestMore(task, pack, panel, input);
  });
  form.append(input, button);
  body.append(form);
}

function runTaskHandoffAuthorize(panel, task, pack, item, action) {
  const buttons = panel.querySelectorAll('button');
  buttons.forEach(function (button) { button.disabled = true; });
  const error = taskHandoffError(panel);
  if (error) error.textContent = '';
  const args = {
    request_id: requestId('task_handoff_authorize'),
    task_id: task.task_id,
    pack_id: pack.pack_id,
    item_id: item.item_id,
    action: action,
    assignment_id: task.assignment.assignment_id,
    assignment_version: task.assignment.assignment_version,
    expected_revision: task.revision
  };
  callTool('network_task_handoff_pack_authorize', args)
    .then(function () {
      return renderTaskHandoffSection(task, pack.version);
    })
    .catch(function (caught) {
      const code = caught && caught.code ? String(caught.code) : '';
      const message = caught && caught.message ? caught.message : caught;
      if (
        code === 'ASSIGNMENT_STALE' ||
        code === 'VERSION_CONFLICT' ||
        code === 'CONFLICT' ||
        code === 'NOT_FOUND' ||
        code === 'FILE_UNAVAILABLE' ||
        code === 'IDEMPOTENCY_CONFLICT'
      ) {
        renderTaskHandoffSection(task, pack.version).then(function () {
          const fresh = document.getElementById('task-handoff-panel');
          const freshError = taskHandoffError(fresh);
          if (freshError) freshError.textContent = '授权失败：' + message;
        });
        return;
      }
      buttons.forEach(function (button) { button.disabled = false; });
      if (error) error.textContent = '授权失败：' + message;
    });
}

function runTaskHandoffRequestMore(task, pack, panel, input) {
  const note = input.value.trim();
  const error = taskHandoffError(panel);
  if (error) error.textContent = '';
  if (!note) {
    if (error) error.textContent = '请先填写需要补充的上下文说明';
    return;
  }
  const buttons = panel.querySelectorAll('button');
  buttons.forEach(function (button) { button.disabled = true; });
  const args = {
    request_id: requestId('task_handoff_request_more'),
    task_id: task.task_id,
    pack_id: pack.pack_id,
    note: note
  };
  if (taskHandoffCanManage(task)) {
    args.assignment_id = task.assignment.assignment_id;
    args.assignment_version = task.assignment.assignment_version;
    args.expected_revision = task.revision;
  }

  let transferLookup = Promise.resolve(null);
  if (!taskHandoffCanManage(task) && pack.viewer_is_successor) {
    transferLookup = callTool('network_task_transfer_list', { task_id: task.task_id })
      .then(function (result) {
        const transfers = Array.isArray(result.transfers) ? result.transfers : [];
        return transfers.find(function (transfer) {
          return transfer.effective_status === 'pending' &&
            transfer.to_actor_id === identity.actor_id;
        }) || null;
      });
  }

  transferLookup
    .then(function (transfer) {
      if (!taskHandoffCanManage(task)) {
        if (!transfer) throw new Error('未找到待接受的交接提议');
        args.transfer_id = transfer.transfer_id;
      }
      return callTool('network_task_handoff_pack_request_more', args);
    })
    .then(function () {
      return renderTaskHandoffSection(task, pack.version);
    })
    .catch(function (caught) {
      buttons.forEach(function (button) { button.disabled = false; });
      const message = caught && caught.message ? caught.message : caught;
      if (error) error.textContent = '请求补充上下文失败：' + message;
    });
}

function taskHandoffRenderPack(task, pack, panel, body) {
  body.append(taskHandoffVersionBar(task, pack));

  const head = document.createElement('div');
  head.className = 'task-handoff-pack-meta';
  const creator = pack.created_by_name || pack.created_by;
  const from = pack.from_owner_name || pack.from_owner_actor_id || '上一执行者';
  head.textContent = '由 ' + creator + ' 于 ' + fullTime(pack.created_at) +
    ' 生成 · 原执行版本 v' + pack.from_assignment_version + ' · ' + from;
  body.append(head);

  const readiness = document.createElement('div');
  readiness.className = 'task-handoff-readiness ' +
    (pack.context_ready ? 'task-handoff-readiness-ready' : 'task-handoff-readiness-incomplete');
  readiness.textContent = pack.context_ready
    ? '上下文完整'
    : '上下文不完整：' + pack.required_missing.length + ' 项必需引用不可用';
  body.append(readiness);

  body.append(taskHandoffBlock('目标', pack.goal));
  const completed = taskHandoffListBlock('已完成', pack.completed);
  if (completed) body.append(completed);

  const resultText = pack.current_result.summary +
    (pack.current_result.submission_id
      ? '（成果 v' + (pack.current_result.submission_version || '?') +
        '，' + (pack.current_result.submission_status || '未知') + '）'
      : '');
  body.append(taskHandoffBlock('当前结果', resultText));

  const unresolved = taskHandoffListBlock('未解决', pack.unresolved);
  if (unresolved) body.append(unresolved);
  const nextSteps = taskHandoffListBlock('下一步', pack.next_steps);
  if (nextSteps) body.append(nextSteps);

  if (pack.items.length > 0) {
    const block = document.createElement('div');
    block.className = 'task-handoff-block';
    const heading = document.createElement('div');
    heading.className = 'task-handoff-block-title';
    heading.textContent = '引用与证据';
    const list = document.createElement('ul');
    list.className = 'task-handoff-items';
    for (const item of pack.items) {
      list.append(taskHandoffItem(task, pack, item, panel));
    }
    block.append(heading, list);
    body.append(block);
  }

  const missing = taskHandoffMissingBlock('缺失项', pack.missing);
  if (missing) body.append(missing);
  const omitted = taskHandoffMissingBlock('未授权/已撤回项', pack.omitted);
  if (omitted) body.append(omitted);

  if (pack.requests.length > 0) {
    const block = document.createElement('div');
    block.className = 'task-handoff-block';
    const heading = document.createElement('div');
    heading.className = 'task-handoff-block-title';
    heading.textContent = '补充上下文请求';
    const list = document.createElement('ul');
    list.className = 'task-handoff-requests';
    for (const request of pack.requests) {
      const li = document.createElement('li');
      li.textContent = (request.requested_by_name || request.requested_by) +
        ' · ' + fullTime(request.created_at) + '：' + request.note;
      list.append(li);
    }
    block.append(heading, list);
    body.append(block);
  }

  taskHandoffRequestBlock(task, pack, panel, body);
}

async function renderTaskHandoffSection(task, version) {
  if (!taskDetailActionsElement || !task) return;
  const previous = taskDetailActionsElement.querySelector('.task-handoff-panel');
  if (previous) previous.remove();
  const panel = taskHandoffPanel();
  taskDetailActionsElement.append(panel);
  const body = panel.querySelector('.task-handoff-body');
  const seq = ++taskHandoffLoadSeq;
  const args = { task_id: task.task_id };
  if (version) args.version = version;

  let pack = null;
  try {
    const result = await callTool('network_task_handoff_pack_get', args);
    if (seq !== taskHandoffLoadSeq) return;
    pack = result && result.pack ? result.pack : null;
  } catch (caught) {
    if (seq !== taskHandoffLoadSeq) return;
    panel.remove();
    return;
  }
  if (seq !== taskHandoffLoadSeq || !pack) {
    if (seq === taskHandoffLoadSeq) panel.remove();
    return;
  }
  taskHandoffRenderPack(task, pack, panel, body);
}
`;
