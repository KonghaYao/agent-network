/**
 * Memory 对外输入 schema（MF01）。
 *
 * 这些是客户端可构造的最小字段。所有对象都是 strict：客户端多传
 * space_id/bank_id/provider_id/verified/trusted/through_seq 等字段会直接
 * 失败，不会被静默转发给适配器。服务端在调用前用已鉴权身份补齐空间与目标。
 */
import { z } from 'zod';

import { MEMORY_ORIGIN_KINDS, MEMORY_SOURCE_KINDS } from './contracts-core';
import { MEMORY_EXPOSURE_EVIDENCE_KINDS } from './experience-contracts';
import { MEMORY_HOST_CAPABILITIES, MEMORY_RECALL_MODES } from './recall-contracts';

// ---------------------------------------------------------------------------
// 对外 schema（MCP 输入）
// ---------------------------------------------------------------------------

const memoryIdSchema = z.string().min(1).max(128);
const memoryHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const memoryEpochSchema = z.number().int().positive();
const memoryBytesSchema = z.number().int().nonnegative();

const memoryMessageRefSchema = z.strictObject({
  room_id: memoryIdSchema,
  message_id: memoryIdSchema,
  created_seq: memoryBytesSchema,
});

const memoryTaskRefSchema = z.strictObject({
  task_id: memoryIdSchema,
  assignment_id: memoryIdSchema,
  assignment_version: z.number().int().positive().nullable(),
});

const memoryMessageDeliveryRefSchema = z.strictObject({
  message_id: memoryIdSchema,
  delivery_id: memoryIdSchema,
  attempt: memoryBytesSchema,
  claim_id: memoryIdSchema,
});

const memoryTaskAssignmentRefSchema = z.strictObject({
  task_id: memoryIdSchema,
  assignment_id: memoryIdSchema,
  assignment_version: z.number().int().positive(),
});

const memoryRecallBudgetSchema = z.strictObject({
  candidate_limit: z.number().int().positive(),
  output_bytes: z.number().int().positive(),
  deadline_at: memoryBytesSchema.optional(),
});

const memoryHostRecallRefSchema = z.strictObject({
  host_binding_id: memoryIdSchema,
  host_generation: memoryEpochSchema,
  session_incarnation: memoryIdSchema,
});

/**
 * 完整 Context 目标只用于 input_prepare：调用时已 claim，且绑定真实 run/input。
 * agent/space 由服务端根据凭据与 HostBinding 解析。kind 与 message/task 必须一致。
 */
export const memoryContextTargetInputSchema = z
  .strictObject({
    kind: z.enum(['message', 'task']),
    host_binding_id: memoryIdSchema,
    host_generation: memoryEpochSchema,
    session_incarnation: memoryIdSchema,
    run_id: memoryIdSchema,
    input_id: memoryIdSchema,
    input_revision: memoryBytesSchema,
    message: memoryMessageDeliveryRefSchema.optional(),
    task: memoryTaskAssignmentRefSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'message' && !value.message) {
      ctx.addIssue({ code: 'custom', message: 'message 目标缺少 message 定位' });
    }
    if (value.kind === 'task' && !value.task) {
      ctx.addIssue({ code: 'custom', message: 'task 目标缺少 task 定位' });
    }
    if (value.kind === 'message' && value.task) {
      ctx.addIssue({ code: 'custom', message: 'message 目标不能携带 task 定位' });
    }
    if (value.kind === 'task' && value.message) {
      ctx.addIssue({ code: 'custom', message: 'task 目标不能携带 message 定位' });
    }
  });

