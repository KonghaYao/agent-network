/**
 * MF06：MCP Memory 工具的输入/输出 schema。
 *
 * 输入保持 strict，客户端不能多传 space_id/provider/bank/verified/trusted/
 * through_seq；服务端按当前凭据补齐空间与目标。输出 schema 只描述稳定字段，
 * 不包含 provider 路由、密钥或内部作业表结构。
 */
import { z } from 'zod';

import {
  MEMORY_EXPOSURE_EVIDENCE_KINDS,
  MEMORY_ORIGIN_KINDS,
} from './contracts';
import { MEMORY_CONTRACT_VERSION } from './contracts-core';

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const nonNegative = z.number().int().nonnegative();
const positive = z.number().int().positive();

const budget = z.strictObject({
  candidate_limit: positive.max(500),
  output_bytes: positive.max(4 * 1024 * 1024),
  deadline_at: nonNegative.nullable().optional(),
});

const catchupBudget = z.strictObject({
  candidate_limit: positive.max(500),
  selected_limit: positive.max(50),
  output_bytes: positive.max(4 * 1024 * 1024),
});

export const memoryEmptyInputSchema = z.strictObject({});

export const memoryContextListInputSchema = z.strictObject({
  kind: z.enum(['lookup', 'bound']).optional(),
  limit: positive.max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const memoryContextGetInputSchema = z.strictObject({
  context_id: id,
});

export const memoryListInputSchema = z.strictObject({
  object_kind: z.enum(['source', 'curated']),
  limit: positive.max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const memoryGetInputSchema = z.strictObject({
  object_kind: z.enum(['source', 'curated']),
  id,
  revision: positive.optional(),
});

export const memoryPutInputSchema = z.strictObject({
  request_id: id,
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(512 * 1024),
  expected_revision: positive.optional(),
});

export const memoryCorrectInputSchema = z.strictObject({
  request_id: id,
  curated_id: id,
  expected_revision: positive,
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(512 * 1024),
});

export const memoryForgetInputSchema = z.strictObject({
  request_id: id,
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('source'),
      source_id: id,
      source_revision: positive.optional(),
    }),
    z.strictObject({
      kind: z.literal('curated'),
      curated_id: id,
      revision: positive,
    }),
    z.strictObject({
      kind: z.literal('experience'),
      experience_id: id,
    }),
  ]),
});

export const memoryOperationGetInputSchema = z.strictObject({
  operation_id: id,
});

export const memoryHostCloseInputSchema = z.strictObject({
  request_id: id,
  host_binding_id: id.optional(),
  host_generation: positive.optional(),
  reason: z.enum(['session_end', 'run_end', 'lease_expired', 'client_closed']).default('client_closed'),
});

export const memoryInputStatusInputSchema = z.strictObject({
  manifest_id: id,
});

export const memoryCatchupPrepareInputSchema = z.strictObject({
  request_id: id,
  room_id: id,
  query: z.string().min(1).max(2000),
  required_message_ids: z.array(id).max(100).optional(),
  current_message_id: id.optional(),
  budget: catchupBudget,
});

