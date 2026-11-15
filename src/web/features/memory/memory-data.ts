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
  limit: number;
  offset: number;
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

/** 本地展示用时间；无法解析时保留原串，不把异常抛给渲染层。 */
export function formatMemoryTime(value: string | null): string {
  if (!value) return '—';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString('zh-CN', { hour12: false });
}
