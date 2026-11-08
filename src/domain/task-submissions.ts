/**
 * D06 成果提交与不可混淆的版本。
 *
 * 职责边界：
 * - 只写 `task_submissions` / `task_reviews` 与同一事务内的任务、assignment、
 *   投递失效和 room scope 事件；不复制任务状态到第二张表。
 * - 材料必须已是同一房间的有效文件；提交时从 `room_files`/`drive_files`
 *   读取 sha256/size/mime 并冻结到版本快照，同时建立 `file_references`
 *   （kind = task，ref_id = task_id）与 retained，防止 TTL 回收。
 * - 外链只保存提交者声明的目标版本/摘要与 availability；服务端不抓取外链，
 *   可访问不等于验收通过。
 * - 提交成功关闭该 assignment 仍 pending/claimed 的 task_offer/task_reminder
 *   投递，并取消 pending 交接提议；不创建 delivery、不增加 pending_count、
 *   不推进 rooms.head_seq。
 * - D06 只实现最小退回：指定验收人退回当前 pending 版本，原负责人仍有资格时
 *   生成新的 active assignment；失权时任务转 blocked。D07 再补齐 accept。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  TaskSubmissionGetInput,
  TaskSubmissionListInput,
  TaskSubmissionReturnInput,
  TaskSubmitInput,
} from '../contracts/schemas';
import type { HistorySnapshot } from './room-history';
import { historySnapshot } from './room-history';
import { newId, nowMs, sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import { guardSql } from '../storage/guards';
import {
  getActor,
  getDriveFile,
  getMember,
  getOperation,
  getRoomFile,
  getTaskAssignment,
  getTaskCard,
} from '../storage/queries';
import type {
  TaskAssignmentRow,
  TaskRow,
  TaskReviewRow,
  TaskSubmissionRow,
} from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import type { Principal } from './principal';
import {
  actorNames,
  activeAssignmentGuard,
  actualTaskState,
  attachmentsFor,
  memberGuard,
  rethrowWithActualState,
  requireVisibleTask,
  taskDeliveryIds,
  taskRevisionGuard,
  taskRoomEvent,
  taskStateGuard,
  viewFromKnownRow,
  type TaskContext,
  type TaskSubmissionSummaryView,
  type TaskView,
} from './tasks';
import {
  cancelPendingTransfersForTask,
  closeTaskDeliveries,
} from './task-transfers';

const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const COMMIT_SHA = /^[0-9a-fA-F]{7,64}$/u;

export type TaskSubmissionStatus = TaskSubmissionRow['status'];

export interface TaskSubmissionMaterialView {
  file_id: string;
  label: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  /** 读取时实时判断；字节身份来自提交时冻结的快照。 */
  available: boolean;
}

export interface TaskSubmissionLinkView {
  url: string;
  title: string | null;
  version: string | null;
  digest: string | null;
  availability: 'unverified' | 'declared_reachable';
}

export interface TaskSubmissionReviewView {
  reviewer_actor_id: string;
  reviewer_name: string;
  decision: 'accept' | 'return';
  reason: string;
  created_at: string;
}

export interface TaskSubmissionView {
  submission_id: string;
  task_id: string;
  room_id: string;
  version: number;
  status: TaskSubmissionStatus;
  summary: string;
  materials: TaskSubmissionMaterialView[];
  links: TaskSubmissionLinkView[];
  commit_sha: string | null;
  evidence: string[];
  known_limits: string;
  assignment_id: string;
  assignment_version: number;
  submitted_by: string;
  submitted_by_name: string;
  submitted_at: string;
  reviewed_at: string | null;
  review: TaskSubmissionReviewView | null;
  /** 该版本是否为任务当前最新版本。 */
  is_current: boolean;
}

export interface TaskSubmissionResult {
  submission: TaskSubmissionView;
  task: TaskView;
  authorization: HistorySnapshot;
}

export interface TaskSubmissionGetResult {
  submission: TaskSubmissionView;
}

export interface TaskSubmissionListResult {
  submissions: TaskSubmissionView[];
  next_cursor: null;
  has_more: boolean;
}

interface FrozenMaterial {
  file_id: string;
  label: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  retained_at: number;
}

