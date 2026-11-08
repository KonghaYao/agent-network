/**
 * D01 任务工作流（tasks / task_assignments / task_deliveries / task_cards）。
 *
 * 设计约束：
 * - 旧 `room_tasks` 迁移后只读；新写入不再写 `room_task_*` 事件。
 * - `title` 只用于列表短展示；详细目标与验收条件保存在受控正文列，不塞进
 *   120 字短字段，也不复制进聊天消息正文。
 * - 指定负责人只形成 `offered` assignment，不等于接单；Agent 明确指派只生成
 *   一条绑定 task/assignment/version 的 delivery，human 使用持久个人通知。
 * - 公开任务创建不产生 delivery、不增加 `pending_count`、不唤醒 Agent；任务
 *   卡片本身是普通房间消息，聊天未读按消息本义维护。
 * - 所有写操作走 `runIdempotent`；同一来源消息至多一个任务，同一 assignment
 *   至多一条 offer delivery。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  TaskAcceptInput,
  TaskBlockInput,
  TaskCancelInput,
  TaskClaimInput,
  TaskCreateInput,
  TaskDeclineInput,
  TaskGetInput,
  TaskListInput,
  TaskOfferInput,
  TaskProgressInput,
  TaskResumeInput,
  TaskSummaryInput,
} from '../contracts/schemas';
import {
  TASK_PHASE_LABELS,
  TASK_STATUS_HINTS,
  TASK_STATUS_LABELS,
  taskCanTransition,
  taskPhaseOf,
} from '../contracts/task-status';
import { newId, nowMs, sha256Hex, stableStringify, truncateUtf8, utf8Bytes } from '../storage/db';
import {
  eventStatement,
  inboxHeadStatement,
  inboxTopic,
  outboxStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import {
  getActor,
  getDelivery,
  getMember,
  getMessage,
  getOperation,
  getRoom,
  getRoomFile,
  getTask,
  getTaskAssignment,
  getTaskBySourceMessage,
  getTaskCard,
} from '../storage/queries';
import type {
  ActorRow,
  MessageRow,
  RoomMemberRow,
  RoomRow,
  TaskAssignmentRow,
  TaskAttachmentRow,
  TaskDeliveryRow,
  TaskProgressRow,
  TaskRow,
} from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement, findActiveBlockBetween } from './contact-blocks';
import { actorId, type Principal } from './principal';
import {
  latestProgressRows,
  normalizeBlockReason,
  normalizeProgressNote,
  normalizeProgressPercent,
  progressActorIds,
  progressHistoryRows,
  progressStatement,
  progressView,
  type TaskProgressView,
} from './task-progress';
import { capabilityGuardStatement, roomCapabilitiesFor } from './room-access';
import {
  historyBoundary,
  historySnapshot,
  visibleMessage,
  type HistoryBoundary,
  type HistorySnapshot,
} from './room-history';
import { messageCoreStatements, type MessageCore } from './messages';

export type TaskStatus = TaskRow['status'];
export type TaskAssignmentStatus = TaskAssignmentRow['status'];

export interface TaskAssignmentView {
  assignment_id: string;
  assignment_version: number;
  owner_actor_id: string;
  owner_name: string | null;
  status: TaskAssignmentStatus;
  offer_expires_at: string | null;
  delivery_id: string | null;
}

export interface TaskAttachmentView {
  file_id: string;
  label: string;
}

export interface TaskView {
  task_id: string;
  room_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: TaskStatus;
  status_label: string;
  status_hint: string;
  phase: ReturnType<typeof taskPhaseOf>;
  phase_label: string;
  revision: number;
  source_message_id: string | null;
  card_message_id: string | null;
  created_by: string;
  created_by_name: string;
  owner_actor_id: string | null;
  owner_name: string | null;
  reviewer_actor_id: string;
  reviewer_name: string;
  due_at: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
  last_progress_at: string | null;
  /** 最新一条进度/阻塞/恢复审计；没有上报过时为 null。 */
  progress: TaskProgressView | null;
  /** 仅 task_get 返回最近历史，列表与写操作不携带，避免放大输出。 */
  progress_history?: TaskProgressView[];
  business_authority: 'native' | 'external';
  external_binding_id: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  assignment: TaskAssignmentView | null;
  delivery_ids: string[];
  attachments: TaskAttachmentView[];
  can_offer: boolean;
  can_claim: boolean;
  can_cancel: boolean;
  can_accept: boolean;
  can_decline: boolean;
  can_report_progress: boolean;
  can_block: boolean;
  can_resume: boolean;
}

export interface TaskResult {
  task: TaskView;
  authorization: HistorySnapshot;
}

export interface TaskListResult {
  tasks: TaskView[];
  next_cursor: null;
  has_more: false;
  authorization: HistorySnapshot | null;
}

export interface TaskSummaryItem {
  room_id: string;
  /** 公开未领取任务数。 */
  pending: number;
  /** 当前身份当前负责的进行中任务数；不含他人。 */
  claimed: number;
  /** 已验收 + 历史完成。 */
  done: number;
  failed: number;
  /** 当前身份可见的全部任务数。 */
  total: number;
}

export interface TaskSummaryResult {
  items: TaskSummaryItem[];
}

export interface TaskCounts {
  pending: number;
  claimed: number;
  done: number;
  failed: number;
  total: number;
}

interface TaskContext {
  caller: string;
  callerKind: 'human' | 'agent';
  room: RoomRow;
  member: RoomMemberRow;
  boundary: HistoryBoundary;
}

interface NamedTaskContext extends TaskContext {
  names: Map<string, string>;
}

const TASK_TITLE_CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const TASK_BODY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function invalid(label: string, message: string): BusinessError {
  return new BusinessError('INVALID_ARGUMENT', `${label}${message}`);
}

export function normalizeTaskTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BusinessError('INVALID_ARGUMENT', '任务标题不能为空');
  if (TASK_TITLE_CONTROL.test(trimmed)) {
    throw new BusinessError('INVALID_ARGUMENT', '任务标题不能包含换行或控制字符');
  }
  if (Array.from(trimmed).length > LIMITS.taskTitleMax) {
    throw new BusinessError(
      'INVALID_ARGUMENT',
      `任务标题不能超过 ${LIMITS.taskTitleMax} 个字符；详细目标请写入 description`,
    );
  }
  return trimmed;
}

/** 受控 Markdown/结构化正文：允许换行与制表，拒绝 NUL/其他控制字符。 */
export function normalizeTaskBody(
  value: string | undefined,
  label: string,
  maxBytes: number,
): string {
  if (value === undefined) return '';
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return '';
  if (TASK_BODY_CONTROL.test(normalized)) {
    throw invalid(label, '不能包含 NUL 或其他不可见控制字符');
  }
  const bytes = utf8Bytes(normalized);
  if (bytes > maxBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', `${label}超过 ${maxBytes} 字节`, {
      bytes,
      max: maxBytes,
    });
  }
  return normalized;
}

function normalizeCancelReason(value: string): string {
  return normalizeTaskBody(value, '取消原因', LIMITS.taskCancelReasonBytes);
}

function normalizeDeclineReason(value: string | undefined): string {
  return normalizeTaskBody(value, '拒绝原因', LIMITS.taskCancelReasonBytes);
}

/**
 * 冲突时返回权威状态快照，失败方不必靠轮询猜测真实负责人。
 *
 * 只用于错误 details，不包含成员列表、凭据或正文。
 */
async function actualTaskState(
  db: D1Database,
  taskId: string,
): Promise<Record<string, unknown>> {
  const task = await getTask(db, taskId);
  if (!task) return { task_id: taskId, status: null };
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  const owner = task.owner_actor_id ?? assignment?.owner_actor_id ?? null;
  const ownerRow = owner ? await getActor(db, owner) : null;
  return {
    task_id: task.task_id,
    status: task.status,
    revision: task.revision,
    owner_actor_id: owner,
    owner_name: ownerRow?.name ?? null,
    assignment_id: assignment?.assignment_id ?? null,
    assignment_version: assignment?.assignment_version ?? null,
    assignment_status: assignment?.status ?? null,
  };
}

async function staleTaskError(
  db: D1Database,
  taskId: string,
  code: 'ASSIGNMENT_STALE' | 'CONFLICT' | 'VERSION_CONFLICT',
  message: string,
): Promise<BusinessError> {
  return new BusinessError(code, message, await actualTaskState(db, taskId));
}

const ACTUAL_STATE_CODES: ReadonlySet<string> = new Set([
  'ASSIGNMENT_STALE',
  'CLAIM_CONFLICT',
  'CONFLICT',
  'VERSION_CONFLICT',
  'REQUEST_EXPIRED',
]);

/** 竞态失败时把权威状态并入错误 details；失败方仍应重新 task_get 刷新 UI。 */
async function rethrowWithActualState(
  db: D1Database,
  taskId: string,
  error: unknown,
): Promise<never> {
  if (error instanceof BusinessError && ACTUAL_STATE_CODES.has(error.code)) {
    throw new BusinessError(error.code, error.message, {
      ...(error.details ?? {}),
      ...(await actualTaskState(db, taskId)),
    });
  }
  throw error;
}

function parseDueAt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw invalid('due_at', '必须是合法的 ISO 8601 时间');
  const now = nowMs();
  if (at < now) throw invalid('due_at', '不能早于当前时间');
  if (at - now > LIMITS.taskDueMaxAheadMs) throw invalid('due_at', '超出允许的期限范围');
  return at;
}

