import { LIMITS } from '../contracts/limits';

/**
 * 浏览器身份分区与设备配对。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此可以使用 `callTool`、
 * `identity`、`drafts`、`roomCache` 等既有符号。所有 token 只保存在本地：
 * 当前 token 在 `agent-network-token`，其他已确认身份在按 actor_id 命名的
 * 本地注册表中；从不写入 DOM、URL、console 或服务端日志。
 *
 * 配对流程：已登录设备打开弹窗即创建 5 分钟一次性 challenge，二维码只含
 * `origin + '/pair#c=' + challenge`；新设备在 /pair 用本地 token join，
 * 已登录设备 approve 后新设备才 redeem。这里只负责已登录设备侧 UI。
 */
export const CHAT_IDENTITY_SCRIPT = `
const IDENTITY_TOKEN_KEY = 'agent-network-token';
const IDENTITY_RECORD_PREFIX = 'agent-network-identity-v1:';
const AGENT_REGISTRY_PER_ACTOR_PREFIX = 'agent-network-agents-v1:';
const SYNC_CURSOR_PREFIX = 'agent-network-sync-v1:';
const DRAFT_PREFIX = 'agent-network-draft-v1:';
const DEVICE_ID_KEY = 'agent-network-device-id-v1';
const IDENTITY_REGISTRY_MAX = ${LIMITS.webIdentityRegistryMax};
const SYNC_CURSOR_MAX = ${LIMITS.webSyncCursorMax};
const WEB_DEVICE_PAIRING_TTL_MS = ${LIMITS.devicePairingTtlMs};

let pairingCreated = null;
let pairingRefreshBusy = false;
let pairingCreateBusy = false;
let identityInvalid = false;

function identityStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function identityStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

function identityStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    // localStorage 不可用时没有持久状态可清理。
  }
}

function identityRecordKey(actorId) {
  return IDENTITY_RECORD_PREFIX + actorId;
}

function parseIdentityRecord(raw) {
  if (!raw) return null;
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  if (!value || value.v !== 1) return null;
  if (typeof value.actor_id !== 'string' || !value.actor_id) return null;
  if (typeof value.token !== 'string' || !value.token) return null;
  if (typeof value.name !== 'string') return null;
  if (value.kind !== 'human' && value.kind !== 'agent') return null;
  return {
    actor_id: value.actor_id,
    name: value.name,
    kind: value.kind,
    token: value.token,
    last_used_at: Number(value.last_used_at) || 0
  };
}

/** 读取本机已确认身份；token 只在返回值中，不渲染。 */
function identityRegistryList() {
  const records = [];
  let keys = [];
  try {
    keys = Object.keys(window.localStorage);
  } catch (error) {
    return records;
  }
  for (const key of keys) {
    if (key.indexOf(IDENTITY_RECORD_PREFIX) !== 0) continue;
    const record = parseIdentityRecord(identityStorageGet(key));
    if (!record) continue;
    if (key !== identityRecordKey(record.actor_id)) continue;
    records.push(record);
  }
  records.sort(function (left, right) {
    return right.last_used_at - left.last_used_at ||
      left.actor_id.localeCompare(right.actor_id);
  });
  return records.slice(0, IDENTITY_REGISTRY_MAX);
}

function rememberIdentity(me, token) {
  if (!me || !me.actor_id || !token) return false;
  const record = {
    v: 1,
    actor_id: me.actor_id,
    name: me.name || '未命名',
    kind: me.kind === 'agent' ? 'agent' : 'human',
    token: token,
    last_used_at: Date.now()
  };
  const ok = identityStorageSet(identityRecordKey(me.actor_id), JSON.stringify(record));
  if (!ok) return false;
  const records = identityRegistryList();
  if (records.length > IDENTITY_REGISTRY_MAX) {
    for (const extra of records.slice(IDENTITY_REGISTRY_MAX)) {
      identityStorageRemove(identityRecordKey(extra.actor_id));
    }
  }
  return true;
}

function forgetIdentity(actorId) {
  if (!actorId) return;
  identityStorageRemove(identityRecordKey(actorId));
  identityStorageRemove(AGENT_REGISTRY_PER_ACTOR_PREFIX + actorId);
  identityStorageRemove('agent-network-outbox:v1:' + actorId);
  identityStorageRemove('agent-network-room-preferences-v1:' + actorId);
  identityStorageRemove(SYNC_CURSOR_PREFIX + actorId);
  forgetDrafts(actorId);
  forgetLegacyAgentEntries(actorId);
}

function currentActorIdForDraft() {
  if (identity && identity.actor_id) return identity.actor_id;
  const token = identityStorageGet(IDENTITY_TOKEN_KEY);
  if (!token) return null;
  const record = identityRegistryList().find(function (item) {
    return item.token === token;
  });
  return record ? record.actor_id : null;
}

function draftStorageKey(roomId) {
  const actorId = currentActorIdForDraft();
  if (!actorId || !roomId) return null;
  return DRAFT_PREFIX + actorId + ':' + roomId;
}

function draftLoad(roomId) {
  const key = draftStorageKey(roomId);
  if (!key) return '';
  return identityStorageGet(key) || '';
}

function draftSave(roomId, text) {
  const key = draftStorageKey(roomId);
  if (!key) return;
  if (!text) identityStorageRemove(key);
  else identityStorageSet(key, text);
}

function draftClear(roomId) {
  const key = draftStorageKey(roomId);
  if (key) identityStorageRemove(key);
}

function forgetDrafts(actorId) {
  const prefix = DRAFT_PREFIX + actorId + ':';
  let keys = [];
  try {
    keys = Object.keys(window.localStorage);
  } catch (error) {
    return;
  }
  for (const key of keys) {
    if (key.indexOf(prefix) === 0 || key.indexOf('agent-network-reply-v1:' + actorId + ':') === 0) identityStorageRemove(key);
  }
}

/** 旧版本把 Agents 放在一个全局 key；退出只移除当前 owner 的条目。 */
function forgetLegacyAgentEntries(ownerActorId) {
  const raw = identityStorageGet('agent-network-agents-v1');
  if (!raw) return;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    identityStorageRemove('agent-network-agents-v1');
    return;
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    identityStorageRemove('agent-network-agents-v1');
    return;
  }
  const kept = parsed.items.filter(function (item) {
    return item && item.owner_actor_id !== ownerActorId;
  });
  if (kept.length === 0) identityStorageRemove('agent-network-agents-v1');
  else identityStorageSet('agent-network-agents-v1', JSON.stringify({ v: 1, items: kept }));
}

function currentIdentityToken() {
  return identityStorageGet(IDENTITY_TOKEN_KEY);
}

function setCurrentIdentityToken(token) {
  return identityStorageSet(IDENTITY_TOKEN_KEY, token);
}

function clearLoggedOutMarker() {
  identityStorageRemove('agent-network-logged-out');
}

/** 当前浏览器设备标识；不是凭据，只用于配对后的设备列表。 */
function ensureDeviceId() {
  let value = identityStorageGet(DEVICE_ID_KEY);
  if (value && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)) return value;
  value = crypto.randomUUID();
  identityStorageSet(DEVICE_ID_KEY, value);
  return value;
}

function pairingSetStatus(message, kind) {
  const element = document.getElementById('pairing-status');
  if (!element) return;
  element.textContent = message || '';
  if (kind === 'error') element.setAttribute('data-error', '1');
  else element.removeAttribute('data-error');
  if (kind === 'success') element.setAttribute('data-success', '1');
  else element.removeAttribute('data-success');
}

function pairingFormatDate(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString();
  } catch (error) {
    return date.toISOString();
  }
}

function pairingChallengeDisplay(challenge) {
  const value = String(challenge || '');
  if (value.length !== 12) return value;
  return value.slice(0, 4) + '-' + value.slice(4, 8) + '-' + value.slice(8);
}

function pairingCopyText(text, onSuccess, onFailure) {
  const fallback = function (error) {
    try {
      legacyCopyText(text);
      onSuccess();
    } catch (fallbackError) {
      onFailure(error || fallbackError);
    }
  };
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    fallback(null);
    return;
  }
  try {
    navigator.clipboard.writeText(text).then(onSuccess, function () {
      fallback(null);
    });
  } catch (error) {
    fallback(error);
  }
}

function openHandoffDialog() {
  const button = document.getElementById('device-handoff');
  const modal = document.getElementById('handoff-modal');
  const closeButton = document.getElementById('handoff-close');
  if (!modal) return;
  openNativeDialog(modal, closeHandoffDialog);
  if (button) button.setAttribute('aria-expanded', 'true');
  pairingSetStatus('', '');
  refreshPairings();
  createPairingChallenge();
  if (closeButton) closeButton.focus();
}

function closeHandoffDialog() {
  const button = document.getElementById('device-handoff');
  const modal = document.getElementById('handoff-modal');
  if (!modal) return;
  closeNativeDialog(modal);
  if (button) button.setAttribute('aria-expanded', 'false');
}

function setPairingRetryVisible(visible) {
  const retry = document.getElementById('pairing-retry');
  if (retry) retry.hidden = !visible;
}

function resetPairingChallenge() {
  pairingCreated = null;
  const wrap = document.getElementById('pairing-qr-wrap');
  if (wrap) wrap.hidden = true;
  const canvas = document.getElementById('handoff-qr');
  if (canvas) canvas.hidden = true;
  const code = document.getElementById('pairing-code');
  if (code) code.textContent = '';
  const expiry = document.getElementById('pairing-expiry');
  if (expiry) expiry.textContent = '';
  const copy = document.getElementById('handoff-copy');
  if (copy) {
    copy.disabled = true;
    copy.textContent = '复制链接';
  }
}

async function cancelPreviousPairing() {
  if (!pairingCreated || !pairingCreated.pairing_id) return true;
  try {
    await callTool('network_device_pairing_cancel', {
      request_id: requestId('pair_cancel'),
      pairing_id: pairingCreated.pairing_id,
      reason: 'regenerated_in_browser'
    });
    return true;
  } catch (error) {
    // 已兑换的挑战没有可撤销状态；其余错误保留旧挑战并让用户重试。
    return Boolean(error && error.code === 'PAIRING_INVALID');
  }
}

async function createPairingChallenge() {
  if (pairingCreateBusy) return;
  if (!identityStorageGet(IDENTITY_TOKEN_KEY) || identityInvalid) {
    resetPairingChallenge();
    setPairingRetryVisible(true);
    pairingSetStatus(identityInvalid
      ? '当前凭据已失效；请用另一台已登录设备配对，成功后在这台设备打开 /pair。'
      : '当前没有已登录身份；请先在另一台设备登录并生成配对码。', 'error');
    return;
  }
  pairingCreateBusy = true;
  const button = document.getElementById('pairing-create');
  if (button) button.disabled = true;
  setPairingRetryVisible(false);
  pairingSetStatus('正在生成 5 分钟一次性配对挑战…', '');
  try {
    if (!identity) {
      await ensureIdentity();
    }
    if (!(await cancelPreviousPairing())) {
      pairingSetStatus('旧配对码撤销失败；请检查网络后重试。', 'error');
      setPairingRetryVisible(true);
      return;
    }
    resetPairingChallenge();
    const created = await callTool('network_device_pairing_create', {
      request_id: requestId('pair_create'),
      device_label: '当前设备',
      platform: String(navigator.platform || 'web').slice(0, 32)
    });
    pairingCreated = created;
    const canvas = document.getElementById('handoff-qr');
    const wrap = document.getElementById('pairing-qr-wrap');
    const code = document.getElementById('pairing-code');
    const expiry = document.getElementById('pairing-expiry');
    const copy = document.getElementById('handoff-copy');
    if (code) code.textContent = pairingChallengeDisplay(created.challenge);
    if (expiry) {
      expiry.textContent = '有效至 ' + pairingFormatDate(created.expires_at);
    }
    if (wrap) wrap.hidden = false;
    if (canvas) {
      canvas.hidden = false;
      try {
        window.agentNetworkQr.draw(canvas, created.pair_url);
      } catch (error) {
        canvas.hidden = true;
        pairingSetStatus('二维码生成失败：' + (error && error.message ? error.message : String(error)) +
          '；仍可复制配对链接或手动输入短码。', 'error');
      }
    }
    if (copy) copy.disabled = false;
    if (!pairingStatusHasError()) {
      pairingSetStatus('用另一台设备扫描二维码或输入短码，然后核对设备名称与确认码后批准。', 'success');
    }
    refreshPairings();
  } catch (error) {
    pairingSetStatus('生成失败：' + (error && error.message ? error.message : String(error)) +
      '；请检查网络后重试。', 'error');
    setPairingRetryVisible(true);
  } finally {
    pairingCreateBusy = false;
    if (button) button.disabled = false;
  }
}

function pairingStatusHasError() {
  const element = document.getElementById('pairing-status');
  return Boolean(element && element.getAttribute('data-error'));
}

function pairingItem(entry) {
  const item = document.createElement('li');
  item.className = 'pairing-item';
  item.dataset.pairingId = entry.pairing_id;
  const main = document.createElement('div');
  main.className = 'pairing-item-main';
  main.textContent = (entry.device_label || '未命名设备') +
    (entry.platform ? ' · ' + entry.platform : '');
  item.appendChild(main);
  const meta = document.createElement('div');
  meta.className = 'pairing-item-meta';
  meta.textContent = '确认码 ' + (entry.confirm_code || '—') +
    ' · ' + pairingFormatDate(entry.created_at) +
    (entry.created_by_current_device ? ' · 由当前设备创建' : '') +
    ' · ' + (entry.status === 'approved' ? '已批准，等待新设备兑换' : '等待确认');
  item.appendChild(meta);
  const code = document.createElement('div');
  code.className = 'pairing-item-code';
  code.textContent = entry.status === 'approved' ? '已批准' : '待确认';
  item.appendChild(code);
  const actions = document.createElement('div');
  actions.className = 'pairing-item-actions';
  if (entry.status === 'pending' && entry.confirm_code) {
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'primary';
    approve.textContent = '确认新设备';
    approve.addEventListener('click', function () {
      decidePairing(entry.pairing_id, 'approve');
    });
    actions.appendChild(approve);
  }
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'danger';
  reject.textContent = entry.status === 'approved' ? '撤销批准' : '拒绝';
  reject.addEventListener('click', function () {
    decidePairing(entry.pairing_id, 'cancel');
  });
  actions.appendChild(reject);
  item.appendChild(actions);
  return item;
}

async function refreshPairings() {
  if (pairingRefreshBusy) return;
  const list = document.getElementById('pairing-list');
  const empty = document.getElementById('pairing-list-empty');
  if (!list || !empty) return;
  if (!identityStorageGet(IDENTITY_TOKEN_KEY)) {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = '当前没有已登录身份；请先在已登录设备生成配对码。';
    return;
  }
  pairingRefreshBusy = true;
  try {
    const page = await callTool('network_device_pairing_list', { limit: 50 });
    const active = (page.items || []).filter(function (entry) {
      if (!entry || (entry.status !== 'pending' && entry.status !== 'approved')) return false;
      // confirm_code 只在有新设备 join 后产生；空值代表左侧配对码仍在等待扫描，
      // 不是“待确认的新设备”，不能提前显示确认按钮。
      return Boolean(entry.confirm_code);
    });
    list.replaceChildren();
    for (const entry of active) list.appendChild(pairingItem(entry));
    empty.hidden = active.length > 0;
    empty.textContent = active.length === 0
      ? '暂无待确认设备；左侧配对码正在等待新设备扫描。'
      : '';
  } catch (error) {
    empty.hidden = false;
    empty.textContent = '读取配对请求失败：' +
      (error && error.message ? error.message : String(error)) + '；请稍后重试。';
  } finally {
    pairingRefreshBusy = false;
  }
}

async function decidePairing(pairingId, action) {
  pairingSetStatus(action === 'approve' ? '正在确认新设备…' : '正在拒绝配对请求…', '');
  try {
    if (action === 'approve') {
      await callTool('network_device_pairing_approve', {
        request_id: requestId('pair_ok'),
        pairing_id: pairingId
      });
      pairingSetStatus('已确认。请让新设备点击“兑换并切换”；它的 token 仍只保存在新设备本地。', 'success');
    } else {
      await callTool('network_device_pairing_cancel', {
        request_id: requestId('pair_cancel'),
        pairing_id: pairingId,
        reason: 'rejected_in_browser'
      });
      pairingSetStatus('已拒绝。新设备需要重新扫描新的配对码。', 'success');
    }
    await refreshPairings();
  } catch (error) {
    pairingSetStatus('操作失败：' + (error && error.message ? error.message : String(error)) +
      '；请刷新配对列表后重试。', 'error');
  }
}

function showCredentialInvalidHome(message) {
  identityInvalid = true;
  if (roomListElement) roomListElement.replaceChildren();
  clearListSkeleton();
  setListRetry(false);
  const detail = message ||
    '当前凭据已失效或已被撤销。本机不会自动创建替代身份。';
  setEmptyListMessage(detail + ' 请在另一台已登录设备生成配对码后打开 /pair。');
  if (accountNameElement) accountNameElement.textContent = '凭据失效';
  if (accountAvatarElement) {
    resetAgentAvatar(accountAvatarElement);
    accountAvatarElement.textContent = '!';
    accountAvatarElement.style.background = '#c0392b';
  }
  const renameButton = document.getElementById('account-rename');
  if (renameButton) renameButton.hidden = true;
  const actions = document.querySelector('.account-actions');
  if (actions) actions.hidden = false;
  const createButton = document.getElementById('pairing-create');
  if (createButton) createButton.disabled = true;
  if (newGroupButton) newGroupButton.disabled = true;
  const startButton = document.getElementById('logged-out-start');
  if (startButton) startButton.hidden = true;
  const pairButton = document.getElementById('credential-invalid-pair');
  if (pairButton) pairButton.hidden = false;
  const emptyTitle = document.getElementById('empty-title');
  if (emptyTitle) emptyTitle.textContent = '凭据已失效';
  const emptyHint = document.getElementById('empty-hint');
  if (emptyHint) {
    emptyHint.textContent = '本机不会自动创建新身份。请用另一台已登录设备生成配对码，再打开 /pair。';
  }
  renderLocalIdentities();
  syncLogoutVisibility();
}

function renderLocalIdentities() {
  const container = document.getElementById('logged-out-identities');
  if (!container) return;
  const records = identityRegistryList();
  container.replaceChildren();
  container.hidden = records.length === 0;
  if (records.length === 0) return;
  const title = document.createElement('p');
  title.className = 'local-identities-title';
  title.textContent = '本机其他身份';
  container.appendChild(title);
  for (const record of records) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-retry local-identity';
    button.textContent = '以 ' + (record.name || '未命名') + ' 继续';
    button.addEventListener('click', function () {
      switchToLocalIdentity(record.actor_id);
    });
    container.appendChild(button);
  }
}

async function switchToLocalIdentity(actorId) {
  const record = parseIdentityRecord(identityStorageGet(identityRecordKey(actorId)));
  if (!record) {
    showCredentialInvalidHome('本机身份记录已损坏；请重新配对。');
    return;
  }
  try {
    const me = await callTool('network_me', {}, record.token);
    if (!rememberIdentity(me, record.token) || !setCurrentIdentityToken(record.token)) {
      throw new Error('浏览器无法保存身份');
    }
    clearLoggedOutMarker();
    window.location.replace('/');
  } catch (error) {
    showCredentialInvalidHome('该本机身份的凭据已失效：' +
      (error && error.message ? error.message : String(error)) +
      '。不会自动创建替代身份；请重新配对。');
  }
}

function syncCursorStore() {
  const actor = identity && identity.actor_id ? identity.actor_id : null;
  if (!actor) return { key: null, values: {} };
  const key = SYNC_CURSOR_PREFIX + actor;
  let values = {};
  const raw = identityStorageGet(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed;
    } catch (error) {
      values = {};
    }
  }
  return { key: key, values: values };
}

function syncCursorGet(scope) {
  const store = syncCursorStore();
  const value = store.values[scope];
  return typeof value === 'string' && value.length > 0 && value.length <= SYNC_CURSOR_MAX
    ? value
    : null;
}

function syncCursorSet(scope, cursor) {
  const store = syncCursorStore();
  if (!store.key || !cursor || cursor.length > SYNC_CURSOR_MAX) return;
  store.values[scope] = cursor;
  identityStorageSet(store.key, JSON.stringify(store.values));
}

function syncCursorClear(scope) {
  const store = syncCursorStore();
  if (!store.key) return;
  delete store.values[scope];
  identityStorageSet(store.key, JSON.stringify(store.values));
}

/** Drop client-side message plaintext when a room sync cursor is no longer authorized. */
function purgeInvalidRoomCache(roomId) {
  const cached = roomCache.get(roomId);
  const messageIds = new Set();
  for (const item of (cached && Array.isArray(cached.items) ? cached.items : [])) {
    if (item && item.message_id) messageIds.add(item.message_id);
  }
  if (activeRoomId === roomId) {
    for (const item of (Array.isArray(currentItems) ? currentItems : [])) {
      if (item && item.message_id) messageIds.add(item.message_id);
    }
  }
  for (const messageId of messageIds) {
    const expanded = expandedMessageBodies.get(messageId);
    if (expanded !== undefined) expandedBodyCacheSize = Math.max(0, expandedBodyCacheSize - expanded.length * 2);
    expandedMessageBodies.delete(messageId);
    longMessageExpanded.delete(messageId);
    agentAutoExpandReads.delete(messageId);
  }
  if (activeRoomId === roomId) {
    resetAgentAutoExpand();
  }
  discardRoomCache(roomId);
  if (activeRoomId === roomId) {
    // Hide old plaintext and disable send while the scheduled authoritative refresh checks access.
    setChatLoading(true);
  }
}

/** 首次房间快照锚定游标；之后始终只从保存的游标增量补读。 */
function syncCursorPrimeRoom(roomId, headSeq) {
  if (!roomId || syncCursorGet('room:' + roomId)) return;
  const seq = Number(headSeq);
  if (!Number.isSafeInteger(seq) || seq < 0) return;
  const payload = { v: 1, scope: 'sync:room:' + roomId, dir: 'after', seq: seq, snapshot: seq };
  const cursor = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  syncCursorSet('room:' + roomId, cursor);
}

let syncCatchUpRunning = false;
let syncCatchUpResumeScope = null;

/**
 * 重连补读：读取服务端游标，只补状态与刷新标记，不重放历史工作。
 *
 * inbox 首次建立游标时使用服务端 head_cursor；房间游标由首次缓存快照的
 * room.head_seq 锚定。只处理撤回事件，不重放历史工作。每轮最多读 5 页，
 * 超出部分在下一次任务调度中继续；业务状态仍由工具读取。
 */
async function syncCatchUp() {
  if (syncCatchUpRunning || !identity || !identity.actor_id) return;
  syncCatchUpRunning = true;
  let dirty = false;
  let continueCatchUp = false;
  let pageBudget = 5;
  const scopes = ['inbox'];
  const roomIds = new Set(Array.from(roomCache.keys()));
  if (activeRoomId) roomIds.add(activeRoomId);
  for (const roomId of roomIds) scopes.push('room:' + roomId);
  let startScopeIndex = syncCatchUpResumeScope ? scopes.indexOf(syncCatchUpResumeScope) : 0;
  if (startScopeIndex < 0) startScopeIndex = 0;
  try {
    for (let scopeIndex = startScopeIndex; scopeIndex < scopes.length; scopeIndex += 1) {
      const scope = scopes[scopeIndex];
      let cursor = syncCursorGet(scope);
      if (!cursor) {
        // Inbox cursor is primed to avoid replaying old work. Room cursors are
        // primed at the snapshot head when their first page is cached.
        if (scope === 'inbox') {
          const prime = await callTool('network_sync', { scope: scope, limit: 1 });
          if (prime && prime.head_cursor) syncCursorSet(scope, prime.head_cursor);
          continue;
        }
        const cached = roomCache.get(scope.slice('room:'.length));
        if (cached && cached.room && cached.room.head_seq !== undefined) {
          syncCursorPrimeRoom(scope.slice('room:'.length), cached.room.head_seq);
          cursor = syncCursorGet(scope);
        }
        if (!cursor) {
          const prime = await callTool('network_sync', { scope: scope, limit: 1 });
          if (prime && prime.head_cursor) syncCursorSet(scope, prime.head_cursor);
          continue;
        }
      }
      let scopeHasMore = false;
      while (pageBudget > 0) {
        pageBudget -= 1;
        let page;
        try {
          page = await callTool('network_sync', { scope: scope, ...(cursor ? { cursor: cursor } : {}), limit: 50 });
        } catch (error) {
          const message = error && error.message ? String(error.message) : String(error);
          if (scope.indexOf('room:') === 0 && (message.indexOf('NOT_MEMBER:') === 0 || message.indexOf('NOT_FOUND:') === 0 || error.code === 'NOT_MEMBER' || error.code === 'NOT_FOUND')) {
            const roomId = scope.slice('room:'.length);
            syncCursorClear(scope);
            purgeInvalidRoomCache(roomId);
            dirty = true;
            break;
          }
          throw error;
        }
        if (page.reset_required) {
          const roomId = scope.slice('room:'.length);
          purgeInvalidRoomCache(roomId);
          if (page.head_cursor) {
            cursor = page.head_cursor;
            syncCursorSet(scope, cursor);
          } else syncCursorClear(scope);
          dirty = true;
          break;
        }
        for (const item of page.items || []) {
          if (scope.indexOf('room:') === 0 && item && item.type === 'message_recalled') {
            const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
            const recalledRoomId = typeof metadata.room_id === 'string' ? metadata.room_id : scope.slice('room:'.length);
            const messageId = typeof metadata.message_id === 'string' ? metadata.message_id : item.ref_id;
            if (messageId) applyRecalledMessage(recalledRoomId, messageId);
          }
          const eventId = item && item.event_id !== undefined
            ? String(item.event_id)
            : item && item.seq !== undefined ? String(item.seq) : '';
          if (!eventId || streamSeenEventIds.has(eventId)) continue;
          rememberStreamEvent(eventId);
          dirty = true;
        }
        if (page.next_cursor) {
          cursor = page.next_cursor;
          syncCursorSet(scope, cursor);
        }
        scopeHasMore = Boolean(page.has_more);
        if (!scopeHasMore) break;
      }
      if (scopeHasMore && pageBudget === 0) {
        syncCatchUpResumeScope = scope;
        continueCatchUp = true;
        break;
      }
      if (pageBudget === 0 && scopeIndex + 1 < scopes.length) {
        syncCatchUpResumeScope = scopes[scopeIndex + 1];
        continueCatchUp = true;
        break;
      }
    }
    if (!continueCatchUp) syncCatchUpResumeScope = null;
    if (dirty) {
      scheduleRoomListRefresh(true);
      if (activeRoomId) {
        invalidateTaskSummaries();
        scheduleRoomRefresh(activeRoomId);
        scheduleFilesRefresh(activeRoomId);
      }
    }
  } catch (error) {
    if (error && error.code === 'CREDENTIAL_INVALID') {
      identity = null;
      showCredentialInvalidHome('实时补读时发现凭据已失效。');
      return;
    }
    streamDebug('sync catch-up failed', error && error.message ? error.message : String(error));
  } finally {
    syncCatchUpRunning = false;
    if (continueCatchUp) setTimeout(syncCatchUp, 0);
  }
}

(function installIdentityUi() {
  'use strict';
  const handoffButton = document.getElementById('device-handoff');
  const handoffModal = document.getElementById('handoff-modal');
  const handoffClose = document.getElementById('handoff-close');
  const pairingCreate = document.getElementById('pairing-create');
  const pairingRefresh = document.getElementById('pairing-refresh');
  const copyButton = document.getElementById('handoff-copy');
  const pairingRetry = document.getElementById('pairing-retry');
  const pairButton = document.getElementById('credential-invalid-pair');

  if (handoffButton) handoffButton.addEventListener('click', openHandoffDialog);
  if (handoffClose) handoffClose.addEventListener('click', closeHandoffDialog);
  if (pairingCreate) pairingCreate.addEventListener('click', createPairingChallenge);
  if (pairingRetry) pairingRetry.addEventListener('click', createPairingChallenge);
  if (pairingRefresh) pairingRefresh.addEventListener('click', refreshPairings);
  if (copyButton) {
    copyButton.addEventListener('click', function () {
      if (!pairingCreated || !pairingCreated.pair_url) return;
      pairingCopyText(pairingCreated.pair_url, function () {
        copyButton.textContent = '已复制链接';
        pairingSetStatus('配对链接已复制，5 分钟内有效；链接只含一次性挑战，不含 token。', 'success');
        setTimeout(function () { copyButton.textContent = '复制链接'; }, 1500);
      }, function (error) {
        copyButton.textContent = '复制链接';
        pairingSetStatus('复制失败：' + (error && error.message ? error.message : String(error)) +
          '；请检查剪贴板权限，或手动输入短码。', 'error');
      });
    });
  }
  if (pairButton) {
    pairButton.addEventListener('click', function () {
      window.location.href = '/pair';
    });
  }
  window.addEventListener('agentnet:device', function () {
    if (handoffModal && handoffModal.open) refreshPairings();
  });
})();
`;
