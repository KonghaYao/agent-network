/**
 * 个人看板 Web 端类型。
 *
 * 只镜像 MCP 契约字段，不从服务端 domain 导入；所有时间保持毫秒字符串，
 * 展示层再统一格式化。列与归档是两个维度，归档卡不占三列。
 */

export type FocusColumnKey = 'needs_me' | 'tracking' | 'done';
export type FocusBindingStatus = 'disabled' | 'provisioning' | 'active' | 'paused' | 'failed';
export type FocusTab = 'current' | 'archived';

export interface FocusCounts {
  needs_me: number;
  tracking: number;
  done: number;
  archived: number;
}

export interface FocusStatus {
  enabled: boolean;
  status: FocusBindingStatus;
  counts: FocusCounts;
  secretary_actor_id: string | null;
  runtime_ready: boolean;
}

export interface FocusItem {
  item_id: string;
  title: string;
  column_key: FocusColumnKey;
  next_step: string;
  waiting_on: string | null;
  due_at: string | null;
  due_text: string | null;
  summary: string;
  version: number;
  source_count: number;
  restricted: boolean;
  archived_at: string | null;
  updated_at: string;
}

export interface FocusEvidence {
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

export interface FocusRevision {
  revision_id: string;
  version: number;
  reason: string;
  changes: unknown;
  evidence: unknown;
  created_at: string;
}

export interface FocusListPage {
  items: FocusItem[];
  next_cursor: string | null;
}

export interface FocusDetailData {
  item: FocusItem;
  evidence: FocusEvidence[];
  revisions: FocusRevision[];
}

export interface FocusJumpTarget {
  room_id: string;
  message_id: string;
  query: string;
  mode: 'exact' | 'fuzzy';
  scope: 'room' | 'all';
}

export interface FocusColumnMeta {
  key: FocusColumnKey;
  label: string;
  /** 列内没有卡时的轻文案，不解释后端状态。 */
  empty: string;
}

export const FOCUS_COLUMNS: readonly FocusColumnMeta[] = [
  { key: 'needs_me', label: '需要我', empty: '现在没有轮到你的事' },
  { key: 'tracking', label: '跟进中', empty: '暂无事在跟进' },
  { key: 'done', label: '已结束', empty: '还没有结束的事项' },
];

export const FOCUS_COLUMN_LABELS: Record<FocusColumnKey, string> = {
  needs_me: '需要我',
  tracking: '跟进中',
  done: '已结束',
};

/** 时间戳字符串转 `16:00` / `11月26日` 一类短标签；非法值返回 null。 */
export function focusTimeLabel(value: string | null, withYear = false): string | null {
  if (!value) return null;
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', {
        ...(withYear ? { year: 'numeric' as const } : {}),
        month: 'numeric',
        day: 'numeric',
      });
}