async function actorNames(db: D1Database, actorIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(actorIds.filter((id) => id.length > 0)));
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT actor_id, name FROM actors WHERE actor_id IN (${placeholders})`)
    .bind(...unique)
    .all<{ actor_id: string; name: string }>();
  return new Map(result.results.map((row) => [row.actor_id, row.name]));
}

async function requireRoomMember(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<{ caller: string; room: RoomRow; member: RoomMemberRow; boundary: HistoryBoundary }> {
  const caller = actorId(principal);
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  return { caller, room, member, boundary: historyBoundary(room, member) };
}

/**
 * 任务直读的唯一授权入口。
 *
 * 非成员、历史边界外与不存在统一返回 `NOT_FOUND`，不能靠 task_id 探测任务
 * 是否存在；只有已知任务且当前成员可见时才继续。
 */
async function requireVisibleTask(
  db: D1Database,
  principal: Principal,
  taskId: string,
): Promise<{ task: TaskRow; context: TaskContext }> {
  const task = await getTask(db, taskId);
  if (!task) throw new BusinessError('NOT_FOUND', '任务不存在');
  const room = await getRoom(db, task.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '任务不存在');
  const caller = actorId(principal);
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_FOUND', '任务不存在');
  }
  const boundary = historyBoundary(room, member);
  if (!boundary.full && task.created_at < boundary.fromAt) {
    throw new BusinessError('NOT_FOUND', '任务不存在');
  }
  return {
    task,
    context: {
      caller,
      callerKind: principal.actor?.kind ?? 'human',
      room,
      member,
      boundary,
    },
  };
}

async function memberBoundary(
  db: D1Database,
  room: RoomRow,
  actor: string,
): Promise<{ actor: ActorRow; member: RoomMemberRow; boundary: HistoryBoundary } | null> {
  const actorRow = await getActor(db, actor);
  if (!actorRow) return null;
  const member = await getMember(db, room.room_id, actor);
  if (!member || member.status !== 'active') return null;
  return { actor: actorRow, member, boundary: historyBoundary(room, member) };
}

/** 负责人/验收人必须有任务访问资格：有效成员且当前历史边界内可见。 */
async function assertTaskParticipant(
  db: D1Database,
  room: RoomRow,
  actor: string,
  label: string,
  taskCreatedAt?: number,
): Promise<ActorRow> {
  const found = await memberBoundary(db, room, actor);
  if (!found) throw invalid(label, '必须是该房间的有效成员');
  if (found.actor.disabled_at !== null) {
    throw new BusinessError('ACTOR_DISABLED', `${label}已停用`);
  }
  if (
    taskCreatedAt !== undefined &&
    !found.boundary.full &&
    taskCreatedAt < found.boundary.fromAt
  ) {
    throw invalid(label, '无权访问该任务');
  }
  return found.actor;
}

function isOwnerOrAdmin(room: RoomRow, member: RoomMemberRow): boolean {
  return room.owner_id === member.actor_id || member.role === 'owner' || member.role === 'admin';
}

function canDispatch(task: TaskRow, context: TaskContext): boolean {
  if (task.created_by === context.caller) return true;
  return isOwnerOrAdmin(context.room, context.member);
}

async function buildTaskView(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  names?: Map<string, string>,
  options?: {
    /** 列表已批量读取最新进度，避免逐任务 N+1。 */
    progress?: Map<string, TaskProgressRow>;
    /** 详情页返回最近历史；列表默认不返回。 */
    history?: boolean;
  },
): Promise<TaskView> {
  const card = await getTaskCard(db, task.task_id);
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  const historyRows = options?.history
    ? await progressHistoryRows(db, task.task_id)
    : [];
  const latestRow =
    historyRows[0] ??
    (options?.progress
      ? (options.progress.get(task.task_id) ?? null)
      : ((await latestProgressRows(db, [task.task_id])).get(task.task_id) ?? null));
  const deliveries = await db
    .prepare(
      `SELECT * FROM task_deliveries
        WHERE task_id = ? ORDER BY created_at ASC, delivery_id ASC`,
    )
    .bind(task.task_id)
    .all<TaskDeliveryRow>();
  const attachments = await db
    .prepare(
      `SELECT * FROM task_attachments
        WHERE task_id = ? ORDER BY created_at ASC, file_id ASC`,
    )
    .bind(task.task_id)
    .all<TaskAttachmentRow>();
  const nameMap =
    names ??
    (await actorNames(db, [
      task.created_by,
      task.reviewer_actor_id,
      ...(task.owner_actor_id ? [task.owner_actor_id] : []),
      ...(assignment ? [assignment.owner_actor_id] : []),
      ...progressActorIds([
        ...(latestRow ? [latestRow] : []),
        ...historyRows,
      ]),
    ]));
  const progress = latestRow ? progressView(latestRow, nameMap) : null;
  const progressHistory = options?.history
    ? historyRows.map((row) => progressView(row, nameMap))
    : undefined;
  const owner = task.owner_actor_id;
  const isAdmin = isOwnerOrAdmin(context.room, context.member);
  const canCancel =
    task.status !== 'accepted' &&
    task.status !== 'cancelled' &&
    task.status !== 'legacy_completed' &&
    (task.created_by === context.caller || owner === context.caller || isAdmin);
  const canActOnOffer =
    task.status === 'offered' &&
    assignment !== null &&
    assignment.status === 'offered' &&
    assignment.owner_actor_id === context.caller &&
    (assignment.offer_expires_at === null || assignment.offer_expires_at > nowMs());
  return {
    task_id: task.task_id,
    room_id: task.room_id,
    title: task.title,
    description: task.description,
    acceptance_criteria: task.acceptance_criteria,
    status: task.status,
    status_label: TASK_STATUS_LABELS[task.status],
    status_hint: TASK_STATUS_HINTS[task.status],
    phase: taskPhaseOf(task.status),
    phase_label: TASK_PHASE_LABELS[taskPhaseOf(task.status)],
    revision: task.revision,
    source_message_id: task.source_message_id,
    card_message_id: card?.message_id ?? null,
    created_by: task.created_by,
    created_by_name: nameMap.get(task.created_by) ?? '',
    owner_actor_id: owner,
    owner_name: owner ? (nameMap.get(owner) ?? null) : null,
    reviewer_actor_id: task.reviewer_actor_id,
    reviewer_name: nameMap.get(task.reviewer_actor_id) ?? '',
    due_at: task.due_at === null ? null : String(task.due_at),
    blocked_reason: task.blocked_reason,
    blocked_at: task.blocked_at === null ? null : String(task.blocked_at),
    last_progress_at:
      task.last_progress_at === null ? null : String(task.last_progress_at),
    progress,
    ...(progressHistory ? { progress_history: progressHistory } : {}),
    business_authority: task.business_authority,
    external_binding_id: task.external_binding_id,
    created_at: String(task.created_at),
    updated_at: String(task.updated_at),
    accepted_at: task.accepted_at === null ? null : String(task.accepted_at),
    cancelled_at: task.cancelled_at === null ? null : String(task.cancelled_at),
    assignment:
      assignment === null
        ? null
        : {
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
            owner_actor_id: assignment.owner_actor_id,
            owner_name: nameMap.get(assignment.owner_actor_id) ?? null,
            status: assignment.status,
            offer_expires_at:
              assignment.offer_expires_at === null
                ? null
                : String(assignment.offer_expires_at),
            delivery_id: assignment.delivery_id,
          },
    delivery_ids: deliveries.results.map((row) => row.delivery_id),
    attachments: attachments.results.map((row) => ({
      file_id: row.file_id,
      label: row.label,
    })),
    can_offer:
      task.status === 'unassigned' &&
      canDispatch(task, context) &&
      roomCapabilitiesFor(context.room, context.member).create_task,
    can_claim:
      task.status === 'unassigned' &&
      task.reviewer_actor_id !== context.caller &&
      (await blockedBetween(db, context.caller, task.created_by)) === false,
    can_cancel: canCancel,
    can_accept: canActOnOffer,
    can_decline: canActOnOffer,
    can_report_progress:
      task.status === 'in_progress' && task.owner_actor_id === context.caller,
    can_block:
      task.status === 'in_progress' && task.owner_actor_id === context.caller,
    can_resume:
      task.status === 'blocked' && task.owner_actor_id === context.caller,
  };
}

async function blockedBetween(db: D1Database, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  return (await findActiveBlockBetween(db, a, b)) !== null;
}

async function resultFor(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  names?: Map<string, string>,
  withProgressHistory = false,
): Promise<TaskResult> {
  return {
    task: await buildTaskView(
      db,
      context,
      task,
      names,
      withProgressHistory ? { history: true } : undefined,
    ),
    authorization: historySnapshot(context.boundary),
  };
}

function memberGuard(db: D1Database, roomId: string, actor: string): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'notMember',
        "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
      ),
    )
    .bind(roomId, actor);
}

function participantGuard(
  db: D1Database,
  roomId: string,
  actor: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'invalidTarget',
        "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
      ),
    )
    .bind(roomId, actor);
}

function taskStateGuard(
  db: D1Database,
  taskId: string,
  predicate: string,
  ...binds: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'taskState',
        `NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = ? AND ${predicate})`,
      ),
    )
    .bind(taskId, ...binds);
}

/** 迟到请求使用读取时的 task_revision 做 CAS，不能覆盖新指派。 */
function taskRevisionGuard(
  db: D1Database,
  taskId: string,
  revision: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'versionConflict',
        'NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = ? AND revision = ?)',
      ),
    )
    .bind(taskId, revision);
}

/**
 * 接受/拒绝必须仍指向当前 `offered` assignment 且执行身份一致。
 *
 * 旧 offer 的 assignment 已不再 current，guard 失败映射为 ASSIGNMENT_STALE；
 * 同一人两设备竞争时，后提交方同样在这里被拒绝。
 */
function assignmentOfferGuard(
  db: D1Database,
  taskId: string,
  assignmentId: string,
  ownerActorId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'assignmentStale',
        `NOT EXISTS (
           SELECT 1 FROM task_assignments
            WHERE assignment_id = ? AND task_id = ? AND owner_actor_id = ?
              AND status = 'offered'
         )`,
      ),
    )
    .bind(assignmentId, taskId, ownerActorId);
}

function offerExpiryGuard(
  db: D1Database,
  assignmentId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'requestExpired',
        `EXISTS (
           SELECT 1 FROM task_assignments
            WHERE assignment_id = ? AND offer_expires_at IS NOT NULL
              AND offer_expires_at <= ?
         )`,
      ),
    )
    .bind(assignmentId, at);
}

/**
 * 进度、阻塞与恢复都必须引用当前 active assignment。
 *
 * C08 要求每个任务变更同时验证 task/assignment 两层版本；旧负责人即使
 * 仍能读取任务，也不能用旧 assignment 写入进度。
 */
function activeAssignmentGuard(
  db: D1Database,
  assignment: TaskAssignmentRow,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'assignmentStale',
        `NOT EXISTS (
           SELECT 1 FROM task_assignments
            WHERE assignment_id = ? AND task_id = ? AND owner_actor_id = ?
              AND assignment_version = ? AND status = 'active'
         )`,
      ),
    )
    .bind(
      assignment.assignment_id,
      assignment.task_id,
      assignment.owner_actor_id,
      assignment.assignment_version,
    );
}

function taskRoomEvent(
  db: D1Database,
  task: Pick<TaskRow, 'task_id' | 'room_id' | 'status' | 'revision'>,
  eventType: string,
  eventKey: string,
  at: number,
  metadata: Record<string, unknown>,
): { eventKey: string; statements: D1PreparedStatement[] } {
  return {
    eventKey,
    statements: [
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: task.room_id,
          eventType,
          refId: task.task_id,
          metadata: {
            task_id: task.task_id,
            room_id: task.room_id,
            status: task.status,
            revision: task.revision,
            ...metadata,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(task.room_id), eventKey }, at),
    ],
  };
}

function inboxTaskEvent(
  db: D1Database,
  actor: string,
  eventKey: string,
  eventType: string,
  task: TaskRow,
  assignment: TaskAssignmentRow | null,
  cardMessageId: string,
  at: number,
  pendingDelta: number,
  extra: Record<string, unknown> = {},
): D1PreparedStatement[] {
  return [
    eventStatement(
      db,
      {
        eventKey,
        scopeKind: 'inbox',
        scopeId: actor,
        eventType,
        refId: task.task_id,
        metadata: {
          task_id: task.task_id,
          room_id: task.room_id,
          message_id: cardMessageId,
          reviewer_actor_id: task.reviewer_actor_id,
          changed_by: task.created_by,
          ...(assignment
            ? {
                assignment_id: assignment.assignment_id,
                assignment_version: assignment.assignment_version,
              }
            : {}),
          ...extra,
        },
      },
      at,
    ),
    outboxStatement(db, { topic: inboxTopic(actor), eventKey }, at),
    inboxHeadStatement(db, actor, eventKey, at, pendingDelta),
  ];
}

function offerDeliveryStatements(
  db: D1Database,
  input: {
    deliveryId: string;
    recipientId: string;
    roomId: string;
    cardMessageId: string;
    cardEventKey: string;
    senderId: string;
    task: TaskRow;
    assignment: TaskAssignmentRow;
    at: number;
  },
): D1PreparedStatement[] {
  const inboxKey = `inbox:${input.recipientId}:${input.cardMessageId}`;
  return [
    db
      .prepare(
        `INSERT INTO deliveries
           (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
            progress_at, result_message_id, error, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL,
           (SELECT event_seq FROM events WHERE event_key = ?), ?, ?)`,
      )
      .bind(
        input.deliveryId,
        input.recipientId,
        input.cardMessageId,
        input.roomId,
        input.cardEventKey,
        input.at,
        input.at,
      ),
    db
      .prepare(
        `INSERT INTO task_deliveries
           (delivery_id, task_id, assignment_id, assignment_version, task_revision, kind, created_at)
         VALUES (?, ?, ?, ?, ?, 'task_offer', ?)`,
      )
      .bind(
        input.deliveryId,
        input.task.task_id,
        input.assignment.assignment_id,
        input.assignment.assignment_version,
        input.task.revision,
        input.at,
      ),
    eventStatement(
      db,
      {
        eventKey: inboxKey,
        scopeKind: 'inbox',
        scopeId: input.recipientId,
        eventType: 'delivery_created',
        refId: input.deliveryId,
        metadata: {
          message_id: input.cardMessageId,
          room_id: input.roomId,
          sender_id: input.senderId,
          task_id: input.task.task_id,
          assignment_id: input.assignment.assignment_id,
          assignment_version: input.assignment.assignment_version,
        },
      },
      input.at,
    ),
    outboxStatement(db, { topic: inboxTopic(input.recipientId), eventKey: inboxKey }, input.at),
    inboxHeadStatement(db, input.recipientId, inboxKey, input.at, 1),
  ];
}

/**
 * 拒绝 offer 时关闭该 assignment 仍有效的投递。
 *
 * 拒绝由候选人自己发起，因此只写状态事件与 pending_count，不再向本人发
 * `inbox:{actor}` outbox，避免自我唤醒；`reason` 保留在事件元数据中作为审计。
 */
async function closeOfferDeliveries(
  db: D1Database,
  assignment: TaskAssignmentRow,
  task: TaskRow,
  actor: string,
  reason: string,
  requestId: string,
  at: number,
): Promise<{ statements: D1PreparedStatement[]; deliveryIds: string[] }> {
  const rows = await db
    .prepare(
      `SELECT * FROM task_deliveries
        WHERE assignment_id = ? AND kind = 'task_offer'`,
    )
    .bind(assignment.assignment_id)
    .all<TaskDeliveryRow>();
  const statements: D1PreparedStatement[] = [];
  const deliveryIds: string[] = [];
  for (const row of rows.results) {
    const delivery = await getDelivery(db, row.delivery_id);
    if (!delivery) continue;
    deliveryIds.push(delivery.delivery_id);
    if (delivery.state !== 'pending' && delivery.state !== 'claimed') continue;
    const inboxKey = `decline:${delivery.delivery_id}:${requestId}`;
    statements.push(
      db
        .prepare(
          `UPDATE actors
              SET pending_count = pending_count - (
                    SELECT CASE WHEN state = 'pending' THEN 1 ELSE 0 END
                      FROM deliveries WHERE delivery_id = ?
                  ),
                  updated_at = ?
            WHERE actor_id = ?`,
        )
        .bind(delivery.delivery_id, at, delivery.recipient_id),
      db
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', error = ?, updated_at = ?
            WHERE delivery_id = ? AND state IN ('pending', 'claimed')`,
        )
        .bind(reason, at, delivery.delivery_id),
      eventStatement(
        db,
        {
          eventKey: inboxKey,
          scopeKind: 'inbox',
          scopeId: delivery.recipient_id,
          eventType: 'delivery_cancelled',
          refId: delivery.delivery_id,
          metadata: {
            reason,
            actor_id: actor,
            room_id: delivery.room_id,
            message_id: delivery.message_id,
            sender_id: task.created_by,
            task_id: task.task_id,
            assignment_id: assignment.assignment_id,
          },
        },
        at,
      ),
      inboxHeadStatement(db, delivery.recipient_id, inboxKey, at, 0),
    );
  }
  return { statements, deliveryIds };
}

