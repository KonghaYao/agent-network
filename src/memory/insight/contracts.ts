/**
 * 只读 Agent 记忆 insight 的稳定契约。
 *
 * 工具只接受业务定位（actor_id）与只读过滤条件；bank/space/provider 全部由
 * 服务端解析。输出白名单不含 document_id/chunk_id/metadata/内部 tags。
 */
import { z } from 'zod';

import { BusinessError, type BusinessErrorCode } from '../../contracts/errors';
import { LIMITS } from '../../contracts/limits';
import { isValidTimeZoneName } from './timeline-zone';

export const INSIGHT_FACT_TYPES = ['world', 'experience', 'observation'] as const;
export type InsightFactType = (typeof INSIGHT_FACT_TYPES)[number];

export const INSIGHT_AVAILABILITY_REASONS = [
  'ok',
  'no_space',
  'bank_missing',
  'panel_disabled',
  'backend_not_configured',
  'backend_unsupported',
] as const;
export type InsightAvailabilityReason = (typeof INSIGHT_AVAILABILITY_REASONS)[number];

export const INSIGHT_TIME_FIELDS = [
  'created_at',
  'mentioned_at',
  'occurred_start',
  'occurred_end',
] as const;
export type InsightTimeField = (typeof INSIGHT_TIME_FIELDS)[number];

export type InsightView = 'overview' | 'graph' | 'list' | 'get' | 'entities' | 'timeline';
export type InsightViewer = { actor_id: string; kind: 'human' | 'agent' };

export type InsightFailureCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE';

interface FailureDefinition {
  business: BusinessErrorCode;
  message: string;
}

const FAILURE_DEFINITIONS: Record<InsightFailureCode, FailureDefinition> = {
  FORBIDDEN: { business: 'PERMISSION_DENIED', message: '无权查看该 Agent 的记忆' },
  NOT_FOUND: { business: 'NOT_FOUND', message: '记忆或实体不存在' },
  UPSTREAM_TIMEOUT: { business: 'MEMORY_UNAVAILABLE', message: '记忆后端读取超时' },
  UPSTREAM_UNAVAILABLE: { business: 'MEMORY_UNAVAILABLE', message: '记忆后端暂时不可用' },
};

/**
 * 内部失败分类到公开 BusinessError 的唯一映射。
 *
 * `insight_code` 让客户端稳定区分超时/不可用，同时不引入新的公开错误码。
 */
export function insightBusinessError(code: InsightFailureCode): BusinessError {
  const definition = FAILURE_DEFINITIONS[code];
  return new BusinessError(definition.business, definition.message, {
    reason: code.toLowerCase(),
    insight_code: code,
  });
}

export interface InsightActorView {
  actor_id: string;
  name: string;
  kind: 'agent';
  archived: boolean;
  disabled: boolean;
}

export interface InsightStats {
  total_nodes: number;
  total_links: number;
  total_documents: number;
  by_fact_type: Record<InsightFactType, number>;
  links_by_type: Record<string, number>;
  pending_operations: number;
  failed_operations: number;
  last_write_at: string | null;
  last_consolidated_at: string | null;
}

export interface InsightMemoryItem {
  id: string;
  text: string;
  fact_type: InsightFactType | null;
  state: 'valid' | 'invalidated';
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string[];
  proof_count: number;
  tags: string[];
}

export interface InsightMemoryDetail extends InsightMemoryItem {
  context: string | null;
  source_memories: {
    id: string;
    text: string;
    type: InsightFactType | null;
    mentioned_at: string | null;
  }[];
  history_count: number;
  text_truncated: boolean;
}

export interface InsightEntityItem {
  id: string;
  name: string;
  mention_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface InsightEntityDetail extends InsightEntityItem {
  observations: { id: string; text: string; proof_count: number }[];
  memories: {
    id: string;
    text_preview: string;
    fact_type: InsightFactType | null;
    mentioned_at: string | null;
  }[];
}

export interface InsightGraphNode {
  id: string;
  label: string;
  text?: string;
  fact_type?: InsightFactType;
  date?: string | null;
  entities?: string[];
  mention_count?: number;
}

export interface InsightGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  entity?: string | null;
}

export interface InsightEntityGraph {
  nodes: InsightGraphNode[];
  edges: InsightGraphEdge[];
  total_entities: number | null;
  total_edges: number;
  raw_node_count: number;
  raw_edge_count: number;
  limit: number;
  truncated: boolean;
}

export interface InsightOverviewResult {
  available: boolean;
  reason: InsightAvailabilityReason;
  actor: InsightActorView;
  fetched_at: number;
  stats: InsightStats | null;
}

export interface InsightGraphResult {
  available: boolean;
  reason: InsightAvailabilityReason;
  actor: InsightActorView;
  fetched_at: number;
  nodes: InsightGraphNode[];
  edges: InsightGraphEdge[];
  total_units: number | null;
  total_edges: number;
  raw_node_count: number;
  raw_edge_count: number;
  limit: number;
  truncated: boolean;
}

export interface InsightListResult {
  available: boolean;
  reason: InsightAvailabilityReason;
  actor: InsightActorView;
  fetched_at: number;
  items: InsightMemoryItem[];
  total: number | null;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  truncated: boolean;
}

