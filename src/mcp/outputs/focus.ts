/** Task Focus 看板工具的 MCP 输出 schema。 */

import { z } from 'zod';

import { FOCUS_BINDING_STATUSES, FOCUS_COLUMNS } from '../../contracts/focus';

export const focusCountsSchema = z.object({
  needs_me: z.number().int().nonnegative(),
  tracking: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
});

export const focusStatusResultSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(FOCUS_BINDING_STATUSES),
  counts: focusCountsSchema,
  secretary_actor_id: z.string().nullable(),
  runtime_ready: z.boolean(),
});

export const focusMutationResultSchema = focusStatusResultSchema.extend({
  /** 本次调用没有改变状态（返回既有绑定）。 */
  idempotent: z.boolean(),
});

export const focusListItemSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  column_key: z.enum(FOCUS_COLUMNS),
  next_step: z.string(),
  waiting_on: z.string().nullable(),
  due_at: z.string().nullable(),
  due_text: z.string().nullable(),
  summary: z.string(),
  version: z.number().int().positive(),
  source_count: z.number().int().nonnegative(),
  restricted: z.boolean(),
  archived_at: z.string().nullable(),
  updated_at: z.string(),
});

export const focusListResultSchema = z.object({
  items: z.array(focusListItemSchema),
  next_cursor: z.string().nullable(),
});

export const focusEvidenceSchema = z.object({
  evidence_id: z.string(),
  source_kind: z.enum(['message', 'delivery']),
  purpose: z.string(),
  readable: z.boolean(),
  occurred_at: z.string(),
  /** 不可读时不返回定位字段，只保留 readable=false 与 purpose。 */
  room_id: z.string().optional(),
  room_name: z.string().optional(),
  message_id: z.string().optional(),
  delivery_id: z.string().optional(),
  sender_id: z.string().optional(),
  sender_name: z.string().optional(),
  sender_kind: z.enum(['human', 'agent']).optional(),
  excerpt: z.string().optional(),
  revision: z.number().int().nonnegative(),
});

export const focusRevisionSchema = z.object({
  revision_id: z.string(),
  version: z.number().int().positive(),
  reason: z.string(),
  changes: z.unknown(),
  evidence: z.unknown(),
  created_at: z.string(),
});

export const focusGetResultSchema = z.object({
  item: focusListItemSchema,
  evidence: z.array(focusEvidenceSchema),
  revisions: z.array(focusRevisionSchema),
});

export const focusArchiveResultSchema = z.object({
  item_id: z.string(),
  archived_at: z.string(),
  version: z.number().int().positive(),
  idempotent: z.boolean(),
});

/* 秘书工具（固定服务身份）输出。 */

export const focusJobCandidateSchema = z.object({
  candidate_id: z.string(),
  source_kind: z.enum(['message', 'delivery']),
  room_id: z.string().nullable(),
  message_id: z.string().nullable(),
  delivery_id: z.string().nullable(),
  reason: z.string(),
  event_seq: z.number().int().nonnegative(),
});

export const focusJobGetResultSchema = z.object({
  job_id: z.string(),
  attempt_ref: z.string(),
  owner_name: z.string(),
  generation: z.number().int().positive(),
  event_from_seq: z.number().int().nonnegative(),
  event_to_seq: z.number().int().nonnegative(),
  status: z.string(),
  candidates: z.array(focusJobCandidateSchema),
  counts: focusCountsSchema,
});

export const focusEvidenceReadItemSchema = z.object({
  candidate_id: z.string(),
  source_kind: z.enum(['message', 'delivery']),
  readable: z.boolean(),
  reason: z.string().optional(),
  room_id: z.string().optional(),
  room_name: z.string().optional(),
  room_kind: z.enum(['direct', 'group']).optional(),
  message_id: z.string().optional(),
  sender_id: z.string().optional(),
  sender_name: z.string().optional(),
  sender_kind: z.enum(['human', 'agent']).optional(),
  created_at: z.string().optional(),
  excerpt: z.string().optional(),
  delivery_id: z.string().optional(),
  delivery_state: z.string().optional(),
  delivery_attempt: z.number().int().nonnegative().optional(),
});

export const focusEvidenceReadResultSchema = z.object({
  items: z.array(focusEvidenceReadItemSchema),
});

export const focusFindItemSchema = z.object({
  item_id: z.string(),
  title: z.string(),
  column_key: z.enum(FOCUS_COLUMNS),
  version: z.number().int().positive(),
  archived: z.boolean(),
  next_step: z.string(),
});

export const focusItemsFindResultSchema = z.object({
  items: z.array(focusFindItemSchema),
});

export const focusCommitItemSchema = z.object({
  item_id: z.string(),
  version: z.number().int().positive(),
  column_key: z.enum(FOCUS_COLUMNS),
  archived: z.boolean(),
});

export const focusCommitReceiptSchema = z.object({
  decision_id: z.string(),
  job_id: z.string(),
  complete: z.boolean(),
  job_status: z.string(),
  items: z.array(focusCommitItemSchema),
  ignored: z.array(z.string()),
  pending: z.array(z.string()),
  covered: z.number().int().nonnegative(),
});
