import { MESSAGE_FILE_ID_SOURCE } from '../contracts/file-links';
import { LIMITS } from '../contracts/limits';
import { CHAT_AGENTS_SCRIPT } from './chat-agents-script';
import { CHAT_ARCHIVE_SCRIPT } from './chat-archive-script';
import { CHAT_FILES_ACTIONS_SCRIPT } from './chat-files-actions-script';
import { CHAT_FILES_SCRIPT } from './chat-files-script';
import { CHAT_LIST_SCRIPT } from './chat-list-script';
import { CHAT_MARKDOWN_SCRIPT } from './chat-markdown-script';
import { CHAT_MEMBERS_SCRIPT } from './chat-members-script';
import { CHAT_MESSAGE_FILES_SCRIPT } from './chat-message-files-script';
import { CHAT_RENDER_SCRIPT } from './chat-render-script';
import { CHAT_ROOM_MENU_SCRIPT } from './chat-room-menu-script';
import { CHAT_ROUTER_SCRIPT } from './chat-router-script';
import { CHAT_SESSION_SCRIPT } from './chat-session-script';
import { CHAT_STREAM_SCRIPT } from './chat-stream-script';
import { HANDOFF_CONTROLLER_SCRIPT } from './handoff';
import { jsonForScript } from './layout';
import { NEW_AGENT_SCRIPT } from './new-agent-script';
import { QR_ENCODER_SCRIPT } from './qr';

/**
 * 应用页内联客户端脚本：会话列表、聊天、建群、@、回执与手机扫码。
 *
 * `roomId` 只作为首屏 SSR 提示；客户端路由解析 `location.pathname` 后
 * 通过 `openRoom` 加载房间。所有片段拼进同一个 `<script>` 共享作用域，
 * 拆文件只为控制单文件行数，不改变工具契约或页面行为。
 */