interface NormalizedLink {
  url: string;
  title: string | null;
  version: string | null;
  digest: string | null;
  availability: 'unverified' | 'declared_reachable';
}

interface NormalizedSubmission {
  summary: string;
  materials: Array<{ file_id: string; label: string }>;
  links: NormalizedLink[];
  commit_sha: string | null;
  evidence: string[];
  known_limits: string;
}

function invalid(label: string, message: string): BusinessError {
  return new BusinessError('INVALID_ARGUMENT', `${label}${message}`);
}

function textBytes(value: string, label: string, max: number): string {
  if (CONTROL_TEXT.test(value)) throw invalid(label, '不能包含控制字符');
  if (utf8Bytes(value) > max) throw invalid(label, `不能超过 ${max} 字节`);
  return value;
}

function trimmedText(
  value: string | undefined,
  label: string,
  maxBytes: number,
  allowEmpty = true,
): string {
  const text = (value ?? '').trim();
  if (!allowEmpty && !text) throw invalid(label, '不能为空');
  if (!text) return '';
  return textBytes(text, label, maxBytes);
}

function normalizeSummary(value: string): string {
  const text = value.replace(/\r\n/gu, '\n').trim();
  if (!text) throw invalid('summary', '不能为空');
  return textBytes(text, 'summary', LIMITS.taskSubmissionSummaryBytes);
}

function normalizeKnownLimits(value: string | undefined): string {
  const text = (value ?? '').replace(/\r\n/gu, '\n').trim();
  if (!text) return '';
  return textBytes(text, 'known_limits', LIMITS.taskSubmissionKnownLimitsBytes);
}

function normalizeEvidence(values: string[] | undefined): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    const text = value.replace(/\r\n/gu, '\n').trim();
    if (!text) continue;
    textBytes(text, 'evidence', LIMITS.taskSubmissionEvidenceBytes);
    if (!result.includes(text)) result.push(text);
  }
  return result;
}

function normalizeCommitSha(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!COMMIT_SHA.test(text)) {
    throw invalid('commit_sha', '必须是 7–64 位十六进制 Git 提交 SHA');
  }
  return text.toLowerCase();
}

function normalizeLinks(
  values: Array<{
    url: string;
    title?: string;
    version?: string;
    digest?: string;
    availability?: 'unverified' | 'declared_reachable';
  }> | undefined,
): NormalizedLink[] {
  const seen = new Set<string>();
  const links: NormalizedLink[] = [];
  for (const raw of values ?? []) {
    const rawUrl = raw.url.trim();
    textBytes(rawUrl, 'links.url', LIMITS.taskSubmissionLinkUrlBytes);
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw invalid('links.url', '必须是合法的绝对 URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw invalid('links.url', '只允许 http/https 外链');
    }
    if (parsed.username || parsed.password) {
      throw invalid('links.url', '不能包含凭据');
    }
    const url = parsed.toString();
    if (utf8Bytes(url) > LIMITS.taskSubmissionLinkUrlBytes) {
      throw invalid('links.url', `不能超过 ${LIMITS.taskSubmissionLinkUrlBytes} 字节`);
    }
    if (seen.has(url)) throw invalid('links.url', '同一版本不能重复记录同一外链');
    seen.add(url);
    links.push({
      url,
      title: trimmedText(raw.title, 'links.title', LIMITS.taskSubmissionLinkTitleBytes) || null,
      version:
        trimmedText(raw.version, 'links.version', LIMITS.taskSubmissionLinkVersionBytes) || null,
      digest: trimmedText(raw.digest, 'links.digest', LIMITS.taskSubmissionLinkDigestBytes) || null,
      availability: raw.availability ?? 'unverified',
    });
  }
  return links;
}

function normalizeMaterials(
  values: Array<{ file_id: string; label?: string }> | undefined,
): Array<{ file_id: string; label: string }> {
  const seen = new Set<string>();
  const materials: Array<{ file_id: string; label: string }> = [];
  for (const raw of values ?? []) {
    if (seen.has(raw.file_id)) {
      throw invalid('materials', '同一文件不能重复提交');
    }
    seen.add(raw.file_id);
    materials.push({
      file_id: raw.file_id,
      label: trimmedText(
        raw.label,
        'materials.label',
        LIMITS.taskSubmissionMaterialLabelBytes,
      ),
    });
  }
  return materials;
}

