import {
  formatDisplayTime,
  formatEntryMeta,
  normalizeCount,
  type CountValue,
  type DisplayTimeValue,
  type EntryMetaInput,
} from '../../lib/display-format';

/** Task dock、预览与 Trace 共用的时间格式；不改变任何业务状态。 */
export function taskTimeLabel(value: string | null | undefined): string {
  return formatDisplayTime(value, { mode: 'detail' }).display;
}

/**
 * Task / delivery 状态的展示顺序。
 *
 * `completed` 只是“已完成”，`failed` 与 `cancelled` 必须单列；三者合计的
 * “执行已结束”不能当成成功。
 */
export const TASK_STATUS_DISPLAY_ORDER = [
  'pending',
  'claimed',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskDisplayStatus = (typeof TASK_STATUS_DISPLAY_ORDER)[number];

const TASK_STATUS_LABELS: Record<TaskDisplayStatus, string> = {
  pending: '待处理',
  claimed: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 已知状态的中文名；未知状态返回空串，由调用方省略。 */
export function taskStatusLabel(status: string | null | undefined): string {
  if (!status) return '';
  return TASK_STATUS_LABELS[status as TaskDisplayStatus] ?? '';
}

/** 排序权重：已知状态按固定顺序，未知状态稳定地排在其后。 */
export function taskStatusRank(status: string): number {
  const rank = TASK_STATUS_DISPLAY_ORDER.indexOf(status as TaskDisplayStatus);
  return rank === -1 ? TASK_STATUS_DISPLAY_ORDER.length : rank;
}

/** 稳定排序状态条目；不写状态、不推断未知状态。 */
export function sortTaskStatusEntries<T extends { status: string }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(
    (left, right) => taskStatusRank(left.status) - taskStatusRank(right.status),
  );
}

export interface TaskStatusEntry {
  status: TaskDisplayStatus;
  label: string;
  count: number;
}

export interface TaskStatusSummary {
  /** 非零状态按固定顺序；`includeZero` 时包含全部已知状态。 */
  entries: TaskStatusEntry[];
  total: number;
  /** pending + claimed。 */
  active: number;
  /** completed + failed + cancelled；执行已结束，不等于成功。 */
  ended: number;
  /** 仅 completed；失败和取消不并入。 */
  completed: number;
  failed: number;
  cancelled: number;
}

/** 展示聚合：把 delivery/Task 计数整理成固定顺序与明确口径。 */
export function summarizeTaskStatuses(
  counts: Partial<Record<string, CountValue>> | null | undefined,
  options: { includeZero?: boolean } = {},
): TaskStatusSummary {
  const normalized = {} as Record<TaskDisplayStatus, number>;
  for (const status of TASK_STATUS_DISPLAY_ORDER) {
    normalized[status] = normalizeCount(counts?.[status]) ?? 0;
  }
  const entries = TASK_STATUS_DISPLAY_ORDER
    .filter((status) => options.includeZero === true || normalized[status] > 0)
    .map((status) => ({
      status,
      label: TASK_STATUS_LABELS[status],
      count: normalized[status],
    }));
  const active = normalized.pending + normalized.claimed;
  const ended = normalized.completed + normalized.failed + normalized.cancelled;
  return {
    entries,
    total: active + ended,
    active,
    ended,
    completed: normalized.completed,
    failed: normalized.failed,
    cancelled: normalized.cancelled,
  };
}

export interface TaskEntryMetaInput extends Omit<EntryMetaInput, 'mode' | 'time'> {
  time?: DisplayTimeValue;
}

/** Task 入口摘要：`N 条消息 · N 个 Agent · 时间`，未知项省略。 */
export function taskEntryMeta(input: TaskEntryMetaInput = {}): string {
  return formatEntryMeta({ ...input, mode: 'detail' });
}
