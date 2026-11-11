/**
 * 已归档 Agent 状态与侧栏浮层。
 *
 * 归档状态只以 `network_agents_get` 的服务端返回为准，不写 localStorage，
 * 也不做轮询。侧栏默认列表过滤 direct Agent 会话，但归档不改变房间、消息、
 * 凭据或在线状态；`/c/<room_id>` 仍可正常打开。
 *
 * 服务端没有“枚举全部已归档 Agent”的接口，本片段只查询当前会话列表里
 * 已解析出的 direct Agent 对方 actor_id；不额外发明端点。
 */
export const CHAT_ARCHIVE_SCRIPT = `
const ARCHIVE_LOOKUP_TTL_MS = 10000;
const ARCHIVE_POPOVER_MARGIN = 8;

let archivedAgentIds = new Set();
let archivedAgentSummaries = new Map();
let archivedLookupError = '';
let archivedActionError = '';
let archivedLookupKey = '';
let archivedLookupAt = 0;
let archivedLookupLoading = false;
let archivedLookupSeq = 0;
let archivedBusyActor = null;
let archivedOpener = null;
let toastTimer = null;

function archiveErrorText(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * direct Agent 会话的对方已归档时隐藏；群聊与人类会话不受影响。
 *
 * 列表摘要携带 peer_archived，首屏即可隐藏，不必等 direct 详情和
 * network_agents_get 返回；详情补全后以服务端归档集合为准，避免恢复
 * 或他端取消归档后仍被旧摘要挡住。
 */
function isArchivedAgentRoom(entry) {
  if (!entry || entry.kind !== 'direct') return false;
  // 列表摘要先于 direct 详情到达；此时用服务端 peer_archived 直接隐藏。
  if (entry.peer_archived === true) return true;
  return Boolean(
    entry.peer_kind === 'agent' &&
    entry.peer_actor_id &&
    archivedAgentIds.has(entry.peer_actor_id)
  );
}

/** 当前会话列表能确定的 direct Agent actor_id；去重并保持首次出现顺序。 */
function archiveKnownAgentIds() {
  const ids = [];
  const seen = new Set();
  function push(value) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  }
  for (const entry of roomEntries) {
    if (entry.kind === 'direct' && entry.peer_kind === 'agent') push(entry.peer_actor_id);
  }
  for (const summary of peerDetails.values()) {
    if (summary.peer_kind === 'agent') push(summary.peer_actor_id);
  }
  return ids;
}

/** 已归档条目按归档时间倒序；没有时间时按名称排序，避免列表抖动。 */
function archivedAgentItems() {
  const byActor = new Map();
  for (const entry of roomEntries) {
    if (entry.kind !== 'direct' || entry.peer_kind !== 'agent') continue;
    if (!entry.peer_actor_id || !archivedAgentIds.has(entry.peer_actor_id)) continue;
    const summary = archivedAgentSummaries.get(entry.peer_actor_id);
    const item = {
      actor_id: entry.peer_actor_id,
      name: summary && summary.name ? summary.name : entry.name,
      archived_at: summary && summary.archived_at ? Number(summary.archived_at) || 0 : 0
    };
    const existing = byActor.get(item.actor_id);
    if (!existing || !existing.name || existing.name === '单聊') byActor.set(item.actor_id, item);
  }
  return Array.from(byActor.values()).sort(function (left, right) {
    if (right.archived_at !== left.archived_at) return right.archived_at - left.archived_at;
    return left.name.localeCompare(right.name);
  });
}

function archivePopoverNode() {
  return document.getElementById('archive-popover');
}

function archiveTriggerNode() {
  return document.getElementById('archived-agents');
}

function archiveIsOpen() {
  const popover = archivePopoverNode();
  return Boolean(popover && !popover.hidden);
}

/** 浮层锚定在账号区图标上方；空间不足时翻到下方，并始终限制在视口内。 */
function positionArchivePopover() {
  const popover = archivePopoverNode();
  const trigger = archiveTriggerNode();
  if (!popover || !trigger || popover.hidden) return;
  popover.style.left = '0px';
  popover.style.top = '0px';
  const rect = popover.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  let left = anchor.right - rect.width;
  if (left + rect.width + ARCHIVE_POPOVER_MARGIN > viewportWidth) {
    left = viewportWidth - rect.width - ARCHIVE_POPOVER_MARGIN;
  }
  if (left < ARCHIVE_POPOVER_MARGIN) left = ARCHIVE_POPOVER_MARGIN;
  let top = anchor.top - rect.height - ARCHIVE_POPOVER_MARGIN;
  if (top < ARCHIVE_POPOVER_MARGIN) {
    top = anchor.bottom + ARCHIVE_POPOVER_MARGIN;
    if (top + rect.height + ARCHIVE_POPOVER_MARGIN > viewportHeight) {
      top = Math.max(ARCHIVE_POPOVER_MARGIN, viewportHeight - rect.height - ARCHIVE_POPOVER_MARGIN);
    }
  }
  popover.style.left = Math.round(left) + 'px';
  popover.style.top = Math.round(top) + 'px';
}

function archiveItemElement(item) {
  const row = document.createElement('li');
  row.className = 'archive-item';
  row.dataset.actorId = item.actor_id;
  row.append(avatarElement(item.name, 'agent', 'avatar archive-avatar'));
  const name = document.createElement('span');
  name.className = 'archive-name';
  name.textContent = item.name;
  name.title = item.name;
  row.append(name);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'archive-restore';
  button.setAttribute('data-actor-id', item.actor_id);
  button.setAttribute('aria-label', '恢复 ' + item.name);
  button.disabled = archivedBusyActor !== null;
  button.textContent = archivedBusyActor === item.actor_id ? '恢复中…' : '恢复';
  button.addEventListener('click', function () {
    restoreArchivedAgent(item.actor_id).catch(function () {});
  });
  row.append(button);
  return row;
}

function renderArchivePopover() {
  const popover = archivePopoverNode();
  if (!popover || popover.hidden) return;
  const list = document.getElementById('archive-popover-list');
  const empty = document.getElementById('archive-popover-empty');
  const status = document.getElementById('archive-popover-status');
  if (!list || !empty || !status) return;
  const items = archivedAgentItems();
  list.replaceChildren();
  for (const item of items) list.append(archiveItemElement(item));
  let statusText = '';
  if (archivedLookupLoading) {
    statusText = '正在读取已归档 Agent…';
  } else if (archivedActionError) {
    statusText = archivedActionError;
  } else if (archivedLookupError) {
    statusText = '读取已归档 Agents 失败：' + archivedLookupError;
  }
  status.textContent = statusText;
  status.hidden = statusText.length === 0;
  status.classList.toggle(
    'error',
    !archivedLookupLoading && Boolean(archivedActionError || archivedLookupError)
  );
  empty.hidden = !(
    items.length === 0 &&
    !archivedLookupLoading &&
    !archivedLookupError &&
    !archivedActionError
  );
  positionArchivePopover();
}

/**
 * 读取服务端归档状态。
 *
 * force 为 true 时忽略 TTL；侧栏列表加载后只做一次合并读取，打开浮层时
 * 再强制刷新，保证用户看到的是当前服务端状态。失败时保留上次成功结果，
 * 并把错误交给浮层展示；侧栏继续显示会话，避免误隐藏。
 */
async function refreshArchivedAgentState(force) {
  const ids = archiveKnownAgentIds().slice(0, AGENT_LOOKUP_MAX);
  if (ids.length === 0) {
    archivedAgentIds = new Set();
    archivedAgentSummaries = new Map();
    archivedLookupError = '';
    archivedLookupKey = '';
    archivedLookupAt = Date.now();
    archivedLookupLoading = false;
    renderRooms();
    renderArchivePopover();
    return;
  }
  const key = ids.slice().sort().join('|');
  if (
    !force &&
    key === archivedLookupKey &&
    Date.now() - archivedLookupAt < ARCHIVE_LOOKUP_TTL_MS
  ) {
    return;
  }
  const seq = ++archivedLookupSeq;
  archivedLookupLoading = true;
  archivedLookupError = '';
  renderArchivePopover();
  try {
    const result = await callTool('network_agents_get', { actor_ids: ids });
    if (seq !== archivedLookupSeq) return;
    const archived = new Set();
    const summaries = new Map();
    for (const item of (result && result.items) || []) {
      if (!item || typeof item.actor_id !== 'string' || item.archived !== true) continue;
      archived.add(item.actor_id);
      summaries.set(item.actor_id, item);
    }
    archivedAgentIds = archived;
    archivedAgentSummaries = summaries;
    // 详情补全后以归档查询结果修正列表摘要，恢复后不会继续被旧标记隐藏。
    for (const entry of roomEntries) {
      if (entry.kind === 'direct' && entry.peer_kind === 'agent' && entry.peer_actor_id) {
        entry.peer_archived = archived.has(entry.peer_actor_id);
      }
    }
    archivedLookupKey = key;
    archivedLookupAt = Date.now();
    archivedLookupError = '';
  } catch (error) {
    if (seq !== archivedLookupSeq) return;
    archivedLookupError = archiveErrorText(error);
  } finally {
    if (seq === archivedLookupSeq) {
      archivedLookupLoading = false;
      renderRooms();
      renderArchivePopover();
    }
  }
}

/** 归档成功后立即隐藏会话；服务端状态仍是唯一权威。 */
function markAgentArchived(actorId, result) {
  if (!actorId) return;
  let name = 'Agent';
  for (const entry of roomEntries) {
    if (entry.peer_actor_id !== actorId) continue;
    entry.peer_archived = true;
    if (entry.name) {
      name = entry.name;
      break;
    }
  }
  const known = archivedAgentSummaries.get(actorId);
  if (known && known.name) name = known.name;
  archivedAgentIds.add(actorId);
  archivedAgentSummaries.set(actorId, {
    actor_id: actorId,
    kind: 'agent',
    name: name,
    agent_session_id: known ? known.agent_session_id : null,
    share_url: known ? known.share_url : null,
    archived: true,
    archived_at: result && typeof result.archived_at === 'string' ? result.archived_at : null,
    archived_by: result && typeof result.archived_by === 'string' ? result.archived_by : null
  });
  archivedLookupKey = '';
  archivedLookupAt = Date.now();
  archivedLookupError = '';
  archivedActionError = '';
  renderRooms();
  renderArchivePopover();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(function () {
    toast.hidden = true;
    toast.textContent = '';
    toastTimer = null;
  }, 3200);
}

/** 恢复成功后把条目放回侧栏；不重新拉取房间，避免无谓请求与列表闪动。 */
async function restoreArchivedAgent(actorId) {
  if (archivedBusyActor !== null) return;
  const summary = archivedAgentSummaries.get(actorId);
  const fallback = archivedAgentItems().find(function (item) {
    return item.actor_id === actorId;
  });
  const name = summary && summary.name ? summary.name : fallback ? fallback.name : 'Agent';
  archivedBusyActor = actorId;
  archivedActionError = '';
  renderArchivePopover();
  try {
    await callTool('network_agent_unarchive', {
      request_id: requestId('web_agent_unarchive'),
      actor_id: actorId
    });
    archivedLookupSeq += 1;
    archivedLookupLoading = false;
    archivedAgentIds.delete(actorId);
    archivedAgentSummaries.delete(actorId);
    archivedLookupKey = '';
    archivedLookupAt = Date.now();
    for (const entry of roomEntries) {
      if (entry.kind === 'direct' && entry.peer_actor_id === actorId) {
        entry.peer_archived = false;
      }
    }
    archivedActionError = '';
    renderRooms();
    showToast('已恢复「' + name + '」');
  } catch (error) {
    archivedActionError = '恢复失败：' + archiveErrorText(error);
  } finally {
    archivedBusyActor = null;
    renderArchivePopover();
  }
}

async function openArchivePopover() {
  const popover = archivePopoverNode();
  const trigger = archiveTriggerNode();
  if (!popover || !trigger || !popover.hidden) return;
  archivedOpener = document.activeElement;
  archivedActionError = '';
  archivedLookupError = '';
  archivedLookupLoading = true;
  popover.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  renderArchivePopover();
  try {
    await ensureIdentity();
    if (roomsPromise) {
      try {
        await roomsPromise;
      } catch (error) {
        // 列表加载失败时仍允许读取已缓存的 direct 对方；错误由列表自己展示。
      }
    }
    if (!popover.hidden) await refreshArchivedAgentState(true);
  } catch (error) {
    if (!archivedLookupError) archivedLookupError = archiveErrorText(error);
    archivedLookupLoading = false;
  }
  if (popover.hidden) return;
  renderArchivePopover();
  const closeButton = document.getElementById('archive-popover-close');
  if (closeButton) {
    try {
      closeButton.focus({ preventScroll: true });
    } catch (error) {
      closeButton.focus();
    }
  }
}

function closeArchivePopover() {
  const popover = archivePopoverNode();
  const trigger = archiveTriggerNode();
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  archivedLookupSeq += 1;
  archivedLookupLoading = false;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  const opener = archivedOpener;
  archivedOpener = null;
  if (opener && opener.focus && document.contains(opener)) {
    try {
      opener.focus({ preventScroll: true });
    } catch (error) {
      opener.focus();
    }
  } else if (trigger) {
    trigger.focus();
  }
}

const archivedAgentsButton = archiveTriggerNode();
if (archivedAgentsButton) {
  archivedAgentsButton.addEventListener('click', function () {
    if (archiveIsOpen()) closeArchivePopover();
    else openArchivePopover().catch(function () {});
  });
}
const archiveCloseButton = document.getElementById('archive-popover-close');
if (archiveCloseButton) {
  archiveCloseButton.addEventListener('click', closeArchivePopover);
}

document.addEventListener('pointerdown', function (event) {
  if (!archiveIsOpen()) return;
  const popover = archivePopoverNode();
  const trigger = archiveTriggerNode();
  if (popover && event.target instanceof Node && popover.contains(event.target)) return;
  if (trigger && event.target instanceof Node && trigger.contains(event.target)) return;
  closeArchivePopover();
}, true);

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !archiveIsOpen()) return;
  event.preventDefault();
  closeArchivePopover();
});

window.addEventListener('resize', function () {
  if (archiveIsOpen()) positionArchivePopover();
});
`;
