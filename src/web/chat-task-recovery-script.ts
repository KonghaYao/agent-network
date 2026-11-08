/**
 * D08 任务恢复片段：失败重试、外部执行未知与对账恢复。
 *
 * 与 `chat-tasks-script.ts` 拼进同一个内联 `<script>` 共享作用域；拆出只为
 * 控制单文件行数。所有输入都用 textContent/value，不使用 innerHTML。
 */
export const CHAT_TASK_RECOVERY_SCRIPT = `
function taskRecoveryInput(placeholder, className) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-cancel-reason ' + (className || '');
  input.maxLength = 512;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  return input;
}

function taskRecoverySelect(label, options) {
  const select = document.createElement('select');
  select.className = 'task-recovery-select';
  select.setAttribute('aria-label', label);
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  }
  return select;
}

function renderTaskRecoveryActions(task, actions, run, error) {
  if (task.can_retry) {
    const reason = taskRecoveryInput('重试原因', 'task-retry-reason');
    const assignee = taskRecoverySelect('重新指派给', [{ value: '', label: '回到待指派' }]);
    for (const member of members.values()) {
      if (identity && member.actor_id === identity.actor_id) continue;
      if (member.actor_id === task.reviewer_actor_id) continue;
      const option = document.createElement('option');
      option.value = member.actor_id;
      option.textContent = member.name;
      assignee.append(option);
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试任务';
    retry.addEventListener('click', function () {
      if (!reason.value.trim()) {
        error.textContent = '请填写重试原因';
        return;
      }
      const args = {
        request_id: requestId('task_retry'),
        task_id: task.task_id,
        reason: reason.value.trim(),
        expected_revision: task.revision
      };
      if (assignee.value) args.assignee_actor_id = assignee.value;
      run(function () {
        return callTool('network_task_retry', args);
      }, '重试失败');
    });
    actions.append(reason, assignee, retry);
  }

  if (task.can_report_execution_unknown) {
    const actionId = taskRecoveryInput('外部 action_id', 'task-execution-action');
    const reason = taskRecoveryInput('结果未知原因', 'task-execution-reason');
    const markUnknown = document.createElement('button');
    markUnknown.type = 'button';
    markUnknown.className = 'danger';
    markUnknown.textContent = '标记执行未知';
    markUnknown.addEventListener('click', function () {
      if (!actionId.value.trim() || !reason.value.trim()) {
        error.textContent = '请填写 action_id 与未知原因';
        return;
      }
      run(function () {
        return callTool('network_task_execution_unknown', {
          request_id: requestId('task_execution_unknown'),
          task_id: task.task_id,
          action_id: actionId.value.trim(),
          reason: reason.value.trim(),
          assignment_id: task.assignment ? task.assignment.assignment_id : undefined,
          assignment_version: task.assignment ? task.assignment.assignment_version : undefined,
          expected_revision: task.revision
        });
      }, '标记执行未知失败');
    });
    actions.append(actionId, reason, markUnknown);
  }

  if (task.can_resolve_execution) {
    const actionId = taskRecoveryInput('待对账 action_id', 'task-execution-resolve-action');
    const outcome = taskRecoverySelect('对账结论', [
      { value: 'confirmed', label: '已确认执行' },
      { value: 'not_executed', label: '确认未执行' },
      { value: 'rejected', label: '目标系统拒绝' }
    ]);
    const evidence = taskRecoveryInput('查询或人工结论证据', 'task-execution-evidence');
    const resolve = document.createElement('button');
    resolve.type = 'button';
    resolve.textContent = '记录对账结论';
    resolve.addEventListener('click', function () {
      if (!actionId.value.trim() || !evidence.value.trim()) {
        error.textContent = '请填写 action_id 与对账证据';
        return;
      }
      run(function () {
        return callTool('network_task_execution_resolve', {
          request_id: requestId('task_execution_resolve'),
          task_id: task.task_id,
          action_id: actionId.value.trim(),
          outcome: outcome.value,
          evidence: evidence.value.trim(),
          assignment_id: task.assignment ? task.assignment.assignment_id : undefined,
          assignment_version: task.assignment ? task.assignment.assignment_version : undefined,
          expected_revision: task.revision
        });
      }, '记录对账结论失败');
    });
    actions.append(actionId, outcome, evidence, resolve);
  }
}
`;
