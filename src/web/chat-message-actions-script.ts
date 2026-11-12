/** Reply intents share the durable send outbox; forwarding always requires an explicit target. */
export const CHAT_MESSAGE_ACTIONS_SCRIPT = `
const REPLY_PREFIX = 'agent-network-reply-v1:';
const replyDrafts = new Map();
const quotePreviewCache = new Map();
let messageForwardDialog = null;
function replyKey(roomId) { return identity ? REPLY_PREFIX + identity.actor_id + ':' + roomId : null; }
function composerReply(roomId) {
  const key = replyKey(roomId);
  if (!key) return null;
  if (replyDrafts.has(key)) return replyDrafts.get(key);
  let value = null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && typeof saved.message_id === 'string' && typeof saved.label === 'string' &&
        typeof saved.version === 'string') value = saved;
  } catch (error) {}
  replyDrafts.set(key, value);
  return value;
}
function setComposerReply(roomId, value) {
  const key = replyKey(roomId);
  if (!key) return;
  replyDrafts.set(key, value);
  try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
  catch (error) {}
  syncComposerReply();
}
function syncComposerReply() {
  let bar = document.getElementById('composer-reply');
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'composer-reply'; bar.className = 'composer-reply';
    const label = document.createElement('span');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '×';
    cancel.setAttribute('aria-label', '取消引用');
    cancel.addEventListener('click', function () { if (activeRoomId) setComposerReply(activeRoomId, null); });
    bar.append(label, cancel);
    // composer 是横向 flex 行；引用条必须放进纵向的 composer-main，才能位于输入框上方。
    const composerMain = document.querySelector('.composer-main');
    if (composerMain) composerMain.prepend(bar); else composer.prepend(bar);
  }
  const reply = activeRoomId ? composerReply(activeRoomId) : null;
  bar.hidden = !reply;
  bar.firstElementChild.textContent = reply ? '引用 ' + reply.label : '';
}
function finishComposerReply(intent, settings) {
  const current = composerReply(intent.room_id);
  if (current && current.message_id === intent.reply_to && current.version === intent.reply_version) {
    setComposerReply(intent.room_id, null);
  }
}
function quoteMessage(item) {
  if (!activeRoomId || !room || room.read_only || Number(item.body_bytes) === 0) return;
  setComposerReply(activeRoomId, { message_id: item.message_id,
    label: senderName(item.sender_id) + '：' + String(item.preview || '').slice(0, 120), version: requestId('quote') });
  bodyInput.focus();
}
let messageActionMenu = null;
function closeMessageMenu() {
  if (messageActionMenu) messageActionMenu.remove();
  messageActionMenu = null;
}
function messageActionButton(label, action) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.className = 'room-menu-item'; button.setAttribute('role', 'menuitem');
  button.addEventListener('click', function () { closeMessageMenu(); action(); }); return button;
}
function quotePreviewText(item) {
  return senderName(item.sender_id) + '：' + String(item.preview || '消息').slice(0, 120);
}
async function resolveQuotePreview(roomId, messageId, quote) {
  const key = roomId + ':' + messageId;
  const cached = quotePreviewCache.get(key);
  if (cached) { quote.textContent = cached; return; }
  try {
    const result = await callTool('network_message_context', {
      room_id: roomId, message_id: messageId, before: 0, after: 0,
    });
    const target = (result && Array.isArray(result.items))
      ? result.items.find(function (value) { return value.message_id === messageId; }) || result.items[0]
      : null;
    const text = target ? quotePreviewText(target) : '引用消息不可见';
    quotePreviewCache.set(key, text);
    if (quote.isConnected && activeRoomId === roomId) quote.textContent = text;
  } catch (error) {
    if (quote.isConnected && activeRoomId === roomId) quote.textContent = '引用消息不可见';
  }
}
/** 引用块跟随正文底部区域：有附件时排在附件之后，否则紧接正文。 */
function placeReplyReference(quote, content) {
  const anchor = content.querySelector('.msg-files') || content.querySelector('.bubble');
  if (anchor) anchor.after(quote); else content.append(quote);
}
function appendMessageActions(item, content) {
  if (item.reply_to) {
    const quote = document.createElement('button'); quote.type = 'button'; quote.className = 'reply-reference';
    quote.dataset.replyTo = item.reply_to;
    const target = currentItems.find(function (value) { return value.message_id === item.reply_to; });
    if (target) quote.textContent = quotePreviewText(target);
    else { quote.textContent = '引用消息 · 查看上下文'; resolveQuotePreview(activeRoomId, item.reply_to, quote); }
    placeReplyReference(quote, content);
  }
  if (Number(item.body_bytes) === 0) return;
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'message-actions-trigger';
  trigger.textContent = '···'; trigger.setAttribute('aria-label', '消息操作');
  trigger.setAttribute('aria-haspopup', 'menu'); content.append(trigger);
}
function openMessageMenu(node, x, y) {
  closeMessageMenu();
  const item = currentItems.find(function (value) { return value.message_id === node.dataset.messageId; });
  if (!item || Number(item.body_bytes) === 0) return;
  const menu = document.createElement('div'); menu.id = 'message-action-menu'; menu.className = 'message-action-menu';
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '消息操作');
  const sourceRoom = activeRoomId, sourceEpoch = roomEpoch;
  menu.append(messageActionButton('复制', async function () {
    try {
      const full = await readMessage(item.message_id);
      if (!isActiveRoom(sourceRoom, sourceEpoch)) return;
      if (!full) throw new Error('消息已撤回');
      await navigator.clipboard.writeText(full); showToast('已复制');
    } catch (error) { if (isActiveRoom(sourceRoom, sourceEpoch)) showToast(error.message || '复制失败'); }
  }));
  if (room && !room.read_only) menu.append(messageActionButton('引用', function () { quoteMessage(item); }));
  // 消息式 Task：直接调用工具，不弹创建表单；已是起点时提供取消入口。
  if (roomCanUseTaskAction()) {
    const markTask = item.task_root_id !== item.message_id;
    menu.append(messageActionButton(
      taskActionLabel(item),
      function () { updateMessageTask(item, markTask); }
    ));
  }
  menu.append(messageActionButton('转发', function () { openMessageForward(item); }));
  if (identity && identity.kind === 'human' && item.sender_id === identity.actor_id && room && !room.read_only) {
    menu.append(messageActionButton('撤回', async function () {
      if (!(await confirmDialog('撤回这条消息？仅支持两分钟内的普通消息，已触发的 Agent 工作需单独取消。',
        { title: '撤回消息', danger: true, confirmText: '撤回' }))) return;
      try {
        await callTool('network_message_recall', { request_id: requestId('recall'), message_id: item.message_id });
        applyRecalledMessage(sourceRoom, item.message_id);
        if (isActiveRoom(sourceRoom, sourceEpoch)) { showToast('消息已撤回'); await refresh(false); }
      } catch (error) { if (isActiveRoom(sourceRoom, sourceEpoch)) showToast(error.message || '撤回失败'); }
    }));
  }
  document.body.append(menu); messageActionMenu = menu;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
  menu.firstElementChild.focus();
}
messagesElement.addEventListener('click', function (event) {
  const target = event.target instanceof Element ? event.target : null;
  const reference = target && target.closest('.reply-reference');
  if (reference) { openMessageContext(reference.dataset.replyTo); return; }
  const trigger = target && target.closest('.message-actions-trigger');
  if (!trigger) return;
  const node = trigger.closest('[data-message-id]');
  const rect = trigger.getBoundingClientRect();
  if (node) openMessageMenu(node, rect.left, rect.bottom);
});
messagesElement.addEventListener('contextmenu', function (event) {
  const target = event.target instanceof Element ? event.target : null;
  const node = target && target.closest('.msg[data-message-id]');
  if (!node || (target && target.closest('a,input,textarea'))) return;
  event.preventDefault(); openMessageMenu(node, event.clientX, event.clientY);
});
document.addEventListener('click', function (event) {
  if (messageActionMenu && !messageActionMenu.contains(event.target) &&
      !(event.target instanceof Element && event.target.closest('.message-actions-trigger'))) closeMessageMenu();
});
document.addEventListener('keydown', function (event) {
  if (!messageActionMenu) return;
  if (event.key === 'Escape') { closeMessageMenu(); return; }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault(); const buttons = Array.from(messageActionMenu.querySelectorAll('button'));
  const index = buttons.indexOf(document.activeElement);
  buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
});
messagesElement.addEventListener('scroll', closeMessageMenu, { passive: true });
function applyRecalledMessage(roomId, messageId) {
  if (!messageId) return;
  const previous = expandedMessageBodies.get(messageId);
  if (previous !== undefined) expandedBodyCacheSize -= previous.length * 2;
  expandedMessageBodies.delete(messageId);
  longMessageExpanded.delete(messageId);
  agentAutoExpandReads.delete(messageId);
  function redact(items) {
    return (items || []).map(function (item) { return item.message_id === messageId
      ? Object.assign({}, item, { preview: '此消息已撤回', body_bytes: 0 }) : item; });
  }
  const cached = roomCache.get(roomId);
  if (cached) cached.items = redact(cached.items);
  if (activeRoomId === roomId) { currentItems = redact(currentItems); renderMessageList(currentItems); }
  const quote = composerReply(roomId);
  if (quote && quote.message_id === messageId) setComposerReply(roomId, null);
  // Open search/context windows may contain an old copy of the body. Close them on a recall.
  if (typeof closeMessageSearchDialogs === 'function') closeMessageSearchDialogs();
  if (messageForwardDialog && messageForwardDialog.open) messageForwardDialog.close();
}
function closeMessageActionDialogs() { closeMessageMenu(); if (messageForwardDialog && messageForwardDialog.open) messageForwardDialog.close(); }

async function openMessageForward(item) {
  if (messageForwardDialog && messageForwardDialog.open) return;
  const sourceRoom = activeRoomId, sourceEpoch = roomEpoch;
  const dialog = document.createElement('dialog'); dialog.className = 'forward-modal';
  dialog.setAttribute('aria-label', '转发消息');
  dialog.innerHTML = '<h2>转发消息</h2><p class="forward-preview"></p><input type="search" aria-label="选择转发会话" placeholder="搜索会话"><div class="forward-rooms"></div><p role="status"></p><button type="button" data-more hidden>加载更多会话</button><footer><button type="button" data-cancel>取消</button><button type="button" data-send disabled>确认转发</button></footer>';
  document.body.append(dialog); messageForwardDialog = dialog;
  const status = dialog.querySelector('[role=status]'), send = dialog.querySelector('[data-send]');
  const input = dialog.querySelector('input'), choices = dialog.querySelector('.forward-rooms');
  let text = null, selected = null, intent = null, sending = false;
  dialog.addEventListener('close', function () { dialog.remove(); if (messageForwardDialog === dialog) messageForwardDialog = null; });
  dialog.querySelector('[data-cancel]').addEventListener('click', function () { dialog.close(); });
  dialog.showModal(); status.textContent = '正在读取消息…';
  function renderTargets() {
    choices.replaceChildren();
    const query = input.value.trim().toLowerCase();
    const targets = roomEntries.filter(function (entry) {
      return entry.room_id !== sourceRoom && !entry.read_only && !isArchivedAgentRoom(entry) && roomMatches(entry, query);
    });
    for (const entry of targets) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = (entry.kind === 'group' ? '群聊 · ' : '单聊 · ') + entry.name;
      button.setAttribute('aria-pressed', selected && selected.room_id === entry.room_id ? 'true' : 'false');
      button.disabled = sending || Boolean(intent);
      button.addEventListener('click', function () {
        selected = entry; status.textContent = '转发给 ' + entry.name + '（不会自动唤醒 Agent）';
        send.disabled = text === null; renderTargets();
      }); choices.append(button);
    }
    if (!targets.length) choices.textContent = '没有匹配的会话';
    dialog.querySelector('[data-more]').hidden = !roomsHasMore;
  }
  input.addEventListener('input', renderTargets);
  dialog.querySelector('[data-more]').addEventListener('click', async function (event) {
    event.currentTarget.disabled = true;
    try { await loadMoreRooms(); if (dialog.open) renderTargets(); }
    finally { if (dialog.open) dialog.querySelector('[data-more]').disabled = false; }
  });
  renderTargets();
  try {
    // Read authority again rather than forwarding a potentially stale cached preview.
    const full = await readMessage(item.message_id);
    if (!dialog.open || !isActiveRoom(sourceRoom, sourceEpoch)) { dialog.close(); return; }
    if (!full) throw new Error('消息已撤回');
    if (messageFileLinks(full).length) throw new Error('含附件的消息暂不支持转发；请下载附件后在目标会话发送。');
    text = '【转发消息】' + senderName(item.sender_id) + '：\\n' + full;
    dialog.querySelector('.forward-preview').textContent = text;
    status.textContent = '选择接收会话，再确认转发'; send.disabled = !selected;
  } catch (error) { if (dialog.open) status.textContent = error.message || '读取失败，请关闭后重试'; }
  send.addEventListener('click', async function () {
    if (sending || !selected || text === null) return;
    sending = true; send.disabled = true; input.disabled = true;
    try {
      if (!intent) intent = outboxCreate(selected.room_id, text, [], [], true);
      else {
        const decision = await outboxCheckBeforeResend(intent);
        if (decision === 'committed') { showToast('已转发给 ' + selected.name); dialog.close(); return; }
        if (decision !== 'send') throw new Error('暂时无法确认转发状态，请稍后重试');
      }
      renderTargets(); status.textContent = '正在转发…';
      await outboxSubmit(intent, { epoch: sourceEpoch, preserveComposer: true, invokeTargets: 0 });
      const result = outboxGet(intent.client_message_id);
      if (result && result.status === 'committed') {
        showToast('已转发给 ' + selected.name); dialog.close(); loadRooms().catch(function () {});
      } else throw new Error((result && result.error) || '转发失败，可重试');
    } catch (error) { if (dialog.open) status.textContent = error.message; }
    finally { sending = false; if (dialog.open) { send.disabled = false; send.textContent = '重试转发'; renderTargets(); } }
  });
}
`;
