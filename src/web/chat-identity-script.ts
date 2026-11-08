import { LIMITS } from '../contracts/limits';

/**
 * 浏览器身份分区、设备配对与旧长期凭据升级。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此可以使用 `callTool`、
 * `identity`、`drafts`、`roomCache` 等既有符号。所有 token 只保存在本地：
 * 当前 token 在 `agent-network-token`，其他已确认身份在按 actor_id 命名的
 * 本地注册表中；从不写入 DOM、URL、console 或服务端日志。
 *
 * 配对流程：已登录设备创建 5 分钟一次性 challenge，二维码只含
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
let pendingLegacyToken = null;
let legacyResolveBusy = false;
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
    if (key.indexOf(prefix) === 0) identityStorageRemove(key);
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
  const createButton = document.getElementById('pairing-create');
  if (!modal) return;
  modal.hidden = false;
  if (button) button.setAttribute('aria-expanded', 'true');
  pairingSetStatus('', '');
  if (!identityStorageGet(IDENTITY_TOKEN_KEY) || identityInvalid) {
    resetPairingChallenge();
    if (createButton) createButton.disabled = true;
    pairingSetStatus(identityInvalid
      ? '当前凭据已失效；不会自动创建替代身份。请用另一台已登录设备配对，或使用旧方式长期凭据。'
      : '当前没有已登录身份；请先在另一台设备登录或从已登录设备生成配对码。', 'error');
  } else if (createButton) {
    createButton.disabled = false;
  }
  refreshPairings();
  if (closeButton) closeButton.focus();
}

function closeHandoffDialog() {
  const button = document.getElementById('device-handoff');
  const modal = document.getElementById('handoff-modal');
  if (!modal) return;
  modal.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}

function resetPairingChallenge() {
  pairingCreated = null;
  const wrap = document.getElementById('pairing-qr-wrap');
  if (wrap) wrap.hidden = true;
  const code = document.getElementById('pairing-code');
  if (code) code.textContent = '';
  const expiry = document.getElementById('pairing-expiry');
  if (expiry) expiry.textContent = '';
  const copy = document.getElementById('handoff-copy');
  if (copy) {
    copy.disabled = true;
    copy.textContent = '复制配对链接';
  }
}

async function createPairingChallenge() {
  if (!identityStorageGet(IDENTITY_TOKEN_KEY) || identityInvalid) {
    resetPairingChallenge();
    pairingSetStatus(identityInvalid
      ? '当前凭据已失效；不会自动创建替代身份。请用另一台已登录设备配对，或使用旧方式长期凭据。'
      : '当前没有已登录身份；请先在另一台设备登录或从已登录设备生成配对码。', 'error');
    return;
  }
  const button = document.getElementById('pairing-create');
  if (button) button.disabled = true;
  resetPairingChallenge();
  pairingSetStatus('正在生成 5 分钟一次性配对挑战…', '');
  try {
    if (!identity) {
      await ensureIdentity();
    }
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
      expiry.textContent = '有效至 ' + pairingFormatDate(created.expires_at) +
        '；过期、已用、已撤销或尝试超限都会失败。';
    }
    if (wrap) wrap.hidden = false;
    if (canvas) {
      try {
        window.agentNetworkQr.draw(canvas, created.pair_url);
      } catch (error) {
        if (wrap) wrap.hidden = true;
        pairingSetStatus('二维码生成失败：' + (error && error.message ? error.message : String(error)) +
          '；仍可复制下方配对链接或手动输入短码。', 'error');
      }
    }
    if (copy) copy.disabled = false;
    pairingSetStatus('二维码只包含 5 分钟一次性挑战，不含 token。请在新设备打开 /pair 后输入短码。', 'success');
    refreshPairings();
  } catch (error) {
    pairingSetStatus('生成失败：' + (error && error.message ? error.message : String(error)) +
      '；请刷新页面后重试。', 'error');
  } finally {
    if (button) button.disabled = false;
  }
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
  if (entry.status === 'pending') {
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
      return entry && (entry.status === 'pending' || entry.status === 'approved');
    });
    list.replaceChildren();
    for (const entry of active) list.appendChild(pairingItem(entry));
    empty.hidden = active.length > 0;
    empty.textContent = active.length === 0 ? '暂无待确认设备' : '';
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

function parseLegacyToken(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  const hashIndex = text.indexOf('#t=');
  if (hashIndex >= 0) {
    try {
      text = decodeURIComponent(text.slice(hashIndex + 3));
    } catch (error) {
      return null;
    }
  } else {
    try {
      const url = new URL(text);
      text = url.searchParams.get('token') || text;
    } catch (error) {
      // 不是 URL，按原始 token 处理。
    }
  }
  text = text.trim();
  if (!text || text.length > 512) return null;
  return text;
}

function legacyClose() {
  const modal = document.getElementById('legacy-token-modal');
  if (modal) modal.hidden = true;
  pendingLegacyToken = null;
  legacyResolveBusy = false;
  const status = document.getElementById('legacy-token-status');
  if (status) {
    status.textContent = '';
    status.removeAttribute('data-error');
  }
}

function legacySetStatus(message, error) {
  const status = document.getElementById('legacy-token-status');
  if (!status) return;
  status.textContent = message || '';
  if (error) status.setAttribute('data-error', '1');
  else status.removeAttribute('data-error');
}

async function describeIdentity(token, fallback) {
  try {
    const me = await callTool('network_me', {}, token);
    return (me.name || '未命名') + '（' + me.actor_id + '）';
  } catch (error) {
    if (error && error.code === 'CREDENTIAL_INVALID') return fallback + '：凭据无效或已撤销';
    return fallback + '：' + (error && error.message ? error.message : String(error));
  }
}

async function openLegacyConfirm(token) {
  const modal = document.getElementById('legacy-token-modal');
  if (!modal) return;
  pendingLegacyToken = token;
  const original = document.getElementById('legacy-token-original');
  const target = document.getElementById('legacy-token-target');
  const confirm = document.getElementById('legacy-token-confirm');
  const cancel = document.getElementById('legacy-token-cancel');
  if (original) original.textContent = '读取中…';
  if (target) target.textContent = '读取中…';
  if (confirm) confirm.disabled = true;
  if (cancel) cancel.disabled = false;
  legacySetStatus('正在验证目标长期凭据…', false);
  modal.hidden = false;
  const currentToken = identityStorageGet(IDENTITY_TOKEN_KEY);
  const currentPromise = currentToken
    ? describeIdentity(currentToken, '当前身份')
    : Promise.resolve(identity && identity.actor_id
      ? (identity.name || '未命名') + '（' + identity.actor_id + '）'
      : '未登录');
  const targetPromise = describeIdentity(token, '目标身份');
  const currentText = await currentPromise;
  const targetText = await targetPromise;
  if (original) original.textContent = currentText;
  if (target) target.textContent = targetText;
  const targetInvalid = targetText.indexOf('凭据无效或已撤销') >= 0;
  if (targetInvalid) {
    legacySetStatus('目标凭据无效或已撤销；不会切换，也不会自动创建替代身份。请改用配对流程。', true);
    return;
  }
  if (confirm) confirm.disabled = false;
  const same = identity && identity.actor_id && targetText.indexOf('（' + identity.actor_id + '）') >= 0;
  legacySetStatus(same
    ? '目标与当前是同一身份；确认后仅改用这条长期凭据。'
    : '确认后切换到目标身份；当前身份仍保留在本机身份列表，可再次显式切回。', false);
}

async function confirmLegacySwitch() {
  if (!pendingLegacyToken || legacyResolveBusy) return;
  legacyResolveBusy = true;
  const confirm = document.getElementById('legacy-token-confirm');
  if (confirm) confirm.disabled = true;
  legacySetStatus('正在确认目标身份…', false);
  try {
    const target = await callTool('network_me', {}, pendingLegacyToken);
    const currentToken = identityStorageGet(IDENTITY_TOKEN_KEY);
    let current = identity;
    if (!current && currentToken) {
      try {
        current = await callTool('network_me', {}, currentToken);
      } catch (error) {
        current = null;
      }
    }
    if (current && currentToken) rememberIdentity(current, currentToken);
    if (!rememberIdentity(target, pendingLegacyToken)) {
      throw new Error('浏览器无法保存身份；请允许本地存储后重试');
    }
    if (!setCurrentIdentityToken(pendingLegacyToken)) {
      throw new Error('浏览器无法保存当前身份 token');
    }
    clearLoggedOutMarker();
    window.__agentNetworkLegacyToken = null;
    pendingLegacyToken = null;
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (error) {
      // hash 已由早执行脚本清除；这里只做兜底。
    }
    window.location.replace('/');
  } catch (error) {
    legacySetStatus('切换失败：' + (error && error.message ? error.message : String(error)) +
      '；当前身份与凭据未改变。', true);
    if (confirm) confirm.disabled = false;
  } finally {
    legacyResolveBusy = false;
  }
}

function showCredentialInvalidHome(message) {
  identityInvalid = true;
  if (roomListElement) roomListElement.replaceChildren();
  clearListSkeleton();
  setListRetry(false);
  const detail = message ||
    '当前凭据已失效或已被撤销。本机不会自动创建替代身份。';
  setEmptyListMessage(detail + ' 请在另一台已登录设备生成配对码后打开 /pair，或使用明确标注的“旧方式（长期凭据）”入口。');
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
  const legacyButton = document.getElementById('credential-invalid-legacy');
  if (legacyButton) legacyButton.hidden = false;
  const emptyTitle = document.getElementById('empty-title');
  if (emptyTitle) emptyTitle.textContent = '凭据已失效';
  const emptyHint = document.getElementById('empty-hint');
  if (emptyHint) {
    emptyHint.textContent = '本机不会自动创建新身份。请用另一台已登录设备生成配对码，或显式使用旧方式长期凭据。';
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

let syncCatchUpRunning = false;

/**
 * 重连补读：读取服务端游标，只补状态与刷新标记，不重放历史工作。
 *
 * 首次建立本地游标时使用服务端 head_cursor，避免把全部历史事件当成
 * “断线期间的新工作”。事件按 event_id/seq 去重；业务状态仍由工具读取。
 */