export interface InsightTimelineItem {
  id: string;
  text: string;
  fact_type: InsightFactType | null;
  state: 'valid' | 'invalidated';
  occurred_at: string | null;
  mentioned_at: string | null;
  entities: string[];
}

export interface InsightTimelineGroup {
  key: string;
  label: string;
  start: string | null;
  end: string | null;
  count: number;
  start_index: number;
  end_index: number;
}

export type InsightTimelineGranularity = 'day' | 'week' | 'month';

export interface InsightTimelineSummary {
  total: number | null;
  returned: number;
  dated: number;
  undated: number;
  by_type: Record<InsightFactType, number>;
}

export interface InsightTimelineResult {
  available: boolean;
  reason: InsightAvailabilityReason;
  actor: InsightActorView;
  fetched_at: number;
  items: InsightTimelineItem[];
  groups: Record<InsightTimelineGranularity, InsightTimelineGroup[]>;
  summary: InsightTimelineSummary;
  days: number;
  limit: number;
  truncated: boolean;
}

export interface InsightGetResult {
  available: boolean;
  reason: InsightAvailabilityReason;
  actor: InsightActorView;
  fetched_at: number;
  memory: InsightMemoryDetail | null;
}

export interface InsightEntitiesResult {
  available: boolean;
  reason: InsightAvailabilityReason;
  actor: InsightActorView;
  fetched_at: number;
  view: 'list' | 'graph' | 'detail';
  items: InsightEntityItem[];
  total: number | null;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  entity: InsightEntityDetail | null;
  graph: InsightEntityGraph | null;
  truncated: boolean;
  partial: boolean;
}

const actorId = z.string().min(1).max(128);
const queryText = z.string().min(1).max(LIMITS.memoryPanelSearchMax);
const refresh = z.boolean().optional();

export const insightOverviewInputSchema = z.strictObject({
  actor_id: actorId,
  refresh,
});

export const insightGraphInputSchema = z.strictObject({
  actor_id: actorId,
  type: z.enum(INSIGHT_FACT_TYPES).optional(),
  q: queryText.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.memoryPanelGraphNodesRequestMax)
    .optional(),
  refresh,
});

export const insightListInputSchema = z.strictObject({
  actor_id: actorId,
  q: queryText.optional(),
  type: z.enum(INSIGHT_FACT_TYPES).optional(),
  entity_id: z.string().min(1).max(256).optional(),
  time_field: z.enum(INSIGHT_TIME_FIELDS).optional(),
  start_date: z.string().min(1).max(40).optional(),
  end_date: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(LIMITS.memoryPanelFactsPageMax).optional(),
  offset: z.number().int().min(0).max(LIMITS.memoryPanelOffsetMax).optional(),
  text_chars: z.number().int().min(1).max(LIMITS.memoryPanelFactsTextChars).optional(),
  refresh,
});

export const insightTimelineInputSchema = z.strictObject({
  actor_id: actorId,
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
  type: z.enum(INSIGHT_FACT_TYPES).optional(),
  limit: z.number().int().min(1).max(LIMITS.memoryPanelTimelineLimitMax).optional(),
  /**
   * 本地时间 = UTC + offset，单位分钟（UTC+8 为 480）。
   *
   * 没有 IANA 名称时回退到该偏移；`timezone` 存在时忽略此值。
   */
  tz_offset_minutes: z.number().int().min(-840).max(840).optional(),
  /**
   * IANA 时区名（如 `Asia/Shanghai`、`America/New_York`），优先级高于
   * `tz_offset_minutes`；服务端按真实时区生成日/周/月分组，DST 切换日正确。
   */
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimeZoneName, { message: 'timezone 必须是有效的 IANA 时区名' })
    .optional(),
  refresh,
});

export const insightGetInputSchema = z.strictObject({
  actor_id: actorId,
  memory_id: z.string().min(1).max(256),
  refresh,
});

export const insightEntitiesInputSchema = z
  .strictObject({
    actor_id: actorId,
    view: z.enum(['list', 'graph', 'detail']).optional(),
    entity_id: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(LIMITS.memoryPanelEntityGraphEdgesRequestMax).optional(),
    offset: z.number().int().min(0).max(LIMITS.memoryPanelOffsetMax).optional(),
    min_count: z.number().int().min(1).max(100).optional(),
    refresh,
  })
  .superRefine((value, context) => {
    if (value.entity_id && value.view && value.view !== 'detail') {
      context.addIssue({
        code: 'custom',
        path: ['view'],
        message: 'entity_id 只能与 view=detail 一起使用',
      });
    }
    if (!value.entity_id && value.view === 'detail') {
      context.addIssue({
        code: 'custom',
        path: ['view'],
        message: 'view=detail 需要 entity_id',
      });
    }
  });

export type InsightOverviewInput = z.infer<typeof insightOverviewInputSchema>;
export type InsightGraphInput = z.infer<typeof insightGraphInputSchema>;
export type InsightListInput = z.infer<typeof insightListInputSchema>;
export type InsightTimelineInput = z.infer<typeof insightTimelineInputSchema>;
export type InsightGetInput = z.infer<typeof insightGetInputSchema>;
export type InsightEntitiesInput = z.infer<typeof insightEntitiesInputSchema>;

