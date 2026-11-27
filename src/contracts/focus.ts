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
  message_id?: string;
  delivery_id?: string;
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
