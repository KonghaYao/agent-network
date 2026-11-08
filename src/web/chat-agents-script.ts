/**
 * 浏览器本地 Agent 注册表。
 *
 * 侧栏不提供 Agents 管理弹窗或归档界面；注册表仍由“新建 Agent”写入，
 * 并供 direct Agent 会话右键提示词、token 重发与已归档浮层复用。
 * 归档状态不写入注册表，始终以服务端工具返回为准。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此可直接使用
 * `AGENT_REGISTRY_MAX`。本地注册表保存 owner/actor/session/名称/创建时间与
 * 该 Agent 自己的 MCP URL（含长期 token）；不保存 human token、提示词或
 * share_url。注册表只在本浏览器，按当前 human 隔离。
 *
 * 群聊选择器直接合并本机注册表与 `network_agents_managed_list`，不再用
 * `network_contact_request` 建立好友关系；Agent 能否直接入群由服务端判定。
 */
export const CHAT_AGENTS_SCRIPT = `
const AGENT_REGISTRY_LEGACY_KEY = 'agent-network-agents-v1';

function agentRegistryKey(ownerActorId) {
  return AGENT_REGISTRY_PER_ACTOR_PREFIX + ownerActorId;
}

/** 读取当前身份的本地注册表；旧全局 key 只作为一次性兼容回退。 */
function agentRegistryRead(ownerActorId) {
  if (!ownerActorId) return { items: [], error: '当前浏览器身份不可用' };
  let raw = null;
  try {
    raw = window.localStorage.getItem(agentRegistryKey(ownerActorId));
    if (!raw) raw = window.localStorage.getItem(AGENT_REGISTRY_LEGACY_KEY);
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
    if (item.owner_actor_id !== ownerActorId) continue;
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

function agentRegistryWrite(ownerActorId, items) {
  if (!ownerActorId) return '当前浏览器身份不可用，未能保存本地 Agent 列表';
  try {
    window.localStorage.setItem(
      agentRegistryKey(ownerActorId),
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

/** 只返回当前 human actor 创建的条目，避免换身份后串列表。 */
function agentRegistryItems(ownerActorId) {
  const read = agentRegistryRead(ownerActorId);
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
  const read = agentRegistryRead(ownerActorId);
  const items = read.items.filter(function (item) {
    return item.owner_actor_id === ownerActorId && item.actor_id !== entry.actor_id;
  });
  items.unshift({
    owner_actor_id: ownerActorId,
    actor_id: entry.actor_id,
    name: entry.name,
    agent_session_id: entry.agent_session_id,
    created_at: entry.created_at,
    mcp_url: typeof entry.mcp_url === 'string' ? entry.mcp_url : ''
  });
  return agentRegistryWrite(ownerActorId, agentsSortByCreated(items));
}

/** 全局改名成功后同步本地展示名；写入失败只影响后续提示词中的名称。 */
function agentRegistryRename(actorId, name) {
  const ownerActorId = identity && identity.actor_id ? identity.actor_id : null;
  if (!ownerActorId) return;
  const read = agentRegistryRead(ownerActorId);
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
  if (changed) agentRegistryWrite(ownerActorId, items);
}

/**
 * token 重发成功后更新本地 MCP URL。
 *
 * token 是该 actor 的全局凭据，因此更新所有同 actor 条目；本浏览器从未保存过
 * 该 Agent 时按 fallback 补一条，保证新 token 至少能从右键提示词再次复制。
 */
function agentRegistryReissue(ownerActorId, actorId, mcpUrl, fallback) {
  if (!ownerActorId) return '当前浏览器身份不可用，未能保存新 MCP URL';
  const read = agentRegistryRead(ownerActorId);
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
  return agentRegistryWrite(ownerActorId, agentsSortByCreated(items));
}

/**
 * 群成员候选额外来源：本机 Agents 注册表与当前 human 可管理的 Agent。
 *
 * Agent 入群由服务端按“好友 / 自有管理者 / unclaimed”判定，网页不再调用
 * network_contact_request 伪造好友关系，也不显示好友申请等待提示。
 * 本机注册表覆盖历史 unclaimed Agent；managed list 覆盖其他浏览器创建的
 * 自有 Agent。两者都按 actor_id 去重。
 */
async function loadManagedPickerAgents() {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const args = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const result = await callTool('network_agents_managed_list', args);
    for (const item of result.items || []) {
      if (!item || typeof item.actor_id !== 'string') continue;
      items.push({
        actor_id: item.actor_id,
        kind: 'agent',
        name: typeof item.name === 'string' ? item.name : item.actor_id,
        agent_session_id: typeof item.agent_session_id === 'string' ? item.agent_session_id : null
      });
    }
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return items;
}

async function mergeAgentPickerContacts(ownerActorId, contacts) {
  const merged = (contacts || []).slice();
  const seen = new Set();
  for (const contact of merged) {
    if (contact && typeof contact.actor_id === 'string') seen.add(contact.actor_id);
  }
  function addAgent(item) {
    if (!item || typeof item.actor_id !== 'string' || !item.actor_id) return;
    if (item.actor_id === ownerActorId || seen.has(item.actor_id)) return;
    seen.add(item.actor_id);
    merged.push({
      actor_id: item.actor_id,
      kind: 'agent',
      name: typeof item.name === 'string' && item.name ? item.name : item.actor_id,
      agent_session_id: typeof item.agent_session_id === 'string'
        ? item.agent_session_id
        : null,
      relation: 'local',
      created_at: String(Date.now())
    });
  }
  for (const item of agentRegistryItems(ownerActorId).items) addAgent(item);
  let managed = [];
  try {
    managed = await loadManagedPickerAgents();
  } catch (error) {
    // managed list 失败不阻塞已加载的好友与本机 Agent；服务端仍会复核资格。
    managed = [];
  }
  for (const item of managed) addAgent(item);
  return { contacts: merged };
}
`;
