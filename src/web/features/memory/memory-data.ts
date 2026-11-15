import { callTool, type McpError } from '../../lib/mcp-client';

/** 只读工具的最小前端契约；字段与服务端白名单一致，不引入 bank/space。 */
export type MemoryFactType = 'world' | 'experience' | 'observation';
export type MemoryAvailabilityReason =
  | 'ok'
  | 'no_space'
  | 'bank_missing'
  | 'panel_disabled'
  | 'backend_not_configured'
  | 'backend_unsupported';

export interface MemoryActor {
  name: string;
  archived: boolean;
  disabled: boolean;
}

export interface MemoryStats {
  total_nodes: number;
  total_links: number;
  total_documents: number;
  by_fact_type: Record<MemoryFactType, number>;
  links_by_type: Record<string, number>;
  pending_operations: number;
  failed_operations: number;
  last_write_at: string | null;
  last_consolidated_at: string | null;
}

export interface MemoryOverviewResult {
  available: boolean;
  reason: MemoryAvailabilityReason;
  actor: MemoryActor;
  fetched_at: number;
  stats: MemoryStats | null;
}

export interface MemoryItem {
  id: string;
  text: string;
  fact_type: MemoryFactType | null;
  state: 'valid' | 'invalidated';
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string[];
  proof_count: number;
  tags: string[];
}

export interface MemorySource {
  id: string;
  text: string;
  type: MemoryFactType | null;
  mentioned_at: string | null;
}

export interface MemoryDetail extends MemoryItem {
  context: string | null;
  source_memories: MemorySource[];
  history_count: number;
  text_truncated: boolean;
}

export interface MemoryListResult {
  available: boolean;
  reason: MemoryAvailabilityReason;
  actor: MemoryActor;
  fetched_at: number;
  items: MemoryItem[];
  total: number | null;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  truncated: boolean;
}

export interface MemoryGetResult {
  available: boolean;
  reason: MemoryAvailabilityReason;
  actor: MemoryActor;
  fetched_at: number;
  memory: MemoryDetail | null;
}

export interface MemoryListQuery {
  q?: string;
  type?: MemoryFactType;
  time_field?: 'created_at' | 'mentioned_at' | 'occurred_start' | 'occurred_end';
  start_date?: string;
  end_date?: string;
  limit: number;
  offset: number;
}

export interface MemoryGraphNode {
  id: string;
  label: string;
  text?: string;
  fact_type?: MemoryFactType;
  date?: string | null;
  entities?: string[];
  mention_count?: number;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  entity?: string | null;
}

export interface MemoryGraphResult {
  available: boolean;
  reason: MemoryAvailabilityReason;
  actor: MemoryActor;
  fetched_at: number;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  total_units: number | null;
  total_edges: number;
  raw_node_count: number;
  raw_edge_count: number;
  limit: number;
  truncated: boolean;
}

export interface MemoryGraphQuery {
  type?: MemoryFactType;
  limit: number;
}

export interface MemoryEntityItem {
  id: string;
  name: string;
  mention_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface MemoryEntityDetail extends MemoryEntityItem {
  observations: { id: string; text: string; proof_count: number }[];
  memories: {
    id: string;
    text_preview: string;
    fact_type: MemoryFactType | null;
    mentioned_at: string | null;
  }[];
}

export interface MemoryEntityGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  total_entities: number | null;
  total_edges: number;
  raw_node_count: number;
  raw_edge_count: number;
  limit: number;
  truncated: boolean;
}

export interface MemoryEntitiesResult {
  available: boolean;
  reason: MemoryAvailabilityReason;
  actor: MemoryActor;
  fetched_at: number;
  view: 'list' | 'graph' | 'detail';
  items: MemoryEntityItem[];
  total: number | null;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  entity: MemoryEntityDetail | null;
  graph: MemoryEntityGraph | null;
  truncated: boolean;
  partial: boolean;
}

export interface MemoryEntitiesQuery {
  view: 'list' | 'graph' | 'detail';
  entity_id?: string;
  limit?: number;
  offset?: number;
}

export type MemoryFailureKind =
  | 'forbidden'
  | 'panel-disabled'
  | 'no-space'
  | 'empty'
  | 'unavailable'
  | 'error';

