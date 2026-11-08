import { MESSAGE_FILE_ID_SOURCE } from '../contracts/file-links';
import { LIMITS } from '../contracts/limits';
import { CHAT_ACCOUNT_RENAME_SCRIPT } from './chat-account-rename-script';
import { CHAT_AGENTS_SCRIPT } from './chat-agents-script';
import { CHAT_ANNOUNCEMENT_SCRIPT } from './chat-announcement-script';
import { CHAT_ARCHIVE_SCRIPT } from './chat-archive-script';
import { CHAT_AVATAR_SCRIPT } from './chat-avatar-script';
import { CHAT_CONTACTS_SCRIPT } from './chat-contacts-script';
import { CHAT_DRAWBOARD_SCRIPT } from './chat-drawboard-script';
import { CHAT_FILES_ACTIONS_SCRIPT } from './chat-files-actions-script';
import { CHAT_FILES_SCRIPT } from './chat-files-script';
import { CHAT_GROUP_COPY_SCRIPT } from './chat-group-copy-script';
import { CHAT_INVITES_SCRIPT } from './chat-invites-script';
import { CHAT_LIST_SCRIPT } from './chat-list-script';
import { CHAT_LOGOUT_SCRIPT } from './chat-logout-script';
import { CHAT_MARKDOWN_SCRIPT } from './chat-markdown-script';
import { CHAT_MEMBER_PICKER_SCRIPT } from './chat-member-picker';
import { CHAT_MEMBERS_SCRIPT } from './chat-members-script';
import { CHAT_MENTION_SCRIPT } from './chat-mention-script';
import { CHAT_MESSAGE_FILES_SCRIPT } from './chat-message-files-script';
import { CHAT_MONITOR_SCRIPT } from './chat-monitor-script';
import { CHAT_OUTBOX_SCRIPT } from './chat-outbox-script';
import { CHAT_RENDER_SCRIPT } from './chat-render-script';
import { CHAT_RESIZER_SCRIPT } from './chat-resizer-script';
import { CHAT_ROOM_MENU_SCRIPT } from './chat-room-menu-script';
import { CHAT_ROUTER_SCRIPT } from './chat-router-script';
import { CHAT_SAFETY_SCRIPT } from './chat-safety-script';
import { CHAT_SCROLL_SCRIPT } from './chat-scroll-script';
import { CHAT_SESSION_SCRIPT } from './chat-session-script';
import { CHAT_STREAM_SCRIPT } from './chat-stream-script';
import { CHAT_TASK_PROGRESS_SCRIPT } from './chat-task-progress-script';
import { CHAT_TASK_SUBMISSION_SCRIPT } from './chat-task-submission-script';
import { CHAT_TASK_TRANSFER_SCRIPT } from './chat-task-transfer-script';
import { CHAT_TASKS_SCRIPT } from './chat-tasks-script';
import { CHAT_UPLOAD_SCRIPT } from './chat-upload-script';
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
export function chatClientScript(
  roomId: string | null,
  markdownVersion: string | null = null,
  resizerVersion: string | null = null,
  drawboardVersion: string | null = null,
): string {
  const roomJson = roomId === null ? 'null' : jsonForScript(roomId);
  const markdownAssetUrl = markdownVersion
    ? `/assets/chat-markdown.js?v=${encodeURIComponent(markdownVersion)}`
    : '/assets/chat-markdown.js';
  const resizerAssetUrl = resizerVersion
    ? `/assets/chat-resizer.js?v=${encodeURIComponent(resizerVersion)}`
    : '/assets/chat-resizer.js';
  const drawboardAssetUrl = drawboardVersion
    ? `/assets/chat-drawboard.js?v=${encodeURIComponent(drawboardVersion)}`
    : '/assets/chat-drawboard.js';
  return `<script>
const initialRoomId = ${roomJson};
const MARKDOWN_ASSET_URL = ${jsonForScript(markdownAssetUrl)};
const RESIZER_ASSET_URL = ${jsonForScript(resizerAssetUrl)};
const DRAWBOARD_ASSET_URL = ${jsonForScript(drawboardAssetUrl)};
const TOKEN_KEY = 'agent-network-token';
const MAX_CHUNKS = 8;
const ACTOR_NAME_MAX = ${LIMITS.actorNameMax};
const MEMBER_CHANGE_MAX = ${LIMITS.memberChangeMax};
const GROUP_MEMBERS_MAX = ${LIMITS.groupMembersMax};
// 群公告上限与服务端 limits.ts 保持一致；客户端只做提前提示。
const ROOM_ANNOUNCEMENT_BYTES = ${LIMITS.roomAnnouncementBytes};
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
const titleElement = document.getElementById('title');
const subtitleElement = document.getElementById('subtitle');
const messagesElement = document.getElementById('messages');
const jumpLatestButton = document.getElementById('jump-latest');
const jumpLatestLabel = document.getElementById('jump-latest-label');
const olderButton = document.getElementById('older');
const olderStatusElement = document.getElementById('older-status');
const historyPagerElement = document.getElementById('history-pager');
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
const streamDotElement = document.getElementById('stream-dot');
const renameButton = document.getElementById('rename');
const renameForm = document.getElementById('rename-form');
const renameInput = document.getElementById('rename-input');
const renameCancel = document.getElementById('rename-cancel');
const mentionPicker = document.getElementById('mention-picker');
const newGroupButton = document.getElementById('new-group');
const groupModal = document.getElementById('group-modal');
const groupForm = document.getElementById('group-form');
const groupTitleInput = document.getElementById('group-title');
const groupSearchElement = document.getElementById('group-search');
const groupContactsElement = document.getElementById('group-contacts');
const groupContactsCountElement = document.getElementById('group-contacts-count');
const groupMoreButton = document.getElementById('group-more');
const groupSelectionElement = document.getElementById('group-selection');
const groupErrorElement = document.getElementById('group-error');
const groupCreateButton = document.getElementById('group-create');
const groupCancelButton = document.getElementById('group-cancel');

let identity = null;
let roomEntries = [];
let activeMention = null;
// 按房间保存选择器选中的稳定 actor_id；展示名只用于正文与去重，不参与派活解析。
const mentionSelections = new Map();
let composing = false;
let ignoreEnterUntil = 0;
let pendingRoomRefreshId = null;
let groupLoadSeq = 0;
let groupPicker = null;
// 发送失败/投递缺失/截断提示必须跨过 SSE 触发的刷新，不能在 300ms 后被清空。
let stickyStatus = '';

${CHAT_LIST_SCRIPT}
${CHAT_AVATAR_SCRIPT}
${CHAT_ARCHIVE_SCRIPT}
${CHAT_ROOM_MENU_SCRIPT}
${CHAT_MEMBER_PICKER_SCRIPT}
${CHAT_MEMBERS_SCRIPT}
${CHAT_MENTION_SCRIPT}
${CHAT_INVITES_SCRIPT}
${CHAT_ANNOUNCEMENT_SCRIPT}
${CHAT_GROUP_COPY_SCRIPT}
${CHAT_MESSAGE_FILES_SCRIPT}
${CHAT_MARKDOWN_SCRIPT}
${CHAT_RENDER_SCRIPT}
${CHAT_OUTBOX_SCRIPT}
${NEW_AGENT_SCRIPT}
${CHAT_AGENTS_SCRIPT}
${CHAT_CONTACTS_SCRIPT}
${CHAT_SAFETY_SCRIPT}
${CHAT_LOGOUT_SCRIPT}
${CHAT_ACCOUNT_RENAME_SCRIPT}
${CHAT_SCROLL_SCRIPT}
${CHAT_SESSION_SCRIPT}
${CHAT_TASK_PROGRESS_SCRIPT}
${CHAT_TASK_SUBMISSION_SCRIPT}
${CHAT_TASK_TRANSFER_SCRIPT}
${CHAT_TASKS_SCRIPT}
${CHAT_STREAM_SCRIPT}
${CHAT_FILES_SCRIPT}
${CHAT_FILES_ACTIONS_SCRIPT}
${CHAT_UPLOAD_SCRIPT}
${CHAT_DRAWBOARD_SCRIPT}
${CHAT_MONITOR_SCRIPT}
${CHAT_RESIZER_SCRIPT}
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

/**
 * 首次访问自动生成并绑定 human 身份。
 *
 * single-flight：首屏列表与深链房间并行调用时只注册一次。token 在注册前
 * 写入 localStorage，重复打开沿用同一身份；凭据被撤销时换新 token 重试一次。
 */
function ensureIdentity() {
  if (isLoggedOut()) {
    return Promise.reject(
      new Error('已退出登录。请先在首页创建新身份，或打开 Agent 分享链接。')
    );
  }
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

/**
 * 收集网页用户发送消息时的明确目标。
 *
 * direct 自动唤醒对方 Agent；group 只使用选择器保存的 actor_id：
 * Agent 进入 invoke，人类进入 mentions。正文「@名字」仅用于显示与
 * “未显式选择时”的服务端兜底解析，页面不靠名字猜目标。
 */
function directInvokeTargets() {
  if (!identity || identity.kind !== 'human') return { targets: [], error: null };
  if (!room) return { targets: [], error: '房间成员尚未加载，请稍后重试' };
  if (room.kind === 'direct') {
    for (const member of members.values()) {
      if (member.actor_id !== identity.actor_id && member.kind === 'agent') {
        return { targets: [member.actor_id], error: null };
      }
    }
  }
  return { targets: [], error: null };
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

async function loadGroupContacts() {
  const contacts = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const args = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const result = await callTool('network_contacts_list', args);
    for (const contact of result.items || []) {
      if (!contact || typeof contact.actor_id !== 'string') continue;
      // 单侧收藏/历史不是好友：只有双向 active 关系才能用于建群或加成员。
      if (contact.relation !== 'active') continue;
      if (seen.has(contact.actor_id)) continue;
      seen.add(contact.actor_id);
      contacts.push(contact);
    }
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return contacts;
}

/** 建群与添加成员共用一个选择器；这里只绑定建群弹窗的 DOM。 */
function groupPickerController() {
  if (groupPicker) return groupPicker;
  groupPicker = createMemberPicker({
    root: groupContactsElement,
    search: groupSearchElement,
    more: groupMoreButton,
    count: groupContactsCountElement,
    selection: groupSelectionElement,
    empty: '还没有好友。通过分享链接发送好友申请，对方确认后即可加入群聊。'
  });
  return groupPicker;
}

function showGroupPicker(contacts, note) {
  const picker = groupPickerController();
  picker.setContacts(contacts);
  picker.setNote(note || '');
}

function closeGroupModal() {
  groupLoadSeq += 1;
  if (groupModal) groupModal.hidden = true;
}

async function openGroupModal() {
  if (!groupModal || !groupContactsElement) return;
  groupLoadSeq += 1;
  const loadSeq = groupLoadSeq;
  groupModal.hidden = false;
  if (groupTitleInput) groupTitleInput.value = '';
  if (groupErrorElement) groupErrorElement.textContent = '';
  if (groupCreateButton) {
    groupCreateButton.disabled = false;
    groupCreateButton.textContent = '创建';
  }
  const picker = groupPickerController();
  const selfId = identity ? identity.actor_id : '';
  picker.reset();
  picker.setExcluded(selfId ? [selfId] : []);
  picker.setNote('正在读取好友…');
  try {
    await ensureIdentity();
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    const contacts = await loadGroupContacts();
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    picker.setExcluded(identity ? [identity.actor_id] : []);
    showGroupPicker(contacts);
    const ownerActorId = identity ? identity.actor_id : '';
    if (agentContactGaps(ownerActorId, contacts).length === 0) return;
    picker.setNote('正在同步本机创建的 Agent…');
    const synced = await addOwnedAgentContacts(ownerActorId, contacts);
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    showGroupPicker(synced.contacts, agentContactSyncError(synced.failed));
  } catch (error) {
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    picker.setContacts([]);
    picker.setNote('');
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
  // 输入框变高会压缩消息视口；pinned 时在下一帧重新钉到底。
  if (jumpLatestButton && composer) {
    jumpLatestButton.style.bottom = Math.ceil(composer.getBoundingClientRect().height + 14) + 'px';
  }
  scrollController.noteContentChanged();
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
    const epoch = roomEpoch;
    refresh(false).catch(function (error) {
      if (isAbortError(error) || !isActiveRoom(targetRoomId, epoch)) return;
      if (error && (error.code === 'NOT_MEMBER' || error.code === 'NOT_FOUND')) {
        handleRoomError(error, targetRoomId, epoch);
        return;
      }
      statusElement.textContent = '刷新会话失败：' + (error && error.message ? error.message : error);
    });
  }, WEB_REFRESH_DEBOUNCE_MS);
}

composer.addEventListener('submit', async function (event) {
  event.preventDefault();
  // 发送中再次回车不得新建第二条意图；按钮禁用是同一道闸。
  if (sendButton.disabled) return;
  const sendRoomId = activeRoomId;
  if (!sendRoomId) return;
  const sendEpoch = roomEpoch;
  const text = bodyInput.value.trim();
  const body = composerOutgoingBody(sendRoomId, text);
  // 只清空本次真拼进正文的文件；发送请求期间的附件不能丢。
  const sentFileKeys = composerReadyKeys(sendRoomId);
  if (!body) return;
  stickyStatus = '';
  statusElement.textContent = '';
  // 群聊只信选择器保存的 actor_id：Agent 进 invoke，人类进 mentions；
  // 没有任何选择时不传 invoke，保留服务端对正文唯一精确成员的兜底解析。
  let invokeTargets = [];
  let mentionTargets = [];
  let invokeExplicit = false;
  let selectionError = null;
  if (room && room.kind === 'group') {
    const selection = resolvedMentionSelection(sendRoomId, body);
    selectionError = selection.error;
    if (!selectionError) {
      for (const entry of selection.items) {
        if (entry.kind === 'agent') invokeTargets.push(entry.actor_id);
        else mentionTargets.push(entry.actor_id);
      }
      // 只要选择器里有仍存在于正文的目标，就显式发送 invoke（可能是 []），
      // 不让服务端再从正文猜测其他 Agent。
      invokeExplicit = selection.items.length > 0;
    }
  } else {
    const direct = directInvokeTargets();
    selectionError = direct.error;
    invokeTargets = direct.targets;
    invokeExplicit = invokeTargets.length > 0;
  }
  if (selectionError) {
    stickyStatus = selectionError;
    statusElement.textContent = stickyStatus;
    return;
  }
  // 同房间、同正文、同目标的失败意图复用原 client_message_id/request_id；
  // 修改正文会生成新意图，旧 ID 与新内容由服务端返回冲突。
  let intent = outboxFindReusable(
    sendRoomId,
    body,
    invokeTargets,
    mentionTargets,
    invokeExplicit,
  );
  const reused = Boolean(intent);
  if (intent) {
    // 响应丢失后先对账；确认已提交就不再发送第二条。
    sendButton.disabled = true;
    const decision = await outboxCheckBeforeResend(intent);
    if (decision !== 'send') {
      outboxRefreshRows();
      if (isActiveRoom(sendRoomId, sendEpoch)) {
        if (decision === 'committed') {
          if (outboxComposerMatches(intent)) {
            drafts.delete(sendRoomId);
            mentionSelections.delete(sendRoomId);
            clearComposerFiles(sendRoomId, sentFileKeys);
            bodyInput.value = '';
            hideMentionPicker();
            resizeComposer();
          }
          stickyStatus = '';
          statusElement.textContent = '';
          await refresh(true).catch(function () {});
        } else if (decision === 'conflict') {
          statusElement.textContent = '发送失败：' + (intent.error || 'client_message_id 冲突');
        } else {
          stickyStatus = '暂时无法对账，请稍后重试';
          statusElement.textContent = stickyStatus;
        }
      }
      sendButton.disabled = false;
      return;
    }
  } else {
    intent = outboxCreate(
      sendRoomId,
      body,
      invokeTargets,
      mentionTargets,
      invokeExplicit,
    );
  }
  sendButton.disabled = true;
  // 自己的消息必须出现在底部；独立标志避免 refresh 合并时丢失强制滚底。
  scrollController.pinNextApply();
  try {
    await outboxSubmit(intent, {
      epoch: sendEpoch,
      sentFileKeys: sentFileKeys,
      fromRetry: reused,
      invokeTargets: invokeTargets.length
    });
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
  if (!activeRoomId) return;
  loadOlder();
});
installOlderAutoLoad();

if (jumpLatestButton) jumpLatestButton.addEventListener('click', function () {
  const jumpRoomId = activeRoomId;
  if (!jumpRoomId) return;
  const jumpEpoch = roomEpoch;
  // 先立即回到底部并置位，再强制刷新；合并等待中的刷新也不会丢掉。
  scrollController.pinNextApply();
  refresh(true).catch(function (error) {
    if (isAbortError(error) || !isActiveRoom(jumpRoomId, jumpEpoch)) return;
    statusElement.textContent = '刷新会话失败：' + (error && error.message ? error.message : error);
  });
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
    const selected = groupPicker ? groupPicker.selectedIds() : [];
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

const loggedOutStartButton = document.getElementById('logged-out-start');
if (loggedOutStartButton) {
  loggedOutStartButton.addEventListener('click', async function () {
    if (loggedOutStartButton.disabled) return;
    loggedOutStartButton.disabled = true;
    // 显式点击后才清除“已退出”状态并自动注册新身份。
    clearLoggedOutState();
    identity = null;
    identityPromise = null;
    roomsPromise = null;
    roomsLoadedAt = 0;
    setEmptyListMessage('正在创建新身份…');
    const emptyTitle = document.getElementById('empty-title');
    if (emptyTitle) emptyTitle.textContent = '选择一个会话开始聊天';
    const emptyHint = document.getElementById('empty-hint');
    if (emptyHint) emptyHint.textContent = '从左侧选择单聊或群聊，也可以新建群聊。';
    try {
      await loadRooms();
      if (identity) startActorStream();
    } finally {
      loggedOutStartButton.disabled = false;
      if (identity) loggedOutStartButton.hidden = true;
      syncLogoutVisibility();
    }
  });
}

(async function init() {
  // 退出后通过 location.replace('/') 回到本页；不自动注册新身份，也不建 SSE。
  if (isLoggedOut()) {
    if (location.pathname !== '/') {
      window.location.replace('/');
      return;
    }
    bootstrapRoute(null);
    showLoggedOutHome();
    return;
  }
  bootstrapRoute(initialRoomId);
  // 首页也启动；每页只有这一条 agentnet://stream，切换房间不重建。
  startActorStream();
  await Promise.allSettled([loadRooms(), refreshContactBadge()]);
  // 刷新/换设备后先对账本地意图，再决定是否提供重试。
  outboxScheduleReconcile(0);
})();
</script>
<script>
${QR_ENCODER_SCRIPT}
${HANDOFF_CONTROLLER_SCRIPT}
</script>`;
}
