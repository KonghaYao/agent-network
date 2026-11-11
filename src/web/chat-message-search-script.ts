import { LIMITS } from '../contracts/limits';

/** Search persistent room history without changing the main timeline position. */
export const CHAT_MESSAGE_SEARCH_SCRIPT = `
let messageSearchDialog = null;
let messageSearchRequest = 0;
let messageSearchAbort = null;
const messageContextDialogs = new Set();
function closeMessageSearchDialogs() {
  messageSearchRequest++;
  if (messageSearchAbort) messageSearchAbort.abort();
  messageSearchAbort = null;
  if (messageSearchDialog) { messageSearchDialog.close(); messageSearchDialog.remove(); messageSearchDialog = null; }
  for (const dialog of messageContextDialogs) { dialog.close(); dialog.remove(); }
  messageContextDialogs.clear();
}
function ensureMessageSearchDialog() {
  if (messageSearchDialog) return messageSearchDialog;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '搜索聊天记录');
  dialog.style.cssText = 'width:min(680px,calc(100vw - 24px));max-height:85vh;border:1px solid #d7dce2;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0003;color:inherit;background:Canvas';
  dialog.innerHTML = '<form method="dialog" style="display:flex;gap:8px;align-items:center"><strong style="flex:1">搜索聊天记录</strong><button aria-label="关闭">关闭</button></form><form data-search style="display:flex;gap:8px;margin:14px 0 8px"><input type="search" aria-label="搜索消息内容" placeholder="搜索完整聊天记录" required style="flex:1;min-width:0"><button type="submit">搜索</button></form><label class="message-search-filter"><input type="checkbox" data-task-only> 只看任务</label><div data-status role="status" aria-live="polite"></div><div data-results></div><button type="button" data-more hidden>更多结果</button>';
  document.body.append(dialog);
  messageSearchDialog = dialog;
  dialog.querySelector('[data-search]').addEventListener('submit', function (event) { event.preventDefault(); runMessageSearch(dialog); });
  dialog.querySelector('[data-more]').addEventListener('click', function () { runMessageSearch(dialog, true); });
  dialog.querySelector('input[type="search"]').addEventListener('input', function () { resetMessageSearchPage(dialog, false); });
  dialog.querySelector('[data-task-only]').addEventListener('change', function () {
    resetMessageSearchPage(dialog, true);
    if (dialog.querySelector('input[type="search"]').value.trim()) runMessageSearch(dialog);
  });
  dialog.addEventListener('close', function () { messageSearchRequest++; if (messageSearchAbort) messageSearchAbort.abort(); dialog.remove(); if (messageSearchDialog === dialog) messageSearchDialog = null; });
  return dialog;
}
function resetMessageSearchPage(dialog, clearResults) {
  dialog.dataset.cursor = '';
  dialog.dataset.query = '';
  dialog.dataset.mode = '';
  dialog.dataset.resultQuery = '';
  dialog.querySelector('[data-more]').hidden = true;
  // 普通搜索保持原行为：输入时只重置分页，不立刻清空已有结果。
  if (clearResults) {
    dialog.querySelector('[data-results]').replaceChildren();
    dialog.querySelector('[data-status]').textContent = '';
  }
}
async function runMessageSearch(dialog, more) {
  const input = dialog.querySelector('input[type="search"]');
  const query = input.value.trim();
  if (!query || !activeRoomId) return;
  const taskOnly = Boolean(dialog.querySelector('[data-task-only]').checked);
  const mode = taskOnly ? 'task' : 'message';
  const roomId = activeRoomId, epoch = roomEpoch, request = ++messageSearchRequest;
  if (messageSearchAbort) messageSearchAbort.abort();
  messageSearchAbort = new AbortController();
  const status = dialog.querySelector('[data-status]'), results = dialog.querySelector('[data-results]');
  const button = dialog.querySelector('[data-more]');
  // 查询词或筛选模式变化时重新从第一页开始；同一模式才允许 cursor 翻页。
  const sameSearch = dialog.dataset.query === query && dialog.dataset.mode === mode;
  const cursor = more && sameSearch ? dialog.dataset.cursor : null;
  if (!more || !cursor) {
    dialog.dataset.cursor = ''; dialog.dataset.query = query; dialog.dataset.mode = mode;
    results.replaceChildren();
  }
  button.disabled = true; status.textContent = '正在搜索…';
  dialog.dataset.resultQuery = '';
  try {
    const page = taskOnly
      ? await callTool('network_task_search', { room_id: roomId, query: query, limit: 25, ...(cursor ? { cursor: cursor } : {}) }, undefined, messageSearchAbort.signal)
      : await callTool('network_message_search', { room_id: roomId, query: query, limit: 25, ...(cursor ? { cursor: cursor } : {}) }, undefined, messageSearchAbort.signal);
    if (request !== messageSearchRequest || !isActiveRoom(roomId, epoch) || !dialog.open) return;
    let count = 0;
    if (taskOnly) {
      const seenRoots = new Set();
      for (const item of page.items || []) {
        const task = item && item.task ? item.task : item;
        const rootId = task && task.root_message_id;
        if (!rootId || seenRoots.has(rootId)) continue;
        seenRoots.add(rootId);
        const row = taskSearchResultElement(item);
        row.addEventListener('click', function () {
          const matches = Array.isArray(item.matches) ? item.matches : [];
          openTaskTrace(rootId, matches.length > 0 ? matches[0].message_id : null);
        });
        results.append(row);
        count += 1;
      }
    } else {
      for (const item of page.items || []) {
        const row = document.createElement('button'); row.type = 'button'; row.style.cssText = 'display:block;width:100%;min-height:44px;text-align:left;padding:10px;border:0;border-top:1px solid #e5e7eb;background:transparent;color:inherit;cursor:pointer';
        const head = document.createElement('strong'); head.textContent = item.sender_name + ' · ' + new Date(Number(item.created_at)).toLocaleString();
        const body = document.createElement('div'); body.textContent = item.snippet || item.preview || '（消息已撤回）'; body.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px';
        row.append(head, body); row.addEventListener('click', function () { openMessageContext(item.message_id); }); results.append(row);
        count += 1;
      }
    }
    dialog.dataset.cursor = page.next_cursor || '';
    dialog.dataset.resultQuery = mode + ':' + query;
    if (taskOnly && page.truncated) {
      status.textContent = '命中过多，仅显示部分任务';
    } else {
      status.textContent = count > 0 ? '' : (more
        ? (taskOnly ? '没有更多任务' : '没有更多结果')
        : (taskOnly ? '没有匹配的任务' : '没有找到匹配消息'));
    }
    button.hidden = !page.next_cursor; button.disabled = false;
  } catch (error) {
    if (request !== messageSearchRequest || isAbortError(error)) return;
    status.textContent = error.message || (taskOnly ? '搜索任务失败，请重试' : '搜索失败，请重试');
    button.disabled = false;
  }
}
async function expandContextMessage(messageId, body, button, roomId, epoch) {
  button.disabled = true; button.textContent = '正在读取…';
  try {
    let cursor = undefined, full = '', round = 0;
    do {
      const part = await callTool('network_message_read', { message_id: messageId, ...(cursor ? { chunk_cursor: cursor } : {}) });
      if (!isActiveRoom(roomId, epoch) || !body.isConnected) return;
      full += part.chunk; cursor = part.next_cursor || undefined; round++;
    } while (cursor && round < Math.ceil(${LIMITS.messageBodyBytes} / ${LIMITS.bodyChunkBytes}));
    body.textContent = full; button.remove();
  } catch (error) { button.disabled = false; button.textContent = error.message || '读取失败，重试'; }
}
async function openMessageContext(messageId) {
  const roomId = activeRoomId, epoch = roomEpoch;
  if (!roomId) return;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', '查看上下文');
  dialog.style.cssText = 'width:min(680px,calc(100vw - 24px));max-height:85vh;border:1px solid #d7dce2;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0003;color:inherit;background:Canvas';
  dialog.innerHTML = '<form method="dialog" style="display:flex;gap:8px;align-items:center"><strong style="flex:1">查看上下文</strong><button aria-label="关闭上下文">关闭</button></form><div data-status role="status" aria-live="polite" style="margin:12px 0">正在加载上下文…</div><div data-items></div>';
  document.body.append(dialog); messageContextDialogs.add(dialog); dialog.showModal();
  dialog.addEventListener('close', function () { dialog.remove(); messageContextDialogs.delete(dialog); });
  try {
    const context = await callTool('network_message_context', { room_id: roomId, message_id: messageId, before: 4, after: 4 });
    if (!dialog.open || !isActiveRoom(roomId, epoch)) { dialog.close(); return; }
    dialog.querySelector('[data-status]').textContent = '';
    for (const item of context.items || []) {
      const article = document.createElement('article'); article.style.cssText = 'padding:10px;border-top:1px solid #e5e7eb;white-space:pre-wrap;overflow-wrap:anywhere';
      if (item.message_id === messageId) article.style.background = 'color-mix(in srgb, Highlight 12%, transparent)';
      const label = document.createElement('strong'); label.textContent = item.sender_name + ' · ' + new Date(Number(item.created_at)).toLocaleString();
      const body = document.createElement('div'); body.textContent = item.preview || '（消息已撤回）'; article.append(label, body);
      if (item.body_bytes > ${LIMITS.previewBytes} && item.preview !== '此消息已撤回') {
        const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = '展开全文'; expand.style.cssText = 'min-height:44px;margin-top:8px';
        expand.addEventListener('click', function () { expandContextMessage(item.message_id, body, expand, roomId, epoch); }); article.append(expand);
      }
      dialog.querySelector('[data-items]').append(article);
    }
  } catch (error) { if (dialog.open) dialog.querySelector('[data-status]').textContent = error.message || '无法读取此消息上下文'; }
}
window.openMessageContext = openMessageContext;
window.closeMessageSearchDialogs = closeMessageSearchDialogs;
function openMessageSearch() { const dialog = ensureMessageSearchDialog(); dialog.showModal(); dialog.querySelector('input').focus(); }
const messageSearchButton = document.createElement('button');
messageSearchButton.type = 'button'; messageSearchButton.className = 'link-btn'; messageSearchButton.textContent = '搜索'; messageSearchButton.setAttribute('aria-label', '搜索聊天记录'); messageSearchButton.title = '搜索聊天记录'; messageSearchButton.style.cssText = 'min-width:44px;min-height:44px';
messageSearchButton.addEventListener('click', openMessageSearch);
const chatTitleRow = document.querySelector('.chat-head .title-row');
if (chatTitleRow) chatTitleRow.append(messageSearchButton);
`;