export interface MemoryFailure {
  kind: MemoryFailureKind;
  message: string;
}

export const FACT_TYPE_LABEL: Record<MemoryFactType, string> = {
  world: '世界',
  experience: '经历',
  observation: '观察',
};

const AVAILABILITY_TEXT: Record<MemoryAvailabilityReason, string> = {
  ok: '',
  no_space: '这个 Agent 还没有启用记忆空间。',
  bank_missing: '还没有形成可查看的记忆。Agent 完成对话后，记忆会在后台提炼。',
  panel_disabled: '当前部署未开启 Agent 记忆面板。',
  backend_not_configured: '当前部署未连接记忆后端，记忆面板暂不可用。',
  backend_unsupported: '当前记忆后端不支持这个只读视图。',
};

export function availabilityText(reason: MemoryAvailabilityReason): string {
  return AVAILABILITY_TEXT[reason] ?? '记忆暂不可用。';
}

export function availabilityKind(reason: MemoryAvailabilityReason): MemoryFailureKind {
  if (reason === 'panel_disabled') return 'panel-disabled';
  if (reason === 'no_space') return 'no-space';
  if (reason === 'bank_missing') return 'empty';
  return 'unavailable';
}

export function memoryFailureOf(error: unknown): MemoryFailure {
  const failure = error as McpError;
  const insightCode =
    typeof failure?.details?.insight_code === 'string' ? failure.details.insight_code : '';
  if (failure?.code === 'PERMISSION_DENIED' || insightCode === 'FORBIDDEN') {
    return {
      kind: 'forbidden',
      message: '无权查看这个 Agent 的记忆。只有好友、共享有效房间的成员或 Agent 本人可以读取。',
    };
  }
  return {
    kind: 'error',
    message: failure?.message || '读取记忆失败，请重试。',
  };
}

export async function fetchMemoryOverview(
  actorId: string,
  token: string,
  signal: AbortSignal,
): Promise<MemoryOverviewResult> {
  return callTool<MemoryOverviewResult>(
    'network_agent_memory_overview',
    { actor_id: actorId },
    { token, signal },
  );
}

export async function fetchMemoryList(
  actorId: string,
  token: string,
  query: MemoryListQuery,
  signal: AbortSignal,
): Promise<MemoryListResult> {
  return callTool<MemoryListResult>(
    'network_agent_memory_list',
    {
      actor_id: actorId,
      limit: query.limit,
      offset: query.offset,
      ...(query.q ? { q: query.q } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.time_field ? { time_field: query.time_field } : {}),
      ...(query.start_date ? { start_date: query.start_date } : {}),
      ...(query.end_date ? { end_date: query.end_date } : {}),
    },
    { token, signal },
  );
}

export async function fetchMemoryDetail(
  actorId: string,
  memoryId: string,
  token: string,
  signal: AbortSignal,
): Promise<MemoryGetResult> {
  return callTool<MemoryGetResult>(
    'network_agent_memory_get',
    { actor_id: actorId, memory_id: memoryId },
    { token, signal },
  );
}

export async function fetchMemoryGraph(
  actorId: string,
  token: string,
  query: MemoryGraphQuery,
  signal: AbortSignal,
): Promise<MemoryGraphResult> {
  return callTool<MemoryGraphResult>(
    'network_agent_memory_graph',
    {
      actor_id: actorId,
      limit: query.limit,
      ...(query.type ? { type: query.type } : {}),
    },
    { token, signal },
  );
}

export async function fetchMemoryEntities(
  actorId: string,
  token: string,
  query: MemoryEntitiesQuery,
  signal: AbortSignal,
): Promise<MemoryEntitiesResult> {
  return callTool<MemoryEntitiesResult>(
    'network_agent_memory_entities',
    {
      actor_id: actorId,
      view: query.view,
      ...(query.entity_id ? { entity_id: query.entity_id } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    },
    { token, signal },
  );
}

/** 本地展示用时间；无法解析时保留原串，不把异常抛给渲染层。 */
export function formatMemoryTime(value: string | null): string {
  if (!value) return '—';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString('zh-CN', { hour12: false });
}