export function chatClientScript(roomId: string | null): string {
  const roomJson = roomId === null ? 'null' : jsonForScript(roomId);
  return `<script>
const initialRoomId = ${roomJson};
const TOKEN_KEY = 'agent-network-token';
const MAX_CHUNKS = 8;
// 服务端 LIMITS.invokeMax 的内联值：阈值只在 limits.ts 维护，页面不复制字面量。
const INVOKE_MAX = ${LIMITS.invokeMax};
const ACTOR_NAME_MAX = ${LIMITS.actorNameMax};
const MEMBER_CHANGE_MAX = ${LIMITS.memberChangeMax};
const GROUP_MEMBERS_MAX = ${LIMITS.groupMembersMax};
// 本地 Agent 注册表上限；阈值只在 limits.ts 维护。
const AGENT_REGISTRY_MAX = ${LIMITS.webAgentRegistryMax};
// 归档状态批量查询上限，与服务端 network_agents_get 一致。
const AGENT_LOOKUP_MAX = ${LIMITS.agentLookupMax};
// 与服务端共享的 fileId 片段与链接上限，避免客户端/服务端规则漂移。
const MESSAGE_FILE_ID_SOURCE = ${jsonForScript(MESSAGE_FILE_ID_SOURCE)};
const MESSAGE_FILE_MAX = ${LIMITS.messageFileLinksMax};
// claimed 超过该时长未更新时显示提示；只做本地重绘，不轮询服务端。
const CLAIM_STALE_MS = ${LIMITS.claimedStaleMs};
const WEB_REQUEST_TIMEOUT_MS = ${LIMITS.webRequestTimeoutMs};
const WEB_REFRESH_DEBOUNCE_MS = ${LIMITS.webRefreshDebounceMs};
const roomListElement = document.getElementById('room-list');
const listStatusElement = document.getElementById('room-list-status');
const listRetryElement = document.getElementById('room-list-retry');
const sidebarListElement = document.querySelector('.sidebar-list');
const searchInput = document.getElementById('room-search');
const accountNameElement = document.getElementById('account-name');
const accountAvatarElement = document.getElementById('account-avatar');
const accountCopyButton = document.getElementById('account-copy-id');
const titleElement = document.getElementById('title');
const subtitleElement = document.getElementById('subtitle');
const messagesElement = document.getElementById('messages');
const olderButton = document.getElementById('older');
const composer = document.getElementById('composer');
const bodyInput = document.getElementById('body');
const sendButton = document.getElementById('send');
const statusElement = document.getElementById('status');
const chatBodyElement = document.getElementById('chat-body');
const chatLoadingElement = document.getElementById('chat-loading');
const chatSkeletonElement = document.getElementById('chat-skeleton');
const chatErrorElement = document.getElementById('chat-error');
const chatErrorTextElement = document.getElementById('chat-error-text');
const chatErrorRetryButton = document.getElementById('chat-error-retry');
const streamStatusElement = document.getElementById('stream-status');
const streamBannerElement = document.getElementById('stream-banner');
const renameButton = document.getElementById('rename');
const renameForm = document.getElementById('rename-form');
const renameInput = document.getElementById('rename-input');
const renameCancel = document.getElementById('rename-cancel');
const mentionPicker = document.getElementById('mention-picker');
const newGroupButton = document.getElementById('new-group');
const groupModal = document.getElementById('group-modal');
const groupForm = document.getElementById('group-form');
const groupTitleInput = document.getElementById('group-title');
const groupContactsElement = document.getElementById('group-contacts');
const groupErrorElement = document.getElementById('group-error');
const groupCreateButton = document.getElementById('group-create');
const groupCancelButton = document.getElementById('group-cancel');

let identity = null;
let roomEntries = [];
let mentionTargets = new Map();
let activeMention = null;
let composing = false;
let ignoreEnterUntil = 0;
let copyResetTimer = null;
let pendingRoomRefreshId = null;
// 发送失败/投递缺失/截断提示必须跨过 SSE 触发的刷新，不能在 300ms 后被清空。
let stickyStatus = '';

${CHAT_LIST_SCRIPT}
${CHAT_ARCHIVE_SCRIPT}
${CHAT_ROOM_MENU_SCRIPT}
${CHAT_MEMBERS_SCRIPT}
${CHAT_MESSAGE_FILES_SCRIPT}
${CHAT_MARKDOWN_SCRIPT}
${CHAT_RENDER_SCRIPT}
${NEW_AGENT_SCRIPT}
${CHAT_AGENTS_SCRIPT}
${CHAT_SESSION_SCRIPT}
${CHAT_STREAM_SCRIPT}
${CHAT_FILES_SCRIPT}
${CHAT_FILES_ACTIONS_SCRIPT}
${CHAT_ROUTER_SCRIPT}

function browserToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function requestId(prefix) {
  return prefix + '_' + crypto.randomUUID().replaceAll('-', '');
}

/**
 * 普通 RPC 带 15s 超时；订阅流只受调用方 AbortController 控制。
 * 超时与主动取消分别抛可识别的错误，调用方据此结束 loading 或静默返回。
 */
async function api(method, params, toolName, tokenOverride, signal) {
  const token = tokenOverride === undefined ? browserToken() : tokenOverride;
  if (!token) throw new Error('浏览器身份尚未初始化，请刷新页面后重试');
  const headers = {
    'content-type': 'application/json',
    accept: method === 'subscriptions/listen' ? 'text/event-stream' : 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    authorization: 'Bearer ' + token
  };
  if (toolName) headers['mcp-name'] = toolName;
  const isListen = method === 'subscriptions/listen';
  // 订阅流直接使用调用方的 signal：中止它即可关闭底层 SSE，避免多一层
  // controller 让已中止的旧流继续占用同源连接池。
  const directSignal = isListen ? signal : undefined;
  const controller = directSignal ? null : new AbortController();
  const requestSignal = directSignal || controller.signal;
  let timedOut = false;
  let timer = null;
  const onCallerAbort = function () { if (controller) controller.abort(); };
  if (controller && signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort);
  }
  if (!isListen) {
    timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, WEB_REQUEST_TIMEOUT_MS);
  }
  try {
    return await fetch('/mcp', {
      method: 'POST',
      headers: headers,
      signal: requestSignal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: method,
        params: Object.assign({}, params, {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'agent-network-web', version: '0.1.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        })
      })
    });
  } catch (error) {
    if (timedOut) throw new Error('请求超时，请重试');
    if (signal && signal.aborted) {
      const aborted = new Error('请求已取消');
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

async function rpc(method, params, toolName, tokenOverride, signal) {
  const response = await api(method, params, toolName, tokenOverride, signal);
  const payload = await response.json().catch(function () { return null; });
  if (!payload) throw new Error('服务无响应');
  if (payload.error) {
    const failure = new Error(payload.error.message || '请求失败');
    const code = payload.error.data && payload.error.data.code;
    if (typeof code === 'string') failure.code = code;
    throw failure;
  }
  return payload.result;
}

async function callTool(name, args, tokenOverride, signal) {
  const result = await rpc('tools/call', { name: name, arguments: args }, name, tokenOverride, signal);
  if (result.isError) {
    const item = (result.content || []).find(function (entry) { return entry.type === 'text'; });
    let detail = null;
    if (item) {
      try { detail = JSON.parse(item.text); } catch (error) { detail = { message: item.text }; }
    }
    const failure = new Error((detail && detail.message) || '请求失败');
    if (detail && detail.code) failure.code = detail.code;
    throw failure;
  }
  if (result.structuredContent) return result.structuredContent;
  const item = (result.content || []).find(function (entry) { return entry.type === 'text'; });
  return item ? JSON.parse(item.text) : {};
}

/** 用指定 token 调工具；新建 Agent 用它注册，不改变浏览器 human 身份。 */
function callToolWithToken(name, args, token) {
  return callTool(name, args, token);
}

/**
 * 首次访问自动生成并绑定 human 身份。
 *
 * single-flight：首屏列表与深链房间并行调用时只注册一次。token 在注册前
 * 写入 localStorage，重复打开沿用同一身份；凭据被撤销时换新 token 重试一次。
 */
function ensureIdentity() {
  if (identity) return Promise.resolve(identity);
  if (identityPromise) return identityPromise;
  identityPromise = (async function () {
    let token = browserToken();
    if (!token) {
      token = crypto.randomUUID();
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch (error) {
        throw new Error('浏览器无法保存身份，请允许本地存储后刷新页面');
      }
    }
    try {
      identity = await callTool('network_me', {});
      return identity;
    } catch (error) {
      if (!error || error.code !== 'CREDENTIAL_INVALID') throw error;
    }
    const register = function (value) {
      return callTool('network_register', {
        request_id: requestId('web_reg'),
        kind: 'human',
        name: '网页访客 ' + value.replaceAll('-', '').slice(0, 4)
      });
    };
    try {
      identity = await register(token);
      return identity;
    } catch (error) {
      if (!error || error.code !== 'CREDENTIAL_INVALID') throw error;
    }
    token = crypto.randomUUID();
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch (error) {
      throw new Error('浏览器无法保存身份，请允许本地存储后刷新页面');
    }
    identity = await register(token);
    return identity;
  })().finally(function () {
    identityPromise = null;
  });
  return identityPromise;
}

/** 首页错误写可见的列表状态，聊天页写聊天状态；不往隐藏元素里写。 */
function showStatusMessage(message) {
  if (activeRoomId && document.body.classList.contains('page-room') && statusElement) {
    statusElement.textContent = message;
    return;
  }
  if (listStatusElement) {
    listStatusElement.hidden = false;
    listStatusElement.textContent = message;
  }
}

/**
 * 收集网页人类发送消息时要唤醒的 Agent 成员。
 *
 * direct 自动唤醒对方 Agent；group 只唤醒文本中仍然存在的 @Agent 记录。
 * 只使用当前 active 房间已加载的 members，不额外发请求；人类成员与
 * 发送者自己不进入 invoke。超过上限时返回错误，由调用方明确提示，
 * 不静默截断。
 */
function agentInvokeTargets() {
  if (!identity || identity.kind !== 'human') return { targets: [], error: null };
  if (!room) return { targets: [], error: '房间成员尚未加载，请稍后重试' };
  if (room.kind === 'direct') {
    for (const member of members.values()) {
      if (member.actor_id !== identity.actor_id && member.kind === 'agent') {
        return { targets: [member.actor_id], error: null };
      }
    }
    return { targets: [], error: null };
  }
  const text = bodyInput ? bodyInput.value : '';
  const targets = [];
  for (const actorId of mentionTargets.keys()) {
    const member = members.get(actorId);
    if (member && member.kind === 'agent' && text.includes('@' + member.name)) {
      targets.push(actorId);
    }
  }
  if (targets.length > INVOKE_MAX) {
    return {
      targets: [],
      error: '单条消息最多 @ ' + INVOKE_MAX + ' 个 Agent，请减少 @ 后重试。'
    };
  }
  return { targets: targets, error: null };
}

/** 非安全上下文没有 navigator.clipboard 时的兜底复制。 */
function legacyCopyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  area.style.top = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(area);
  }
  if (!copied) throw new Error('浏览器拒绝了复制操作');
}

function showCopyIdError(error) {
  const message = '复制 ID 失败：' + (error && error.message ? error.message : String(error));
  if (accountCopyButton) accountCopyButton.title = message;
  showStatusMessage(message);
}

/** 复制当前 actor ID；成功后按钮短暂显示“已复制”，不改变任何身份状态。 */
async function copyActorId() {
  let me;
  try {
    me = await ensureIdentity();
  } catch (error) {
    showCopyIdError(error);
    return;
  }
  const actorId = me && me.actor_id;
  if (!actorId) {
    showCopyIdError(new Error('当前身份缺少 actor ID'));
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(actorId);
      } catch (error) {
        legacyCopyText(actorId);
      }
    } else {
      legacyCopyText(actorId);
    }
  } catch (error) {
    showCopyIdError(error);
    return;
  }
  if (!accountCopyButton) return;
  accountCopyButton.textContent = '已复制';
  accountCopyButton.title = '已复制当前 actor ID';
  if (statusElement && statusElement.textContent.indexOf('复制 ID 失败：') === 0) {
    statusElement.textContent = '';
  }
  if (copyResetTimer) clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(function () {
    accountCopyButton.textContent = '复制 ID';
    accountCopyButton.title = '复制当前 actor ID';
    copyResetTimer = null;
  }, 1500);
}

function directPeer() {
  if (!room || room.kind !== 'direct' || !identity) return null;
  for (const member of members.values()) {
    if (member.actor_id !== identity.actor_id) return member;
  }
  return null;
}

function updateRenameAffordance() {
  if (!renameButton) return;
  const peer = directPeer();
  const canRename = Boolean(room && room.kind === 'direct' && peer && peer.kind === 'agent');
  renameButton.hidden = !canRename;
  if (!canRename && renameForm) renameForm.hidden = true;
}

function openRenameForm() {
  const peer = directPeer();
  if (!peer || peer.kind !== 'agent' || !renameForm || !renameInput) return;
  renameInput.value = peer.name;
  renameForm.hidden = false;
  renameButton.hidden = true;
  renameInput.focus();
  renameInput.select();
}

function closeRenameForm() {
  if (renameForm) renameForm.hidden = true;
  updateRenameAffordance();
}

/** 改名是全局操作：同步更新 active 房间、所有缓存与匹配的 direct 列表项。 */
function applyAgentName(actorId, name) {
  const member = members.get(actorId);
  if (member) member.name = name;
  for (const cache of roomCache.values()) {
    for (const cachedMember of cache.members || []) {
      if (cachedMember.actor_id === actorId) cachedMember.name = name;
    }
  }
  for (const summary of peerDetails.values()) {
    if (summary.peer_actor_id === actorId) summary.name = name;
  }
  for (const entry of roomEntries) {
    if (entry.peer_actor_id === actorId) entry.name = name;
  }
  const peer = directPeer();
  if (peer && peer.actor_id === actorId && titleElement) titleElement.textContent = name;
  // 本地 Agents 注册表只做展示缓存；同步失败不影响改名结果。
  agentRegistryRename(actorId, name);
  renderRooms();
}

function hideMentionPicker() {
  if (mentionPicker) mentionPicker.hidden = true;
  activeMention = null;
}

/** 文本中已不存在的 @名字 不再作为 invoke 目标。 */
function pruneMentions() {
  const value = bodyInput ? bodyInput.value : '';
  for (const entry of Array.from(mentionTargets.entries())) {
    if (!value.includes('@' + entry[1])) mentionTargets.delete(entry[0]);
  }
}

function updateMentionPicker() {
  if (!mentionPicker || !bodyInput || !room || room.kind !== 'group' || !identity) {
    hideMentionPicker();
    return;
  }
  const value = bodyInput.value;
  const caret = bodyInput.selectionStart === null ? value.length : bodyInput.selectionStart;
  const match = value.slice(0, caret).match(/@([^\\s@]*)$/);
  if (!match) {
    hideMentionPicker();
    return;
  }
  const query = match[1];
  activeMention = { start: caret - query.length - 1, end: caret };
  const lower = query.toLowerCase();
  const candidates = [];
  for (const member of members.values()) {
    if (member.actor_id === identity.actor_id) continue;
    if (lower && member.name.toLowerCase().indexOf(lower) < 0) continue;
    candidates.push(member);
  }
  mentionPicker.replaceChildren();
  if (candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'list-hint';
    empty.textContent = query ? '没有匹配成员' : '房间还没有其他成员';
    mentionPicker.append(empty);
  } else {
    for (const member of candidates.slice(0, 20)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mention-item';
      item.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.textContent = member.name;
      const kind = document.createElement('span');
      kind.className = 'mention-kind';
      kind.textContent = member.kind === 'agent' ? 'Agent' : '人';
      item.append(name, kind);
      item.addEventListener('click', function () { insertMention(member); });
      mentionPicker.append(item);
    }
  }
  mentionPicker.hidden = false;
}

function insertMention(member) {
  if (!activeMention || !bodyInput) return;
  const value = bodyInput.value;
  const insert = '@' + member.name + ' ';
  bodyInput.value = value.slice(0, activeMention.start) + insert + value.slice(activeMention.end);
  const position = activeMention.start + insert.length;
  bodyInput.setSelectionRange(position, position);
  mentionTargets.set(member.actor_id, member.name);
  if (activeRoomId) drafts.set(activeRoomId, bodyInput.value);
  hideMentionPicker();
  resizeComposer();
  bodyInput.focus();
}

async function loadGroupContacts() {
  const contacts = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const args = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const result = await callTool('network_contacts_list', args);
    contacts.push.apply(contacts, result.items || []);
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return contacts;
}

function renderGroupContacts(contacts) {
  if (!groupContactsElement || !identity) return;
  groupContactsElement.replaceChildren();
  const others = contacts.filter(function (contact) { return contact.actor_id !== identity.actor_id; });
  if (others.length === 0) {
    groupContactsElement.textContent = '还没有好友。先打开 Agent 分享链接添加好友。';
    return;
  }
  for (const contact of others) {
    const label = document.createElement('label');
    label.className = 'contact-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = contact.actor_id;
    const name = document.createElement('span');
    name.textContent = contact.name;
    const kind = document.createElement('span');
    kind.className = 'contact-kind';
    kind.textContent = contact.kind === 'agent' ? 'Agent' : '人';
    label.append(input, name, kind);
    groupContactsElement.append(label);
  }
}

function closeGroupModal() {
  if (groupModal) groupModal.hidden = true;
}

async function openGroupModal() {
  if (!groupModal || !groupContactsElement) return;
  groupModal.hidden = false;
  if (groupTitleInput) groupTitleInput.value = '';
  if (groupErrorElement) groupErrorElement.textContent = '';
  if (groupCreateButton) {
    groupCreateButton.disabled = false;
    groupCreateButton.textContent = '创建';
  }
  groupContactsElement.textContent = '正在读取好友…';
  try {
    await ensureIdentity();
    renderGroupContacts(await loadGroupContacts());
  } catch (error) {
    groupContactsElement.replaceChildren();
    if (groupErrorElement) {
      groupErrorElement.textContent = '读取好友失败：' + (error && error.message ? error.message : error);
    }
  }
}

/** 输入框 1–4 行自适应，超过 4 行后内部滚动。 */
function resizeComposer() {
  if (!bodyInput) return;
  const max = 96;
  bodyInput.style.height = 'auto';
  const height = Math.min(bodyInput.scrollHeight, max);
  bodyInput.style.height = height + 'px';
  bodyInput.style.overflowY = bodyInput.scrollHeight > max ? 'auto' : 'hidden';
}

/**
 * 房间通知的 300ms 合并刷新。
 *
 * 只保留一个定时器，但记住最新的目标房间；切换房间后旧事件不会刷新
 * 新房间，新房间的事件也不会因为旧定时器而丢失。
 */
function scheduleRoomRefresh(roomId) {
  if (!roomId) return;
  pendingRoomRefreshId = roomId;
  if (reloadTimer) return;
  reloadTimer = setTimeout(function () {
    reloadTimer = null;
    const targetRoomId = pendingRoomRefreshId;
    pendingRoomRefreshId = null;
    if (!targetRoomId || activeRoomId !== targetRoomId) return;
    refresh(false).catch(function (error) {
      if (isAbortError(error) || !isActiveRoom(targetRoomId, roomEpoch)) return;
      statusElement.textContent = '刷新会话失败：' + (error && error.message ? error.message : error);
    });
  }, WEB_REFRESH_DEBOUNCE_MS);
}

composer.addEventListener('submit', async function (event) {
  event.preventDefault();
  const sendRoomId = activeRoomId;
  if (!sendRoomId) return;
  const sendEpoch = roomEpoch;
  const body = bodyInput.value.trim();
  if (!body) return;
  stickyStatus = '';
  statusElement.textContent = '';
  const invoke = agentInvokeTargets();
  if (invoke.error) {
    stickyStatus = invoke.error;
    statusElement.textContent = stickyStatus;
    return;
  }
  sendButton.disabled = true;
  try {
    const args = {
      request_id: requestId('web_msg'),
      client_message_id: crypto.randomUUID(),
      room_id: sendRoomId,
      body: body
    };
    // direct 自动唤醒对方 Agent；group 只唤醒被 @ 的 Agent。
    if (invoke.targets.length > 0) args.invoke = invoke.targets;
    const result = await callTool('network_message_send', args);
    // 发送请求不绑定 roomAbort；切换房间后只丢弃 UI 更新，不取消写入。
    const deliveryIds = Array.isArray(result.delivery_ids) ? result.delivery_ids : [];
    // 消息已发出，旧房间草稿必须清除；但不要覆盖新房间的输入框。
    drafts.delete(sendRoomId);
    if (!isActiveRoom(sendRoomId, sendEpoch)) return;
    bodyInput.value = '';
    mentionTargets.clear();
    hideMentionPicker();
    resizeComposer();
    await refresh(true);
    if (!isActiveRoom(sendRoomId, sendEpoch)) return;
    if (invoke.targets.length > 0 && deliveryIds.length !== invoke.targets.length) {
      stickyStatus =
        '消息已发送，但 Agent 投递未建立（' + deliveryIds.length + '/' +
        invoke.targets.length + '），请检查房间成员后重试。';
      statusElement.textContent = stickyStatus;
    }
  } catch (error) {
    if (!isActiveRoom(sendRoomId, sendEpoch)) return;
    stickyStatus = '发送失败：' + (error && error.message ? error.message : error);
    statusElement.textContent = stickyStatus;
  } finally {
    if (isActiveRoom(sendRoomId, sendEpoch)) {
      sendButton.disabled = false;
      bodyInput.focus();
    }
  }
});

bodyInput.addEventListener('input', function () {
  if (activeRoomId) drafts.set(activeRoomId, bodyInput.value);
  resizeComposer();
  pruneMentions();
  updateMentionPicker();
});
bodyInput.addEventListener('compositionstart', function () {
  composing = true;
});
bodyInput.addEventListener('compositionend', function () {
  composing = false;
  // Safari/Chrome 可能在确认候选后紧接着再派发一次 Enter，短暂忽略。
  ignoreEnterUntil = Date.now() + 80;
});
bodyInput.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    hideMentionPicker();
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey) return;
  if (!activeRoomId) return;
  if (event.isComposing || composing || event.keyCode === 229 || Date.now() < ignoreEnterUntil) {
    return;
  }
  event.preventDefault();
  composer.requestSubmit();
});

olderButton.addEventListener('click', function () {
  if (activeRoomId) loadOlder();
});

if (renameButton) renameButton.addEventListener('click', function () {
  if (activeRoomId) openRenameForm();
});
if (renameCancel) renameCancel.addEventListener('click', closeRenameForm);
if (renameForm) {
  renameForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const renameRoomId = activeRoomId;
    if (!renameRoomId) return;
    const renameEpoch = roomEpoch;
    const peer = directPeer();
    if (!peer || peer.kind !== 'agent') return;
    const name = renameInput.value.trim();
    if (!name) {
      statusElement.textContent = '名称不能为空';
      return;
    }
    if (name.length > ACTOR_NAME_MAX) {
      statusElement.textContent = '名称最多 ' + ACTOR_NAME_MAX + ' 个字符';
      return;
    }
    const submitButton = renameForm.querySelector('button[type=submit]');
    submitButton.disabled = true;
    try {
      const result = await callTool('network_agent_rename', {
        request_id: requestId('rename'),
        actor_id: peer.actor_id,
        name: name
      });
      applyAgentName(peer.actor_id, result.name);
      if (!isActiveRoom(renameRoomId, renameEpoch)) return;
      stickyStatus = '';
      statusElement.textContent = '';
      closeRenameForm();
    } catch (error) {
      if (!isActiveRoom(renameRoomId, renameEpoch)) return;
      statusElement.textContent = '改名失败：' + (error && error.message ? error.message : error);
    } finally {
      submitButton.disabled = false;
    }
  });
}

if (chatErrorRetryButton) {
  chatErrorRetryButton.addEventListener('click', function () {
    if (!activeRoomId) return;
    openRoom(activeRoomId, { force: true, initial: false }).catch(function () {});
  });
}

document.addEventListener('click', function (event) {
  if (!mentionPicker || mentionPicker.hidden) return;
  if (mentionPicker.contains(event.target) || event.target === bodyInput) return;
  hideMentionPicker();
});

if (newGroupButton) newGroupButton.addEventListener('click', openGroupModal);
if (groupCancelButton) groupCancelButton.addEventListener('click', closeGroupModal);
if (groupModal) {
  groupModal.addEventListener('click', function (event) {
    if (event.target === groupModal) closeGroupModal();
  });
}
if (groupForm) {
  groupForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const selected = [];
    for (const input of groupContactsElement.querySelectorAll('input[type=checkbox]:checked')) {
      selected.push(input.value);
    }
    if (selected.length === 0) {
      groupErrorElement.textContent = '请至少选择一个成员';
      return;
    }
    const title = groupTitleInput.value.trim();
    groupCreateButton.disabled = true;
    groupErrorElement.textContent = '正在创建…';
    try {
      const args = {
        request_id: requestId('group'),
        kind: 'group',
        members: selected
      };
      if (title) args.title = title;
      const result = await callTool('network_room_create', args);
      const newRoomId = seedRoomCacheFromDetail(result);
      groupErrorElement.textContent = '';
      closeGroupModal();
      navigateTo('/c/' + encodeURIComponent(newRoomId));
    } catch (error) {
      groupErrorElement.textContent =
        '创建失败：' + (error && error.message ? error.message : error);
    } finally {
      groupCreateButton.disabled = false;
    }
  });
}

if (accountCopyButton) accountCopyButton.addEventListener('click', copyActorId);

(async function init() {
  bootstrapRoute(initialRoomId);
  // 首页也启动；每页只有这一条 agentnet://stream，切换房间不重建。
  startActorStream();
  await Promise.allSettled([loadRooms()]);
})();
</script>
<script>
${QR_ENCODER_SCRIPT}
${HANDOFF_CONTROLLER_SCRIPT}
</script>`;
}