const actorSchema = z.looseObject({
  actor_id: z.string(),
  name: z.string(),
  kind: z.literal('agent'),
  archived: z.boolean(),
  disabled: z.boolean(),
});
const reasonSchema = z.enum(INSIGHT_AVAILABILITY_REASONS);

const statsSchema = z.looseObject({
  total_nodes: z.number(),
  total_links: z.number(),
  total_documents: z.number(),
  by_fact_type: z.looseObject({
    world: z.number(),
    experience: z.number(),
    observation: z.number(),
  }),
  links_by_type: z.record(z.string(), z.number()),
  pending_operations: z.number(),
  failed_operations: z.number(),
  last_write_at: z.string().nullable(),
  last_consolidated_at: z.string().nullable(),
});

const graphNodeSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  text: z.string().optional(),
  fact_type: z.enum(INSIGHT_FACT_TYPES).optional(),
  date: z.string().nullable().optional(),
  entities: z.array(z.string()).optional(),
  mention_count: z.number().optional(),
});

const graphEdgeSchema = z.looseObject({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.string(),
  weight: z.number(),
  entity: z.string().nullable().optional(),
});

const memoryItemSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  fact_type: z.enum(INSIGHT_FACT_TYPES).nullable(),
  state: z.enum(['valid', 'invalidated']),
  mentioned_at: z.string().nullable(),
  occurred_start: z.string().nullable(),
  occurred_end: z.string().nullable(),
  entities: z.array(z.string()),
  proof_count: z.number(),
  tags: z.array(z.string()),
});

const memoryDetailSchema = memoryItemSchema.extend({
  context: z.string().nullable(),
  source_memories: z.array(
    z.looseObject({
      id: z.string(),
      text: z.string(),
      type: z.enum(INSIGHT_FACT_TYPES).nullable(),
      mentioned_at: z.string().nullable(),
    }),
  ),
  history_count: z.number(),
  text_truncated: z.boolean(),
});

const entityItemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  mention_count: z.number(),
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
});

const entityDetailSchema = entityItemSchema.extend({
  observations: z.array(
    z.looseObject({ id: z.string(), text: z.string(), proof_count: z.number() }),
  ),
  memories: z.array(
    z.looseObject({
      id: z.string(),
      text_preview: z.string(),
      fact_type: z.enum(INSIGHT_FACT_TYPES).nullable(),
      mentioned_at: z.string().nullable(),
    }),
  ),
});

const entityGraphSchema = z.looseObject({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  total_entities: z.number().nullable(),
  total_edges: z.number(),
  raw_node_count: z.number(),
  raw_edge_count: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
});

export const insightOverviewOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: reasonSchema,
  actor: actorSchema,
  fetched_at: z.number(),
  stats: statsSchema.nullable(),
});

export const insightGraphOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: reasonSchema,
  actor: actorSchema,
  fetched_at: z.number(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  total_units: z.number().nullable(),
  total_edges: z.number(),
  raw_node_count: z.number(),
  raw_edge_count: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
});

export const insightListOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: reasonSchema,
  actor: actorSchema,
  fetched_at: z.number(),
  items: z.array(memoryItemSchema),
  total: z.number().nullable(),
  limit: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  truncated: z.boolean(),
});

const timelineItemSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  fact_type: z.enum(INSIGHT_FACT_TYPES).nullable(),
  state: z.enum(['valid', 'invalidated']),
  occurred_at: z.string().nullable(),
  mentioned_at: z.string().nullable(),
  entities: z.array(z.string()),
});

const timelineGroupSchema = z.looseObject({
  key: z.string(),
  label: z.string(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  count: z.number(),
  start_index: z.number(),
  end_index: z.number(),
});

const timelineSummarySchema = z.looseObject({
  total: z.number().nullable(),
  returned: z.number(),
  dated: z.number(),
  undated: z.number(),
  by_type: z.looseObject({
    world: z.number(),
    experience: z.number(),
    observation: z.number(),
  }),
});

export const insightTimelineOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: reasonSchema,
  actor: actorSchema,
  fetched_at: z.number(),
  items: z.array(timelineItemSchema),
  groups: z.looseObject({
    day: z.array(timelineGroupSchema),
    week: z.array(timelineGroupSchema),
    month: z.array(timelineGroupSchema),
  }),
  summary: timelineSummarySchema,
  days: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
});

export const insightGetOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: reasonSchema,
  actor: actorSchema,
  fetched_at: z.number(),
  memory: memoryDetailSchema.nullable(),
});

export const insightEntitiesOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: reasonSchema,
  actor: actorSchema,
  fetched_at: z.number(),
  view: z.enum(['list', 'graph', 'detail']),
  items: z.array(entityItemSchema),
  total: z.number().nullable(),
  limit: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  entity: entityDetailSchema.nullable(),
  graph: entityGraphSchema.nullable(),
  truncated: z.boolean(),
  partial: z.boolean(),
});