async function taskDeliveryIds(db: D1Database, taskId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT delivery_id FROM task_deliveries
        WHERE task_id = ? ORDER BY created_at ASC, delivery_id ASC`,
    )
    .bind(taskId)
    .all<{ delivery_id: string }>();
  return rows.results.map((row) => row.delivery_id);
}

async function validateAttachments(
  db: D1Database,
  room: RoomRow,
  fileIds: string[] | undefined,
): Promise<Array<{ file_id: string; label: string }>> {  const unique = Array.from(new Set(fileIds ?? []));
  if (unique.length > LIMITS.taskAttachmentsMax) {
    throw invalid('附件', `一次最多引用 ${LIMITS.taskAttachmentsMax} 个文件`);
  }
  const attachments: Array<{ file_id: string; label: string }> = [];
  for (const fileId of unique) {
    const file = await getRoomFile(db, fileId);
    if (!file || file.room_id !== room.room_id || file.deleted_at !== null) {
      throw new BusinessError('FILE_UNAVAILABLE', '附件不存在、已删除或不属于该房间', {
        file_id: fileId,
      });
    }
    attachments.push({ file_id: fileId, label: '' });
  }
  return attachments;
}

/**
 * 任务附件引用。
 *
 * 附件只保存 file_id，但必须同时建立 `file_references` 并把文件置为
 * retained，否则房间文件 30 天 TTL 或维护 GC 会在任务仍存在时回收字节。
 * 引用在任务删除且无其他引用后由 `maintainFiles` 释放并恢复普通 TTL。
 */
function taskAttachmentStatements(
  db: D1Database,
  input: {
    taskId: string;
    roomId: string;
    caller: string;
    attachments: Array<{ file_id: string; label: string }>;
    at: number;
  },
): D1PreparedStatement[] {
  return input.attachments.flatMap((attachment) => [
    db
      .prepare(
        guardSql(
          'fileUnavailable',
          `NOT EXISTS (
             SELECT 1 FROM room_files
              WHERE file_id = ? AND room_id = ? AND deleted_at IS NULL
           ) OR EXISTS (
             SELECT 1 FROM drive_files WHERE file_id = ? AND state = 'deleted'
           )`,
        ),
      )
      .bind(attachment.file_id, input.roomId, attachment.file_id),
    db
      .prepare(
        `INSERT INTO file_references
           (reference_id, file_id, kind, ref_id, room_id, actor_id, state, created_at,
            released_at, released_by)
         VALUES (?, ?, 'task', ?, ?, ?, 'active', ?, NULL, NULL)
         ON CONFLICT(kind, ref_id, file_id) DO UPDATE SET
           state = 'active', released_at = NULL, released_by = NULL`,
      )
      .bind(
        newId('ref'),
        attachment.file_id,
        input.taskId,
        input.roomId,
        input.caller,
        input.at,
      ),
    db
      .prepare(
        `INSERT INTO task_attachments (task_id, file_id, label, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.taskId, attachment.file_id, attachment.label, input.at),
    db
      .prepare('UPDATE room_files SET retained = 1 WHERE file_id = ? AND deleted_at IS NULL')
      .bind(attachment.file_id),
    db
      .prepare(
        `UPDATE drive_files SET retained = 1, expires_at = NULL
          WHERE file_id = ? AND state != 'deleted'`,
      )
      .bind(attachment.file_id),
  ]);
}

/**
 * 创建时负责人。
 *
 * 新任务直接读 `tasks.initial_assignee_actor_id`；0030 之前的旧行该列为
 * NULL，只有在 assignment 可证明由创建事务产生时才兼容推断，绝不使用后续
 * claim/offer 产生的最早 assignment。
 */
async function createdAssigneeOf(
  db: D1Database,
  task: TaskRow,
): Promise<string | null> {
  if (task.initial_assignee_actor_id !== null) return task.initial_assignee_actor_id;
  const legacy = await db
    .prepare(
      `SELECT owner_actor_id FROM task_assignments
        WHERE task_id = ? AND assignment_version = 1
          AND created_at = ? AND offered_by = ?
        LIMIT 1`,
    )
    .bind(task.task_id, task.created_at, task.created_by)
    .first<{ owner_actor_id: string }>();
  return legacy?.owner_actor_id ?? null;
}

