import { LIMITS } from '../contracts/limits';

/**
 * 浏览器发送意图（outbox）：持久保存 client_message_id/request_id 与状态。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域。意图按 actor 隔离存放在
 * localStorage，只保存重试所需的正文、目标与对账定位信息，不保存 token。
 * 状态机：sending → committed（服务端已提交，等待时间线出现）或
 * failed（retryable 表示可安全重试）。重试前必须先对账，因此即使响应
 * 丢失也不会生成第二条消息。
 */
export const CHAT_OUTBOX_SCRIPT = `
const OUTBOX_PREFIX = 'agent-network-outbox:v1:';
const OUTBOX_MAX = ${LIMITS.webOutboxMax};
const OUTBOX_TTL_MS = ${LIMITS.webOutboxTtlMs};
const OUTBOX_COMMITTED_MS = ${LIMITS.webOutboxCommittedMs};
const OUTBOX_STATUS_BATCH = ${LIMITS.messageSendStatusMax};
// 与服务端 errors.ts 的 RETRYABLE 保持一致；无 code 的传输/超时错误也可重试。
const OUTBOX_RETRYABLE_CODES = ['RATE_LIMITED', 'CONFLICT', 'DRIVE_UNAVAILABLE'];
const OUTBOX_MAX_ROWS = 6;
const outboxInFlight = new Set();
let outboxReconcilePromise = null;
let outboxReconcileTimer = null;

/** 无身份时返回 null：发送与渲染都只在身份就绪后进行。 */
function outboxKey() {
  if (!identity || !identity.actor_id) return null;
  return OUTBOX_PREFIX + identity.actor_id;
}

function outboxRead() {
  const key = outboxKey();
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function outboxWrite(items) {
  const key = outboxKey();
  if (!key) return;
  try {
    if (items.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(items));
  } catch (error) {
    // localStorage 不可用时只影响跨刷新恢复，不阻塞当前发送。
  }
}

function outboxValid(item) {
  return Boolean(item) &&
    typeof item.client_message_id === 'string' &&
    typeof item.request_id === 'string' &&
    typeof item.room_id === 'string' &&
    typeof item.body === 'string' &&
    Array.isArray(item.invoke) &&
    (item.mentions === undefined || Array.isArray(item.mentions));
}

/** 读取时按 TTL、已提交保留窗口和总量上限收敛，避免本地无限增长。 */
function outboxItems() {
  const now = Date.now();
  const items = outboxRead().filter(function (item) {
    if (!outboxValid(item)) return false;
    if (item.status === 'committed') {
      return now - Number(item.committed_at || item.updated_at || 0) <= OUTBOX_COMMITTED_MS;
    }
    return now - Number(item.updated_at || item.created_at || 0) <= OUTBOX_TTL_MS;
  });
  items.sort(function (a, b) {
    return Number(a.created_at || 0) - Number(b.created_at || 0);
  });
  return items.length > OUTBOX_MAX ? items.slice(items.length - OUTBOX_MAX) : items;
}

function outboxGet(clientMessageId) {
  const items = outboxItems();
  for (const item of items) {
    if (item.client_message_id === clientMessageId) return item;
  }
  return null;
}

function outboxUpdate(clientMessageId, patch) {
  const items = outboxItems();
  let updated = null;
  const next = items.map(function (item) {
    if (item.client_message_id !== clientMessageId) return item;
    updated = Object.assign({}, item, patch, { updated_at: Date.now() });
    return updated;
  });
  if (updated) outboxWrite(next);
  return updated;
}

function outboxRemove(clientMessageId) {
  const items = outboxItems();
  outboxWrite(items.filter(function (item) {
    return item.client_message_id !== clientMessageId;
  }));
}

function outboxInvokeKey(invoke, mentions, invokeExplicit) {
  return (invokeExplicit ? 'explicit:' : 'omit:') +
    (invoke || []).slice().sort().join(',') + '|' +
    (mentions || []).slice().sort().join(',');
}

/** 只有同房间、同正文、同目标且可重试的失败意图才允许复用原 ID。 */
function outboxFindReusable(roomId, body, invoke, mentions, invokeExplicit) {
  const items = outboxItems();
  const key = outboxInvokeKey(invoke, mentions, invokeExplicit);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.room_id !== roomId || item.status !== 'failed' || !item.retryable) continue;
    if (item.body !== body) continue;
    const itemExplicit = item.invoke_explicit === true || item.invoke.length > 0;
    if (outboxInvokeKey(item.invoke, item.mentions || [], itemExplicit) !== key) continue;
    return item;
  }
  return null;
}

function outboxCreate(roomId, body, invoke, mentions, invokeExplicit) {
  const at = Date.now();
  const item = {
    client_message_id: crypto.randomUUID(),
    request_id: requestId('web_msg'),
    room_id: roomId,
    body: body,
    invoke: invoke.slice(),
    mentions: mentions.slice(),
    invoke_explicit: Boolean(invokeExplicit),
    status: 'sending',
    retryable: false,
    error: '',
    attempt: 1,
    created_at: at,
    updated_at: at
  };
  const items = outboxItems();
  items.push(item);
  outboxWrite(items);
  return item;
}

function outboxIsRetryable(error) {
  if (!error || !error.code) return true;
  return OUTBOX_RETRYABLE_CODES.indexOf(error.code) >= 0;
}

function outboxByteLength(text) {
  return new TextEncoder().encode(text).length;
}

function outboxPreview(body) {
  const text = String(body || '').replace(/\\s+/g, ' ').trim();
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

function outboxMarkCommitted(clientMessageId, result) {
  const message = (result && result.message) || {};
  return outboxUpdate(clientMessageId, {
    status: 'committed',
    retryable: false,
    error: '',
    message_id: message.message_id || null,
    delivery_ids: Array.isArray(result && result.delivery_ids) ? result.delivery_ids.slice() : [],
    created_seq: message.created_seq == null ? null : String(message.created_seq),
    committed_at: Date.now()
  });
}

function outboxMarkFailed(clientMessageId, error, retryable) {
  const message = error && error.message ? error.message : '发送失败';
  return outboxUpdate(clientMessageId, {
    status: 'failed',
    retryable: Boolean(retryable),
    error: message
  });
}

/**
 * 对账本地意图：已提交 → committed；未提交的 sending（进程已无在途请求）
 * → 可重试失败。绝不根据“没收到响应”直接重发。
 */
function outboxApplyFound(intent, status) {
  if (status.room_id !== intent.room_id) {
    return outboxUpdate(intent.client_message_id, {
      status: 'failed',
      retryable: false,
      error: 'client_message_id 已用于其他房间',
      message_id: status.message_id || null
    });
  }
  if (Number(status.body_bytes) !== outboxByteLength(intent.body)) {
    return outboxUpdate(intent.client_message_id, {
      status: 'failed',
      retryable: false,
      error: 'client_message_id 已用于不同正文',
      message_id: status.message_id || null
    });
  }
  return outboxUpdate(intent.client_message_id, {
    status: 'committed',
    retryable: false,
    error: '',
    message_id: status.message_id || null,
    delivery_ids: Array.isArray(status.delivery_ids) ? status.delivery_ids.slice() : [],
    created_seq: status.created_seq == null ? null : String(status.created_seq),
    committed_at: Date.now()
  });
}

/** 单次最多 20 个 client_message_id；返回 { ok, items }，失败时不改本地状态。 */
async function outboxSendStatus(ids) {
  if (!identity || ids.length === 0) return { ok: true, items: [] };
  const items = [];
  for (let index = 0; index < ids.length; index += OUTBOX_STATUS_BATCH) {
    const batch = ids.slice(index, index + OUTBOX_STATUS_BATCH);
    try {
      const page = await callTool('network_message_send_status', {
        client_message_ids: batch
      });
      for (const item of (page && page.items) || []) items.push(item);
    } catch (error) {
      return { ok: false, items: items };
    }
  }
  return { ok: true, items: items };
}

/**
 * 对账并收敛本地状态。targetIds 为空时处理全部非 committed 意图。
 * 返回值只用于判断是否需要补拉，不向调用方暴露正文。
 */
async function outboxReconcile(targetIds) {
  if (!identity) return { committed: false, ok: false };
  const wanted = targetIds ? new Set(targetIds) : null;
  const pending = outboxItems().filter(function (item) {
    if (item.status === 'committed') return false;
    if (outboxInFlight.has(item.client_message_id)) return false;
    return !wanted || wanted.has(item.client_message_id);
  });
  if (pending.length === 0) return { committed: false, ok: true };
  const response = await outboxSendStatus(pending.map(function (item) {
    return item.client_message_id;
  }));
  if (!response.ok) return { committed: false, ok: false };
  const byId = new Map();
  for (const status of response.items) {
    if (status && status.found) byId.set(status.client_message_id, status);
  }
  let committed = false;
  for (const intent of pending) {
    const status = byId.get(intent.client_message_id);
    if (status) {
      const updated = outboxApplyFound(intent, status);
      if (updated && updated.status === 'committed') committed = true;
      continue;
    }
    if (intent.status === 'sending') {
      outboxUpdate(intent.client_message_id, {
        status: 'failed',
        retryable: true,
        error: '发送状态未确认，可重试'
      });
    }
  }
  return { committed: committed, ok: true };
}

/** 单飞对账：页面加载、重连、online 与重试共用，避免并发重复请求。 */
function outboxScheduleReconcile(delay) {
  if (!identity) return Promise.resolve({ committed: false, ok: false });
  if (outboxReconcilePromise) return outboxReconcilePromise;
  outboxReconcilePromise = new Promise(function (resolve) {
    outboxReconcileTimer = setTimeout(function () {
      outboxReconcileTimer = null;
      outboxReconcile().then(function (result) {
        outboxRefreshRows();
        if (result.committed && activeRoomId) {
          refresh(false).catch(function () {});
        }
        resolve(result);
      }).catch(function () {
        resolve({ committed: false, ok: false });
      });
    }, Number(delay) || 0);
  }).finally(function () {
    outboxReconcileTimer = null;
    outboxReconcilePromise = null;
  });
  return outboxReconcilePromise;
}

function outboxRowFor(item) {
  const line = document.createElement('li');
  line.className = 'msg-system msg-outbox';
  line.dataset.clientMessageId = item.client_message_id;
  const label = document.createElement('span');
  let state = '发送中';
  if (item.status === 'committed') state = '已提交，正在同步';
  else if (item.status === 'failed') state = item.retryable ? '发送失败，可重试' : '发送失败';
  label.textContent = state + ' · ' + outboxPreview(item.body);
  if (item.status === 'failed' && item.error) label.title = item.error;
  line.append(label);
  if (item.status === 'failed' && item.retryable) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'outbox-retry';
    retry.textContent = '重试';
    retry.addEventListener('click', function () {
      outboxRetry(item.client_message_id);
    });
    line.append(retry);
  }
  if (item.status === 'failed') {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'outbox-dismiss';
    dismiss.textContent = '移除';
    dismiss.addEventListener('click', function () {
      outboxRemove(item.client_message_id);
      outboxRefreshRows();
    });
    line.append(dismiss);
  }
  return line;
}

/** 状态行只展示当前房间的本地意图，不进入时间线排序或未读。 */
function outboxAppendRows(container, roomId) {
  if (!container || !roomId || !identity) return;
  const items = outboxItems().filter(function (item) {
    return item.room_id === roomId;
  });
  const visible = items.slice(Math.max(0, items.length - OUTBOX_MAX_ROWS));
  for (const item of visible) container.append(outboxRowFor(item));
}

function outboxRefreshRows() {
  if (!messagesElement || !activeRoomId) return;
  const rows = messagesElement.querySelectorAll('.msg-outbox');
  for (const row of rows) row.remove();
  outboxAppendRows(messagesElement, activeRoomId);
  ensureMessagesEnd();
  scrollController.noteContentChanged();
}

/** 服务端消息已出现在时间线后清掉本地意图；以 message_id 为唯一依据。 */
function outboxPruneAgainstTimeline(items) {
  if (!identity || !Array.isArray(items)) return;
  const visible = new Set();
  for (const item of items) {
    if (item && item.message_id) visible.add(item.message_id);
  }
  if (visible.size === 0) return;
  const current = outboxItems();
  const kept = current.filter(function (intent) {
    return !(intent.message_id && visible.has(intent.message_id));
  });
  if (kept.length !== current.length) outboxWrite(kept);
}

function outboxComposerMatches(intent) {
  if (!bodyInput || !isActiveRoom(intent.room_id, roomEpoch)) return false;
  const text = bodyInput.value.trim();
  if (!text) return false;
  return composerOutgoingBody(intent.room_id, text) === intent.body;
}

/** 发送成功后的收尾：只有当前房间且输入框仍是该意图内容时才清草稿。 */
function outboxFinishCommitted(intent, options) {
  const settings = options || {};
  const matches = outboxComposerMatches(intent);
  if (settings.fromRetry) {
    if (!matches) return;
  } else {
    // 选择器和本次实际发送的附件已被这条消息消费；即使用户在响应返回前
    // 已经改写了输入，也不能让旧选择影响下一条消息。
    mentionSelections.delete(intent.room_id);
    if (settings.sentFileKeys) clearComposerFiles(intent.room_id, settings.sentFileKeys);
    // 当前房间仍显示该意图时才清空输入；响应迟到或用户已改写时保留新内容。
    if (isActiveRoom(intent.room_id, roomEpoch) && !matches) return;
  }
  drafts.delete(intent.room_id);
  draftClear(intent.room_id);
  mentionSelections.delete(intent.room_id);
  if (settings.sentFileKeys) clearComposerFiles(intent.room_id, settings.sentFileKeys);
  if (!isActiveRoom(intent.room_id, settings.epoch)) return;
  bodyInput.value = '';
  hideMentionPicker();
  resizeComposer();
}

/**
 * 提交一个持久意图。响应丢失时先对账；对账确认已提交则按成功收尾，
 * 确认未提交才标记可重试失败，不生成第二条消息。
 */
async function outboxSubmit(intent, options) {
  const settings = options || {};
  const epoch = Number(settings.epoch) || roomEpoch;
  outboxInFlight.add(intent.client_message_id);
  stickyStatus = '';
  outboxUpdate(intent.client_message_id, {
    status: 'sending',
    retryable: false,
    error: '',
    attempt: (Number(intent.attempt) || 1) + (settings.fromRetry ? 1 : 0)
  });
  outboxRefreshRows();
  const args = {
    request_id: intent.request_id,
    client_message_id: intent.client_message_id,
    room_id: intent.room_id,
    body: intent.body
  };
  // 旧本地意图没有 invoke_explicit：有目标时按显式发送，空列表保持省略。
  const explicitInvoke = intent.invoke_explicit === true || intent.invoke.length > 0;
  if (explicitInvoke) args.invoke = intent.invoke;
  if (Array.isArray(intent.mentions) && intent.mentions.length > 0) {
    args.mentions = intent.mentions;
  }
  let failure = null;
  try {
    const result = await callTool('network_message_send', args);
    outboxMarkCommitted(intent.client_message_id, result);
    if (settings.invokeTargets > 0) {
      const deliveryIds = Array.isArray(result.delivery_ids) ? result.delivery_ids : [];
      if (deliveryIds.length !== settings.invokeTargets) {
        stickyStatus =
          '消息已发送，但 Agent 投递未建立（' + deliveryIds.length + '/' +
          settings.invokeTargets + '），请检查房间成员后重试。';
      }
    }
  } catch (error) {
    const response = await outboxSendStatus([intent.client_message_id]);
    const status = response.ok
      ? (response.items || []).find(function (item) {
          return item.client_message_id === intent.client_message_id && item.found;
        })
      : undefined;
    if (status) {
      const updated = outboxApplyFound(intent, status);
      if (updated && updated.status === 'committed') {
        stickyStatus = '';
      } else {
        failure = new Error((updated && updated.error) || '发送失败');
      }
    } else if (!response.ok) {
      // 无法对账时必须保留可重试入口；重试会再次先对账。
      outboxMarkFailed(intent.client_message_id, error, true);
      failure = error;
    } else {
      outboxMarkFailed(intent.client_message_id, error, outboxIsRetryable(error));
      failure = error;
    }
  } finally {
    outboxInFlight.delete(intent.client_message_id);
  }
  outboxRefreshRows();
  if (!failure) {
    outboxFinishCommitted(intent, settings);
    if (!isActiveRoom(intent.room_id, epoch)) return;
    await refresh(true);
    if (!isActiveRoom(intent.room_id, epoch)) return;
    statusElement.textContent = stickyStatus;
    return;
  }
  if (!isActiveRoom(intent.room_id, epoch)) return;
  scrollController.clearPinNextApply();
  stickyStatus = '发送失败：' + (failure.message || '请求失败');
  statusElement.textContent = stickyStatus;
}

/** 从状态行重试：先对账，确认未提交后才复用原 request_id/client_message_id。 */
async function outboxRetry(clientMessageId) {
  const intent = outboxGet(clientMessageId);
  if (!intent || intent.status !== 'failed' || !intent.retryable) return;
  if (outboxInFlight.has(clientMessageId)) return;
  if (!isActiveRoom(intent.room_id, roomEpoch)) return;
  outboxInFlight.add(clientMessageId);
  outboxUpdate(clientMessageId, { status: 'sending', error: '' });
  outboxRefreshRows();
  let response;
  try {
    response = await outboxSendStatus([clientMessageId]);
  } finally {
    outboxInFlight.delete(clientMessageId);
  }
  const status = response.ok
    ? (response.items || []).find(function (item) {
        return item.client_message_id === clientMessageId && item.found;
      })
    : undefined;
  if (status) {
    outboxApplyFound(intent, status);
    outboxRefreshRows();
    refresh(false).catch(function () {});
    return;
  }
  if (!response.ok) {
    outboxUpdate(clientMessageId, { status: 'failed', error: '暂时无法对账，请稍后重试' });
    outboxRefreshRows();
    statusElement.textContent = '暂时无法对账，请稍后重试';
    return;
  }
  stickyStatus = '';
  statusElement.textContent = '';
  scrollController.pinNextApply();
  const fresh = outboxGet(clientMessageId);
  if (!fresh) return;
  await outboxSubmit(fresh, {
    epoch: roomEpoch,
    sentFileKeys: [],
    fromRetry: true,
    invokeTargets: fresh.invoke.length
  });
}

/** 复用失败意图重发前先对账；返回 send / committed / conflict / unknown。 */
async function outboxCheckBeforeResend(intent) {
  const response = await outboxSendStatus([intent.client_message_id]);
  if (!response.ok) return 'unknown';
  const status = (response.items || []).find(function (item) {
    return item.client_message_id === intent.client_message_id && item.found;
  });
  if (!status) return 'send';
  const updated = outboxApplyFound(intent, status);
  return updated && updated.status === 'committed' ? 'committed' : 'conflict';
}

window.addEventListener('online', function () {
  outboxScheduleReconcile(0);
});
`;