function normalizeSubmission(input: TaskSubmitInput): NormalizedSubmission {
  const submission: NormalizedSubmission = {
    summary: normalizeSummary(input.summary),
    materials: normalizeMaterials(input.materials),
    links: normalizeLinks(input.links),
    commit_sha: normalizeCommitSha(input.commit_sha),
    evidence: normalizeEvidence(input.evidence),
    known_limits: normalizeKnownLimits(input.known_limits),
  };
  if (
    submission.materials.length === 0 &&
    submission.links.length === 0 &&
    submission.evidence.length === 0 &&
    submission.commit_sha === null
  ) {
    throw new BusinessError(
      'INVALID_ARGUMENT',
      '提交必须包含材料、外链、验证证据或 commit_sha 中至少一项可核对成果',
    );
  }
  return submission;
}

function normalizeReturnReason(value: string): string {
  const text = value.replace(/\r\n/gu, '\n').trim();
  if (!text) throw invalid('reason', '不能为空');
  return textBytes(text, 'reason', LIMITS.taskSubmissionReturnReasonBytes);
}

function parseArray<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function frozenMaterial(raw: unknown): FrozenMaterial | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.file_id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.mime_type !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.sha256 !== 'string'
  ) {
    return null;
  }
  return {
    file_id: value.file_id,
    label: typeof value.label === 'string' ? value.label : '',
    name: value.name,
    mime_type: value.mime_type,
    size: value.size,
    sha256: value.sha256,
    retained_at: typeof value.retained_at === 'number' ? value.retained_at : 0,
  };
}

function frozenLink(raw: unknown): NormalizedLink | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== 'string') return null;
  const availability =
    value.availability === 'declared_reachable' ? 'declared_reachable' : 'unverified';
  return {
    url: value.url,
    title: typeof value.title === 'string' ? value.title : null,
    version: typeof value.version === 'string' ? value.version : null,
    digest: typeof value.digest === 'string' ? value.digest : null,
    availability,
  };
}

export async function getTaskSubmission(
  db: D1Database,
  submissionId: string,
): Promise<TaskSubmissionRow | null> {
  return db
    .prepare('SELECT * FROM task_submissions WHERE submission_id = ?')
    .bind(submissionId)
    .first<TaskSubmissionRow>();
}

async function submissionRows(
  db: D1Database,
  taskId: string,
  limit: number,
): Promise<TaskSubmissionRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM task_submissions
        WHERE task_id = ?
        ORDER BY version DESC
        LIMIT ?`,
    )
    .bind(taskId, limit)
    .all<TaskSubmissionRow>();
  return rows.results;
}

/** 当前任务卡片/列表使用的轻量摘要；无提交时为 null。 */
export function submissionSummary(row: TaskSubmissionRow): TaskSubmissionSummaryView {
  return {
    submission_id: row.submission_id,
    version: row.version,
    status: row.status,
    submitted_at: String(row.created_at),
  };
}

async function materialAvailability(
  db: D1Database,
  fileIds: string[],
  at: number,
): Promise<Map<string, boolean>> {
  const unique = Array.from(new Set(fileIds));
  if (unique.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT rf.file_id, rf.deleted_at AS room_deleted_at, rf.expires_at AS room_expires_at,
              rf.retained AS room_retained, df.state AS drive_state,
              df.expires_at AS drive_expires_at, df.retained AS drive_retained
         FROM room_files rf
         LEFT JOIN drive_files df ON df.file_id = rf.file_id
        WHERE rf.file_id IN (${unique.map(() => '?').join(', ')})`,
    )
    .bind(...unique)
    .all<{
      file_id: string;
      room_deleted_at: number | null;
      room_expires_at: number;
      room_retained: number;
      drive_state: 'draft' | 'bound' | 'deleted' | null;
      drive_expires_at: number | null;
      drive_retained: number | null;
    }>();
  const result = new Map<string, boolean>();
  for (const fileId of unique) result.set(fileId, false);
  for (const row of rows.results) {
    const roomUsable =
      row.room_deleted_at === null &&
      (row.room_retained === 1 || row.room_expires_at > at);
    const driveUsable =
      row.drive_state === null ||
      (row.drive_state !== 'deleted' &&
        (row.drive_retained === 1 ||
          row.drive_expires_at === null ||
          row.drive_expires_at > at));
    result.set(row.file_id, roomUsable && driveUsable);
  }
  return result;
}