/** 同一来源消息的并发/重复创建收敛到已有任务；任一语义参数不同都返回冲突。 */
async function convergeSourceTask(
  db: D1Database,
  context: TaskContext,
  existing: TaskRow,
  expected: {
    title: string;
    description: string;
    acceptance: string;
    dueAt: number | null;
    attachments: string[];
    reviewer: string;
    assignee: string | null;
  },
): Promise<TaskResult> {
  const existingAttachments = (await attachmentsFor(db, existing.task_id))
    .map((attachment) => attachment.file_id)
    .sort();
  const expectedAttachments = [...expected.attachments].sort();
  const sameAttachments =
    existingAttachments.length === expectedAttachments.length &&
    existingAttachments.every((fileId, index) => fileId === expectedAttachments[index]);
  // 只比较创建时的负责人；后续领取、重派、接受不会改变创建语义。
  const originalAssignee = await createdAssigneeOf(db, existing);
  if (
    existing.room_id !== context.room.room_id ||
    existing.created_by !== context.caller ||
    existing.title !== expected.title ||
    existing.description !== expected.description ||
    existing.acceptance_criteria !== expected.acceptance ||
    existing.due_at !== expected.dueAt ||
    existing.reviewer_actor_id !== expected.reviewer ||
    originalAssignee !== expected.assignee ||
    !sameAttachments
  ) {
    throw new BusinessError('CONFLICT', '该消息已关联另一个任务，或创建参数与已有任务不一致', {
      task_id: existing.task_id,
      source_message_id: existing.source_message_id,
    });
  }
  return resultFor(db, context, existing);
}

export async function taskCreate(
  db: D1Database,
  principal: Principal,
  input: TaskCreateInput,
): Promise<TaskResult> {
  const { caller, room, member, boundary } = await requireRoomMember(db, principal, input.room_id);
  const capabilities = roomCapabilitiesFor(room, member);
  if (!capabilities.create_task) {
    throw new BusinessError('PERMISSION_DENIED', '当前身份没有创建任务的权限');
  }
  const title = normalizeTaskTitle(input.title);
  const description = normalizeTaskBody(
    input.description,
    '任务详细目标',
    LIMITS.taskDescriptionBytes,
  );
  const acceptance = normalizeTaskBody(
    input.acceptance_criteria,
    '验收条件',
    LIMITS.taskAcceptanceBytes,
  );
  const reviewerId = input.reviewer_actor_id ?? caller;
  const assigneeId = input.assignee_actor_id ?? null;
  if (reviewerId === assigneeId && assigneeId !== null) {
    throw invalid('验收人', '不能与当前负责人相同；执行者不能验收自己的交付');
  }
  if (assigneeId === caller && reviewerId === caller) {
    throw invalid('验收人', '自己执行任务时必须指定独立验收人');
  }
  const reviewer = await assertTaskParticipant(db, room, reviewerId, '验收人');
  void reviewer;
  let assignee: ActorRow | null = null;
  if (assigneeId) {
    assignee = await assertTaskParticipant(db, room, assigneeId, '候选负责人');
    if (await blockedBetween(db, caller, assigneeId)) {
      throw new BusinessError('BLOCKED', '对方已拉黑，不能直接指派任务');
    }
    if (reviewerId !== caller && (await blockedBetween(db, reviewerId, assigneeId))) {
      throw new BusinessError('BLOCKED', '验收人与候选负责人之间存在拉黑关系');
    }
  }

  let source: MessageRow | null = null;
  if (input.source_message_id) {
    source = await getMessage(db, input.source_message_id);
    if (
      !source ||
      source.room_id !== room.room_id ||
      !visibleMessage(source, boundary)
    ) {
      throw new BusinessError('NOT_FOUND', '来源消息不存在或当前不可见');
    }
  }
  const dueAt = parseDueAt(input.due_at);
  const attachments = await validateAttachments(db, room, input.attachment_file_ids);
  const payloadHash = await sha256Hex(
    stableStringify({
      room_id: room.room_id,
      title,
      description,
      acceptance_criteria: acceptance,
      source_message_id: source?.message_id ?? null,
      assignee_actor_id: assigneeId,
      reviewer_actor_id: reviewerId,
      due_at: dueAt,
      attachment_file_ids: attachments.map((item) => item.file_id),
    }),
  );
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;

  const context: TaskContext = {
    caller,
    callerKind: principal.actor?.kind ?? 'human',
    room,
    member,
    boundary,
  };
  if (source) {
    const existing = await getTaskBySourceMessage(db, source.message_id);
    if (existing) {
      return convergeSourceTask(db, context, existing, {
        title,
        description,
        acceptance,
        dueAt,
        attachments: attachments.map((item) => item.file_id),
        reviewer: reviewerId,
        assignee: assigneeId,
      });
    }
  }

  const at = nowMs();
  const taskId = newId('tsk');
  const cardMessageId = newId('msg');
  const cardEventKey = `message:${cardMessageId}`;
  const assignmentId = assigneeId ? newId('asg') : null;
  const recipientKind = assignee?.kind ?? null;
  const deliveryId =
    assigneeId && recipientKind === 'agent' && assigneeId !== caller ? newId('dlv') : null;
  const cardBody = `【任务卡】${title}`;
  const rootId = source ? (source.root_id ?? source.message_id) : null;
  const cardCore: MessageCore = {
    messageId: cardMessageId,
    roomId: room.room_id,
    senderId: caller,
    clientMessageId: `taskcard_${taskId}`,
    body: cardBody,
    preview: truncateUtf8(cardBody, LIMITS.previewBytes),
    bodyBytes: utf8Bytes(cardBody),
    replyTo: source?.message_id ?? null,
    rootId,
    rootKey: rootId ?? cardMessageId,
    hop: source ? source.hop + 1 : 0,
    invoke: [],
    mentionAll: false,
    mentions: [],
    reminders: [],
    deliveries: [],
    eventKey: cardEventKey,
    at,
  };
  const task: TaskRow = {
    task_id: taskId,
    room_id: room.room_id,
    created_by: caller,
    source_message_id: source?.message_id ?? null,
    title,
    description,
    acceptance_criteria: acceptance,
    status: assigneeId ? 'offered' : 'unassigned',
    revision: 1,
    owner_actor_id: null,
    current_assignment_id: assignmentId,
    initial_assignee_actor_id: assigneeId,
    reviewer_actor_id: reviewerId,
    due_at: dueAt,
    blocked_reason: null,
    blocked_at: null,
    last_progress_at: null,
    business_authority: 'native',
    external_binding_id: null,
    created_at: at,
    updated_at: at,
    accepted_at: null,
    cancelled_at: null,
  };
  const assignment: TaskAssignmentRow | null =
    assigneeId && assignmentId
      ? {
          assignment_id: assignmentId,
          task_id: taskId,
          assignment_version: 1,
          owner_actor_id: assigneeId,
          status: 'offered',
          offered_by: caller,
          offer_expires_at: at + LIMITS.taskOfferTtlMs,
          accepted_at: null,
          ended_at: null,
          last_progress_at: null,
          delivery_id: deliveryId,
          created_at: at,
          updated_at: at,
        }
      : null;
  const names = await actorNames(db, [
    caller,
    reviewerId,
    ...(assigneeId ? [assigneeId] : []),
  ]);
  const view = await viewFromKnownRow(db, context, task, cardMessageId, assignment, deliveryId ? [deliveryId] : [], attachments, names);
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(boundary),
  };

  const createdEvent = taskRoomEvent(db, task, 'task_created', `task:created:${taskId}`, at, {
    changed_by: caller,
    card_message_id: cardMessageId,
    source_message_id: source?.message_id ?? null,
    reviewer_actor_id: reviewerId,
    owner_actor_id: null,
  });

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      capabilityGuardStatement(db, room.room_id, caller, 'create_task'),
      participantGuard(db, room.room_id, reviewerId),
      ...(assigneeId ? [participantGuard(db, room.room_id, assigneeId)] : []),
      ...(assigneeId ? [contactBlockGuardStatement(db, caller, assigneeId)] : []),
      ...(assigneeId && reviewerId !== caller
        ? [contactBlockGuardStatement(db, reviewerId, assigneeId)]
        : []),
      ...messageCoreStatements(db, cardCore),
      db
        .prepare(
          `INSERT INTO tasks
             (task_id, room_id, created_by, source_message_id, title, description,
              acceptance_criteria, status, revision, owner_actor_id, current_assignment_id,
              initial_assignee_actor_id, reviewer_actor_id, due_at, blocked_reason, blocked_at,
              last_progress_at, business_authority, external_binding_id, created_at, updated_at,
              accepted_at, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, NULL, NULL, NULL,
             'native', NULL, ?, ?, NULL, NULL)`,
        )
        .bind(
          taskId,
          room.room_id,
          caller,
          source?.message_id ?? null,
          title,
          description,
          acceptance,
          task.status,
          assignmentId,
          assigneeId,
          reviewerId,
          dueAt,
          at,
          at,
        ),
      db
        .prepare(
          `INSERT INTO task_cards (task_id, message_id, room_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(taskId, cardMessageId, room.room_id, at),
      ...(assignment
        ? [
            db
              .prepare(
                `INSERT INTO task_assignments
                   (assignment_id, task_id, assignment_version, owner_actor_id, status,
                    offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
                    delivery_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'offered', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
              )
              .bind(
                assignment.assignment_id,
                taskId,
                assignment.assignment_version,
                assignment.owner_actor_id,
                caller,
                assignment.offer_expires_at,
                deliveryId,
                at,
                at,
              ),
          ]
        : []),
      ...(deliveryId && assignment
        ? offerDeliveryStatements(db, {
            deliveryId,
            recipientId: assignment.owner_actor_id,
            roomId: room.room_id,
            cardMessageId,
            cardEventKey,
            senderId: caller,
            task,
            assignment,
            at,
          })
        : []),
      ...taskAttachmentStatements(db, {
        taskId,
        roomId: room.room_id,
        caller,
        attachments,
        at,
      }),
      ...createdEvent.statements,
      ...(assignment
        ? taskRoomEvent(
            db,
            task,
            'task_offered',
            `task:offered:${assignment.assignment_id}`,
            at,
            {
              changed_by: caller,
              assignment_id: assignment.assignment_id,
              assignment_version: assignment.assignment_version,
              owner_actor_id: assignment.owner_actor_id,
            },
          ).statements
        : []),
      ...(assignment && recipientKind === 'human' && assignment.owner_actor_id !== caller
        ? inboxTaskEvent(
            db,
            assignment.owner_actor_id,
            `task:offer:${assignment.assignment_id}`,
            'task_offered',
            task,
            assignment,
            cardMessageId,
            at,
            0,
          )
        : []),
    ],
    onUniqueConflict: async (error) => {
      const text = String(error);
      if (
        !text.includes('UNIQUE constraint failed: tasks.source_message_id') &&
        !text.includes('idx_tasks_source_message')
      ) {
        return undefined;
      }
      if (!source) return undefined;
      const existing = await getTaskBySourceMessage(db, source.message_id);
      if (!existing) return undefined;
      return convergeSourceTask(db, context, existing, {
        title,
        description,
        acceptance,
        dueAt,
        attachments: attachments.map((item) => item.file_id),
        reviewer: reviewerId,
        assignee: assigneeId,
      });
    },
  });
  return result;
}