export const memoryCatchupGetInputSchema = z.strictObject({
  plan_id: id,
  limit: positive.max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const memoryExperienceListInputSchema = z.strictObject({
  room_id: id.optional(),
  member_generation: nonNegative.optional(),
  origin_kinds: z.array(z.enum(MEMORY_ORIGIN_KINDS)).optional(),
  minimum_evidence: z.enum(MEMORY_EXPOSURE_EVIDENCE_KINDS).optional(),
  limit: positive.max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const memoryExperienceGetInputSchema = z.strictObject({
  experience_id: id,
});

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const injectionSchema = z.looseObject({
  eligible: z.boolean(),
  admit_required: z.literal(true),
  reason: z.string(),
});

const preparedTargetSchema = z.looseObject({
  kind: z.enum(['message', 'task']),
  host_binding_id: z.string(),
  host_generation: z.number(),
  session_incarnation: z.string(),
  run_id: z.string(),
  input_id: z.string(),
  input_revision: z.number(),
});

export const memoryStatusOutputSchema = z.looseObject({
  enabled: z.boolean(),
  capture: z.boolean(),
  space_id: z.string(),
  ownership_epoch: z.number(),
  backend_binding_epoch: z.number(),
  host_level: z.string(),
  supported_host_modes: z.array(z.string()).readonly(),
  modes: z.array(z.string()).readonly(),
  counts: z.looseObject({
    jobs_pending: z.number(),
    jobs_unknown: z.number(),
    jobs_failed: z.number(),
    retain_pending: z.number(),
    contexts_ready: z.number(),
  }),
  unsupported: z.array(z.string()).readonly(),
});

export const memoryRecallOutputSchema = z.looseObject({
  recall_id: z.string(),
  status: z.string(),
  coverage: z.string(),
  evidence_complete: z.boolean(),
  items: z.array(z.record(z.string(), z.unknown())).readonly(),
  context: z.record(z.string(), z.unknown()).nullable(),
  exclusions: z.array(z.record(z.string(), z.unknown())).readonly(),
  context_ref: z.string().nullable(),
  injection: injectionSchema,
});

export const memoryContextListOutputSchema = z.looseObject({
  items: z.array(z.looseObject({ context_id: z.string() })).readonly(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const memoryContextGetOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: z.string().nullable().optional(),
  context_id: z.string().optional(),
  kind: z.enum(['lookup', 'bound']).optional(),
  body: z.string().optional(),
  body_sha256: z.string().optional(),
  items: z.array(z.record(z.string(), z.unknown())).readonly().optional(),
  validity: z.string().optional(),
  injection: injectionSchema.optional(),
});

export const memoryListOutputSchema = z.looseObject({
  object_kind: z.enum(['source', 'curated']),
  items: z.array(z.record(z.string(), z.unknown())).readonly(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const memoryGetOutputSchema = z.looseObject({
  object_kind: z.enum(['source', 'curated']),
  found: z.boolean(),
  item: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable().optional(),
});

export const memoryPutOutputSchema = z.looseObject({
  request_id: z.string(),
  curated_id: z.string(),
  revision: z.number(),
  operation_id: z.string().nullable(),
  status: z.string(),
  duplicate: z.boolean().optional(),
});

export const memoryForgetOutputSchema = z.looseObject({
  request_id: z.string(),
  operation_id: z.string().nullable(),
  status: z.string(),
  purge: z.string().nullable(),
});

export const memoryOperationOutputSchema = z.looseObject({
  found: z.boolean(),
  operation: z.record(z.string(), z.unknown()).nullable(),
});

export const memoryHostBindOutputSchema = z.looseObject({
  protocol_version: z.string(),
  binding_id: z.string(),
  generation: z.number(),
  agent_actor_id: z.string(),
  space: z.looseObject({ space_id: z.string() }),
  level: z.string(),
  declared_capabilities: z.array(z.string()).readonly(),
  granted_capabilities: z.array(z.string()).readonly(),
  session_incarnation: z.string(),
  lease_expires_at: z.number(),
  created_at: z.number(),
  reused: z.boolean(),
});

export const memoryHostCloseOutputSchema = z.looseObject({
  closed: z.boolean(),
  binding_id: z.string(),
  generation: z.number(),
  reason: z.string(),
});

export const memoryInputPrepareOutputSchema = z.looseObject({
  status: z.enum(['prepared', 'skipped_no_boundary']),
  prepared_input_id: z.string().optional(),
  target: preparedTargetSchema.optional(),
  items: z.array(z.looseObject({ selection_id: z.string(), text: z.string() })).readonly().optional(),
  snapshot_upper_bound: z.number().optional(),
  budget: budget.optional(),
  created_at: z.number().optional(),
  expires_at: z.number().nullable().optional(),
  retain_eligible: z.literal(false),
  reason: z.string().optional(),
});

export const memoryInputStatusOutputSchema = z.looseObject({
  manifest_id: z.string(),
  status: z.string(),
  submitted_evidence: z.string().nullable(),
  retain_eligible: z.boolean(),
  retain_ids: z.array(z.string()).readonly(),
  receipt_disposition: z.string().nullable(),
  receipt_reason: z.string().nullable(),
  manifest_sha256: hash,
  payload_sha256: hash,
  created_at: z.number(),
});

export const memoryAdmitOutputSchema = z.looseObject({
  kind: z.enum(['context_delivery', 'input_exposure']),
  disposition: z.string(),
  reason: z.string().nullable(),
  receipt_id: z.string().optional(),
  evidence: z.string().nullable().optional(),
  experience_ids: z.array(z.string()).readonly().optional(),
  retain_ids: z.array(z.string()).readonly().optional(),
});

export const memoryCatchupPrepareOutputSchema = z.looseObject({
  plan_id: z.string(),
  room_id: z.string(),
  status: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  items: z.array(z.record(z.string(), z.unknown())).readonly(),
  selections: z.array(z.looseObject({ selection_id: z.string() })).readonly(),
  missing: z.array(z.looseObject({ message_id: z.string(), reason: z.string() })).readonly(),
  retain_eligible: z.literal(false),
});

export const memoryCatchupGetOutputSchema = z.looseObject({
  plan_id: z.string(),
  status: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  items: z.array(z.record(z.string(), z.unknown())).readonly(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const memoryExperienceListOutputSchema = z.looseObject({
  items: z.array(z.looseObject({ experience_id: z.string() })).readonly(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const memoryExperienceGetOutputSchema = z.looseObject({
  available: z.boolean(),
  reason: z.string().nullable().optional(),
  experience_id: z.string(),
  item: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
});

export const memoryCatalogSchema = z.looseObject({
  enabled: z.boolean(),
  contract_version: z.literal(MEMORY_CONTRACT_VERSION),
  capture: z.boolean(),
  host_modes: z.array(z.string()).readonly(),
  recall_modes: z.array(z.string()).readonly(),
  tools: z.array(z.string()).readonly(),
  supported: z.array(z.string()).readonly(),
  unsupported: z.array(z.string()).readonly(),
  reason: z.string().nullable(),
});