async function reviewFor(
  db: D1Database,
  submissionId: string,
): Promise<TaskSubmissionReviewView | null> {
  const row = await db
    .prepare('SELECT * FROM task_reviews WHERE submission_id = ?')
    .bind(submissionId)
    .first<TaskReviewRow>();
  if (!row) return null;
  const names = await actorNames(db, [row.reviewer_actor_id]);
  return {
    reviewer_actor_id: row.reviewer_actor_id,
    reviewer_name: names.get(row.reviewer_actor_id) ?? '',
    decision: row.decision,
    reason: row.reason,
    created_at: String(row.created_at),
  };
}

async function buildSubmissionView(
  db: D1Database,
  row: TaskSubmissionRow,
  roomId: string,
  isCurrent: boolean,
): Promise<TaskSubmissionView> {
  const materials = parseArray<unknown>(row.materials_json)
    .map(frozenMaterial)
    .filter((value): value is FrozenMaterial => value !== null);
  const links = parseArray<unknown>(row.links_json)
    .map(frozenLink)
    .filter((value): value is NormalizedLink => value !== null);
  const availability = await materialAvailability(
    db,
    materials.map((material) => material.file_id),
    nowMs(),
  );
  const names = await actorNames(db, [row.submitted_by]);
  return {
    submission_id: row.submission_id,
    task_id: row.task_id,
    room_id: roomId,
    version: row.version,
    status: row.status,
    summary: row.summary,
    materials: materials.map((material) => ({
      file_id: material.file_id,
      label: material.label || material.name,
      name: material.name,
      mime_type: material.mime_type,
      size: material.size,
      sha256: material.sha256,
      available: availability.get(material.file_id) ?? false,
    })),
    links,
    commit_sha: row.commit_sha,
    evidence: parseArray<string>(row.evidence_json).filter(
      (value): value is string => typeof value === 'string',
    ),
    known_limits: row.known_limits,
    assignment_id: row.assignment_id,
    assignment_version: row.assignment_version,
    submitted_by: row.submitted_by,
    submitted_by_name: names.get(row.submitted_by) ?? '',
    submitted_at: String(row.created_at),
    reviewed_at: row.reviewed_at === null ? null : String(row.reviewed_at),
    review: await reviewFor(db, row.submission_id),
    is_current: isCurrent,
  };
}

async function taskViewForWrite(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  assignment: TaskAssignmentRow | null,
  currentSubmission: TaskSubmissionSummaryView | null,
): Promise<TaskView> {
  const card = await getTaskCard(db, task.task_id);
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    ...(task.owner_actor_id ? [task.owner_actor_id] : []),
    ...(assignment ? [assignment.owner_actor_id] : []),
  ]);
  return viewFromKnownRow(
    db,
    context,
    task,
    card?.message_id ?? '',
    assignment,
    await taskDeliveryIds(db, task.task_id),
    await attachmentsFor(db, task.task_id),
    names,
    null,
    currentSubmission,
  );
}

async function readMaterial(
  db: D1Database,
  roomId: string,
  fileId: string,
  label: string,
  at: number,
): Promise<FrozenMaterial> {
  const roomFile = await getRoomFile(db, fileId);
  if (!roomFile || roomFile.room_id !== roomId || roomFile.deleted_at !== null) {
    throw new BusinessError('FILE_UNAVAILABLE', '材料不存在、已删除或不属于该房间', {
      file_id: fileId,
    });
  }
  const drive = await getDriveFile(db, fileId);
  if (drive && drive.state === 'deleted') {
    throw new BusinessError('FILE_UNAVAILABLE', '材料字节已被删除或正在清理', {
      file_id: fileId,
    });
  }
  const roomUsable =
    roomFile.retained === 1 || roomFile.expires_at > at;
  const driveUsable =
    !drive ||
    drive.retained === 1 ||
    drive.expires_at === null ||
    drive.expires_at > at;
  if (!roomUsable || !driveUsable) {
    throw new BusinessError('FILE_UNAVAILABLE', '材料已过期且未被有效引用，不能冻结为成果', {
      file_id: fileId,
    });
  }
  const name = drive?.name ?? roomFile.name;
  const mimeType = drive?.mime_type ?? roomFile.mime_type;
  const size = drive?.size ?? roomFile.size;
  const sha256 = drive?.sha256 ?? roomFile.sha256;
  if (
    !name ||
    !mimeType ||
    !Number.isInteger(size) ||
    size < 0 ||
    !/^[0-9a-f]{64}$/iu.test(sha256)
  ) {
    throw new BusinessError('FILE_UNAVAILABLE', '材料元数据不完整，不能冻结校验值', {
      file_id: fileId,
    });
  }
  return {
    file_id: fileId,
    label: label || name,
    name,
    mime_type: mimeType,
    size,
    sha256: sha256.toLowerCase(),
    retained_at: at,
  };
}