async function syncCatchUp() {
  if (syncCatchUpRunning || !identity || !identity.actor_id) return;
  syncCatchUpRunning = true;
  let dirty = false;
  const scopes = ['inbox'];
  if (activeRoomId) scopes.push('room:' + activeRoomId);
  try {
    for (const scope of scopes) {
      let cursor = syncCursorGet(scope);
      if (!cursor) {
        const prime = await callTool('network_sync', { scope: scope, limit: 1 });
        if (prime && prime.head_cursor) syncCursorSet(scope, prime.head_cursor);
        continue;
      }
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const page = await callTool('network_sync', { scope: scope, cursor: cursor, limit: 50 });
        if (page.reset_required) {
          syncCursorClear(scope);
          dirty = true;
          break;
        }
        for (const item of page.items || []) {
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
        if (!page.has_more) break;
      }
    }
    if (dirty) {
      scheduleRoomListRefresh(true);
      if (activeRoomId) {
        invalidateRoomTasks();
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
  const legacyUse = document.getElementById('legacy-token-use');
  const legacyInput = document.getElementById('legacy-token-input');
  const legacyConfirm = document.getElementById('legacy-token-confirm');
  const legacyCancel = document.getElementById('legacy-token-cancel');
  const legacyModal = document.getElementById('legacy-token-modal');
  const legacyButton = document.getElementById('credential-invalid-legacy');
  const pairButton = document.getElementById('credential-invalid-pair');

  if (handoffButton) handoffButton.addEventListener('click', openHandoffDialog);
  if (handoffClose) handoffClose.addEventListener('click', closeHandoffDialog);
  if (pairingCreate) pairingCreate.addEventListener('click', createPairingChallenge);
  if (pairingRefresh) pairingRefresh.addEventListener('click', refreshPairings);
  if (copyButton) {
    copyButton.addEventListener('click', function () {
      if (!pairingCreated || !pairingCreated.pair_url) return;
      pairingCopyText(pairingCreated.pair_url, function () {
        copyButton.textContent = '已复制配对链接';
        pairingSetStatus('配对链接已复制，5 分钟内有效；链接只含一次性挑战，不含 token。', 'success');
        setTimeout(function () { copyButton.textContent = '复制配对链接'; }, 1500);
      }, function (error) {
        copyButton.textContent = '复制配对链接';
        pairingSetStatus('复制失败：' + (error && error.message ? error.message : String(error)) +
          '；请检查剪贴板权限，或手动输入短码。', 'error');
      });
    });
  }
  if (legacyUse && legacyInput) {
    legacyUse.addEventListener('click', function () {
      const token = parseLegacyToken(legacyInput.value);
      if (!token) {
        pairingSetStatus('旧链接或 token 格式不正确；请粘贴完整的 /#t= 链接或 token。', 'error');
        return;
      }
      legacyInput.value = '';
      openLegacyConfirm(token);
    });
  }
  if (legacyConfirm) legacyConfirm.addEventListener('click', confirmLegacySwitch);
  if (legacyCancel) legacyCancel.addEventListener('click', legacyClose);
  if (legacyModal) {
    legacyModal.addEventListener('click', function (event) {
      if (event.target === legacyModal) legacyClose();
    });
  }
  if (legacyButton) {
    legacyButton.addEventListener('click', function () {
      openHandoffDialog();
      const details = document.getElementById('legacy-token-details');
      if (details) details.open = true;
      const input = document.getElementById('legacy-token-input');
      if (input) input.focus();
    });
  }
  if (pairButton) {
    pairButton.addEventListener('click', function () {
      window.location.href = '/pair';
    });
  }
  if (handoffModal) {
    handoffModal.addEventListener('click', function (event) {
      if (event.target === handoffModal) closeHandoffDialog();
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (legacyModal && !legacyModal.hidden) legacyClose();
    else if (handoffModal && !handoffModal.hidden) closeHandoffDialog();
  });
  window.addEventListener('agentnet:device', function () {
    if (handoffModal && !handoffModal.hidden) refreshPairings();
  });
  if (window.__agentNetworkLegacyToken) {
    openLegacyConfirm(window.__agentNetworkLegacyToken);
  }
})();
`;
