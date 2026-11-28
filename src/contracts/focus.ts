/**
 * Task Focus 个人看板的输入契约与共享类型。
 *
 * owner 永远从 Bearer 身份推导，任何工具都不接受 owner 参数；Agent 身份在
 * 领域层统一返回 `PERMISSION_DENIED`。时间字段对外一律为毫秒字符串，
 * 与其它读接口保持一致。
 */

import { z } from 'zod';

import { LIMITS } from './limits';

const itemId = z.string().min(1).max(128);
const requestId = z.string().min(1).max(128);
const cursor = z.string().min(1).max(2048).optional();

/** 三列看板；归档是独立维度，不占列值。 */
export const FOCUS_COLUMNS = ['needs_me', 'tracking', 'done'] as const;
export type FocusColumn = (typeof FOCUS_COLUMNS)[number];

/** `disabled` 只由「没有绑定行」推导，不写入数据库。 */
export const FOCUS_BINDING_STATUSES = [
  'disabled',
  'provisioning',
  'active',
  'paused',
  'failed',
] as const;
export type FocusBindingStatus = (typeof FOCUS_BINDING_STATUSES)[number];

export const focusStatusSchema = z.object({});

export const focusEnableSchema = z.object({
  request_id: requestId,
});

export const focusDisableSchema = z.object({
  request_id: requestId,
});

export const focusListSchema = z.object({
  column: z.enum(FOCUS_COLUMNS).optional(),
  /** 缺省 false：只返回未归档卡；true 只返回已归档卡。 */
  archived: z.boolean().optional(),
  /** 匹配 title / next_step / summary，SQL LIKE 语义，`%` 与 `_` 按字面量处理。 */
  query: z.string().min(1).max(LIMITS.focusQueryMax).optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.focusListPageMax).optional(),
});

export const focusGetSchema = z.object({
  item_id: itemId,
});

export const focusArchiveSchema = z.object({
  item_id: itemId,
  request_id: requestId,
  expected_version: z.number().int().positive(),
});

export interface FocusCounts {
  needs_me: number;
  tracking: number;
  done: number;
  /** 归档卡不计入前三列。 */
  archived: number;
}

export interface FocusStatusResult {
  enabled: boolean;
  status: FocusBindingStatus;
  counts: FocusCounts;
  secretary_actor_id: string | null;
  /** 本阶段只预留远端会话开通，恒为 false。 */
  runtime_ready: boolean;
}

export interface FocusEnableResult extends FocusStatusResult {
  /** 本次调用没有改变状态（返回既有绑定）。 */
  idempotent: boolean;
}

export type FocusDisableResult = FocusEnableResult;

export interface FocusListItem {
  item_id: string;
  title: string;
  column_key: FocusColumn;
  next_step: string;
  waiting_on: string | null;
  due_at: string | null;
  due_text: string | null;
  summary: string;
  version: number;
  source_count: number;
  /** 任一证据失权时为 true，同时遮蔽卡面内容与来源计数。 */
  restricted: boolean;
  archived_at: string | null;
  updated_at: string;
}

export interface FocusEvidenceView {
  evidence_id: string;
  source_kind: 'message' | 'delivery';
  purpose: string;
  readable: boolean;
  occurred_at: string;
  room_id?: string;
  room_name?: string;
  message_id?: string;
  delivery_id?: string;
  sender_id?: string;
  sender_name?: string;
  sender_kind?: 'human' | 'agent';
  excerpt?: string;
  revision: number;
}

export interface FocusRevisionView {
  revision_id: string;
  version: number;
  reason: string;
  changes: unknown;
  evidence: unknown;
  created_at: string;
}

export interface FocusListResult {
  items: FocusListItem[];
  next_cursor: string | null;
}

export interface FocusGetResult {
  item: FocusListItem;
  evidence: FocusEvidenceView[];
  revisions: FocusRevisionView[];
}

export interface FocusArchiveResult {
  item_id: string;
  archived_at: string;
  version: number;
  idempotent: boolean;
}

/* ------------------------------------------------------------------ */
/* 秘书工具（固定服务身份）：owner 从 attempt_ref 对应的作业推导      */
/* ------------------------------------------------------------------ */

const attemptRef = z.string().min(1).max(128);
const focusCandidateId = z.string().min(1).max(128);
const focusDueAt = z.union([z.number().int().nonnegative(), z.string().min(1).max(64)]);

export const focusJobGetSchema = z.object({
  attempt_ref: attemptRef,
});

const focusEvidenceSourceSchema = z.object({
  candidate_id: focusCandidateId,
});

export const focusEvidenceReadSchema = z.object({
  attempt_ref: attemptRef,
  sources: z
    .array(focusEvidenceSourceSchema)
    .min(1)
    .max(LIMITS.focusSecretaryEvidenceMax),
  limit: z.number().int().min(1).max(LIMITS.focusSecretaryEvidenceMax).optional(),
});

