/**
 * MF09 Langfuse observation 解析与受控映射。
 *
 * 外部 trace 的 `userId`、metadata、trace 名称都不能自报 actor/room/verified。
 * 只有服务端配置的 binding（project + 可选 trace 名称 + observation 名称）
 * 才能把观测归入某个 WeBots Agent/房间；未匹配项一律跳过。
 *
 * 语义边界：
 * - original_input / business_event / tool_result -> raw_fragment；
 * - summary -> summary（必须携带可核实的最终输入 manifest id）；
 * - memory_context -> memory_context（必须引用已存在的 Context）；
 * - authored / agent_claim -> 不生成独立来源证据（WeBots 消息才是权威）。
 */
import { LIMITS } from '../../contracts/limits';
import { sha256Hex, utf8Bytes } from '../../storage/db';
import type {
  LangfuseObservationClass,
  LangfuseSourceBinding,
} from './langfuse-config';

export const LANGFUSE_SKIP_REASONS = [
  'unmapped_project',
  'unmapped_trace',
  'unmapped_observation',
  'ambiguous_binding',
  'invalid_observation',
  'empty_content',
  'oversized',
  'non_independent',
  'unverified_summary',
  'unverified_context',
  'excluded',
  'conflict',
  'echo_suppressed',
  'mapping_stale',
  'space_missing',
  'binding_agent_disabled',
  'store_error',
] as const;

export type LangfuseSkipReason = (typeof LANGFUSE_SKIP_REASONS)[number];

export interface LangfuseObservationRecord {
  id: string;
  traceId: string;
  projectId: string;
  type: string;
  name: string | null;
  startTimeMs: number;
  startTime: string;
  endTime: string | null;
  traceName: string | null;
  userId: string | null;
  sessionId: string | null;
  input: string | null;
  output: string | null;
  metadata: Record<string, unknown> | null;
}

export type LangfuseObservationParseResult =
  | { ok: true; observation: LangfuseObservationRecord }
  | { ok: false; reason: 'invalid_observation' };

export type LangfuseMappingResult =
  | {
      kind: 'source';
      binding: LangfuseSourceBinding;
      sourceKey: string;
      traceId: string;
      observationId: string;
      observationName: string;
      observationClass: LangfuseObservationClass;
      observationType: string;
      representationKind: 'raw_fragment' | 'summary' | 'memory_context';
      text: string;
      digest: string | null;
      bytes: number;
      occurredAt: number;
      manifestId: string | null;
      contextId: string | null;
      businessRefJson: string;
    }
  | { kind: 'skipped'; reason: LangfuseSkipReason; observation: LangfuseObservationRecord | null };

export interface LangfuseObservationsPage {
  observations: readonly unknown[];
  cursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 只接受 Observations v2 的原始字符串 I/O。对象/数组 I/O 不转成 JSON 文本
 * 冒充原文，直接跳过，避免把宿主结构体当作用户原文。
 */
export function parseLangfuseObservation(value: unknown): LangfuseObservationParseResult {
  if (!isRecord(value)) return { ok: false, reason: 'invalid_observation' };
  const id = value.id;
  const traceId = value.traceId;
  const projectId = value.projectId;
  const type = value.type;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof traceId !== 'string' ||
    traceId.length === 0 ||
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    typeof type !== 'string' ||
    type.length === 0
  ) {
    return { ok: false, reason: 'invalid_observation' };
  }
  const startTime = optionalString(value.startTime);
  const startTimeMs = parseTimestamp(startTime) ?? parseTimestamp(value.createdAt);
  if (startTimeMs === null) return { ok: false, reason: 'invalid_observation' };
  const normalizedStartTime =
    startTime !== null && parseTimestamp(startTime) !== null
      ? startTime
      : new Date(startTimeMs).toISOString();
  const rawInput = value.input;
  const rawOutput = value.output;
  if (
    rawInput !== undefined &&
    rawInput !== null &&
    typeof rawInput !== 'string'
  ) {
    return { ok: false, reason: 'invalid_observation' };
  }
  if (
    rawOutput !== undefined &&
    rawOutput !== null &&
    typeof rawOutput !== 'string'
  ) {
    return { ok: false, reason: 'invalid_observation' };
  }
  const metadata = value.metadata;
  if (metadata !== undefined && metadata !== null && !isRecord(metadata)) {
    return { ok: false, reason: 'invalid_observation' };
  }
  return {
    ok: true,
    observation: {
      id,
      traceId,
      projectId,
      type,
      name: optionalString(value.name),
      startTimeMs,
      startTime: normalizedStartTime,
      endTime: optionalString(value.endTime),
      traceName: optionalString(value.traceName),
      userId: optionalString(value.userId),
      sessionId: optionalString(value.sessionId),
      input: typeof rawInput === 'string' ? rawInput : null,
      output: typeof rawOutput === 'string' ? rawOutput : null,
      metadata: isRecord(metadata) ? metadata : null,
    },
  };
}

