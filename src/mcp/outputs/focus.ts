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
  message_id: z.string().optional(),
  delivery_id: z.string().optional(),
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