export const focusItemsFindSchema = z.object({
  attempt_ref: attemptRef,
  query: z.string().min(1).max(LIMITS.focusQueryMax).optional(),
  /** `message:<id>` / `delivery:<id>` 或候选 ID。 */
  sources: z.array(z.string().min(1).max(256)).max(20).optional(),
});

const focusEvidenceRefSchema = z.object({
  candidate_id: focusCandidateId,
  purpose: z.string().min(1).max(64).optional(),
});

const focusCreateDecisionSchema = z.object({
  type: z.literal('create'),
  title: z.string().min(1).max(LIMITS.focusSecretaryTextMax),
  column_key: z.enum(FOCUS_COLUMNS),
  next_step: z.string().max(LIMITS.focusSecretaryTextMax).default(''),
  waiting_on: z.string().max(LIMITS.focusSecretaryTextMax).nullable().optional(),
  due_at: focusDueAt.nullable().optional(),
  due_text: z.string().max(LIMITS.focusSecretaryTextMax).nullable().optional(),
  summary: z.string().max(LIMITS.focusSecretaryTextMax).optional(),
  evidence: z.array(focusEvidenceRefSchema).min(1).max(LIMITS.focusSecretaryEvidenceMax),
});

const focusUpdateChangesSchema = z.object({
  title: z.string().min(1).max(LIMITS.focusSecretaryTextMax).optional(),
  column_key: z.enum(FOCUS_COLUMNS).optional(),
  next_step: z.string().max(LIMITS.focusSecretaryTextMax).optional(),
  waiting_on: z.string().max(LIMITS.focusSecretaryTextMax).nullable().optional(),
  due_at: focusDueAt.nullable().optional(),
  due_text: z.string().max(LIMITS.focusSecretaryTextMax).nullable().optional(),
  summary: z.string().max(LIMITS.focusSecretaryTextMax).optional(),
});

const focusUpdateDecisionSchema = z.object({
  type: z.literal('update'),
  item_id: itemId,
  expected_version: z.number().int().positive(),
  changes: focusUpdateChangesSchema.default({}),
  evidence: z.array(focusEvidenceRefSchema).max(LIMITS.focusSecretaryEvidenceMax).optional(),
});

const focusDispositionDecisionSchema = z.object({
  type: z.enum(['ignore', 'pending']),
  candidate_ids: z.array(focusCandidateId).min(1).max(LIMITS.focusJobCandidatesMax),
  reason: z.string().min(1).max(LIMITS.focusSecretaryTextMax),
});

export const focusCommitSchema = z.object({
  attempt_ref: attemptRef,
  decision_id: z.string().min(1).max(128),
  complete: z.boolean(),
  decisions: z
    .array(
      z.discriminatedUnion('type', [
        focusCreateDecisionSchema,
        focusUpdateDecisionSchema,
        focusDispositionDecisionSchema,
      ]),
    )
    .min(1)
    .max(LIMITS.focusJobCandidatesMax),
});

export type FocusCommitInput = z.input<typeof focusCommitSchema>;
export type FocusCreateDecision = z.input<typeof focusCreateDecisionSchema>;
export type FocusUpdateDecision = z.input<typeof focusUpdateDecisionSchema>;
export type FocusDispositionDecision = z.input<typeof focusDispositionDecisionSchema>;

export interface FocusJobCandidateView {
  candidate_id: string;
  source_kind: 'message' | 'delivery';
  room_id: string | null;
  message_id: string | null;
  delivery_id: string | null;
  reason: string;
  event_seq: number;
}

export interface FocusJobGetResult {
  job_id: string;
  attempt_ref: string;
  owner_name: string;
  generation: number;
  event_from_seq: number;
  event_to_seq: number;
  status: string;
  candidates: FocusJobCandidateView[];
  counts: FocusCounts;
}

export interface FocusEvidenceReadItem {
  candidate_id: string;
  source_kind: 'message' | 'delivery';
  readable: boolean;
  reason?: string;
  room_id?: string;
  room_name?: string;
  room_kind?: 'direct' | 'group';
  message_id?: string;
  sender_id?: string;
  sender_name?: string;
  sender_kind?: 'human' | 'agent';
  created_at?: string;
  excerpt?: string;
  delivery_id?: string;
  delivery_state?: string;
  delivery_attempt?: number;
}

export interface FocusEvidenceReadResult {
  items: FocusEvidenceReadItem[];
}

export interface FocusFindItem {
  item_id: string;
  title: string;
  column_key: FocusColumn;
  version: number;
  archived: boolean;
  next_step: string;
}

export interface FocusItemsFindResult {
  items: FocusFindItem[];
}

export interface FocusCommitItem {
  item_id: string;
  version: number;
  column_key: FocusColumn;
  archived: boolean;
}

export interface FocusCommitReceipt {
  decision_id: string;
  job_id: string;
  complete: boolean;
  job_status: string;
  items: FocusCommitItem[];
  ignored: string[];
  pending: string[];
  covered: number;
}
