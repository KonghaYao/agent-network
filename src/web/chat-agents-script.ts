/**
 * Agents 管理弹窗与浏览器本地注册表。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此可复用 `identity`、
 * `ensureIdentity`、`callTool`、`requestId`、`avatarElement` 与
 * `legacyCopyText`。本地注册表保存 owner/actor/session/名称/创建时间与该
 * Agent 自己的 MCP URL（含长期 token），供会话右键提示词复用；不保存
 * human token、提示词或 share_url。注册表只在本浏览器，按当前 human 隔离。
 */
export const CHAT_AGENTS_SCRIPT = `
const AGENT_REGISTRY_KEY = 'agent-network-agents-v1';

const agentsButton = document.getElementById('agents');
const agentsModal = document.getElementById('agents-modal');
const agentsCloseButton = document.getElementById('agents-close');
const agentsNewButton = document.getElementById('agents-new');
const agentsToggleButton = document.getElementById('agents-toggle');
const agentsListElement = document.getElementById('agents-list');
const agentsArchivedListElement = document.getElementById('agents-archived-list');
const agentsArchivedSection = document.getElementById('agents-archived-section');
const agentsArchivedCountElement = document.getElementById('agents-archived-count');
const agentsArchivedEmptyElement = document.getElementById('agents-archived-empty');
const agentsEmptyElement = document.getElementById('agents-empty');
const agentsNoteElement = document.getElementById('agents-note');
const agentsErrorElement = document.getElementById('agents-error');

let agentsEntries = [];
let agentsSummaries = new Map();
let agentsMissing = new Set();
let agentsShowArchived = false;
let agentsSeq = 0;
let agentsOpener = null;
let agentsBusyActor = null;

function agentsErrorText(error) {
  return error && error.message ? error.message : String(error);
}

/** 读取本地注册表；坏数据或不可用一律回退为空表，并返回可展示的提示。 */
function agentRegistryRead() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(AGENT_REGISTRY_KEY);
  } catch (error) {
    return { items: [], error: '浏览器无法读取本地 Agent 列表' };
  }
  if (!raw) return { items: [], error: '' };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { items: [], error: '本地 Agent 列表已损坏，已按空列表处理' };
  }
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) {
    return { items: [], error: '本地 Agent 列表版本不兼容，已按空列表处理' };
  }
  const items = [];
  const seen = new Set();
  for (const item of parsed.items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.owner_actor_id !== 'string' || !item.owner_actor_id) continue;
    if (typeof item.actor_id !== 'string' || !item.actor_id) continue;
    if (typeof item.name !== 'string') continue;
    if (typeof item.agent_session_id !== 'string' && item.agent_session_id !== null) continue;
    if (typeof item.created_at !== 'string') continue;
    if (typeof item.mcp_url !== 'string' && typeof item.mcp_url !== 'undefined' &&
        item.mcp_url !== null) continue;
    if (seen.has(item.actor_id)) continue;
    seen.add(item.actor_id);
    items.push({
      owner_actor_id: item.owner_actor_id,
      actor_id: item.actor_id,
      name: item.name,
      agent_session_id: item.agent_session_id,
      created_at: item.created_at,
      mcp_url: typeof item.mcp_url === 'string' ? item.mcp_url : ''
    });
  }
  return { items: items, error: '' };
}

function agentRegistryWrite(items) {
  try {
    window.localStorage.setItem(
      AGENT_REGISTRY_KEY,
      JSON.stringify({ v: 1, items: items.slice(0, AGENT_REGISTRY_MAX) })
    );
    return '';
  } catch (error) {
    return '本地 Agent 列表保存失败（浏览器可能禁用了本地存储）';
  }
}

function agentsSortByCreated(items) {
  return items.slice().sort(function (left, right) {
    const leftAt = Number(left.created_at);
    const rightAt = Number(right.created_at);
    const leftValue = Number.isNaN(leftAt) ? 0 : leftAt;
    const rightValue = Number.isNaN(rightAt) ? 0 : rightAt;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return String(left.actor_id).localeCompare(String(right.actor_id));
  });
}

/** 只返回当前 human actor 创建的条目，避免 /#t= 换身份后串列表。 */
function agentRegistryItems(ownerActorId) {
  const read = agentRegistryRead();
  const items = read.items.filter(function (item) {
    return item.owner_actor_id === ownerActorId;
  });
  return { items: agentsSortByCreated(items).slice(0, AGENT_REGISTRY_MAX), error: read.error };
}

/** 按当前 human 与 Agent actor 查本地条目；不存在或读失败时返回空。 */
function agentRegistryEntry(ownerActorId, actorId) {
  const read = agentRegistryItems(ownerActorId);
  const item = read.items.find(function (entry) {
    return entry.actor_id === actorId;
  });
  return { item: item || null, error: read.error };
}

/** 创建成功后写入；同一 actor_id 去重，超过上限保留最新条目。 */
function agentRegistryAdd(ownerActorId, entry) {
  if (!ownerActorId) return '当前浏览器身份不可用，未能保存本地 Agent 列表';
  const read = agentRegistryRead();
  const items = read.items.filter(function (item) {
    return item.actor_id !== entry.actor_id;
  });
  items.unshift({
    owner_actor_id: ownerActorId,
    actor_id: entry.actor_id,
    name: entry.name,
    agent_session_id: entry.agent_session_id,
    created_at: entry.created_at,
    mcp_url: typeof entry.mcp_url === 'string' ? entry.mcp_url : ''
  });
  return agentRegistryWrite(agentsSortByCreated(items));
}

/** 全局改名成功后同步本地展示名；写入失败只影响下次打开的缓存名称。 */
function agentRegistryRename(actorId, name) {
  const read = agentRegistryRead();
  if (read.error) return;
  let changed = false;
  const items = read.items.map(function (item) {
    if (item.actor_id !== actorId || item.name === name) return item;
    changed = true;
    return {
      owner_actor_id: item.owner_actor_id,
      actor_id: item.actor_id,
      name: name,
      agent_session_id: item.agent_session_id,
      created_at: item.created_at,
      mcp_url: item.mcp_url
    };
  });
  if (changed) agentRegistryWrite(items);
}

/**
 * token 重发成功后更新本地 MCP URL。
 *
 * token 是该 actor 的全局凭据，因此更新所有同 actor 条目；本浏览器从未保存过
 * 该 Agent 时按 fallback 补一条，保证新 token 至少能从右键提示词再次复制。
 */
function agentRegistryReissue(ownerActorId, actorId, mcpUrl, fallback) {
  const read = agentRegistryRead();
  if (read.error) return read.error;
  let changed = false;
  const items = read.items.map(function (item) {
    if (item.actor_id !== actorId || item.mcp_url === mcpUrl) return item;
    changed = true;
    return {
      owner_actor_id: item.owner_actor_id,
      actor_id: item.actor_id,
      name: item.name,
      agent_session_id: item.agent_session_id,
      created_at: item.created_at,
      mcp_url: mcpUrl
    };
  });
  if (!changed) {
    if (!ownerActorId) return '当前浏览器身份不可用，未能保存新 MCP URL';
    items.unshift({
      owner_actor_id: ownerActorId,
      actor_id: actorId,
      name: typeof fallback.name === 'string' ? fallback.name : 'Agent',
      agent_session_id: typeof fallback.agent_session_id === 'string'
        ? fallback.agent_session_id
        : null,
      created_at: typeof fallback.created_at === 'string' ? fallback.created_at : String(Date.now()),
      mcp_url: mcpUrl
    });
  }
  return agentRegistryWrite(agentsSortByCreated(items));
}

function agentsSummaryOf(entry) {
  return agentsSummaries.get(entry.actor_id) || null;
}

function agentsView(entry) {
  const summary = agentsSummaryOf(entry);
  return {
    entry: entry,
    name: summary ? summary.name : entry.name,
    archived: summary ? summary.archived === true : false,
    shareUrl: summary ? summary.share_url : null,
    missing: agentsMissing.has(entry.actor_id)
  };
}

function agentsShortId(actorId) {
  return actorId.length > 14 ? actorId.slice(0, 12) + '…' : actorId;
}

function agentsCreatedLabel(value) {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return '创建于 ' + date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
}

function agentsActionButton(view, action, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('data-action', action);
  const busy = agentsBusyActor === view.entry.actor_id;
  button.disabled = view.missing || (agentsBusyActor !== null && !busy);
  if (busy) {
    button.textContent = '处理中…';
  } else {
    button.textContent = label;
  }
  return button;
}

function agentsItemElement(view, inArchiveGroup) {
  const item = document.createElement('li');
  item.className = 'agents-item';
  item.setAttribute('data-actor-id', view.entry.actor_id);
  item.append(avatarElement(view.name, 'agent', 'avatar agents-avatar'));

  const main = document.createElement('div');
  main.className = 'agents-item-main';
  const top = document.createElement('p');
  top.className = 'agents-item-top';
  const name = document.createElement('span');
  name.className = 'agents-item-name';
  name.textContent = view.name;
  name.title = view.name;
  top.append(name);
  if (inArchiveGroup || view.archived) {
    const archivedBadge = document.createElement('span');
    archivedBadge.className = 'agents-badge';
    archivedBadge.textContent = '已归档';
    top.append(archivedBadge);
  }
  if (view.missing) {
    const missingBadge = document.createElement('span');
    missingBadge.className = 'agents-badge';
    missingBadge.textContent = '不可用';
    top.append(missingBadge);
  }
  main.append(top);

  const session = document.createElement('p');
  session.className = 'agents-item-meta';
  session.textContent = view.entry.agent_session_id || '无 session';
  session.title = view.entry.agent_session_id || '';
  main.append(session);

  const identityLine = document.createElement('p');
  identityLine.className = 'agents-item-meta';
  identityLine.textContent = view.entry.actor_id;
  identityLine.title = view.entry.actor_id;
  main.append(identityLine);

  const created = agentsCreatedLabel(view.entry.created_at);
  if (created) {
    const createdLine = document.createElement('p');
    createdLine.className = 'agents-item-meta';
    createdLine.textContent = created;
    main.append(createdLine);
  }

  if (view.shareUrl) {
    const shareLine = document.createElement('p');
    shareLine.className = 'agents-item-meta agents-item-share';
    shareLine.textContent = view.shareUrl;
    shareLine.title = view.shareUrl;
    main.append(shareLine);
  }
  item.append(main);

  const actions = document.createElement('div');
  actions.className = 'agents-item-actions';
  if (inArchiveGroup || view.archived) {
    actions.append(agentsActionButton(view, 'unarchive', '取消归档'));
  } else {
    actions.append(agentsActionButton(view, 'archive', '归档'));
  }
  const copyButton = agentsActionButton(view, 'copy-share', '复制分享链接');
  if (!view.shareUrl) copyButton.disabled = true;
  actions.append(copyButton);
  item.append(actions);
  return item;
}

function renderAgents() {
  if (!agentsListElement || !agentsArchivedListElement) return;
  const views = agentsEntries.map(agentsView);
  const active = views.filter(function (view) { return !view.archived; });
  const archived = views.filter(function (view) { return view.archived; });

  agentsListElement.replaceChildren();
  for (const view of active) agentsListElement.append(agentsItemElement(view, false));
  agentsArchivedListElement.replaceChildren();
  for (const view of archived) agentsArchivedListElement.append(agentsItemElement(view, true));

  if (agentsArchivedCountElement) agentsArchivedCountElement.textContent = String(archived.length);
  if (agentsArchivedSection) agentsArchivedSection.hidden = !agentsShowArchived;
  if (agentsArchivedEmptyElement) {
    agentsArchivedEmptyElement.hidden = !(agentsShowArchived && archived.length === 0);
  }
  if (agentsToggleButton) {
    agentsToggleButton.textContent = agentsShowArchived
      ? '隐藏已归档 (' + archived.length + ')'
      : '显示已归档 (' + archived.length + ')';
    agentsToggleButton.setAttribute('aria-pressed', agentsShowArchived ? 'true' : 'false');
  }
  if (agentsEmptyElement) {
    if (agentsEntries.length === 0) {
      agentsEmptyElement.hidden = false;
      agentsEmptyElement.textContent = '还没有 Agent。点击“新建 Agent”创建第一个 Agent。';
    } else if (active.length === 0 && !agentsShowArchived) {
      agentsEmptyElement.hidden = false;
      agentsEmptyElement.textContent =
        '没有未归档的 Agent。点击“显示已归档”查看 ' + archived.length + ' 个已归档 Agent。';
    } else {
      agentsEmptyElement.hidden = true;
      agentsEmptyElement.textContent = '';
    }
  }
}

function agentsSetNote(message) {
  if (agentsNoteElement) agentsNoteElement.textContent = message || '';
}

function agentsSetError(message) {
  if (agentsErrorElement) agentsErrorElement.textContent = message || '';
}

/** 用服务端摘要刷新名称、分享链接与归档状态；过期响应按 agentsSeq 丢弃。 */
async function agentsRefresh() {
  if (agentsEntries.length === 0) {
    renderAgents();
    return;
  }
  const seq = ++agentsSeq;
  const actorIds = agentsEntries.slice(0, AGENT_LOOKUP_MAX).map(function (entry) {
    return entry.actor_id;
  });
  agentsSetNote('正在同步…');
  try {
    const result = await callTool('network_agents_get', { actor_ids: actorIds });
    if (seq !== agentsSeq) return;
    const summaries = new Map();
    for (const item of (result && result.items) || []) {
      if (item && typeof item.actor_id === 'string') summaries.set(item.actor_id, item);
    }
    const missing = new Set();
    for (const actorId of (result && result.missing_actor_ids) || []) {
      if (typeof actorId === 'string') missing.add(actorId);
    }
    agentsSummaries = summaries;
    agentsMissing = missing;
    agentsSetNote('');
    agentsSetError('');
  } catch (error) {
    if (seq !== agentsSeq) return;
    agentsSetNote('');
    agentsSetError('同步失败，显示本地记录：' + agentsErrorText(error));
  }
  renderAgents();
}

async function agentsOpen() {
  if (!agentsModal) return;
  const seq = ++agentsSeq;
  agentsOpener = document.activeElement;
  agentsShowArchived = false;
  agentsBusyActor = null;
  agentsSummaries = new Map();
  agentsMissing = new Set();
  agentsEntries = [];
  agentsSetNote('');
  agentsSetError('');
  if (agentsNewButton) agentsNewButton.disabled = false;
  agentsModal.hidden = false;
  if (agentsButton) agentsButton.setAttribute('aria-expanded', 'true');
  renderAgents();
  try {
    const me = await ensureIdentity();
    if (seq !== agentsSeq) return;
    const read = agentRegistryItems(me.actor_id);
    agentsEntries = read.items;
    if (read.error) agentsSetError(read.error);
    renderAgents();
    if (agentsEntries.length > 0) await agentsRefresh();
  } catch (error) {
    if (seq !== agentsSeq) return;
    agentsEntries = [];
    renderAgents();
    agentsSetError('无法初始化浏览器身份：' + agentsErrorText(error));
    if (agentsNewButton) agentsNewButton.disabled = true;
  }
  if (agentsCloseButton && agentsModal && !agentsModal.hidden) agentsCloseButton.focus();
}

function agentsClose() {
  if (!agentsModal || agentsModal.hidden) return;
  agentsSeq += 1;
  agentsModal.hidden = true;
  if (agentsButton) agentsButton.setAttribute('aria-expanded', 'false');
  const opener = agentsOpener;
  agentsOpener = null;
  if (opener && opener.focus) opener.focus();
}

async function agentsCopyShare(view, button) {
  if (!view.shareUrl) {
    agentsSetError('分享链接尚未同步，请稍后重试');
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(view.shareUrl);
      } catch (error) {
        legacyCopyText(view.shareUrl);
      }
    } else {
      legacyCopyText(view.shareUrl);
    }
    agentsSetError('');
    agentsSetNote('已复制「' + view.name + '」的分享链接。');
    if (button) {
      button.textContent = '已复制';
      setTimeout(function () {
        if (button.isConnected) button.textContent = '复制分享链接';
      }, 1500);
    }
  } catch (error) {
    agentsSetError('复制分享链接失败：' + agentsErrorText(error));
  }
}

async function agentsRunAction(action, actorId, button) {
  if (!actorId) return;
  const entry = agentsEntries.find(function (item) { return item.actor_id === actorId; });
  if (!entry) return;
  const view = agentsView(entry);
  if (view.missing) return;
  if (action === 'copy-share') {
    await agentsCopyShare(view, button);
    return;
  }
  if (action !== 'archive' && action !== 'unarchive') return;
  if (agentsBusyActor !== null) return;

  agentsBusyActor = actorId;
  agentsSetNote(action === 'archive' ? '正在归档…' : '正在取消归档…');
  agentsSetError('');
  renderAgents();
  try {
    const result = await callTool(
      action === 'archive' ? 'network_agent_archive' : 'network_agent_unarchive',
      {
        request_id: requestId(action === 'archive' ? 'web_agent_archive' : 'web_agent_unarchive'),
        actor_id: actorId
      }
    );
    // 让仍在途的旧同步响应失效，避免覆盖刚写入的归档状态。
    agentsSeq += 1;
    const current = agentsSummaries.get(actorId) || {
      actor_id: actorId,
      kind: 'agent',
      name: entry.name,
      agent_session_id: entry.agent_session_id,
      share_url: null,
      archived: false,
      archived_at: null,
      archived_by: null
    };
    agentsSummaries.set(actorId, Object.assign({}, current, {
      archived: action === 'archive',
      archived_at: result && typeof result.archived_at === 'string' ? result.archived_at : null,
      archived_by: result && typeof result.archived_by === 'string' ? result.archived_by : null
    }));
    agentsSetNote(
      action === 'archive'
        ? '已归档「' + view.name + '」，点击“显示已归档”查看。'
        : '已取消归档「' + view.name + '」。'
    );
    agentsSetError('');
  } catch (error) {
    agentsSetNote('');
    agentsSetError(
      (action === 'archive' ? '归档失败：' : '取消归档失败：') + agentsErrorText(error)
    );
  } finally {
    agentsBusyActor = null;
    renderAgents();
  }
}

function agentsListClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const button = target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('[data-actor-id]');
  if (!item) return;
  agentsRunAction(button.getAttribute('data-action'), item.getAttribute('data-actor-id'), button)
    .catch(function () {});
}

if (agentsButton) agentsButton.addEventListener('click', function () { agentsOpen().catch(function () {}); });
if (agentsCloseButton) agentsCloseButton.addEventListener('click', agentsClose);
if (agentsToggleButton) {
  agentsToggleButton.addEventListener('click', function () {
    agentsShowArchived = !agentsShowArchived;
    renderAgents();
  });
}
if (agentsNewButton) {
  agentsNewButton.addEventListener('click', function () {
    agentsClose();
    if (typeof newAgentOpen === 'function') newAgentOpen();
  });
}
if (agentsModal) {
  agentsModal.addEventListener('click', function (event) {
    if (event.target === agentsModal) agentsClose();
  });
}
if (agentsListElement) agentsListElement.addEventListener('click', agentsListClick);
if (agentsArchivedListElement) agentsArchivedListElement.addEventListener('click', agentsListClick);
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && agentsModal && !agentsModal.hidden) agentsClose();
});
`;