/** 已知新任务行时构造视图；只为返回结果，不重新查询任务本身。 */
async function viewFromKnownRow(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  cardMessageId: string,
  assignment: TaskAssignmentRow | null,
  deliveryIds: string[],
  attachments: Array<{ file_id: string; label: string }>,
  names: Map<string, string>,
  progress: TaskProgressView | null = null,
): Promise<TaskView> {
  const isAdmin = isOwnerOrAdmin(context.room, context.member);
  const canCancel =
    task.status !== 'accepted' &&
    task.status !== 'cancelled' &&
    task.status !== 'legacy_completed' &&
    (task.created_by === context.caller ||
      task.owner_actor_id === context.caller ||
      isAdmin);
  const canActOnOffer =
    task.status === 'offered' &&
    assignment !== null &&
    assignment.status === 'offered' &&
    assignment.owner_actor_id === context.caller &&
    (assignment.offer_expires_at === null || assignment.offer_expires_at > nowMs());
  return {
    task_id: task.task_id,
    room_id: task.room_id,
    title: task.title,
    description: task.description,
    acceptance_criteria: task.acceptance_criteria,
    status: task.status,
    status_label: TASK_STATUS_LABELS[task.status],
    status_hint: TASK_STATUS_HINTS[task.status],
    phase: taskPhaseOf(task.status),
    phase_label: TASK_PHASE_LABELS[taskPhaseOf(task.status)],
    revision: task.revision,
    source_message_id: task.source_message_id,
    card_message_id: cardMessageId,
    created_by: task.created_by,
    created_by_name: names.get(task.created_by) ?? '',
    owner_actor_id: task.owner_actor_id,
    owner_name: task.owner_actor_id
      ? (names.get(task.owner_actor_id) ?? null)
      : null,
    reviewer_actor_id: task.reviewer_actor_id,
    reviewer_name: names.get(task.reviewer_actor_id) ?? '',
    due_at: task.due_at === null ? null : String(task.due_at),
    blocked_reason: task.blocked_reason,
    blocked_at: task.blocked_at === null ? null : String(task.blocked_at),
    last_progress_at:
      task.last_progress_at === null ? null : String(task.last_progress_at),
    progress,
    business_authority: task.business_authority,
    external_binding_id: task.external_binding_id,
    created_at: String(task.created_at),
    updated_at: String(task.updated_at),
    accepted_at: task.accepted_at === null ? null : String(task.accepted_at),
    cancelled_at: task.cancelled_at === null ? null : String(task.cancelled_at),
    assignment:
      assignment === null
        ? null
        : {
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
            owner_actor_id: assignment.owner_actor_id,
            owner_name: names.get(assignment.owner_actor_id) ?? null,
            status: assignment.status,
            offer_expires_at:
              assignment.offer_expires_at === null
                ? null
                : String(assignment.offer_expires_at),
            delivery_id: assignment.delivery_id,
          },
    delivery_ids: deliveryIds,
    attachments,
    can_offer:
      task.status === 'unassigned' &&
      canDispatch(task, context) &&
      roomCapabilitiesFor(context.room, context.member).create_task,
    can_claim:
      task.status === 'unassigned' &&
      task.reviewer_actor_id !== context.caller,
    can_cancel: canCancel,
    can_accept: canActOnOffer,
    can_decline: canActOnOffer,
    can_report_progress:
      task.status === 'in_progress' && task.owner_actor_id === context.caller,
    can_block:
      task.status === 'in_progress' && task.owner_actor_id === context.caller,
    can_resume:
      task.status === 'blocked' && task.owner_actor_id === context.caller,
  };
}

export async function taskGet(
  db: D1Database,
  principal: Principal,
  input: TaskGetInput,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  return resultFor(db, context, task, undefined, true);
}

export async function taskList(
  db: D1Database,
  principal: Principal,
  input: TaskListInput,
): Promise<TaskListResult> {
  const caller = actorId(principal);
  const limit = Math.min(input.limit ?? LIMITS.taskListDefault, LIMITS.taskListMax);
  if (input.scope === 'mine') {
    const filters = input.status ? 'AND t.status = ?' : '';
    const binds: unknown[] = [caller];
    if (input.status) binds.push(input.status);
    if (input.room_id) binds.push(input.room_id);
    // 五个位置参数按 SQL 出现顺序：创建者、负责人、验收人、offer/active 负责人、limit。
    binds.push(caller, caller, caller, caller, limit);
    const rows = await db
      .prepare(
        `SELECT t.* FROM tasks t
           JOIN room_members m
             ON m.room_id = t.room_id AND m.actor_id = ? AND m.status = 'active'
           JOIN rooms r ON r.room_id = t.room_id
          WHERE (r.kind = 'direct' OR r.member_history_policy = 'full' OR t.created_at >= m.joined_at)
            ${filters}
            ${input.room_id ? 'AND t.room_id = ?' : ''}
            AND (t.created_by = ? OR t.owner_actor_id = ? OR t.reviewer_actor_id = ?
                 OR EXISTS (
                   SELECT 1 FROM task_assignments a
                    WHERE a.task_id = t.task_id AND a.owner_actor_id = ?
                      AND a.status IN ('offered','active')
                 ))
          ORDER BY t.updated_at DESC, t.task_id DESC
          LIMIT ?`,
      )
      .bind(...binds)
      .all<TaskRow>();
    const tasks: TaskView[] = [];
    for (const task of rows.results) {
      const room = await getRoom(db, task.room_id);
      if (!room) continue;
      const member = await getMember(db, room.room_id, caller);
      if (!member || member.status !== 'active') continue;
      const boundary = historyBoundary(room, member);
      tasks.push(
        await buildTaskView(db, {
          caller,
          callerKind: principal.actor?.kind ?? 'human',
          room,
          member,
          boundary,
        }, task),
      );
    }
    return { tasks, next_cursor: null, has_more: false, authorization: null };
  }

  if (!input.room_id) {
    throw new BusinessError('INVALID_ARGUMENT', 'room_id 与 scope=mine 至少提供一个');
  }
  const { caller: roomCaller, room, member, boundary } = await requireRoomMember(
    db,
    principal,
    input.room_id,
  );
  const filters: string[] = [];
  const binds: unknown[] = [room.room_id];
  if (input.status) {
    filters.push('AND status = ?');
    binds.push(input.status);
  }
  if (!boundary.full) {
    filters.push('AND created_at >= ?');
    binds.push(boundary.fromAt);
  }
  binds.push(limit);
  const rows = await db
    .prepare(
      `SELECT * FROM tasks
        WHERE room_id = ? ${filters.join(' ')}
        ORDER BY updated_at DESC, task_id DESC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<TaskRow>();
  const context: TaskContext = {
    caller: roomCaller,
    callerKind: principal.actor?.kind ?? 'human',
    room,
    member,
    boundary,
  };
  const assignmentIds = rows.results
    .map((task) => task.current_assignment_id)
    .filter((value): value is string => value !== null);
  const assignmentOwners =
    assignmentIds.length === 0
      ? []
      : (
          await db
            .prepare(
              `SELECT owner_actor_id FROM task_assignments
                WHERE assignment_id IN (${assignmentIds.map(() => '?').join(', ')})`,
            )
            .bind(...assignmentIds)
            .all<{ owner_actor_id: string }>()
        ).results.map((row) => row.owner_actor_id);
  const progressRows = await latestProgressRows(
    db,
    rows.results.map((task) => task.task_id),
  );
  const progressActors = Array.from(progressRows.values()).map((row) => row.actor_id);
  const names = await actorNames(
    db,
    [
      ...rows.results.flatMap((task) => [
        task.created_by,
        task.reviewer_actor_id,
        ...(task.owner_actor_id ? [task.owner_actor_id] : []),
      ]),
      ...assignmentOwners,
      ...progressActors,
    ],
  );
  const tasks = await Promise.all(
    rows.results.map((task) =>
      buildTaskView(db, context, task, names, { progress: progressRows }),
    ),
  );
  return {
    tasks,
    next_cursor: null,
    has_more: false,
    authorization: historySnapshot(boundary),
  };
}

export async function taskOffer(
  db: D1Database,
  principal: Principal,
  input: TaskOfferInput,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      assignee_actor_id: input.assignee_actor_id,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;
  if (!canDispatch(task, context)) {
    throw new BusinessError('PERMISSION_DENIED', '只有创建者、群 owner 或管理员可以派发任务');
  }
  if (task.status !== 'unassigned') {
    throw new BusinessError('CONFLICT', '只有未指派任务可以发起 offer', {
      task_id: task.task_id,
      status: task.status,
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      actual: task.revision,
    });
  }
  if (input.assignee_actor_id === task.reviewer_actor_id) {
    throw invalid('候选负责人', '不能是当前验收人；执行者不能验收自己的交付');
  }
  const candidate = await assertTaskParticipant(
    db,
    context.room,
    input.assignee_actor_id,
    '候选负责人',
    task.created_at,
  );
  if (await blockedBetween(db, context.caller, input.assignee_actor_id)) {
    throw new BusinessError('BLOCKED', '对方已拉黑，不能派发任务');
  }
  if (
    task.created_by !== context.caller &&
    (await blockedBetween(db, task.created_by, input.assignee_actor_id))
  ) {
    throw new BusinessError('BLOCKED', '任务创建者与候选负责人之间存在拉黑关系');
  }
  if (
    task.reviewer_actor_id !== context.caller &&
    (await blockedBetween(db, task.reviewer_actor_id, input.assignee_actor_id))
  ) {
    throw new BusinessError('BLOCKED', '验收人与候选负责人之间存在拉黑关系');
  }
  const card = await getTaskCard(db, task.task_id);
  if (!card) throw new BusinessError('CONFLICT', '任务卡片不存在，不能派发');
  const canDeliver = candidate.kind === 'agent' && candidate.actor_id !== context.caller;
  // `deliveries` 以 (recipient_id, message_id) 唯一。同一候选再次被指派时，
  // 旧卡片上的 cancelled 投递仍占用该唯一键，必须换一张新卡片与新投递。
  const priorDelivery = canDeliver
    ? await db
        .prepare(
          'SELECT 1 AS n FROM deliveries WHERE recipient_id = ? AND message_id = ? LIMIT 1',
        )
        .bind(candidate.actor_id, card.message_id)
        .first<{ n: number }>()
    : null;
  const needsNewCard = Boolean(priorDelivery);

  const at = nowMs();
  const assignmentId = newId('asg');
  const deliveryId = canDeliver ? newId('dlv') : null;
  const offerCardMessageId = needsNewCard ? newId('msg') : card.message_id;
  const offerCardEventKey = `message:${offerCardMessageId}`;
  const nextRevision = task.revision + 1;
  const versionRow = await db
    .prepare(
      'SELECT COALESCE(MAX(assignment_version), 0) + 1 AS version FROM task_assignments WHERE task_id = ?',
    )
    .bind(task.task_id)
    .first<{ version: number }>();
  const assignmentVersion = versionRow?.version ?? 1;
  const assignment: TaskAssignmentRow = {
    assignment_id: assignmentId,
    task_id: task.task_id,
    assignment_version: assignmentVersion,
    owner_actor_id: candidate.actor_id,
    status: 'offered',
    offered_by: context.caller,
    offer_expires_at: at + LIMITS.taskOfferTtlMs,
    accepted_at: null,
    ended_at: null,
    last_progress_at: null,
    delivery_id: deliveryId,
    created_at: at,
    updated_at: at,
  };
  const updated: TaskRow = {
    ...task,
    status: 'offered',
    current_assignment_id: assignmentId,
    revision: nextRevision,
    updated_at: at,
  };
  const cardBody = `【任务卡】${task.title}`;
  const newCardCore: MessageCore | null = needsNewCard
    ? {
        messageId: offerCardMessageId,
        roomId: task.room_id,
        senderId: context.caller,
        clientMessageId: `taskcard_${assignmentId}`,
        body: cardBody,
        preview: truncateUtf8(cardBody, LIMITS.previewBytes),
        bodyBytes: utf8Bytes(cardBody),
        replyTo: null,
        rootId: null,
        rootKey: offerCardMessageId,
        hop: 0,
        invoke: [],
        mentionAll: false,
        mentions: [],
        reminders: [],
        deliveries: [],
        eventKey: offerCardEventKey,
        at,
      }
    : null;
  const names = await actorNames(db, [
    context.caller,
    task.reviewer_actor_id,
    candidate.actor_id,
  ]);
  const view = await viewFromKnownRow(
    db,
    context,
    updated,
    offerCardMessageId,
    assignment,
    deliveryId ? [deliveryId] : [],
    [],
    names,
  );
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(context.boundary),
  };

  await runIdempotent(db, {
    actorId: context.caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, context.room.room_id, context.caller),
      taskStateGuard(db, task.task_id, 'status = ? AND revision = ?', 'unassigned', task.revision),
      db
        .prepare(
          guardSql(
            'taskState',
            "EXISTS (SELECT 1 FROM task_assignments WHERE task_id = ? AND status IN ('offered','active'))",
          ),
        )
        .bind(task.task_id),
      participantGuard(db, context.room.room_id, candidate.actor_id),
      contactBlockGuardStatement(db, context.caller, candidate.actor_id),
      ...(task.created_by !== context.caller
        ? [contactBlockGuardStatement(db, task.created_by, candidate.actor_id)]
        : []),
      ...(task.reviewer_actor_id !== context.caller
        ? [contactBlockGuardStatement(db, task.reviewer_actor_id, candidate.actor_id)]
        : []),
      db
        .prepare(
          `UPDATE tasks
              SET status = 'offered', current_assignment_id = ?, revision = revision + 1,
                  updated_at = ?
            WHERE task_id = ? AND status = 'unassigned' AND revision = ?`,
        )
        .bind(assignmentId, at, task.task_id, task.revision),
      db
        .prepare(
          `INSERT INTO task_assignments
             (assignment_id, task_id, assignment_version, owner_actor_id, status,
              offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
              delivery_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'offered', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .bind(
          assignmentId,
          task.task_id,
          assignmentVersion,
          candidate.actor_id,
          context.caller,
          assignment.offer_expires_at,
          deliveryId,
          at,
          at,
        ),
      ...(newCardCore
        ? [
            ...messageCoreStatements(db, newCardCore),
            db
              .prepare(
                `UPDATE task_cards SET message_id = ?, created_at = ?
                  WHERE task_id = ?`,
              )
              .bind(offerCardMessageId, at, task.task_id),
          ]
        : []),
      ...(deliveryId
        ? offerDeliveryStatements(db, {
            deliveryId,
            recipientId: candidate.actor_id,
            roomId: task.room_id,
            cardMessageId: offerCardMessageId,
            cardEventKey: offerCardEventKey,
            senderId: task.created_by,
            task: updated,
            assignment,
            at,
          })
        : []),
      ...taskRoomEvent(
        db,
        updated,
        'task_offered',
        `task:offered:${assignmentId}`,
        at,
        {
          changed_by: context.caller,
          assignment_id: assignmentId,
          assignment_version: assignmentVersion,
          owner_actor_id: candidate.actor_id,
        },
      ).statements,
      ...(candidate.kind === 'human' && candidate.actor_id !== context.caller
        ? inboxTaskEvent(
            db,
            candidate.actor_id,
            `task:offer:${assignmentId}`,
            'task_offered',
            updated,
            assignment,
            offerCardMessageId,
            at,
            0,
          )
        : []),
    ],
    onUniqueConflict: async (error) => {
      const text = String(error);
      if (
        text.includes('idx_task_assignments_current') ||
        text.includes('idx_task_deliveries_assignment_kind') ||
        text.includes('UNIQUE constraint failed: task_assignments.task_id') ||
        text.includes('UNIQUE constraint failed: deliveries.recipient_id, deliveries.message_id')
      ) {
        throw new BusinessError('CONFLICT', '该任务已被派发或该卡片已向该 Agent 派发过', {
          task_id: task.task_id,
        });
      }
      return undefined;
    },
  });
  return result;
}

