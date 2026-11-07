/**
 * 任务业务状态的单一文案与阶段投影。
 *
 * `tasks.status` 是唯一权威状态；这里只提供展示文案、业务阶段和合法迁移表。
 * delivery 的 pending/claimed/completed/failed/cancelled 是通知处理状态，
 * 不映射为本文件的业务状态。
 */

export const TASK_STATUS_VALUES = [
  'unassigned',
  'offered',
  'in_progress',
  'blocked',
  'submitted',
  'accepted',
  'failed',
  'cancelled',
  'legacy_completed',
] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  unassigned: '待领取',
  offered: '待接手',
  in_progress: '进行中',
  blocked: '受阻',
  submitted: '待验收',
  accepted: '已验收',
  failed: '失败',
  cancelled: '已取消',
  legacy_completed: '历史完成',
};

/**
 * 状态说明同时出现在网页详情和 MCP 输出中，避免各入口自行发明语义。
 *
 * `legacy_completed` 明确说明旧任务板纪录没有经过新验收流程，不能当作
 * `accepted`；`submitted`/`accepted` 只由 D06/D07 的提交与验收入口产生。
 */
export const TASK_STATUS_HINTS: Record<TaskStatus, string> = {
  unassigned: '任务尚未指派，符合资格的成员可以领取。',
  offered: '已向候选负责人发出接手邀请，接受后才开始执行，原任务状态还未变为进行中。',
  in_progress: '负责人正在执行；普通进度更新只增加 revision，不改变业务状态。',
  blocked: '负责人报告阻塞并记录原因；需要由仍有资格的负责人显式恢复。',
  submitted: '成果已提交，等待指定验收人处理；提交不等于验收通过。',
  accepted: '验收人已通过；该状态不能由执行者或 delivery complete 自行产生。',
  failed: '执行失败；重试或重派会产生新的 assignment 版本，不能复用旧执行资格。',
  cancelled: '任务已取消，不能继续执行、提交或验收；需要追加工作时应创建关联任务。',
  legacy_completed:
    '旧任务板的历史完成记录，未经过新验收流程；只读展示，不能当作 accepted，也不能由 delivery complete 产生。',
};

export type TaskPhase = 'dispatch' | 'execution' | 'review' | 'closed';

export const TASK_PHASE_LABELS: Record<TaskPhase, string> = {
  dispatch: '派发',
  execution: '执行',
  review: '验收',
  closed: '已结束',
};

export function taskPhaseOf(status: TaskStatus): TaskPhase {
  switch (status) {
    case 'unassigned':
    case 'offered':
      return 'dispatch';
    case 'in_progress':
    case 'blocked':
      return 'execution';
    case 'submitted':
      return 'review';
    case 'accepted':
    case 'failed':
    case 'cancelled':
    case 'legacy_completed':
      return 'closed';
  }
}

/** 状态变化必须按 C07；同一状态不算变化，进度更新单独处理。 */
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  unassigned: ['offered', 'in_progress', 'cancelled'],
  offered: ['in_progress', 'unassigned', 'cancelled'],
  in_progress: ['blocked', 'submitted', 'failed', 'cancelled'],
  blocked: ['in_progress', 'offered', 'cancelled'],
  submitted: ['accepted', 'in_progress', 'blocked', 'cancelled'],
  failed: ['offered', 'unassigned', 'cancelled'],
  accepted: [],
  cancelled: [],
  legacy_completed: [],
};

export function taskCanTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to);
}

/** 终态不能继续推进；failed 仍可由后续任务重试/取消，不在本集合内。 */
export function taskIsTerminal(status: TaskStatus): boolean {
  return status === 'accepted' || status === 'cancelled' || status === 'legacy_completed';
}
