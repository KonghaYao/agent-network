/**
 * 任务详情面板共享辅助：字段行、消息定位与“在聊天中查看”。
 *
 * 进度、成果、验收与交接脚本都拼进同一个 `<script>` 共享作用域；拆出只为
 * 让 `chat-tasks-script.ts` 保持在 1000 行以内。DOM id/class 与行为不变。
 */

export const CHAT_TASK_DETAIL_SCRIPT = `
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
`;