/** 解析 Observations v2 的 `{ data, meta: { cursor } }` 响应；形状不符 fail closed。 */
export function parseLangfusePage(
  body: unknown,
): { ok: true; page: LangfuseObservationsPage } | { ok: false } {
  if (!isRecord(body) || !Array.isArray(body.data)) return { ok: false };
  const meta = body.meta;
  if (meta !== undefined && meta !== null && !isRecord(meta)) return { ok: false };
  const rawCursor = isRecord(meta) ? meta.cursor : null;
  if (rawCursor !== undefined && rawCursor !== null && typeof rawCursor !== 'string') {
    return { ok: false };
  }
  const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null;
  return { ok: true, page: { observations: body.data, cursor } };
}

function selectBinding(
  observation: LangfuseObservationRecord,
  bindings: readonly LangfuseSourceBinding[],
):
  | { kind: 'ok'; binding: LangfuseSourceBinding }
  | { kind: 'skipped'; reason: LangfuseSkipReason } {
  const projectBindings = bindings.filter(
    (binding) => binding.project_id === observation.projectId,
  );
  if (projectBindings.length === 0) return { kind: 'skipped', reason: 'unmapped_project' };
  const traceBindings = projectBindings.filter(
    (binding) =>
      !binding.trace_names ||
      (observation.traceName !== null && binding.trace_names.includes(observation.traceName)),
  );
  if (traceBindings.length === 0) return { kind: 'skipped', reason: 'unmapped_trace' };
  if (traceBindings.length > 1) return { kind: 'skipped', reason: 'ambiguous_binding' };
  return { kind: 'ok', binding: traceBindings[0]! };
}

/**
 * 将一条 observation 映射为可写入共享来源的候选。
 *
 * `digest` 对 memory_context 为 null：调用方必须用已核实的 Context 正文
 * 替换，不能把 trace 文本当作 Context 原文。
 */
export async function mapLangfuseObservation(
  observation: LangfuseObservationRecord,
  bindings: readonly LangfuseSourceBinding[],
): Promise<LangfuseMappingResult> {
  if (!observation.name) {
    return { kind: 'skipped', reason: 'unmapped_observation', observation };
  }
  const selected = selectBinding(observation, bindings);
  if (selected.kind === 'skipped') return { ...selected, observation };
  const binding = selected.binding;
  const rule = binding.observations[observation.name];
  if (!rule) {
    return { kind: 'skipped', reason: 'unmapped_observation', observation };
  }
  const observationClass = rule.class;
  if (observationClass === 'authored' || observationClass === 'agent_claim') {
    // WeBots message/review 才是 authored/验收的权威来源；trace 自述只保留
    // 在外部系统，不转成独立 Memory 证据。
    return { kind: 'skipped', reason: 'non_independent', observation };
  }
  const rawText =
    rule.field === 'input' ? observation.input : observation.output;
  let text = rawText ?? '';
  let manifestId: string | null = null;
  let contextId: string | null = null;
  let representationKind: 'raw_fragment' | 'summary' | 'memory_context';
  if (observationClass === 'summary') {
    manifestId = metadataString(
      observation.metadata,
      rule.manifest_metadata_key ?? 'agentnet_manifest_id',
    );
    if (!manifestId) {
      return { kind: 'skipped', reason: 'unverified_summary', observation };
    }
    representationKind = 'summary';
  } else if (observationClass === 'memory_context') {
    contextId = metadataString(
      observation.metadata,
      rule.context_metadata_key ?? 'agentnet_context_id',
    );
    if (!contextId) {
      return { kind: 'skipped', reason: 'unverified_context', observation };
    }
    representationKind = 'memory_context';
    // Context 正文由 importer 从 memory_contexts 读取，trace 文本只作定位提示。
    text = '';
  } else {
    representationKind = 'raw_fragment';
  }
  if (representationKind !== 'memory_context') {
    if (text.length === 0) {
      return { kind: 'skipped', reason: 'empty_content', observation };
    }
    if (utf8Bytes(text) > LIMITS.memoryLangfuseMaxObservationBytes) {
      return { kind: 'skipped', reason: 'oversized', observation };
    }
  }
  const digest = representationKind === 'memory_context' ? null : await sha256Hex(text);
  const businessRefJson = JSON.stringify({
    trace_id: observation.traceId,
    observation_id: observation.id,
    project_id: observation.projectId,
    trace_name: observation.traceName,
    observation_name: observation.name,
    observation_type: observation.type,
    observation_class: observationClass,
    // 外部作者标识只作溯源展示，不转成 actor、授权或可信证据。
    trace_user_id: observation.userId,
    trace_session_id: observation.sessionId,
    start_time: observation.startTime,
    end_time: observation.endTime,
  });
  return {
    kind: 'source',
    binding,
    sourceKey: `langfuse:${binding.binding_id}:${observation.traceId}:${observation.id}`,
    traceId: observation.traceId,
    observationId: observation.id,
    observationName: observation.name,
    observationClass,
    observationType: observation.type,
    representationKind,
    text,
    digest,
    bytes: representationKind === 'memory_context' ? 0 : utf8Bytes(text),
    occurredAt: observation.startTimeMs,
    manifestId,
    contextId,
    businessRefJson,
  };
}
