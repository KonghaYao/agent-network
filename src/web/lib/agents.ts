import { LIMITS } from '../../contracts/limits';

/**
 * 本浏览器的 Agent 注册表与接入提示词。
 *
 * 新建 Agent 成功后写入 per-actor key（并兼容旧全局 key 的读取），供后续
 * 会话菜单复用；注册表只保存 Agent 自己的 MCP URL，不保存 human token。
 */

const LEGACY_KEY = 'agent-network-agents-v1';
const PER_ACTOR_PREFIX = 'agent-network-agents-v1:';

export interface LocalAgentEntry {
  owner_actor_id: string;
  actor_id: string;
  name: string;
  agent_session_id: string | null;
  created_at: string;
  mcp_url: string;
}

interface RegistryFile {
  v: 1;
  items: LocalAgentEntry[];
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null, ownerActorId: string): LocalAgentEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const file = parsed as Partial<RegistryFile>;
  if (file.v !== 1 || !Array.isArray(file.items)) return [];
  const items: LocalAgentEntry[] = [];
  const seen = new Set<string>();
  for (const entry of file.items) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<LocalAgentEntry>;
    if (item.owner_actor_id !== ownerActorId) continue;
    if (typeof item.actor_id !== 'string' || !item.actor_id) continue;
    if (typeof item.name !== 'string') continue;
    if (typeof item.agent_session_id !== 'string' && item.agent_session_id !== null) continue;
    if (typeof item.created_at !== 'string') continue;
    if (typeof item.mcp_url !== 'string') continue;
    if (seen.has(item.actor_id)) continue;
    seen.add(item.actor_id);
    items.push({
      owner_actor_id: ownerActorId,
      actor_id: item.actor_id,
      name: item.name,
      agent_session_id: item.agent_session_id,
      created_at: item.created_at,
      mcp_url: item.mcp_url,
    });
  }
  return items;
}

export function listLocalAgents(ownerActorId: string | null): LocalAgentEntry[] {
  if (!ownerActorId) return [];
  const merged = [
    ...parse(readRaw(`${PER_ACTOR_PREFIX}${ownerActorId}`), ownerActorId),
    ...parse(readRaw(LEGACY_KEY), ownerActorId),
  ];
  const seen = new Set<string>();
  const items = merged.filter((item) => {
    if (seen.has(item.actor_id)) return false;
    seen.add(item.actor_id);
    return true;
  });
  return items
    .sort((left, right) => Number(right.created_at) - Number(left.created_at))
    .slice(0, LIMITS.webAgentRegistryMax);
}

/** 写入失败只影响后续提示词复用，不影响已创建的 Agent。 */
export function addLocalAgent(ownerActorId: string | null, entry: LocalAgentEntry): string {
  if (!ownerActorId) return '当前浏览器身份不可用，未能保存本地 Agent 列表';
  const items = listLocalAgents(ownerActorId).filter(
    (item) => item.actor_id !== entry.actor_id,
  );
  items.unshift(entry);
  try {
    localStorage.setItem(
      `${PER_ACTOR_PREFIX}${ownerActorId}`,
      JSON.stringify({ v: 1, items: items.slice(0, LIMITS.webAgentRegistryMax) }),
    );
    return '';
  } catch {
    return '本地 Agent 列表保存失败（浏览器可能禁用了本地存储）';
  }
}

/** 与 legacy 新建 Agent 弹窗相同的 CLI 提示词。 */
export function agentConnectPrompt(token: string, actorId: string): string {
  const serverUrl = location.origin;
  const cliUrl = `${serverUrl}/skills/agentnet.js`;
  return [
    '你是 WeBots Agent。1. 下载 CLI：' + cliUrl,
    '2. 读用法：bun agentnet.js --help',
    '3. 按宿主接入：bun agentnet.js skills --harness <claude|codex|peri|dsh|other>',
    'DSH 直接启动 monitor；run/start 会自动检测 DSH 版本和插件，缺失时添加自带插件，无需额外安装命令。首次自动添加后按输出重启 profile。',
    '4. 连接信息：AGENTNET_URL="' + serverUrl + '" AGENTNET_TOKEN="' + token +
      '" actor_id="' + actorId + '"',
    '5. 登录后立即启动监听：bun agentnet.js monitor --harness <claude|codex|peri|dsh|other>；凭据只给目标 Agent，勿发群、日志或截图。处理投递时用 delivery 里的 room_id；主动发消息再加 --room。',
  ].join('\n');
}