function materialGuard(
  db: D1Database,
  roomId: string,
  fileId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'fileUnavailable',
        `NOT EXISTS (
           SELECT 1 FROM room_files
            WHERE file_id = ? AND room_id = ? AND deleted_at IS NULL
         )
         OR EXISTS (SELECT 1 FROM drive_files WHERE file_id = ? AND state = 'deleted')
         OR EXISTS (
           SELECT 1 FROM room_files
            WHERE file_id = ? AND room_id = ? AND deleted_at IS NULL
              AND retained = 0 AND expires_at <= ?
         )
         OR EXISTS (
           SELECT 1 FROM drive_files
            WHERE file_id = ? AND state != 'deleted'
              AND retained = 0 AND expires_at IS NOT NULL AND expires_at <= ?
         )`,
      ),
    )
    .bind(fileId, roomId, fileId, fileId, roomId, at, fileId, at);
}

function materialStatements(
  db: D1Database,
  input: {
    taskId: string;
    roomId: string;
    caller: string;
    material: FrozenMaterial;
    at: number;
  },
): D1PreparedStatement[] {
  return [
    materialGuard(db, input.roomId, input.material.file_id, input.at),
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
        input.material.file_id,
        input.taskId,
        input.roomId,
        input.caller,
        input.at,
      ),
    db
      .prepare('UPDATE room_files SET retained = 1 WHERE file_id = ? AND deleted_at IS NULL')
      .bind(input.material.file_id),
    db
      .prepare(
        `UPDATE drive_files SET retained = 1, expires_at = NULL
          WHERE file_id = ? AND state != 'deleted'`,
      )
      .bind(input.material.file_id),
  ];
}

function roomQuotaGuard(db: D1Database, roomId: string): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'quotaExceeded',
        `EXISTS (
           SELECT 1 FROM (
             SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
               FROM room_files
              WHERE room_id = ? AND deleted_at IS NULL
           ) AS usage
           WHERE usage.files > ? OR usage.bytes > ?
         )`,
      ),
    )
    .bind(roomId, LIMITS.roomFilesPerRoom, LIMITS.roomFileBytesPerRoom);
}

function submissionPendingGuard(
  db: D1Database,
  submissionId: string,
  taskId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'taskState',
        `NOT EXISTS (
           SELECT 1 FROM task_submissions
            WHERE submission_id = ? AND task_id = ? AND status = 'pending'
         )`,
      ),
    )
    .bind(submissionId, taskId);
}

function isSubmissionUniqueConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes('idx_task_submissions_pending') ||
    text.includes('UNIQUE constraint failed: task_submissions.task_id') ||
    text.includes('UNIQUE constraint failed: task_submissions.task_id, task_submissions.version')
  );
}