export const memoryRecallInputSchema = z
  .strictObject({
    request_id: memoryIdSchema,
    mode: z.enum(MEMORY_RECALL_MODES),
    dispatch: z.enum(['explicit', 'auto']),
    query: z.string().min(1).optional(),
    host: memoryHostRecallRefSchema.optional(),
    message: memoryMessageRefSchema.optional(),
    task: memoryTaskRefSchema.optional(),
    hard_filters: z
      .strictObject({
        origin_kinds: z.array(z.enum(MEMORY_ORIGIN_KINDS)).optional(),
        minimum_evidence: z.enum(MEMORY_EXPOSURE_EVIDENCE_KINDS).optional(),
        origin_room_ids: z.array(memoryIdSchema).optional(),
        source_kinds: z.array(z.enum(MEMORY_SOURCE_KINDS)).optional(),
        time_field: z.enum(['created_at', 'submitted_at']).optional(),
        time_from: memoryBytesSchema.optional(),
        time_to: memoryBytesSchema.optional(),
        timezone: z.string().min(1).max(64).optional(),
      })
      .optional(),
    ranking_hints: z
      .strictObject({
        recency_bias: z.number().min(0).max(1).optional(),
        relevance_bias: z.number().min(0).max(1).optional(),
        preferred_source_kinds: z.array(z.enum(MEMORY_SOURCE_KINDS)).optional(),
      })
      .optional(),
    budget: memoryRecallBudgetSchema,
  })
  .superRefine((value, ctx) => {
    const isAuto = value.dispatch === 'auto';
    const isBootstrap = value.mode === 'bootstrap';
    const isQueryOnly = value.mode === 'lookup' || value.mode === 'reflect';

    if (isAuto && value.mode !== 'related' && value.mode !== 'task') {
      ctx.addIssue({ code: 'custom', message: '只有 related/task 可以自动派发' });
    }
    if (isAuto && !value.host) {
      ctx.addIssue({ code: 'custom', message: 'auto 召回必须提供宿主绑定代次' });
    }
    if (isBootstrap && !value.host) {
      ctx.addIssue({ code: 'custom', message: 'bootstrap 召回必须提供宿主绑定代次' });
    }
    if (value.host && !isBootstrap && !isAuto) {
      ctx.addIssue({ code: 'custom', message: '只有 bootstrap/auto 召回携带宿主绑定代次' });
    }
    if (isQueryOnly && !value.query) {
      ctx.addIssue({ code: 'custom', message: `${value.mode} 必须提供 query` });
    }
    if (value.mode === 'related' && !value.message) {
      ctx.addIssue({ code: 'custom', message: 'related 召回必须提供 message 定位' });
    }
    if (value.mode === 'task' && !value.task) {
      ctx.addIssue({ code: 'custom', message: 'task 召回必须提供 task 定位' });
    }
    if (value.mode === 'related' && value.task) {
      ctx.addIssue({ code: 'custom', message: 'related 召回不能携带 task 定位' });
    }
    if (value.mode === 'task' && value.message) {
      ctx.addIssue({ code: 'custom', message: 'task 召回不能携带 message 定位' });
    }
    if ((isBootstrap || isQueryOnly) && (value.message || value.task)) {
      ctx.addIssue({ code: 'custom', message: `${value.mode} 召回不能携带消息/任务定位` });
    }
  });

/** 宿主只能申请能力；level/trusted/verified 由服务端判定。 */
export const memoryHostBindInputSchema = z.strictObject({
  request_id: memoryIdSchema,
  session_incarnation: memoryIdSchema.optional(),
  declared_capabilities: z.array(z.enum(MEMORY_HOST_CAPABILITIES)).optional(),
  lease_ms: z.number().int().positive().optional(),
});

/** 输入准备只接受服务端签发的 selection 引用，不接受客户端正文或来源 ID。 */
export const memoryInputPrepareInputSchema = z.strictObject({
  request_id: memoryIdSchema,
  target: memoryContextTargetInputSchema,
  selection_ids: z.array(memoryIdSchema).min(1),
  budget: memoryRecallBudgetSchema,
});

/**
 * 回执输入不包含 evidence/verified/trusted/through_seq。
 *
 * kind=input_exposure 必须绑定准确 manifest 与 payload；kind=context_delivery
 * 必须绑定 context。提交证据等级由服务端按 HostBinding 派生。
 */
export const memoryExposureReceiptInputSchema = z
  .strictObject({
    request_id: memoryIdSchema,
    kind: z.enum(['context_delivery', 'input_exposure']),
    context_id: memoryIdSchema.optional(),
    context_sha256: memoryHashSchema.optional(),
    manifest_id: memoryIdSchema.optional(),
    manifest_sha256: memoryHashSchema.optional(),
    payload_sha256: memoryHashSchema.optional(),
    invocation_id: memoryIdSchema,
    proof_id: memoryIdSchema,
    submitted_at: memoryBytesSchema,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'context_delivery') {
      if (!value.context_id || !value.context_sha256) {
        ctx.addIssue({ code: 'custom', message: 'context_delivery 必须绑定 context 与 hash' });
      }
      if (value.manifest_id || value.manifest_sha256 || value.payload_sha256) {
        ctx.addIssue({ code: 'custom', message: 'context_delivery 不能携带 manifest 字段' });
      }
      return;
    }
    if (!value.manifest_id || !value.manifest_sha256 || !value.payload_sha256) {
      ctx.addIssue({ code: 'custom', message: 'input_exposure 必须绑定 manifest 与 payload' });
    }
    if (value.context_id || value.context_sha256) {
      ctx.addIssue({ code: 'custom', message: 'input_exposure 不能携带 context 字段' });
    }
  });

export type MemoryContextTargetInput = z.infer<typeof memoryContextTargetInputSchema>;
export type MemoryRecallInput = z.infer<typeof memoryRecallInputSchema>;
export type MemoryHostBindInput = z.infer<typeof memoryHostBindInputSchema>;
export type MemoryInputPrepareInput = z.infer<typeof memoryInputPrepareInputSchema>;
export type MemoryExposureReceiptInput = z.infer<typeof memoryExposureReceiptInputSchema>;