/**
 * 接受指定 offer：原子把 `offered` 转为 `in_progress`。
 *
 * 只接受当前 assignment 的候选人；`expected_revision`、assignment 状态与
 * offer 有效期都在事务内再次校验。接受不完成 delivery：通知处理完成不是
 * 任务验收，也不是任务状态变化的替代品。
 */
export async function taskAccept(
  db: D1Database,
  principal: Principal,
  input: TaskAcceptInput,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      assignment_id: input.assignment_id ?? null,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;

  if (task.status !== 'offered' || task.current_assignment_id === null) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '任务已不是待接手状态',
    );
  }
  const assignment = await getTaskAssignment(db, task.current_assignment_id);
  if (!assignment || assignment.status !== 'offered') {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '当前接手邀请已失效');
  }
  if (input.assignment_id !== undefined && input.assignment_id !== assignment.assignment_id) {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '接手邀请版本已变化');
  }
  if (assignment.owner_actor_id !== context.caller) {
    throw new BusinessError(
      'PERMISSION_DENIED',
      '只有当前被指派候选者可以接受任务',
      await actualTaskState(db, task.task_id),
    );
  }
  if (task.reviewer_actor_id === context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '验收人不能接受自己验收的任务', {
      task_id: task.task_id,
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const at = nowMs();
  if (assignment.offer_expires_at !== null && assignment.offer_expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '接手邀请已过期', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (await blockedBetween(db, context.caller, task.created_by)) {
    throw new BusinessError('BLOCKED', '对方已拉黑，不能接受该任务');
  }

  const updated: TaskRow = {
    ...task,
    status: 'in_progress',
    owner_actor_id: context.caller,
    current_assignment_id: assignment.assignment_id,
    revision: task.revision + 1,
    last_progress_at: at,
    updated_at: at,
  };
  const activeAssignment: TaskAssignmentRow = {
    ...assignment,
    status: 'active',
    accepted_at: at,
    updated_at: at,
  };
  const card = await getTaskCard(db, task.task_id);
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    context.caller,
  ]);
  const view = await viewFromKnownRow(
    db,
    context,
    updated,
    card?.message_id ?? '',
    activeAssignment,
    await taskDeliveryIds(db, task.task_id),
    await attachmentsFor(db, task.task_id),
    names,
  );
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(context.boundary),
  };

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        taskRevisionGuard(db, task.task_id, task.revision),
        taskStateGuard(
          db,
          task.task_id,
          'status = ? AND current_assignment_id = ?',
          'offered',
          assignment.assignment_id,
        ),
        assignmentOfferGuard(
          db,
          task.task_id,
          assignment.assignment_id,
          context.caller,
        ),
        offerExpiryGuard(db, assignment.assignment_id, at),
        contactBlockGuardStatement(db, context.caller, task.created_by),
        db
          .prepare(
            `UPDATE tasks
                SET status = 'in_progress', owner_actor_id = ?, current_assignment_id = ?,
                    revision = revision + 1, last_progress_at = ?, updated_at = ?
              WHERE task_id = ? AND status = 'offered' AND revision = ?
                AND current_assignment_id = ? AND owner_actor_id IS NULL`,
          )
          .bind(
            context.caller,
            assignment.assignment_id,
            at,
            at,
            task.task_id,
            task.revision,
            assignment.assignment_id,
          ),
        db
          .prepare(
            `UPDATE task_assignments
                SET status = 'active', accepted_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'offered' AND owner_actor_id = ?`,
          )
          .bind(at, at, assignment.assignment_id, context.caller),
        ...taskRoomEvent(
          db,
          updated,
          'task_offer_accepted',
          `task:offer-accepted:${assignment.assignment_id}`,
          at,
          {
            changed_by: context.caller,
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
            owner_actor_id: context.caller,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

/**
 * 拒绝指定 offer：任务回到 `unassigned`，不自动尝试其他成员。
 *
 * 拒绝不会产生新 assignment；旧 assignment 标记为 declined，关联的待接手
 * delivery 关闭并同步 `pending_count`。原因只进入事件审计，不复制到消息。
 */
export async function taskDecline(
  db: D1Database,
  principal: Principal,
  input: TaskDeclineInput,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const reason = normalizeDeclineReason(input.reason);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      assignment_id: input.assignment_id ?? null,
      expected_revision: input.expected_revision ?? null,
      reason,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;

  if (task.status !== 'offered' || task.current_assignment_id === null) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '任务已不是待接手状态',
    );
  }
  const assignment = await getTaskAssignment(db, task.current_assignment_id);
  if (!assignment || assignment.status !== 'offered') {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '当前接手邀请已失效');
  }
  if (input.assignment_id !== undefined && input.assignment_id !== assignment.assignment_id) {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '接手邀请版本已变化');
  }
  if (assignment.owner_actor_id !== context.caller) {
    throw new BusinessError(
      'PERMISSION_DENIED',
      '只有当前被指派候选者可以拒绝任务',
      await actualTaskState(db, task.task_id),
    );
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }

  const at = nowMs();
  const updated: TaskRow = {
    ...task,
    status: 'unassigned',
    owner_actor_id: null,
    current_assignment_id: null,
    revision: task.revision + 1,
    updated_at: at,
  };
  const declinedAssignment: TaskAssignmentRow = {
    ...assignment,
    status: 'declined',
    ended_at: at,
    updated_at: at,
  };
  const closed = await closeOfferDeliveries(
    db,
    assignment,
    task,
    context.caller,
    reason,
    input.request_id,
    at,
  );
  const card = await getTaskCard(db, task.task_id);
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    context.caller,
  ]);
  const view = await viewFromKnownRow(
    db,
    context,
    updated,
    card?.message_id ?? '',
    null,
    closed.deliveryIds,
    await attachmentsFor(db, task.task_id),
    names,
  );
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(context.boundary),
  };

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        taskRevisionGuard(db, task.task_id, task.revision),
        taskStateGuard(
          db,
          task.task_id,
          'status = ? AND current_assignment_id = ?',
          'offered',
          declinedAssignment.assignment_id,
        ),
        assignmentOfferGuard(
          db,
          task.task_id,
          declinedAssignment.assignment_id,
          context.caller,
        ),
        db
          .prepare(
            `UPDATE tasks
                SET status = 'unassigned', owner_actor_id = NULL, current_assignment_id = NULL,
                    revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND status = 'offered' AND revision = ?
                AND current_assignment_id = ? AND owner_actor_id IS NULL`,
          )
          .bind(at, task.task_id, task.revision, declinedAssignment.assignment_id),
        db
          .prepare(
            `UPDATE task_assignments
                SET status = 'declined', ended_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'offered' AND owner_actor_id = ?`,
          )
          .bind(at, at, declinedAssignment.assignment_id, context.caller),
        ...closed.statements,
        ...taskRoomEvent(
          db,
          updated,
          'task_offer_declined',
          `task:offer-declined:${declinedAssignment.assignment_id}`,
          at,
          {
            changed_by: context.caller,
            assignment_id: declinedAssignment.assignment_id,
            assignment_version: declinedAssignment.assignment_version,
            owner_actor_id: context.caller,
            reason,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskClaim(
  db: D1Database,
  principal: Principal,
  input: TaskClaimInput,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;
  // 已被他人领取时，即使请求携带的 revision 也已过期，也应归类为领取竞争；
  // VERSION_CONFLICT 只用于任务仍待领取但 revision 已变化（例如标题或指派更新）。
  if (task.status === 'in_progress' && task.owner_actor_id !== null) {
    throw new BusinessError('CLAIM_CONFLICT', '任务已被他人领取', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'unassigned') {
    throw new BusinessError('CLAIM_CONFLICT', '任务已被领取或状态已变化', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.reviewer_actor_id === context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '验收人不能领取自己验收的任务');
  }
  if (await blockedBetween(db, context.caller, task.created_by)) {
    throw new BusinessError('BLOCKED', '对方已拉黑，不能领取该任务');
  }
  const at = nowMs();
  const assignmentId = newId('asg');
  const versionRow = await db
    .prepare(
      'SELECT COALESCE(MAX(assignment_version), 0) + 1 AS version FROM task_assignments WHERE task_id = ?',
    )
    .bind(task.task_id)
    .first<{ version: number }>();
  const assignmentVersion = versionRow?.version ?? 1;
  const updated: TaskRow = {
    ...task,
    status: 'in_progress',
    owner_actor_id: context.caller,
    current_assignment_id: assignmentId,
    revision: task.revision + 1,
    last_progress_at: at,
    updated_at: at,
  };
  const assignment: TaskAssignmentRow = {
    assignment_id: assignmentId,
    task_id: task.task_id,
    assignment_version: assignmentVersion,
    owner_actor_id: context.caller,
    status: 'active',
    offered_by: context.caller,
    offer_expires_at: null,
    accepted_at: at,
    ended_at: null,
    last_progress_at: at,
    delivery_id: null,
    created_at: at,
    updated_at: at,
  };
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    context.caller,
  ]);
  const view = await viewFromKnownRow(
    db,
    context,
    updated,
    (await getTaskCard(db, task.task_id))?.message_id ?? '',
    assignment,
    [],
    [],
    names,
  );
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(context.boundary),
  };

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        // 领取竞争必须映射为 CLAIM_CONFLICT，而不是通用的任务状态 CONFLICT。
        db
          .prepare(
            guardSql(
              'claimConflict',
              "NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = ? AND status = ? AND revision = ?)",
            ),
          )
          .bind(task.task_id, 'unassigned', task.revision),
        db
          .prepare(
            guardSql(
              'taskState',
              "EXISTS (SELECT 1 FROM task_assignments WHERE task_id = ? AND status IN ('offered','active'))",
            ),
          )
          .bind(task.task_id),
        contactBlockGuardStatement(db, context.caller, task.created_by),
        db
          .prepare(
            `UPDATE tasks
                SET status = 'in_progress', owner_actor_id = ?, current_assignment_id = ?,
                    revision = revision + 1, last_progress_at = ?, updated_at = ?
              WHERE task_id = ? AND status = 'unassigned' AND revision = ?`,
          )
          .bind(context.caller, assignmentId, at, at, task.task_id, task.revision),
        db
          .prepare(
            `INSERT INTO task_assignments
               (assignment_id, task_id, assignment_version, owner_actor_id, status,
                offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
                delivery_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, NULL, ?, NULL, ?, ?)`,
          )
          .bind(assignmentId, task.task_id, assignmentVersion, context.caller, context.caller, at, at, at, at),
        ...taskRoomEvent(
          db,
          updated,
          'task_claimed',
          `task:claimed:${assignmentId}`,
          at,
          {
            changed_by: context.caller,
            assignment_id: assignmentId,
            assignment_version: assignmentVersion,
            owner_actor_id: context.caller,
          },
        ).statements,
      ],
      onUniqueConflict: async (error) => {
        const text = String(error);
        if (
          text.includes('idx_task_assignments_current') ||
          text.includes('UNIQUE constraint failed: task_assignments.task_id')
        ) {
          throw new BusinessError('CLAIM_CONFLICT', '任务已被他人领取', {
            task_id: task.task_id,
          });
        }
        return undefined;
      },
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskCancel(
  db: D1Database,
  principal: Principal,
  input: TaskCancelInput,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const reason = normalizeCancelReason(input.reason);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      reason,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (
    task.status === 'accepted' ||
    task.status === 'cancelled' ||
    task.status === 'legacy_completed'
  ) {
    throw new BusinessError('CONFLICT', '终态任务不能取消', { status: task.status });
  }
  const canCancel =
    task.created_by === context.caller ||
    task.owner_actor_id === context.caller ||
    isOwnerOrAdmin(context.room, context.member);
  if (!canCancel) {
    throw new BusinessError('PERMISSION_DENIED', '只有创建者、当前负责人或群管理员可以取消任务');
  }
  const at = nowMs();
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  const deliveries = assignment
    ? await db
        .prepare(
          `SELECT * FROM task_deliveries
            WHERE assignment_id = ? AND kind = 'task_offer'`,
        )
        .bind(assignment.assignment_id)
        .all<TaskDeliveryRow>()
    : { results: [] as TaskDeliveryRow[] };
  const updated: TaskRow = {
    ...task,
    status: 'cancelled',
    owner_actor_id: null,
    current_assignment_id: null,
    revision: task.revision + 1,
    cancelled_at: at,
    updated_at: at,
  };
  const card = await getTaskCard(db, task.task_id);
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    ...(task.owner_actor_id ? [task.owner_actor_id] : []),
  ]);
  const keptDeliveryIds = deliveries.results.map((row) => row.delivery_id);
  const view = await viewFromKnownRow(
    db,
    context,
    updated,
    card?.message_id ?? '',
    null,
    keptDeliveryIds,
    await attachmentsFor(db, task.task_id),
    names,
  );
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(context.boundary),
  };

  const deliveryStatements: D1PreparedStatement[] = [];
  const inboxHumanStatements: D1PreparedStatement[] = [];
  for (const row of deliveries.results) {
    const delivery = await getDelivery(db, row.delivery_id);
    if (!delivery) continue;
    if (delivery.state !== 'pending' && delivery.state !== 'claimed') continue;
    const inboxKey = `cancel:${delivery.delivery_id}:${input.request_id}`;
    deliveryStatements.push(
      db
        .prepare(
          `UPDATE actors
              SET pending_count = pending_count - (
                    SELECT CASE WHEN state = 'pending' THEN 1 ELSE 0 END
                      FROM deliveries WHERE delivery_id = ?
                  ),
                  updated_at = ?
            WHERE actor_id = ?`,
        )
        .bind(delivery.delivery_id, at, delivery.recipient_id),
      db
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', error = ?, updated_at = ?
            WHERE delivery_id = ? AND state IN ('pending', 'claimed')`,
        )
        .bind(reason, at, delivery.delivery_id),
      eventStatement(
        db,
        {
          eventKey: inboxKey,
          scopeKind: 'inbox',
          scopeId: delivery.recipient_id,
          eventType: 'delivery_cancelled',
          refId: delivery.delivery_id,
          metadata: {
            reason,
            actor_id: context.caller,
            room_id: delivery.room_id,
            message_id: delivery.message_id,
            sender_id: task.created_by,
            task_id: task.task_id,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(delivery.recipient_id), eventKey: inboxKey }, at),
      inboxHeadStatement(db, delivery.recipient_id, inboxKey, at, 0),
    );
  }
  // human 没有 delivery；offer/接单状态被取消时用持久个人通知说明控制变化，
  // 不产生新任务、新 delivery 或 pending_count。
  if (
    assignment &&
    assignment.delivery_id === null &&
    assignment.owner_actor_id !== context.caller &&
    (assignment.status === 'offered' || assignment.status === 'active')
  ) {
    inboxHumanStatements.push(
      ...inboxTaskEvent(
        db,
        assignment.owner_actor_id,
        `task:cancel:${assignment.assignment_id}`,
        'task_cancelled',
        updated,
        assignment,
        card?.message_id ?? '',
        at,
        0,
        { reason },
      ),
    );
  }

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        taskRevisionGuard(db, task.task_id, task.revision),
        taskStateGuard(
          db,
          task.task_id,
          "status NOT IN ('accepted','cancelled','legacy_completed')",
        ),
        db
          .prepare(
            `UPDATE tasks
                SET status = 'cancelled', owner_actor_id = NULL, current_assignment_id = NULL,
                    revision = revision + 1, cancelled_at = ?, updated_at = ?
              WHERE task_id = ? AND status NOT IN ('accepted','cancelled','legacy_completed')
                AND revision = ?`,
          )
          .bind(at, at, task.task_id, task.revision),
        ...(assignment
          ? [
              db
                .prepare(
                  `UPDATE task_assignments
                      SET status = 'revoked', ended_at = ?, updated_at = ?
                    WHERE assignment_id = ? AND status IN ('offered','active')`,
                )
                .bind(at, at, assignment.assignment_id),
            ]
          : []),
        ...deliveryStatements,
        ...inboxHumanStatements,
        ...taskRoomEvent(
          db,
          updated,
          'task_cancelled',
          `task:cancelled:${task.task_id}:${updated.revision}`,
          at,
          {
            changed_by: context.caller,
            reason,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

/**
 * 进度、阻塞与恢复共用一条写路径。
 *
 * 三者都只改任务 revision 与 `task_progress` 审计，不创建消息、delivery 或
 * inbox 待办；普通进度不会推进房间 head_seq，也不会增加任何人的
 * pending_count。所有入口都验证当前 active assignment，旧执行者不能借旧
 * 版本写进度。
 */
type TaskProgressAction = 'report' | 'block' | 'resume';

interface TaskProgressActionInput {
  request_id: string;
  task_id: string;
  expected_revision?: number;
  assignment_id?: string;
  assignment_version?: number;
  note?: string;
  percent?: number;
  reason?: string;
}

async function taskProgressAction(
  db: D1Database,
  principal: Principal,
  input: TaskProgressActionInput,
  action: TaskProgressAction,
): Promise<TaskResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const note =
    action === 'block'
      ? ''
      : normalizeProgressNote(
          input.note,
          action === 'resume' ? '恢复说明' : '进度说明',
        );
  const percent = action === 'report' ? normalizeProgressPercent(input.percent) : null;
  const reason = action === 'block' ? normalizeBlockReason(input.reason ?? '') : null;
  if (action === 'report' && note === '' && percent === null) {
    throw new BusinessError('INVALID_ARGUMENT', '进度说明与进度百分比至少填写一项');
  }
  const payloadHash = await sha256Hex(
    stableStringify({
      action,
      task_id: task.task_id,
      expected_revision: input.expected_revision ?? null,
      assignment_id: input.assignment_id ?? null,
      assignment_version: input.assignment_version ?? null,
      note,
      percent,
      reason,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskResult;

  if (action === 'report' && task.status !== 'in_progress') {
    throw new BusinessError('CONFLICT', '只有进行中的任务可以更新进度', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (action === 'block' && (task.status !== 'in_progress' || !taskCanTransition(task.status, 'blocked'))) {
    throw new BusinessError('CONFLICT', '只有进行中的任务可以报告阻塞', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (action === 'resume' && (task.status !== 'blocked' || !taskCanTransition(task.status, 'in_progress'))) {
    throw new BusinessError('CONFLICT', '只有受阻任务可以恢复执行', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.owner_actor_id !== context.caller) {
    throw new BusinessError(
      'PERMISSION_DENIED',
      action === 'resume'
        ? '只有当前负责人可以恢复执行'
        : '只有当前负责人可以更新任务进度',
      await actualTaskState(db, task.task_id),
    );
  }
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (
    !assignment ||
    assignment.status !== 'active' ||
    assignment.owner_actor_id !== context.caller
  ) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '当前执行资格已失效，不能写入任务进度',
    );
  }
  if (
    input.assignment_id !== undefined &&
    input.assignment_id !== assignment.assignment_id
  ) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '任务执行版本已变化，请刷新后重试',
    );
  }
  if (
    input.assignment_version !== undefined &&
    input.assignment_version !== assignment.assignment_version
  ) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '任务执行版本已变化，请刷新后重试',
    );
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }

  const at = nowMs();
  const nextStatus: TaskStatus = action === 'block' ? 'blocked' : 'in_progress';
  const nextRevision = task.revision + 1;
  const progressId = newId('prg');
  const updated: TaskRow = {
    ...task,
    status: nextStatus,
    revision: nextRevision,
    blocked_reason: reason,
    blocked_at: action === 'block' ? at : null,
    last_progress_at: at,
    updated_at: at,
  };
  const progressRow: TaskProgressRow = {
    progress_id: progressId,
    task_id: task.task_id,
    task_revision: nextRevision,
    assignment_id: assignment.assignment_id,
    assignment_version: assignment.assignment_version,
    actor_id: context.caller,
    prior_status: task.status,
    status: nextStatus,
    percent,
    note,
    blocked_reason: reason,
    created_at: at,
  };
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    context.caller,
  ]);
  const latestProgress = progressView(progressRow, names);
  const view = await viewFromKnownRow(
    db,
    context,
    updated,
    (await getTaskCard(db, task.task_id))?.message_id ?? '',
    assignment,
    await taskDeliveryIds(db, task.task_id),
    await attachmentsFor(db, task.task_id),
    names,
    latestProgress,
  );
  const result: TaskResult = {
    task: view,
    authorization: historySnapshot(context.boundary),
  };
  const eventType =
    action === 'report'
      ? 'task_progress_reported'
      : action === 'block'
        ? 'task_blocked'
        : 'task_resumed';
  const eventKey = `task:${action}:${task.task_id}:${nextRevision}`;

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        taskRevisionGuard(db, task.task_id, task.revision),
        taskStateGuard(
          db,
          task.task_id,
          'status = ? AND owner_actor_id = ? AND current_assignment_id = ?',
          task.status,
          context.caller,
          assignment.assignment_id,
        ),
        activeAssignmentGuard(db, assignment),
        db
          .prepare(
            `UPDATE tasks
                SET status = ?, revision = revision + 1, last_progress_at = ?,
                    updated_at = ?, blocked_reason = ?, blocked_at = ?
              WHERE task_id = ? AND revision = ? AND status = ?
                AND owner_actor_id = ? AND current_assignment_id = ?`,
          )
          .bind(
            nextStatus,
            at,
            at,
            reason,
            action === 'block' ? at : null,
            task.task_id,
            task.revision,
            task.status,
            context.caller,
            assignment.assignment_id,
          ),
        db
          .prepare(
            `UPDATE task_assignments
                SET last_progress_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'active'
                AND owner_actor_id = ? AND assignment_version = ?`,
          )
          .bind(
            at,
            at,
            assignment.assignment_id,
            context.caller,
            assignment.assignment_version,
          ),
        progressStatement(db, {
          progressId,
          taskId: task.task_id,
          revision: nextRevision,
          assignmentId: assignment.assignment_id,
          assignmentVersion: assignment.assignment_version,
          actorId: context.caller,
          priorStatus: task.status,
          status: nextStatus,
          percent,
          note,
          blockedReason: reason,
          at,
        }),
        ...taskRoomEvent(db, updated, eventType, eventKey, at, {
          changed_by: context.caller,
          assignment_id: assignment.assignment_id,
          assignment_version: assignment.assignment_version,
          percent,
          has_note: note.length > 0,
          note_bytes: utf8Bytes(note),
          ...(reason === null ? {} : { reason }),
        }).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskReportProgress(
  db: D1Database,
  principal: Principal,
  input: TaskProgressInput,
): Promise<TaskResult> {
  return taskProgressAction(db, principal, input, 'report');
}

export async function taskBlock(
  db: D1Database,
  principal: Principal,
  input: TaskBlockInput,
): Promise<TaskResult> {
  return taskProgressAction(db, principal, input, 'block');
}

export async function taskResume(
  db: D1Database,
  principal: Principal,
  input: TaskResumeInput,
): Promise<TaskResult> {
  return taskProgressAction(db, principal, input, 'resume');
}

async function attachmentsFor(
  db: D1Database,
  taskId: string,
): Promise<Array<{ file_id: string; label: string }>> {
  const rows = await db
    .prepare(
      `SELECT * FROM task_attachments
        WHERE task_id = ? ORDER BY created_at ASC, file_id ASC`,
    )
    .bind(taskId)
    .all<TaskAttachmentRow>();
  return rows.results.map((row) => ({ file_id: row.file_id, label: row.label }));
}

export async function taskSummary(
  db: D1Database,
  principal: Principal,
  input: TaskSummaryInput,
): Promise<TaskSummaryResult> {
  const caller = actorId(principal);
  const filters = input.room_ids ?? [];
  const placeholders =
    filters.length > 0 ? ` AND m.room_id IN (${filters.map(() => '?').join(', ')})` : '';
  const result = await db
    .prepare(
      `SELECT m.room_id AS room_id,
              COUNT(t.task_id) AS total,
              COALESCE(SUM(CASE WHEN t.status = 'unassigned' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN t.status = 'in_progress' AND t.owner_actor_id = ? THEN 1 ELSE 0 END), 0) AS claimed,
              COALESCE(SUM(CASE WHEN t.status IN ('accepted','legacy_completed') THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM room_members m
         JOIN rooms r ON r.room_id = m.room_id
         LEFT JOIN tasks t
           ON t.room_id = m.room_id
          AND (r.kind = 'direct' OR r.member_history_policy = 'full' OR t.created_at >= m.joined_at)
        WHERE m.actor_id = ? AND m.status = 'active'${placeholders}
        GROUP BY m.room_id
        ORDER BY m.room_id ASC`,
    )
    .bind(caller, caller, ...filters)
    .all<{
      room_id: string;
      total: number;
      pending: number;
      claimed: number;
      done: number;
      failed: number;
    }>();
  return {
    items: result.results.map((row) => ({
      room_id: row.room_id,
      pending: row.pending,
      claimed: row.claimed,
      done: row.done,
      failed: row.failed,
      total: row.total,
    })),
  };
}

export async function taskCounts(db: D1Database, principal: Principal): Promise<TaskCounts> {
  const caller = actorId(principal);
  const row = await db
    .prepare(
      `SELECT COUNT(t.task_id) AS total,
              COALESCE(SUM(CASE WHEN t.status = 'unassigned' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN t.status = 'in_progress' AND t.owner_actor_id = ? THEN 1 ELSE 0 END), 0) AS claimed,
              COALESCE(SUM(CASE WHEN t.status IN ('accepted','legacy_completed') THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM room_members m
         JOIN rooms r ON r.room_id = m.room_id
         LEFT JOIN tasks t
           ON t.room_id = m.room_id
          AND (r.kind = 'direct' OR r.member_history_policy = 'full' OR t.created_at >= m.joined_at)
        WHERE m.actor_id = ? AND m.status = 'active'`,
    )
    .bind(caller, caller)
    .first<{ total: number; pending: number; claimed: number; done: number; failed: number }>();
  return {
    pending: row?.pending ?? 0,
    claimed: row?.claimed ?? 0,
    done: row?.done ?? 0,
    failed: row?.failed ?? 0,
    total: row?.total ?? 0,
  };
}
