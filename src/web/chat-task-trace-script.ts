import { LIMITS } from '../contracts/limits';
import { kubaiIcon } from './icons';
import { jsonForScript } from './layout';

/**
 * 消息式 Task 的 Web 客户端片段。
 *
 * 起点消息由 `task_root_id === message_id` 识别；摘要按房间 + 起点批量读取，
 * 只在当前消息页请求，不扫描整段历史。Trace 打开后按 cursor 分页，切房、
 * 关闭或旧请求返回都通过 `roomEpoch` / `taskTraceLoadSeq` 丢弃。
 *
 * 与其他 Web 片段拼进同一个 `<script>` 共享作用域，不使用 innerHTML 写入
 * 任何服务端文本；唯一静态 HTML 是本地 Kubai Task 图标。
 */
export const CHAT_TASK_TRACE_SCRIPT = `
const TASK_ICON_HTML = ${jsonForScript(kubaiIcon('my-tasks', { size: 18 }))};
const TASK_SUMMARY_ROOTS_MAX = ${LIMITS.taskSummaryRootsMax};
const TASK_TRACE_PAGE = ${LIMITS.taskTracePageDefault};
// 摘要缓存只覆盖当前浏览器已看过的根；按 room_id + root_message_id 隔离。
const taskSummaryCache = new Map();
const taskSummaryMissing = new Set();
const taskSummaryFailed = new Set();
const taskSummaryPending = new Set();
// message_id -> Set<节点>；由 messageItem 注册，loadOlder 后直接复用。
let taskMarkerNodes = new Map();
let taskBarSignature = '';
let taskTraceRootId = null;
let taskTraceRoomId = null;
let taskTraceFocusId = null;
let taskTraceItems = [];
let taskTraceNextCursor = null;
let taskTracePrevCursor = null;
let taskTraceHasMoreBefore = false;
let taskTraceHasMoreAfter = false;
let taskTraceMessageCount = 0;
let taskTraceLoadSeq = 0;
const taskTraceDrawerElement = document.getElementById('task-trace-drawer');
const taskTraceTitleElement = document.getElementById('task-trace-title');
const taskTraceMetaElement = document.getElementById('task-trace-meta');
const taskTraceParticipantsElement = document.getElementById('task-trace-participants');
const taskTraceStatusElement = document.getElementById('task-trace-status');
const taskTraceItemsElement = document.getElementById('task-trace-items');
const taskTraceOlderButton = document.getElementById('task-trace-older');
const taskTraceNewerButton = document.getElementById('task-trace-newer');
const taskTraceRefreshButton = document.getElementById('task-trace-refresh');

function taskSummaryKey(roomId, rootMessageId) {
  return String(roomId) + '::' + String(rootMessageId);
}

function taskSummaryOf(rootMessageId) {
  if (!activeRoomId) return null;
  return taskSummaryCache.get(taskSummaryKey(activeRoomId, rootMessageId)) || null;
}

function taskIconElement() {
  const icon = document.createElement('span');
  icon.className = 'task-bar-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = TASK_ICON_HTML;
  return icon;
}

/** 参与 Agent 头像组：首次参与顺序、去重；空间不足时前 N 个 + “+N”。 */
function taskAvatarGroup(summary, visibleMax) {
  const wrap = document.createElement('span');
  wrap.className = 'task-bar-avatars';
  const participants = summary && Array.isArray(summary.participants) ? summary.participants : [];
  const names = participants.map(function (participant) {
    return participant && participant.name ? String(participant.name) : 'Agent';
  });
  const visible = participants.slice(0, visibleMax);
  for (const participant of visible) {
    const name = participant && participant.name ? String(participant.name) : 'Agent';
    const avatar = avatarElement(name, 'agent', 'task-avatar');
    avatar.title = name;
    wrap.append(avatar);
  }
  const total = Math.max(0, Number(summary && summary.participant_count) || participants.length);
  if (total > visible.length) {
    const more = document.createElement('span');
    more.className = 'task-bar-more';
    more.textContent = '+' + (total - visible.length);
    more.title = names.slice(visible.length).join('、') || '更多参与者';
    wrap.append(more);
  }
  wrap.title = names.join('、') || '暂无 Agent 参与';
  return wrap;
}

function taskBarLabel(summary) {
  const preview = String((summary && summary.preview) || 'Task').slice(0, 80);
  return 'Task：' + preview + '，' + (Number(summary && summary.message_count) || 0) + ' 条消息';
}

function renderTaskBar(item, summary, state) {
  const nodes = taskMarkerNodes.get(item.message_id);
  if (!nodes) return;
  for (const node of nodes) {
    const slot = node.querySelector('.msg-task-bar-slot');
    if (!slot) continue;
    if (state === 'missing') {
      slot.replaceChildren();
      slot.hidden = true;
      continue;
    }
    slot.hidden = false;
    if (!summary) {
      const pending = document.createElement('div');
      pending.className = 'task-bar task-bar-pending';
      pending.setAttribute('aria-busy', state === 'failed' ? 'false' : 'true');
      if (state === 'failed') {
        pending.classList.add('task-bar-failed');
        pending.setAttribute('role', 'button');
        pending.tabIndex = 0;
        pending.textContent = 'Task 摘要加载失败，点击重试';
        pending.addEventListener('click', function () { retryTaskBarSummary(item.message_id); });
        pending.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            retryTaskBarSummary(item.message_id);
          }
        });
      } else {
        pending.append(taskIconElement());
        const skeleton = document.createElement('span');
        skeleton.className = 'task-bar-skeleton';
        pending.append(skeleton);
      }
      slot.replaceChildren(pending);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-bar';
    button.dataset.taskRoot = item.message_id;
    button.setAttribute('aria-label', taskBarLabel(summary));
    button.append(taskIconElement(), taskAvatarGroup(summary, 3));
    const preview = document.createElement('span');
    preview.className = 'task-bar-preview';
    preview.textContent = summary.preview || item.preview || '（无正文）';
    const count = document.createElement('span');
    count.className = 'task-bar-count';
    count.textContent = (Number(summary.message_count) || 0) + ' 消息';
    button.append(preview, count);
    button.addEventListener('click', function () {
      openTaskTrace(item.message_id, null);
    });
    slot.replaceChildren(button);
  }
}

function retryTaskBarSummary(rootMessageId) {
  if (!activeRoomId) return;
  const key = taskSummaryKey(activeRoomId, rootMessageId);
  taskSummaryFailed.delete(key);
  taskSummaryMissing.delete(key);
  taskSummaryCache.delete(key);
  refreshTaskBars();
  queueTaskSummaries(activeRoomId, roomEpoch, [rootMessageId]);
}

function queueTaskSummaries(roomId, epoch, rootMessageIds) {
  const chunk = [];
  for (const rootMessageId of rootMessageIds) {
    const key = taskSummaryKey(roomId, rootMessageId);
    if (taskSummaryPending.has(key)) continue;
    taskSummaryPending.add(key);
    chunk.push(rootMessageId);
  }
  for (let start = 0; start < chunk.length; start += TASK_SUMMARY_ROOTS_MAX) {
    const ids = chunk.slice(start, start + TASK_SUMMARY_ROOTS_MAX);
    const requestedSignature = taskBarSignature;
    callTool('network_task_summaries', {
      room_id: roomId,
      root_message_ids: ids
    }, undefined, sessionSignal()).then(function (page) {
      // 先释放 pending；切房后旧响应被丢弃，但下一轮进入该房间仍要能重新请求。
      for (const rootMessageId of ids) {
        taskSummaryPending.delete(taskSummaryKey(roomId, rootMessageId));
      }
      if (!isActiveRoom(roomId, epoch)) return;
      const returned = new Set();
      for (const summary of (page && page.items) || []) {
        if (!summary || !summary.root_message_id) continue;
        const key = taskSummaryKey(roomId, summary.root_message_id);
        taskSummaryCache.set(key, summary);
        taskSummaryMissing.delete(key);
        taskSummaryFailed.delete(key);
        returned.add(summary.root_message_id);
      }
      for (const rootMessageId of ids) {
        if (!returned.has(rootMessageId)) {
          const key = taskSummaryKey(roomId, rootMessageId);
          taskSummaryCache.delete(key);
          taskSummaryMissing.add(key);
        }
      }
      refreshTaskBars();
      // 请求期间消息集合变化时，旧响应可能少算新增消息；按当前页再校验一次。
      if (taskBarSignature !== requestedSignature) {
        queueTaskSummaries(roomId, epoch, ids);
      }
    }).catch(function (error) {
      for (const rootMessageId of ids) {
        const key = taskSummaryKey(roomId, rootMessageId);
        taskSummaryPending.delete(key);
        if (isAbortError(error)) continue;
        taskSummaryCache.delete(key);
        taskSummaryFailed.add(key);
      }
      if (!isAbortError(error) && isActiveRoom(roomId, epoch)) refreshTaskBars();
    });
  }
}

/**
 * 摘要行只跟随当前消息页：起点由 task_root_id === message_id 识别。
 * 每次消息集合变化都让缓存里的旧摘要保持可见并重新校验，计数不会停在旧值。
 */
function refreshTaskBars() {
  if (!activeRoomId || !messagesElement || !currentItems) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const starts = [];
  const startIds = new Set();
  for (const item of currentItems) {
    if (!item || item.kind === 'presence' || !item.message_id) continue;
    if (item.task_root_id && item.task_root_id === item.message_id) {
      starts.push(item);
      startIds.add(item.message_id);
    }
  }
  for (const entry of taskMarkerNodes) {
    if (startIds.has(entry[0])) continue;
    for (const node of entry[1]) {
      const slot = node.querySelector('.msg-task-bar-slot');
      if (slot) {
        slot.replaceChildren();
        slot.hidden = true;
      }
    }
  }
  const signature = roomId + '|' + currentItems.map(function (item) {
    if (!item) return '';
    if (item.kind === 'presence') return 'p:' + (item.presence_event_id || '');
    return (item.message_id || '') + ':' + (item.task_root_id || '') + ':' + (item.body_bytes || 0);
  }).join(',');
  const changed = signature !== taskBarSignature;
  taskBarSignature = signature;
  const request = [];
  for (const item of starts) {
    const key = taskSummaryKey(roomId, item.message_id);
    const summary = taskSummaryCache.get(key) || null;
    if (summary) {
      renderTaskBar(item, summary, null);
      if (changed) request.push(item.message_id);
    } else if (taskSummaryMissing.has(key)) {
      renderTaskBar(item, null, 'missing');
    } else if (taskSummaryFailed.has(key)) {
      renderTaskBar(item, null, 'failed');
    } else {
      renderTaskBar(item, null, null);
      request.push(item.message_id);
    }
  }
  if (changed) {
    for (const rootMessageId of request) taskSummaryFailed.delete(taskSummaryKey(roomId, rootMessageId));
    if (request.length) queueTaskSummaries(roomId, epoch, request);
  }
  if (taskTraceRootId && taskTraceRoomId === roomId) {
    // Trace 可从搜索打开更早的起点；只有当前页确实加载了该起点且已取消标记时才关闭。
    const traceRootItem = currentItems.find(function (item) {
      return item && item.message_id === taskTraceRootId;
    });
    if (traceRootItem && traceRootItem.task_root_id !== traceRootItem.message_id) {
      closeTaskTrace();
    } else {
      const rootVisible = currentItems.some(function (item) {
        return item && (item.message_id === taskTraceRootId ||
          item.task_root_id === taskTraceRootId);
      });
      if (changed && rootVisible) {
        showTaskTraceNewHint();
        // 起点不在当前消息页时不会进入上面的 starts 循环；Trace 头部仍需更新计数。
        if (!traceRootItem) queueTaskSummaries(roomId, epoch, [taskTraceRootId]);
      }
      const summary = taskSummaryCache.get(taskSummaryKey(roomId, taskTraceRootId));
      if (summary) renderTaskTraceHeader(summary);
    }
  }
}

function rememberTaskMarkerNode(messageId, node) {
  let nodes = taskMarkerNodes.get(messageId);
  if (!nodes) {
    nodes = new Set();
    taskMarkerNodes.set(messageId, nodes);
  }
  nodes.add(node);
}

function resetTaskMarkerIndex() {
  taskMarkerNodes = new Map();
  taskBarSignature = '';
  closeTaskTrace();
}

function syncTaskCardMarkers() {
  refreshTaskBars();
}

function taskActionLabel(item) {
  return item && item.task_root_id === item.message_id ? '取消 Task' : '标记为 Task';
}

function roomCanUseTaskAction() {
  if (!room || room.read_only) return false;
  if (room.capabilities && room.capabilities.send_message === false) return false;
  return true;
}

async function updateMessageTask(item, mark) {
  const roomId = activeRoomId;
  if (!roomId || !item) return;
  const epoch = roomEpoch;
  try {
    await callTool(mark ? 'network_task_mark' : 'network_task_unmark', {
      request_id: requestId('task_mark'),
      room_id: roomId,
      message_id: item.message_id
    });
    if (!isActiveRoom(roomId, epoch)) return;
    const target = currentItems.find(function (value) {
      return value && value.message_id === item.message_id;
    }) || item;
    target.task_root_id = mark ? target.message_id : null;
    const key = taskSummaryKey(roomId, item.message_id);
    taskSummaryCache.delete(key);
    taskSummaryMissing.delete(key);
    taskSummaryFailed.delete(key);
    taskBarSignature = '';
    refreshTaskBars();
    showToast(mark ? '已标记为 Task' : '已取消 Task 标记');
    if (!mark && taskTraceRootId === item.message_id) closeTaskTrace();
  } catch (error) {
    if (!isActiveRoom(roomId, epoch)) return;
    const detail = error && (error.message || error.code) ? (error.message || error.code) : '请重试';
    showToast((mark ? '标记失败：' : '取消标记失败：') + detail);
  }
}

/** 服务端 Task 标记事件只改对应消息的归属与摘要，不触发消息未读。 */
function applyMessageTaskChange(event) {
  if (!event || !activeRoomId) return;
  if (event.room_id && event.room_id !== activeRoomId) return;
  const rootId = event.ref_id ? String(event.ref_id) : '';
  if (!rootId) return;
  const marked = event.change === 'marked';
  if (!marked && taskTraceRootId === rootId) closeTaskTrace();
  const item = currentItems.find(function (value) {
    return value && value.message_id === rootId;
  });
  if (!item) return;
  item.task_root_id = marked ? item.message_id : null;
  const key = taskSummaryKey(activeRoomId, rootId);
  taskSummaryCache.delete(key);
  taskSummaryMissing.delete(key);
  taskSummaryFailed.delete(key);
  taskBarSignature = '';
  refreshTaskBars();
}

function renderTaskTraceHeader(summary) {
  if (!summary) return;
  if (taskTraceTitleElement) taskTraceTitleElement.textContent = summary.preview || 'Task';
  if (taskTraceMetaElement) {
    taskTraceMetaElement.textContent = (Number(summary.message_count) || 0) + ' 条消息 · ' +
      (Number(summary.participant_count) || 0) + ' 个 Agent 参与';
  }
  if (!taskTraceParticipantsElement) return;
  taskTraceParticipantsElement.replaceChildren();
  const participants = Array.isArray(summary.participants) ? summary.participants : [];
  for (const participant of participants) {
    const name = participant && participant.name ? String(participant.name) : 'Agent';
    const avatar = avatarElement(name, 'agent', 'task-avatar');
    avatar.title = name;
    taskTraceParticipantsElement.append(avatar);
  }
  if (participants.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'task-trace-participant-name';
    empty.textContent = '暂无 Agent 参与';
    taskTraceParticipantsElement.append(empty);
  }
}

function renderTaskTraceHeaderFallback(item) {
  if (taskTraceTitleElement) {
    taskTraceTitleElement.textContent = (item && item.preview) || 'Task';
  }
  if (taskTraceMetaElement) taskTraceMetaElement.textContent = '正在读取摘要…';
  if (taskTraceParticipantsElement) taskTraceParticipantsElement.replaceChildren();
}

function taskTraceRoleLabel(role) {
  if (role === 'root') return '起点';
  if (role === 'reference') return '引用';
  return '处理';
}

function taskTraceItemElement(item) {
  const element = document.createElement(item.recalled ? 'div' : 'button');
  if (!item.recalled) element.type = 'button';
  element.className = 'task-trace-item' + (item.recalled ? ' is-recalled' : '') +
    (item.message_id === taskTraceFocusId ? ' is-focus' : '');
  element.dataset.messageId = item.message_id;
  element.setAttribute('role', 'listitem');
  const head = document.createElement('div');
  head.className = 'task-trace-item-head';
  const sender = document.createElement('span');
  sender.className = 'task-trace-sender';
  sender.textContent = item.sender_name || (item.sender_kind === 'agent' ? 'Agent' : '成员');
  const time = document.createElement('span');
  time.className = 'task-trace-time';
  time.textContent = chatTime(item.created_at);
  const role = document.createElement('span');
  role.className = 'task-trace-role task-trace-role-' + (item.role || 'member');
  role.textContent = taskTraceRoleLabel(item.role);
  head.append(sender, time, role);
  const preview = document.createElement('div');
  preview.className = 'task-trace-preview';
  preview.textContent = item.recalled ? '此消息已撤回' : (item.preview || '（无正文）');
  element.append(head, preview);
  if (item.has_unavailable_reference) {
    const note = document.createElement('div');
    note.className = 'task-trace-note';
    note.textContent = '引用的来源当前不可见';
    element.append(note);
  } else if (item.role === 'reference') {
    const note = document.createElement('div');
    note.className = 'task-trace-note';
    note.textContent = '引用来源';
    element.append(note);
  }
  if (!item.recalled) {
    element.addEventListener('click', function () {
      jumpToTaskMessage(item.message_id);
    });
  }
  return element;
}

function renderTaskTraceItems() {
  if (!taskTraceItemsElement) return;
  taskTraceItemsElement.replaceChildren();
  if (taskTraceItems.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'task-trace-empty';
    empty.textContent = '这个 Task 还没有可显示的消息';
    taskTraceItemsElement.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of taskTraceItems) fragment.append(taskTraceItemElement(item));
  taskTraceItemsElement.append(fragment);
  const focus = taskTraceItemsElement.querySelector('.is-focus');
  if (focus) focus.scrollIntoView({ block: 'center' });
}

function updateTaskTracePager() {
  if (taskTraceOlderButton) {
    taskTraceOlderButton.hidden = !taskTraceHasMoreBefore || !taskTracePrevCursor;
  }
  if (taskTraceNewerButton) {
    taskTraceNewerButton.hidden = !taskTraceHasMoreAfter || !taskTraceNextCursor;
  }
}

function mergeTaskTraceItems(pageItems, mode) {
  const merged = mode === 'replace' ? [] : taskTraceItems.slice();
  const known = new Set(merged.map(function (item) { return item.message_id; }));
  for (const item of pageItems || []) {
    if (!item || !item.message_id || known.has(item.message_id)) continue;
    known.add(item.message_id);
    merged.push(item);
  }
  merged.sort(function (left, right) {
    const leftSeq = Number(left.created_seq);
    const rightSeq = Number(right.created_seq);
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    return String(left.message_id).localeCompare(String(right.message_id));
  });
  taskTraceItems = merged;
}

async function loadTaskTracePage(args, mode) {
  const roomId = taskTraceRoomId;
  const rootMessageId = taskTraceRootId;
  if (!roomId || !rootMessageId || !activeRoomId) return;
  const epoch = roomEpoch;
  const seq = taskTraceLoadSeq;
  if (taskTraceStatusElement) taskTraceStatusElement.textContent = '正在加载…';
  if (taskTraceOlderButton) taskTraceOlderButton.disabled = true;
  if (taskTraceNewerButton) taskTraceNewerButton.disabled = true;
  const before = mode === 'before' && taskTraceItemsElement
    ? { height: taskTraceItemsElement.scrollHeight, top: taskTraceItemsElement.scrollTop }
    : null;
  try {
    const page = await callTool('network_task_trace', {
      room_id: roomId,
      root_message_id: rootMessageId,
      limit: TASK_TRACE_PAGE,
      ...args
    }, undefined, sessionSignal());
    if (seq !== taskTraceLoadSeq || !isActiveRoom(roomId, epoch) ||
        !taskTraceDrawerElement || !taskTraceDrawerElement.open) return;
    mergeTaskTraceItems(page.items, mode);
    taskTraceNextCursor = page.next_cursor || null;
    taskTracePrevCursor = page.prev_cursor || null;
    taskTraceHasMoreBefore = page.has_more_before === true;
    taskTraceHasMoreAfter = page.has_more_after === true;
    taskTraceMessageCount = Number(page.message_count) || 0;
    if (page.focus_message_id) taskTraceFocusId = page.focus_message_id;
    renderTaskTraceItems();
    updateTaskTracePager();
    if (before && taskTraceItemsElement) {
      taskTraceItemsElement.scrollTop = taskTraceItemsElement.scrollHeight - (before.height - before.top);
    }
    if (taskTraceStatusElement) {
      taskTraceStatusElement.textContent = taskTraceItems.length === 0
        ? '没有可显示的消息'
        : taskTraceItems.length + ' / ' + taskTraceMessageCount + ' 条已加载';
    }
  } catch (error) {
    if (seq !== taskTraceLoadSeq || !isActiveRoom(roomId, epoch)) return;
    if (taskTraceStatusElement) {
      taskTraceStatusElement.textContent = error && error.message ? error.message : 'Trace 加载失败，请重试';
    }
  } finally {
    if (seq === taskTraceLoadSeq) {
      if (taskTraceOlderButton) taskTraceOlderButton.disabled = false;
      if (taskTraceNewerButton) taskTraceNewerButton.disabled = false;
    }
  }
}

function openTaskTrace(rootMessageId, focusMessageId) {
  if (!activeRoomId || !taskTraceDrawerElement) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  taskTraceRootId = rootMessageId;
  taskTraceRoomId = roomId;
  taskTraceFocusId = focusMessageId || null;
  taskTraceItems = [];
  taskTraceNextCursor = null;
  taskTracePrevCursor = null;
  taskTraceHasMoreBefore = false;
  taskTraceHasMoreAfter = false;
  taskTraceMessageCount = 0;
  taskTraceLoadSeq += 1;
  if (taskTraceRefreshButton) taskTraceRefreshButton.hidden = true;
  if (taskTraceStatusElement) taskTraceStatusElement.textContent = '正在加载…';
  if (taskTraceItemsElement) taskTraceItemsElement.replaceChildren();
  if (taskTraceOlderButton) taskTraceOlderButton.hidden = true;
  if (taskTraceNewerButton) taskTraceNewerButton.hidden = true;
  const item = currentItems.find(function (value) {
    return value && value.message_id === rootMessageId;
  });
  const summary = taskSummaryOf(rootMessageId);
  if (summary) renderTaskTraceHeader(summary);
  else renderTaskTraceHeaderFallback(item);
  if (!taskTraceDrawerElement.open) taskTraceDrawerElement.showModal();
  if (!summary) queueTaskSummaries(roomId, epoch, [rootMessageId]);
  const args = { root_message_id: rootMessageId };
  if (focusMessageId) args.focus_message_id = focusMessageId;
  loadTaskTracePage(args, 'replace');
}

function closeTaskTrace() {
  if (taskTraceDrawerElement && taskTraceDrawerElement.open) taskTraceDrawerElement.close();
  taskTraceLoadSeq += 1;
  taskTraceRootId = null;
  taskTraceRoomId = null;
  taskTraceFocusId = null;
  taskTraceItems = [];
  taskTraceNextCursor = null;
  taskTracePrevCursor = null;
  taskTraceHasMoreBefore = false;
  taskTraceHasMoreAfter = false;
  if (taskTraceItemsElement) taskTraceItemsElement.replaceChildren();
  if (taskTraceRefreshButton) taskTraceRefreshButton.hidden = true;
  if (taskTraceStatusElement) taskTraceStatusElement.textContent = '';
  if (taskTraceOlderButton) taskTraceOlderButton.hidden = true;
  if (taskTraceNewerButton) taskTraceNewerButton.hidden = true;
}

function resetTaskTraceRoom() {
  closeTaskTrace();
  taskBarSignature = '';
}

/** 断线/补读后丢弃摘要缓存，下一次刷新按当前消息页重新校验计数。 */
function invalidateTaskSummaries() {
  if (!activeRoomId) return;
  const prefix = String(activeRoomId) + '::';
  for (const key of Array.from(taskSummaryCache.keys())) {
    if (key.indexOf(prefix) === 0) taskSummaryCache.delete(key);
  }
  for (const key of Array.from(taskSummaryMissing)) {
    if (key.indexOf(prefix) === 0) taskSummaryMissing.delete(key);
  }
  for (const key of Array.from(taskSummaryFailed)) {
    if (key.indexOf(prefix) === 0) taskSummaryFailed.delete(key);
  }
  taskBarSignature = '';
  refreshTaskBars();
}

function showTaskTraceNewHint() {
  if (taskTraceRefreshButton) taskTraceRefreshButton.hidden = false;
  if (taskTraceStatusElement) taskTraceStatusElement.textContent = '有新消息';
}

function taskMessageNode(messageId) {
  if (!messagesElement) return null;
  for (const node of messagesElement.querySelectorAll('[data-message-id]')) {
    if (node.dataset.messageId === messageId) return node;
  }
  return null;
}

/** 点击 Trace 消息回到原聊天位置；不在已加载历史中时打开上下文弹窗。 */
function jumpToTaskMessage(messageId) {
  const node = taskMessageNode(messageId);
  closeTaskTrace();
  if (!node) {
    if (typeof openMessageContext === 'function') openMessageContext(messageId);
    return;
  }
  node.scrollIntoView({ block: 'center' });
  node.classList.add('task-message-flash');
  setTimeout(function () { node.classList.remove('task-message-flash'); }, 1200);
}

/** 搜索“只看任务”结果行：按起点聚合后由搜索脚本追加点击处理。 */
function taskSearchResultElement(entry) {
  const summary = entry && entry.task ? entry.task : entry;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'task-search-result';
  if (summary && summary.root_message_id) row.dataset.rootMessageId = summary.root_message_id;
  row.append(taskIconElement(), taskAvatarGroup(summary, 2));
  const main = document.createElement('span');
  main.className = 'task-search-main';
  const top = document.createElement('span');
  top.className = 'task-search-top';
  const preview = document.createElement('span');
  preview.className = 'task-search-preview';
  preview.textContent = (summary && summary.preview) || '（无正文）';
  const count = document.createElement('span');
  count.className = 'task-search-count';
  count.textContent = (Number(summary && summary.message_count) || 0) + ' 消息';
  top.append(preview, count);
  const hit = document.createElement('span');
  hit.className = 'task-search-hit';
  const matches = entry && Array.isArray(entry.matches) ? entry.matches : [];
  const first = matches[0];
  hit.textContent = '命中 ' + (Number(entry && entry.hit_count) || matches.length) + ' 条' +
    (first && first.snippet ? ' · ' + String(first.snippet).replace(/\\s+/g, ' ').slice(0, 120) : '');
  main.append(top, hit);
  row.append(main);
  return row;
}

if (taskTraceDrawerElement) {
  taskTraceDrawerElement.addEventListener('close', function () {
    taskTraceLoadSeq += 1;
    taskTraceRootId = null;
    taskTraceRoomId = null;
    taskTraceFocusId = null;
    taskTraceItems = [];
    // Esc 关闭也清掉旧房间 DOM，避免隐藏抽屉里残留可见权限之外的数据。
    if (taskTraceItemsElement) taskTraceItemsElement.replaceChildren();
    if (taskTraceStatusElement) taskTraceStatusElement.textContent = '';
    if (taskTraceRefreshButton) taskTraceRefreshButton.hidden = true;
    if (taskTraceOlderButton) taskTraceOlderButton.hidden = true;
    if (taskTraceNewerButton) taskTraceNewerButton.hidden = true;
  });
}
const taskTraceCloseButton = document.getElementById('task-trace-close');
if (taskTraceCloseButton) {
  taskTraceCloseButton.addEventListener('click', function () { closeTaskTrace(); });
}
if (taskTraceOlderButton) {
  taskTraceOlderButton.addEventListener('click', function () {
    if (!taskTracePrevCursor) return;
    loadTaskTracePage({ cursor: taskTracePrevCursor }, 'before');
  });
}
if (taskTraceNewerButton) {
  taskTraceNewerButton.addEventListener('click', function () {
    if (!taskTraceNextCursor) return;
    loadTaskTracePage({ cursor: taskTraceNextCursor }, 'after');
  });
}
if (taskTraceRefreshButton) {
  taskTraceRefreshButton.addEventListener('click', function () {
    if (!taskTraceRootId) return;
    const rootMessageId = taskTraceRootId;
    const focusMessageId = taskTraceFocusId;
    openTaskTrace(rootMessageId, focusMessageId);
  });
}
`;