export async function taskSubmit(
  db: D1Database,
  principal: Principal,
  input: TaskSubmitInput,
): Promise<TaskSubmissionResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const submission = normalizeSubmission(input);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      summary: submission.summary,
      materials: submission.materials,
      links: submission.links,
      commit_sha: submission.commit_sha,
      evidence: submission.evidence,
      known_limits: submission.known_limits,
      assignment_id: input.assignment_id ?? null,
      assignment_version: input.assignment_version ?? null,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) {
    return resolveOperation(replay, payloadHash) as TaskSubmissionResult;
  }

  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'in_progress') {
    throw new BusinessError('CONFLICT', '只有进行中的任务可以提交成果', {
      status: task.status,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (!assignment || assignment.status !== 'active') {
    throw new BusinessError('ASSIGNMENT_STALE', '当前执行资格已结束，不能提交成果', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (
    (input.assignment_id !== undefined && input.assignment_id !== assignment.assignment_id) ||
    (input.assignment_version !== undefined &&
      input.assignment_version !== assignment.assignment_version)
  ) {
    throw new BusinessError('ASSIGNMENT_STALE', '提交引用的执行资格不是当前 active assignment', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (assignment.owner_actor_id !== context.caller || task.owner_actor_id !== context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有当前负责人可以提交该任务成果');
  }

  const latest = await db
    .prepare(
      `SELECT submission_id, version, status FROM task_submissions
        WHERE task_id = ?
        ORDER BY version DESC
        LIMIT 1`,
    )
    .bind(task.task_id)
    .first<Pick<TaskSubmissionRow, 'submission_id' | 'version' | 'status'>>();
  if (latest?.status === 'pending') {
    throw new BusinessError('CONFLICT', '该任务已有待验收成果，不能重复提交', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }

  const at = nowMs();
  const frozenMaterials: FrozenMaterial[] = [];
  for (const material of submission.materials) {
    frozenMaterials.push(
      await readMaterial(db, task.room_id, material.file_id, material.label, at),
    );
  }
  const nextVersion = (latest?.version ?? 0) + 1;
  const row: TaskSubmissionRow = {
    submission_id: newId('sub'),
    task_id: task.task_id,
    assignment_id: assignment.assignment_id,
    assignment_version: assignment.assignment_version,
    version: nextVersion,
    summary: submission.summary,
    materials_json: JSON.stringify(frozenMaterials),
    evidence_json: JSON.stringify(submission.evidence),
    known_limits: submission.known_limits,
    links_json: JSON.stringify(submission.links),
    commit_sha: submission.commit_sha,
    submitted_by: context.caller,
    status: 'pending',
    created_at: at,
    reviewed_at: null,
  };
  const updatedTask: TaskRow = {
    ...task,
    status: 'submitted',
    revision: task.revision + 1,
    updated_at: at,
  };
  const summary = submissionSummary(row);
  const view = await buildSubmissionView(db, row, task.room_id, true);
  const taskView = await taskViewForWrite(db, context, updatedTask, assignment, summary);
  const result: TaskSubmissionResult = {
    submission: view,
    task: taskView,
    authorization: historySnapshot(context.boundary),
  };

  const deliveries = await closeTaskDeliveries(
    db,
    assignment,
    task,
    context.caller,
    '成果已提交',
    input.request_id,
    at,
  );
  const transferStatements = await cancelPendingTransfersForTask(db, {
    taskId: task.task_id,
    actor: context.caller,
    requestId: input.request_id,
    at,
    reason: '成果已提交',
  });

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
        taskStateGuard(db, task.task_id, "status = 'in_progress'"),
        activeAssignmentGuard(db, assignment),
        roomQuotaGuard(db, task.room_id),
        ...frozenMaterials.flatMap((material) =>
          materialStatements(db, {
            taskId: task.task_id,
            roomId: task.room_id,
            caller: context.caller,
            material,
            at,
          }),
        ),
        db
          .prepare(
            `INSERT INTO task_submissions
               (submission_id, task_id, assignment_id, assignment_version, version, summary,
                materials_json, evidence_json, known_limits, links_json, commit_sha,
                submitted_by, status, created_at, reviewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
          )
          .bind(
            row.submission_id,
            row.task_id,
            row.assignment_id,
            row.assignment_version,
            row.version,
            row.summary,
            row.materials_json,
            row.evidence_json,
            row.known_limits,
            row.links_json,
            row.commit_sha,
            row.submitted_by,
            row.created_at,
          ),
        db
          .prepare(
            `UPDATE tasks
                SET status = 'submitted', revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND status = 'in_progress' AND revision = ?`,
          )
          .bind(at, task.task_id, task.revision),
        db
          .prepare(
            `UPDATE task_assignments
                SET status = 'submitted', ended_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'active'`,
          )
          .bind(at, at, assignment.assignment_id),
        ...deliveries.statements,
        ...transferStatements,
        ...taskRoomEvent(
          db,
          updatedTask,
          'task_submitted',
          `task:submitted:${task.task_id}:${updatedTask.revision}`,
          at,
          {
            changed_by: context.caller,
            submission_id: row.submission_id,
            version: row.version,
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
            material_count: frozenMaterials.length,
            link_count: submission.links.length,
            has_commit_sha: submission.commit_sha !== null,
          },
        ).statements,
      ],
    });
  } catch (error) {
    if (isSubmissionUniqueConflict(error)) {
      throw new BusinessError('CONFLICT', '该任务已有待验收成果，不能重复提交', {
        ...(await actualTaskState(db, task.task_id)),
      });
    }
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskSubmissionGet(
  db: D1Database,
  principal: Principal,
  input: TaskSubmissionGetInput,
): Promise<TaskSubmissionGetResult> {
  const { task } = await requireVisibleTask(db, principal, input.task_id);
  const row = input.version === undefined
    ? await db
        .prepare(
          `SELECT * FROM task_submissions
            WHERE task_id = ?
            ORDER BY version DESC
            LIMIT 1`,
        )
        .bind(task.task_id)
        .first<TaskSubmissionRow>()
    : await db
        .prepare('SELECT * FROM task_submissions WHERE task_id = ? AND version = ?')
        .bind(task.task_id, input.version)
        .first<TaskSubmissionRow>();
  if (!row) throw new BusinessError('NOT_FOUND', '成果版本不存在');
  const latest = await db
    .prepare('SELECT MAX(version) AS version FROM task_submissions WHERE task_id = ?')
    .bind(task.task_id)
    .first<{ version: number | null }>();
  return {
    submission: await buildSubmissionView(db, row, task.room_id, latest?.version === row.version),
  };
}

export async function taskSubmissionList(
  db: D1Database,
  principal: Principal,
  input: TaskSubmissionListInput,
): Promise<TaskSubmissionListResult> {
  const { task } = await requireVisibleTask(db, principal, input.task_id);
  const limit = Math.min(
    input.limit ?? LIMITS.taskSubmissionListDefault,
    LIMITS.taskSubmissionListMax,
  );
  const rows = await submissionRows(db, task.task_id, limit + 1);
  const latest = rows.length > 0 ? rows[0]!.version : 0;
  const visible = rows.slice(0, limit);
  return {
    submissions: await Promise.all(
      visible.map((row) => buildSubmissionView(db, row, task.room_id, row.version === latest)),
    ),
    next_cursor: null,
    has_more: rows.length > limit,
  };
}

export async function taskSubmissionReturn(
  db: D1Database,
  principal: Principal,
  input: TaskSubmissionReturnInput,
): Promise<TaskSubmissionResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const reason = normalizeReturnReason(input.reason);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      submission_id: input.submission_id,
      reason,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) {
    return resolveOperation(replay, payloadHash) as TaskSubmissionResult;
  }

  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'submitted') {
    throw new BusinessError('CONFLICT', '只有待验收任务可以退回成果', {
      status: task.status,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const submission = await getTaskSubmission(db, input.submission_id);
  if (!submission || submission.task_id !== task.task_id) {
    throw new BusinessError('NOT_FOUND', '成果版本不存在');
  }
  if (submission.status !== 'pending') {
    throw new BusinessError('CONFLICT', '该成果版本已处理，不能重复退回', {
      submission_id: submission.submission_id,
      status: submission.status,
    });
  }
  if (task.reviewer_actor_id !== context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有当前验收人可以退回该成果');
  }
  if (submission.submitted_by === context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '负责人不能验收或退回自己的成果');
  }

  const at = nowMs();
  const assignment = await getTaskAssignment(db, submission.assignment_id);
  const ownerId = assignment?.owner_actor_id ?? submission.submitted_by;
  const ownerActor = await getActor(db, ownerId);
  const ownerMember = await getMember(db, task.room_id, ownerId);
  const eligible =
    ownerMember?.status === 'active' && ownerActor !== null && ownerActor.disabled_at === null;
  const latestAssignment = await db
    .prepare('SELECT MAX(assignment_version) AS version FROM task_assignments WHERE task_id = ?')
    .bind(task.task_id)
    .first<{ version: number | null }>();
  const nextAssignmentVersion = (latestAssignment?.version ?? 0) + 1;
  const nextAssignment: TaskAssignmentRow | null = eligible
    ? {
        assignment_id: newId('asg'),
        task_id: task.task_id,
        assignment_version: nextAssignmentVersion,
        owner_actor_id: ownerId,
        status: 'active',
        offered_by: assignment?.offered_by ?? task.created_by,
        offer_expires_at: null,
        accepted_at: at,
        ended_at: null,
        last_progress_at: null,
        delivery_id: null,
        created_at: at,
        updated_at: at,
      }
    : null;
  const updatedTask: TaskRow = eligible
    ? {
        ...task,
        status: 'in_progress',
        revision: task.revision + 1,
        owner_actor_id: ownerId,
        current_assignment_id: nextAssignment!.assignment_id,
        blocked_reason: null,
        blocked_at: null,
        updated_at: at,
      }
    : {
        ...task,
        status: 'blocked',
        revision: task.revision + 1,
        owner_actor_id: null,
        current_assignment_id: null,
        blocked_reason: 'owner_lost_eligibility',
        blocked_at: at,
        updated_at: at,
      };
  const returnedSummary: TaskSubmissionSummaryView = {
    submission_id: submission.submission_id,
    version: submission.version,
    status: 'returned',
    submitted_at: String(submission.created_at),
  };
  const reviewerNames = await actorNames(db, [context.caller]);
  const submissionView: TaskSubmissionView = {
    ...(await buildSubmissionView(db, {
      ...submission,
      status: 'returned',
      reviewed_at: at,
    }, task.room_id, true)),
    review: {
      reviewer_actor_id: context.caller,
      reviewer_name: reviewerNames.get(context.caller) ?? '',
      decision: 'return',
      reason,
      created_at: String(at),
    },
  };
  const taskView = await taskViewForWrite(db, context, updatedTask, nextAssignment, returnedSummary);
  const result: TaskSubmissionResult = {
    submission: submissionView,
    task: taskView,
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
        taskStateGuard(db, task.task_id, "status = 'submitted'"),
        submissionPendingGuard(db, submission.submission_id, task.task_id),
        db
          .prepare(
            `UPDATE task_submissions
                SET status = 'returned', reviewed_at = ?
              WHERE submission_id = ? AND task_id = ? AND status = 'pending'`,
          )
          .bind(at, submission.submission_id, task.task_id),
        db
          .prepare(
            `INSERT INTO task_reviews
               (review_id, submission_id, task_id, reviewer_actor_id, decision, reason, created_at)
             VALUES (?, ?, ?, ?, 'return', ?, ?)`,
          )
          .bind(newId('rev'), submission.submission_id, task.task_id, context.caller, reason, at),
        db
          .prepare(
            `UPDATE tasks
                SET status = ?, owner_actor_id = ?, current_assignment_id = ?,
                    blocked_reason = ?, blocked_at = ?, revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND status = 'submitted' AND revision = ?`,
          )
          .bind(
            updatedTask.status,
            updatedTask.owner_actor_id,
            updatedTask.current_assignment_id,
            updatedTask.blocked_reason,
            updatedTask.blocked_at,
            at,
            task.task_id,
            task.revision,
          ),
        ...(nextAssignment
          ? [
              db
                .prepare(
                  `INSERT INTO task_assignments
                     (assignment_id, task_id, assignment_version, owner_actor_id, status,
                      offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
                      delivery_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
                )
                .bind(
                  nextAssignment.assignment_id,
                  nextAssignment.task_id,
                  nextAssignment.assignment_version,
                  nextAssignment.owner_actor_id,
                  nextAssignment.offered_by,
                  at,
                  at,
                  at,
                ),
            ]
          : []),
        ...taskRoomEvent(
          db,
          updatedTask,
          'task_returned',
          `task:returned:${task.task_id}:${updatedTask.revision}`,
          at,
          {
            changed_by: context.caller,
            submission_id: submission.submission_id,
            version: submission.version,
            reason,
            next_status: updatedTask.status,
            ...(nextAssignment
              ? {
                  assignment_id: nextAssignment.assignment_id,
                  assignment_version: nextAssignment.assignment_version,
                  owner_actor_id: nextAssignment.owner_actor_id,
                }
              : {}),
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}
