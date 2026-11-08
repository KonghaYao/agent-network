/**
 * D05 可授权交接上下文包。
 *
 * 交接包是版本化工作数据：每个版本保存目标、已完成事项、当前结果（可绑定
 * submission 版本）、未解决问题、下一步与显式引用。它不复制群历史、消息正文
 * 或文件字节，也不授予任何额外权限；读取时按当前读者重新校验可见性与保留期。
 *
 * 跨范围（源群 != 任务房间）的私有材料默认不可见；只有仍能访问源范围且能
 * 管理该材料的身份显式 `grant` 后，目标房间成员才能通过包内 URL 读取。源文件
 * 删除、过期或授权人失权后，重新读取立即显示 missing/omitted，不缓存旧副本。
 *
 * 所有写操作经 `runIdempotent` 并校验当前 active assignment、assignment_version
 * 与 task revision。交接包事件是 human-only 房间提示，不创建 delivery、不增加
 * Agent pending_count、不推进 rooms.head_seq。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  TaskHandoffAuthorizeInput,
  TaskHandoffItemInput,
  TaskHandoffPackCreateInput,
  TaskHandoffPackGetInput,
  TaskHandoffRequestMoreInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import { guardSql } from '../storage/guards';
import {
  getDriveFile,
  getLatestTaskHandoffPack,
  getMessage,
  getOperation,
  getRoom,
  getRoomFile,
  getTask,
  getTaskAssignment,
  getTaskHandoffItem,
  getTaskHandoffPack,
  getTaskHandoffPackForAssignment,
  getTaskTransfer,
  listTaskHandoffContextRequests,
  listTaskHandoffItems,
} from '../storage/queries';
import type {
  DriveFileRow,
  MessageRow,
  RoomFileRow,
  RoomMemberRow,
  RoomRow,
  TaskHandoffContextRequestRow,
  TaskHandoffItemKind,
  TaskHandoffItemRow,
  TaskHandoffPackRow,
  TaskRow,
  TaskSubmissionRow,
  TaskTransferRow,
} from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { driveFileUsable, roomFileUsable, roomFileUrls } from './file-access';
import { actorId, type Principal } from './principal';
import { historyBoundary, visibleCreated, type HistoryBoundary } from './room-history';
import {
  activeAssignmentGuard,
  actualTaskState,
  actorNames,
  isOwnerOrAdmin,
  memberGuard,
  normalizeTaskBody,
  requireVisibleTask,
  taskRevisionGuard,
  taskRoomEvent,
  taskStateGuard,
  type TaskContext,
} from './tasks';

export interface TaskHandoffFileView {
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  available: boolean;
  public_url: string | null;
  preview_url: string | null;
  download_url: string | null;
}

export interface TaskHandoffMessageView {
  message_id: string;
  created_at: string;
  /** 只返回消息预览；不返回完整正文，避免把群历史复制进包。 */
  preview: string;
}

export interface TaskHandoffSubmissionView {
  submission_id: string;
  version: number;
  status: TaskSubmissionRow['status'];
}

export interface TaskHandoffPackItemView {
  item_id: string;
  kind: TaskHandoffItemKind;
  ref: string;
  label: string;
  summary: string | null;
  source_room_id: string | null;
  source_scope: 'task_room' | 'external';
  required: boolean;
  authorized: boolean;
  authorized_by: string | null;
  authorized_by_name: string | null;
  authorized_at: string | null;
  revoked_at: string | null;
  note: string | null;
  status: 'available' | 'missing' | 'omitted';
  reason: string | null;
  /** 外部分支/提交/测试引用只记录，不在服务端抓取。 */
  verified: boolean;
  file: TaskHandoffFileView | null;
  message: TaskHandoffMessageView | null;
  submission: TaskHandoffSubmissionView | null;
}

export interface TaskHandoffGapView {
  item_id: string;
  kind: TaskHandoffItemKind;
  ref: string;
  label: string;
  required: boolean;
  status: 'missing' | 'omitted';
  reason: string;
}

export interface TaskHandoffRequestView {
  context_request_id: string;
  requested_by: string;
  requested_by_name: string;
  note: string;
  created_at: string;
}

export interface TaskHandoffPackView {
  pack_id: string;
  task_id: string;
  room_id: string;
  version: number;
  latest_version: number;
  versions: number[];
  from_assignment_id: string | null;
  from_assignment_version: number;
  from_owner_actor_id: string | null;
  from_owner_name: string | null;
  created_by: string;
  created_by_name: string;
  goal: string;
  completed: string[];
  current_result: {
    summary: string;
    submission_id: string | null;
    submission_version: number | null;
    submission_status: TaskSubmissionRow['status'] | null;
  };
  unresolved: string[];
  next_steps: string[];
  source_room_id: string | null;
  created_at: string;
  items: TaskHandoffPackItemView[];
  missing: TaskHandoffGapView[];
  omitted: TaskHandoffGapView[];
  required_missing: string[];
  context_ready: boolean;
  context_incomplete: boolean;
  viewer_is_successor: boolean;
  can_authorize: boolean;
  can_request_more: boolean;
  requests: TaskHandoffRequestView[];
}

export interface TaskHandoffPackResult {
  pack: TaskHandoffPackView;
}

export interface TaskHandoffRequestResult {
  pack: TaskHandoffPackView;
  request: TaskHandoffRequestView;
}

export interface HandoffReadiness {
  /** 没有包时为 false，保持 D04 的兼容语义。 */
  context_ready: boolean;
  has_pack: boolean;
  pack_id: string | null;
  pack_version: number | null;
  required_missing: number;
}

interface PackContext {
  publicOrigin: string;
  ticketSecret: string;
  at: number;
}

interface ViewerScope {
  actor: string;
  room: RoomRow;
  member: RoomMemberRow;
  boundary: HistoryBoundary;
}

interface ItemEvaluation {
  status: 'available' | 'missing' | 'omitted';
  reason: string | null;
  sourceRoomId: string | null;
  external: boolean;
  message: MessageRow | null;
  roomFile: RoomFileRow | null;
  drive: DriveFileRow | null;
  submission: TaskSubmissionRow | null;
}

interface NormalizedItem {
  kind: TaskHandoffItemKind;
  reference: string;
  label: string;
  summary: string;
  sourceRoomId: string | null;
  required: boolean;
  note: string;
}

interface NormalizedPack {
  goal: string;
  completed: string[];
  currentResult: {
    summary: string;
    submissionId: string | null;
    submissionVersion: number | null;
  };
  unresolved: string[];
  nextSteps: string[];
  sourceRoomId: string | null;
  items: NormalizedItem[];
}

function invalid(message: string, details?: Record<string, unknown>): BusinessError {
  return new BusinessError('INVALID_ARGUMENT', message, details);
}

function text(value: string | undefined, label: string, maxBytes: number): string {
  const normalized = normalizeTaskBody(value, label, maxBytes);
  if (value !== undefined && value.trim().length > 0 && normalized.length === 0) {
    throw invalid(`${label}不能为空`);
  }
  return normalized;
}

function textList(
  values: string[] | undefined,
  label: string,
  maxItems: number,
  maxBytes: number,
): string[] {
  if (!values) return [];
  if (values.length > maxItems) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', `${label}最多 ${maxItems} 条`, {
      count: values.length,
      max: maxItems,
    });
  }
  return values
    .map((value, index) => text(value, `${label}第 ${index + 1} 项`, maxBytes))
    .filter((value) => value.length > 0);
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseCurrentResult(raw: string): {
  summary: string;
  submission_id: string | null;
  submission_version: number | null;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { summary: '', submission_id: null, submission_version: null };
    }
    const record = parsed as Record<string, unknown>;
    return {
      summary: typeof record.summary === 'string' ? record.summary : '',
      submission_id: typeof record.submission_id === 'string' ? record.submission_id : null,
      submission_version:
        typeof record.submission_version === 'number' ? record.submission_version : null,
    };
  } catch {
    return { summary: '', submission_id: null, submission_version: null };
  }
}

function noteOf(raw: string): string | null {
  return raw.trim().length > 0 ? raw : null;
}

async function getSubmissionRow(
  db: D1Database,
  submissionId: string,
): Promise<TaskSubmissionRow | null> {
  return db
    .prepare('SELECT * FROM task_submissions WHERE submission_id = ?')
    .bind(submissionId)
    .first<TaskSubmissionRow>();
}

async function viewerScope(
  db: D1Database,
  room: RoomRow,
  actor: string,
): Promise<ViewerScope | null> {
  const member = await db
    .prepare(
      `SELECT * FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
    )
    .bind(room.room_id, actor)
    .first<RoomMemberRow>();
  if (!member) return null;
  return { actor, room, member, boundary: historyBoundary(room, member) };
}

async function sourceScopeValid(
  db: D1Database,
  sourceRoomId: string,
  actor: string,
  roomFile: RoomFileRow | null,
  message: MessageRow | null,
  at: number,
): Promise<boolean> {
  const [room, member] = await Promise.all([
    getRoom(db, sourceRoomId),
    db
      .prepare(
        `SELECT * FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
      )
      .bind(sourceRoomId, actor)
      .first<RoomMemberRow>(),
  ]);
  if (!room || !member || member.status !== 'active') return false;
  const boundary = historyBoundary(room, member);
  if (message) return message.room_id === sourceRoomId && visibleCreated(message, boundary);
  if (roomFile) {
    return (
      roomFile.room_id === sourceRoomId &&
      roomFileUsable(roomFile, at) &&
      visibleCreated(roomFile, boundary)
    );
  }
  return true;
}

/**
 * 评估单个引用对读者是否可用。
 *
 * 同房间引用按读者自己的成员边界判断；跨范围引用必须显式授权，并持续校验
 * 授权人仍能看到源材料。包内文字不参与授权判定。
 */
async function evaluateItem(
  db: D1Database,
  pack: TaskHandoffPackRow,
  item: TaskHandoffItemRow,
  viewer: ViewerScope,
  at: number,
): Promise<ItemEvaluation> {
  const base: ItemEvaluation = {
    status: 'available',
    reason: null,
    sourceRoomId: item.source_room_id,
    external: false,
    message: null,
    roomFile: null,
    drive: null,
    submission: null,
  };

  if (item.kind === 'branch' || item.kind === 'commit' || item.kind === 'test') {
    return base;
  }

  if (item.kind === 'submission') {
    const submission = await getSubmissionRow(db, item.reference);
    if (!submission || submission.task_id !== pack.task_id) {
      return { ...base, status: 'missing', reason: 'submission_not_found' };
    }
    return { ...base, submission };
  }

  if (item.kind === 'message') {
    const message = await getMessage(db, item.reference);
    if (!message) return { ...base, status: 'missing', reason: 'message_not_found' };
    const sourceRoomId = item.source_room_id ?? pack.room_id;
    const external = sourceRoomId !== pack.room_id;
    if (!external) {
      if (message.room_id !== pack.room_id || !visibleCreated(message, viewer.boundary)) {
        return { ...base, status: 'missing', reason: 'message_not_visible' };
      }
      return { ...base, sourceRoomId, message };
    }
    if (item.revoked_at !== null) return { ...base, sourceRoomId, external, status: 'omitted', reason: 'revoked' };
    if (item.authorized !== 1) {
      return { ...base, sourceRoomId, external, status: 'omitted', reason: 'not_authorized' };
    }
    const valid = await sourceScopeValid(
      db,
      sourceRoomId,
      item.authorized_by ?? '',
      null,
      message,
      at,
    );
    if (!valid) {
      return {
        ...base,
        sourceRoomId,
        external,
        message,
        status: 'omitted',
        reason: 'authorization_source_lost',
      };
    }
    return { ...base, sourceRoomId, external, message };
  }

  // file
  const roomFile = await getRoomFile(db, item.reference);
  const drive = await getDriveFile(db, item.reference);
  if (!roomFile && (!drive || !driveFileUsable(drive, at))) {
    return { ...base, status: 'missing', reason: 'file_not_found' };
  }
  const sourceRoomId = roomFile ? (item.source_room_id ?? pack.room_id) : null;
  const external = roomFile ? sourceRoomId !== pack.room_id : true;
  if (!external && roomFile) {
    if (roomFile.room_id !== pack.room_id || !roomFileUsable(roomFile, at)) {
      return { ...base, sourceRoomId, roomFile, drive, status: 'missing', reason: 'file_unavailable' };
    }
    if (!visibleCreated(roomFile, viewer.boundary)) {
      return { ...base, sourceRoomId, roomFile, drive, status: 'missing', reason: 'file_not_visible' };
    }
    return { ...base, sourceRoomId, roomFile, drive };
  }
  if (item.revoked_at !== null) {
    return { ...base, sourceRoomId, external, roomFile, drive, status: 'omitted', reason: 'revoked' };
  }
  if (item.authorized !== 1) {
    return {
      ...base,
      sourceRoomId,
      external,
      roomFile,
      drive,
      status: 'omitted',
      reason: 'not_authorized',
    };
  }
  if (roomFile && (!roomFileUsable(roomFile, at))) {
    return { ...base, sourceRoomId, external, roomFile, drive, status: 'missing', reason: 'file_unavailable' };
  }
  if (!roomFile && (!drive || !driveFileUsable(drive, at))) {
    return { ...base, sourceRoomId, external, drive, status: 'missing', reason: 'file_unavailable' };
  }
  const valid = roomFile
    ? await sourceScopeValid(db, sourceRoomId ?? '', item.authorized_by ?? '', roomFile, null, at)
    : drive !== null && drive.uploader_id === item.authorized_by;
  if (!valid) {
    return {
      ...base,
      sourceRoomId,
      external,
      roomFile,
      drive,
      status: 'omitted',
      reason: 'authorization_source_lost',
    };
  }
  return { ...base, sourceRoomId, external, roomFile, drive };
}

async function buildItemView(
  db: D1Database,
  pack: TaskHandoffPackRow,
  item: TaskHandoffItemRow,
  evaluation: ItemEvaluation,
  viewer: ViewerScope,
  context: PackContext,
  names: Map<string, string>,
): Promise<TaskHandoffPackItemView> {
  const available = evaluation.status === 'available';
  let file: TaskHandoffFileView | null = null;
  if (item.kind === 'file' && available) {
    const meta = evaluation.roomFile ?? evaluation.drive;
    const urls = meta
      ? roomFileUrls(
          context.ticketSecret,
          context.publicOrigin,
          item.reference,
          pack.room_id,
          viewer.actor,
          viewer.boundary,
        )
      : null;
    file = meta
      ? {
          file_id: item.reference,
          name: meta.name,
          mime_type: meta.mime_type,
          size: meta.size,
          sha256: meta.sha256,
          available: true,
          public_url: urls?.public_url ?? null,
          preview_url: urls?.preview_url ?? null,
          download_url: urls?.download_url ?? null,
        }
      : null;
  }
  return {
    item_id: item.item_id,
    kind: item.kind,
    ref: item.reference,
    label: item.label,
    summary: noteOf(item.summary),
    source_room_id: evaluation.sourceRoomId,
    source_scope: evaluation.external ? 'external' : 'task_room',
    required: item.required === 1,
    authorized: item.authorized === 1,
    authorized_by: item.authorized_by,
    authorized_by_name: item.authorized_by
      ? (names.get(item.authorized_by) ?? item.authorized_by)
      : null,
    authorized_at: item.authorized_at === null ? null : String(item.authorized_at),
    revoked_at: item.revoked_at === null ? null : String(item.revoked_at),
    note: noteOf(item.note),
    status: evaluation.status,
    reason: evaluation.reason,
    verified: item.kind === 'message' || item.kind === 'file' || item.kind === 'submission',
    file,
    message:
      available && evaluation.message
        ? {
            message_id: evaluation.message.message_id,
            created_at: String(evaluation.message.created_at),
            preview: evaluation.message.preview,
          }
        : null,
    submission:
      available && evaluation.submission
        ? {
            submission_id: evaluation.submission.submission_id,
            version: evaluation.submission.version,
            status: evaluation.submission.status,
          }
        : null,
  };
}

function gapOf(view: TaskHandoffPackItemView): TaskHandoffGapView | null {
  if (view.status === 'available') return null;
  return {
    item_id: view.item_id,
    kind: view.kind,
    ref: view.ref,
    label: view.label,
    required: view.required,
    status: view.status,
    reason: view.reason ?? 'unavailable',
  };
}

function normalizePackInput(input: TaskHandoffPackCreateInput): NormalizedPack {
  const goal = text(input.goal, '交接目标', LIMITS.taskHandoffGoalBytes);
  if (!goal) throw invalid('交接目标不能为空');
  const summary = text(
    input.current_result.summary,
    '当前结果摘要',
    LIMITS.taskHandoffResultSummaryBytes,
  );
  if (!summary) throw invalid('当前结果摘要不能为空');
  return {
    goal,
    completed: textList(
      input.completed,
      '已完成事项',
      LIMITS.taskHandoffSectionItemsMax,
      LIMITS.taskHandoffSectionItemBytes,
    ),
    currentResult: {
      summary,
      submissionId: input.current_result.submission_id ?? null,
      submissionVersion: input.current_result.submission_version ?? null,
    },
    unresolved: textList(
      input.unresolved,
      '未解决问题',
      LIMITS.taskHandoffSectionItemsMax,
      LIMITS.taskHandoffSectionItemBytes,
    ),
    nextSteps: textList(
      input.next_steps,
      '下一步',
      LIMITS.taskHandoffSectionItemsMax,
      LIMITS.taskHandoffSectionItemBytes,
    ),
    sourceRoomId: input.source_room_id ?? null,
    items: [],
  };
}

async function requireSourceAccess(
  db: D1Database,
  roomId: string,
  actor: string,
  roomFile: RoomFileRow | null,
  message: MessageRow | null,
): Promise<void> {
  const valid = await sourceScopeValid(db, roomId, actor, roomFile, message, Date.now());
  if (!valid) throw new BusinessError('NOT_FOUND', '引用的材料不存在或当前不可见');
}

function normalizeItems(inputs: TaskHandoffItemInput[] | undefined): NormalizedItem[] {
  if (!inputs || inputs.length === 0) return [];
  if (inputs.length > LIMITS.taskHandoffItemsMax) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `交接包引用最多 ${LIMITS.taskHandoffItemsMax} 条`,
      { count: inputs.length, max: LIMITS.taskHandoffItemsMax },
    );
  }
  return inputs.map((input, index) => {
    const label = text(input.label, `引用第 ${index + 1} 项标签`, LIMITS.taskHandoffItemLabelBytes);
    const summary = normalizeTaskBody(
      input.summary,
      `引用第 ${index + 1} 项摘要`,
      LIMITS.taskHandoffItemSummaryBytes,
    );
    const reference = text(
      input.ref,
      `引用第 ${index + 1} 项`,
      LIMITS.taskHandoffReferenceBytes,
    );
    if (!reference) throw invalid(`引用第 ${index + 1} 项不能为空`);
    return {
      kind: input.kind,
      reference,
      label,
      summary,
      sourceRoomId: input.source_room_id ?? null,
      required: input.required === true,
      note: '',
    };
  });
}

async function validateItems(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  inputs: TaskHandoffItemInput[] | undefined,
): Promise<NormalizedItem[]> {
  const result = normalizeItems(inputs);
  for (const [index, item] of result.entries()) {
    let sourceRoomId = item.sourceRoomId;

    if (item.kind === 'message') {
      sourceRoomId = sourceRoomId ?? task.room_id;
      const message = await getMessage(db, item.reference);
      if (!message || message.room_id !== sourceRoomId) {
        throw new BusinessError('NOT_FOUND', '引用的消息不存在或不属于该范围');
      }
      await requireSourceAccess(db, sourceRoomId, context.caller, null, message);
    } else if (item.kind === 'file') {
      const roomFile = await getRoomFile(db, item.reference);
      if (roomFile) {
        sourceRoomId = sourceRoomId ?? task.room_id;
        if (roomFile.room_id !== sourceRoomId) {
          throw new BusinessError('NOT_FOUND', '引用的文件不存在或不属于该范围');
        }
        if (!roomFileUsable(roomFile)) {
          throw new BusinessError('FILE_UNAVAILABLE', '引用的文件已删除或过期');
        }
        await requireSourceAccess(db, sourceRoomId, context.caller, roomFile, null);
      } else {
        const drive = await getDriveFile(db, item.reference);
        if (!drive || !driveFileUsable(drive) || drive.uploader_id !== context.caller) {
          throw new BusinessError('NOT_FOUND', '引用的文件不存在或当前不可见');
        }
        // 草稿没有房间归属；保留调用方提供的源范围仅作展示。
      }
    } else if (item.kind === 'submission') {
      const submission = await getSubmissionRow(db, item.reference);
      if (!submission || submission.task_id !== task.task_id) {
        throw new BusinessError('NOT_FOUND', '引用的成果版本不存在或不属于该任务');
      }
      sourceRoomId = null;
    } else {
      sourceRoomId = null;
    }
    result[index] = { ...item, sourceRoomId };
  }
  return result;
}

async function resolveSuccessorScope(
  db: D1Database,
  pack: TaskHandoffPackRow,
): Promise<ViewerScope | null> {
  const transfer = await db
    .prepare(
      `SELECT * FROM task_transfers
        WHERE task_id = ? AND status = 'pending'
          AND (from_assignment_id IS NULL OR from_assignment_id = ?)
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(pack.task_id, pack.from_assignment_id)
    .first<TaskTransferRow>();
  const task = await getTask(db, pack.task_id);
  const actor = transfer?.to_actor_id ?? task?.owner_actor_id ?? pack.from_owner_actor_id;
  if (!actor) return null;
  const room = await getRoom(db, pack.room_id);
  if (!room) return null;
  return viewerScope(db, room, actor);
}

async function readinessFor(
  db: D1Database,
  pack: TaskHandoffPackRow,
  successor: ViewerScope | null,
  at: number,
  itemsOverride?: TaskHandoffItemRow[],
): Promise<{ ready: boolean; requiredMissing: string[] }> {
  const items = itemsOverride ?? (await listTaskHandoffItems(db, pack.pack_id));
  const current = parseCurrentResult(pack.current_result_json);
  let submissionMissing = false;
  if (current.submission_id) {
    const submission = await getSubmissionRow(db, current.submission_id);
    submissionMissing =
      !submission ||
      submission.task_id !== pack.task_id ||
      (current.submission_version !== null && submission.version !== current.submission_version);
  }
  if (!successor) {
    return {
      ready: false,
      requiredMissing: items.filter((item) => item.required === 1).map((item) => item.item_id),
    };
  }
  const requiredMissing: string[] = [];
  for (const item of items) {
    if (item.required !== 1) continue;
    const evaluation = await evaluateItem(db, pack, item, successor, at);
    if (evaluation.status !== 'available') requiredMissing.push(item.item_id);
  }
  return { ready: !submissionMissing && requiredMissing.length === 0, requiredMissing };
}

async function buildPackView(
  db: D1Database,
  pack: TaskHandoffPackRow,
  viewer: ViewerScope,
  context: PackContext,
  options: {
    items?: TaskHandoffItemRow[];
    requests?: TaskHandoffContextRequestRow[];
  } = {},
): Promise<TaskHandoffPackView> {
  const [task, itemRows, requestRows, versionRows, successor] = await Promise.all([
    getTask(db, pack.task_id),
    options.items ? Promise.resolve(options.items) : listTaskHandoffItems(db, pack.pack_id),
    options.requests
      ? Promise.resolve(options.requests)
      : listTaskHandoffContextRequests(db, pack.pack_id, LIMITS.taskHandoffRequestListMax),
    db
      .prepare(
        `SELECT version FROM task_handoff_packs
          WHERE task_id = ?
          ORDER BY version DESC
          LIMIT ?`,
      )
      .bind(pack.task_id, LIMITS.taskHandoffRequestListMax)
      .all<{ version: number }>(),
    resolveSuccessorScope(db, pack),
  ]);
  if (!task) throw new BusinessError('NOT_FOUND', '任务不存在');

  const names = await actorNames(db, [
    pack.created_by,
    ...(pack.from_owner_actor_id ? [pack.from_owner_actor_id] : []),
    ...itemRows.flatMap((item) => (item.authorized_by ? [item.authorized_by] : [])),
    ...requestRows.map((request) => request.requested_by),
  ]);

  const evaluations = new Map<string, ItemEvaluation>();
  const itemViews: TaskHandoffPackItemView[] = [];
  for (const item of itemRows) {
    const evaluation = await evaluateItem(db, pack, item, viewer, context.at);
    evaluations.set(item.item_id, evaluation);
    itemViews.push(
      await buildItemView(db, pack, item, evaluation, viewer, context, names),
    );
  }

  const [readiness, transferTarget] = await Promise.all([
    readinessFor(db, pack, successor, context.at, itemRows),
    db
      .prepare(
        `SELECT to_actor_id FROM task_transfers
          WHERE task_id = ? AND status = 'pending'
            AND (from_assignment_id IS NULL OR from_assignment_id = ?)
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .bind(pack.task_id, pack.from_assignment_id)
      .first<{ to_actor_id: string }>(),
  ]);
  const manager = task.owner_actor_id === viewer.actor;
  const successorActor = successor?.actor ?? null;
  const current = parseCurrentResult(pack.current_result_json);
  const currentSubmission = current.submission_id
    ? await getSubmissionRow(db, current.submission_id)
    : null;
  const gaps = itemViews.map(gapOf).filter((gap): gap is TaskHandoffGapView => gap !== null);
  const requiredMissing = itemViews
    .filter((item) => item.required && item.status !== 'available')
    .map((item) => item.item_id);

  return {
    pack_id: pack.pack_id,
    task_id: pack.task_id,
    room_id: pack.room_id,
    version: pack.version,
    latest_version: versionRows.results[0]?.version ?? pack.version,
    versions: versionRows.results.map((row) => row.version),
    from_assignment_id: pack.from_assignment_id,
    from_assignment_version: pack.from_assignment_version,
    from_owner_actor_id: pack.from_owner_actor_id,
    from_owner_name: pack.from_owner_actor_id
      ? (names.get(pack.from_owner_actor_id) ?? null)
      : null,
    created_by: pack.created_by,
    created_by_name: names.get(pack.created_by) ?? '',
    goal: pack.goal,
    completed: parseJsonArray(pack.completed_json),
    current_result: {
      summary: current.summary,
      submission_id: current.submission_id,
      submission_version: currentSubmission?.version ?? current.submission_version,
      submission_status: currentSubmission?.status ?? null,
    },
    unresolved: parseJsonArray(pack.unresolved_json),
    next_steps: parseJsonArray(pack.next_steps_json),
    source_room_id: pack.source_room_id,
    created_at: String(pack.created_at),
    items: itemViews,
    missing: gaps.filter((gap) => gap.status === 'missing'),
    omitted: gaps.filter((gap) => gap.status === 'omitted'),
    required_missing: readiness.requiredMissing,
    context_ready: readiness.ready,
    context_incomplete: !readiness.ready,
    viewer_is_successor: successorActor === viewer.actor,
    can_authorize:
      manager &&
      itemRows.some((item) => evaluations.get(item.item_id)?.external === true),
    can_request_more:
      task.owner_actor_id === viewer.actor || transferTarget?.to_actor_id === viewer.actor,
    requests: requestRows.map((request) => ({
      context_request_id: request.context_request_id,
      requested_by: request.requested_by,
      requested_by_name: names.get(request.requested_by) ?? '',
      note: request.note,
      created_at: String(request.created_at),
    })),
  };
}

async function loadPackForGet(
  db: D1Database,
  input: TaskHandoffPackGetInput,
): Promise<TaskHandoffPackRow> {
  let pack: TaskHandoffPackRow | null = null;
  if (input.pack_id) {
    pack = await getTaskHandoffPack(db, input.pack_id);
    if (pack && pack.task_id !== input.task_id) pack = null;
  } else if (input.version !== undefined) {
    pack = await db
      .prepare('SELECT * FROM task_handoff_packs WHERE task_id = ? AND version = ?')
      .bind(input.task_id, input.version)
      .first<TaskHandoffPackRow>();
  } else {
    pack = await getLatestTaskHandoffPack(db, input.task_id);
  }
  if (!pack) throw new BusinessError('NOT_FOUND', '交接包不存在');
  return pack;
}

async function canViewPack(
  db: D1Database,
  task: TaskRow,
  pack: TaskHandoffPackRow,
  context: TaskContext,
): Promise<boolean> {
  if (
    context.caller === pack.created_by ||
    context.caller === task.created_by ||
    context.caller === task.reviewer_actor_id ||
    context.caller === task.owner_actor_id ||
    isOwnerOrAdmin(context.room, context.member)
  ) {
    return true;
  }
  const transfer = await db
    .prepare(
      `SELECT 1 AS n FROM task_transfers
        WHERE task_id = ? AND status = 'pending' AND to_actor_id = ?
          AND (from_assignment_id IS NULL OR from_assignment_id = ?)
        LIMIT 1`,
    )
    .bind(task.task_id, context.caller, pack.from_assignment_id)
    .first<{ n: number }>();
  return transfer !== null;
}

function packRow(input: {
  task: TaskRow;
  assignment: { assignment_id: string; assignment_version: number; owner_actor_id: string };
  createdBy: string;
  version: number;
  goal: string;
  completed: string[];
  currentResult: NormalizedPack['currentResult'];
  unresolved: string[];
  nextSteps: string[];
  sourceRoomId: string | null;
  at: number;
}): TaskHandoffPackRow {
  return {
    pack_id: newId('hpf'),
    task_id: input.task.task_id,
    room_id: input.task.room_id,
    version: input.version,
    from_assignment_id: input.assignment.assignment_id,
    from_assignment_version: input.assignment.assignment_version,
    from_owner_actor_id: input.assignment.owner_actor_id,
    created_by: input.createdBy,
    goal: input.goal,
    completed_json: JSON.stringify(input.completed),
    current_result_json: JSON.stringify({
      summary: input.currentResult.summary,
      submission_id: input.currentResult.submissionId,
      submission_version: input.currentResult.submissionVersion,
    }),
    unresolved_json: JSON.stringify(input.unresolved),
    next_steps_json: JSON.stringify(input.nextSteps),
    source_room_id: input.sourceRoomId,
    created_at: input.at,
  };
}

function isHandoffVersionConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    text.includes('idx_task_handoff_packs_version') ||
    text.includes('UNIQUE constraint failed: task_handoff_packs.task_id, task_handoff_packs.version')
  );
}

export async function taskHandoffPackCreate(
  db: D1Database,
  principal: Principal,
  input: TaskHandoffPackCreateInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<TaskHandoffPackResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const normalized = normalizePackInput(input);
  normalized.items = normalizeItems(input.items);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      assignment_id: input.assignment_id,
      assignment_version: input.assignment_version,
      expected_revision: input.expected_revision ?? null,
      goal: normalized.goal,
      completed: normalized.completed,
      current_result: normalized.currentResult,
      unresolved: normalized.unresolved,
      next_steps: normalized.nextSteps,
      items: normalized.items,
      transfer_id: input.transfer_id ?? null,
      source_room_id: normalized.sourceRoomId,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskHandoffPackResult;
  normalized.items = await validateItems(db, context, task, input.items);

  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'in_progress' && task.status !== 'blocked') {
    throw new BusinessError('CONFLICT', '只有进行中或受阻任务可以生成交接包', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (
    !assignment ||
    assignment.status !== 'active' ||
    assignment.assignment_id !== input.assignment_id ||
    assignment.assignment_version !== input.assignment_version
  ) {
    throw new BusinessError('ASSIGNMENT_STALE', '交接包引用的执行资格不是当前 active assignment', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (
    assignment.owner_actor_id !== context.caller ||
    task.owner_actor_id !== context.caller
  ) {
    throw new BusinessError('PERMISSION_DENIED', '只有当前负责人可以生成交接包');
  }
  const at = nowMs();
  if (input.transfer_id) {
    const transfer = await getTaskTransfer(db, input.transfer_id);
    if (!transfer || transfer.task_id !== task.task_id) {
      throw new BusinessError('NOT_FOUND', '交接提议不存在');
    }
    if (transfer.status !== 'pending') {
      throw new BusinessError('CONFLICT', '交接提议已结束，不能绑定交接包', {
        transfer_id: transfer.transfer_id,
        status: transfer.status,
      });
    }
    if (transfer.expires_at <= at) {
      throw new BusinessError('REQUEST_EXPIRED', '交接提议已过期', {
        transfer_id: transfer.transfer_id,
      });
    }
    if (
      transfer.from_assignment_id !== assignment.assignment_id ||
      transfer.from_assignment_version !== assignment.assignment_version
    ) {
      throw new BusinessError('ASSIGNMENT_STALE', '交接提议对应的执行资格已失效');
    }
  }
  if (normalized.sourceRoomId) {
    const sourceRoom = await getRoom(db, normalized.sourceRoomId);
    if (!sourceRoom) throw new BusinessError('NOT_FOUND', '源范围不存在');
    const member = await db
      .prepare(
        `SELECT 1 AS n FROM room_members
          WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
      )
      .bind(sourceRoom.room_id, context.caller)
      .first<{ n: number }>();
    if (!member) throw new BusinessError('NOT_FOUND', '源范围不存在');
  }

  let submissionId = normalized.currentResult.submissionId;
  let submissionVersion = normalized.currentResult.submissionVersion;
  if (submissionId) {
    const submission = await getSubmissionRow(db, submissionId);
    if (!submission || submission.task_id !== task.task_id) {
      throw new BusinessError('NOT_FOUND', '当前结果引用的成果版本不存在');
    }
    if (submissionVersion !== null && submission.version !== submissionVersion) {
      throw new BusinessError('CONFLICT', '当前结果引用的成果版本已变化', {
        submission_id: submissionId,
        version: submission.version,
        expected: submissionVersion,
      });
    }
    submissionVersion = submission.version;
  } else if (submissionVersion !== null) {
    throw invalid('指定 submission_version 时必须同时提供 submission_id');
  }

  const versionRow = await db
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM task_handoff_packs WHERE task_id = ?')
    .bind(task.task_id)
    .first<{ version: number }>();
  const version = versionRow?.version ?? 1;
  const pack = packRow({
    task,
    assignment,
    createdBy: context.caller,
    version,
    goal: normalized.goal,
    completed: normalized.completed,
    currentResult: { ...normalized.currentResult, submissionVersion },
    unresolved: normalized.unresolved,
    nextSteps: normalized.nextSteps,
    sourceRoomId: normalized.sourceRoomId,
    at,
  });
  const itemRows: TaskHandoffItemRow[] = normalized.items.map((item, index) => ({
    item_id: newId('hpi'),
    pack_id: pack.pack_id,
    kind: item.kind,
    reference: item.reference,
    label: item.label,
    summary: item.summary,
    source_room_id: item.sourceRoomId,
    required: item.required ? 1 : 0,
    authorized: 0,
    authorized_by: null,
    authorized_at: null,
    revoked_by: null,
    revoked_at: null,
    note: item.note,
    created_at: at + index,
  }));
  const viewer: ViewerScope = {
    actor: context.caller,
    room: context.room,
    member: context.member,
    boundary: context.boundary,
  };
  const createdView = await buildPackView(
    db,
    pack,
    viewer,
    { publicOrigin, ticketSecret, at },
    { items: itemRows, requests: [] },
  );
  // 事务尚未提交，版本列表查不到本行；创建响应必须包含刚生成的版本，
  // 否则 latest_version 会回退到上一版，与 version 自相矛盾。
  const result: TaskHandoffPackResult = {
    pack: {
      ...createdView,
      latest_version: version,
      versions: Array.from(new Set([version, ...createdView.versions])).sort(
        (left, right) => right - left,
      ),
    },
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
          "status IN ('in_progress', 'blocked') AND current_assignment_id = ? AND owner_actor_id = ?",
          assignment.assignment_id,
          context.caller,
        ),
        activeAssignmentGuard(db, assignment),
        db
          .prepare(
            guardSql(
              'handoffConflict',
              `EXISTS (
                 SELECT 1 FROM task_handoff_packs WHERE task_id = ? AND version = ?
               )`,
            ),
          )
          .bind(task.task_id, version),
        db
          .prepare(
            `INSERT INTO task_handoff_packs
               (pack_id, task_id, room_id, version, from_assignment_id,
                from_assignment_version, from_owner_actor_id, created_by, goal,
                completed_json, current_result_json, unresolved_json, next_steps_json,
                source_room_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            pack.pack_id,
            pack.task_id,
            pack.room_id,
            pack.version,
            pack.from_assignment_id,
            pack.from_assignment_version,
            pack.from_owner_actor_id,
            pack.created_by,
            pack.goal,
            pack.completed_json,
            pack.current_result_json,
            pack.unresolved_json,
            pack.next_steps_json,
            pack.source_room_id,
            pack.created_at,
          ),
        ...itemRows.map((item) =>
          db
            .prepare(
              `INSERT INTO task_handoff_pack_items
                 (item_id, pack_id, kind, reference, label, summary, source_room_id,
                  required, authorized, authorized_by, authorized_at, revoked_by,
                  revoked_at, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
            )
            .bind(
              item.item_id,
              item.pack_id,
              item.kind,
              item.reference,
              item.label,
              item.summary,
              item.source_room_id,
              item.required,
              item.note,
              item.created_at,
            ),
        ),
        ...taskRoomEvent(
          db,
          task,
          'task_handoff_pack_created',
          `task:handoff-pack:${pack.pack_id}:v${pack.version}`,
          at,
          {
            changed_by: context.caller,
            pack_id: pack.pack_id,
            version: pack.version,
            from_assignment_id: assignment.assignment_id,
            from_assignment_version: assignment.assignment_version,
            item_count: itemRows.length,
            required_count: itemRows.filter((item) => item.required === 1).length,
          },
        ).statements,
      ],
    });
  } catch (error) {
    if (isHandoffVersionConflict(error)) {
      throw new BusinessError('CONFLICT', '交接包版本已变化，请刷新后重试', {
        ...(await actualTaskState(db, task.task_id)),
      });
    }
    throw error;
  }
  return result;
}

export async function taskHandoffPackGet(
  db: D1Database,
  principal: Principal,
  input: TaskHandoffPackGetInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<TaskHandoffPackResult> {
  const pack = await loadPackForGet(db, input);
  const { task, context } = await requireVisibleTask(db, principal, pack.task_id);
  if (!(await canViewPack(db, task, pack, context))) {
    throw new BusinessError('NOT_FOUND', '交接包不存在');
  }
  return {
    pack: await buildPackView(db, pack, {
      actor: context.caller,
      room: context.room,
      member: context.member,
      boundary: context.boundary,
    }, { publicOrigin, ticketSecret, at: nowMs() }),
  };
}

async function requireCurrentAssignment(
  db: D1Database,
  task: TaskRow,
  caller: string,
  assignmentId: string,
  assignmentVersion: number,
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskAssignment>>>> {
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (
    !assignment ||
    assignment.status !== 'active' ||
    assignment.assignment_id !== assignmentId ||
    assignment.assignment_version !== assignmentVersion ||
    assignment.owner_actor_id !== caller ||
    task.owner_actor_id !== caller
  ) {
    throw new BusinessError('ASSIGNMENT_STALE', '当前执行资格已失效', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  return assignment;
}

async function canAuthorizeFileFromSource(
  db: D1Database,
  sourceRoomId: string,
  caller: string,
  roomFile: RoomFileRow,
  at: number,
): Promise<boolean> {
  if (!(await sourceScopeValid(db, sourceRoomId, caller, roomFile, null, at))) return false;
  if (roomFile.uploader_id === caller) return true;
  const [room, member] = await Promise.all([
    getRoom(db, sourceRoomId),
    db
      .prepare(
        `SELECT * FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
      )
      .bind(sourceRoomId, caller)
      .first<RoomMemberRow>(),
  ]);
  if (!room || !member) return false;
  return isOwnerOrAdmin(room, member);
}

export async function taskHandoffAuthorize(
  db: D1Database,
  principal: Principal,
  input: TaskHandoffAuthorizeInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<TaskHandoffPackResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const pack = await getTaskHandoffPack(db, input.pack_id);
  if (!pack || pack.task_id !== task.task_id) {
    throw new BusinessError('NOT_FOUND', '交接包不存在');
  }
  const item = await getTaskHandoffItem(db, input.item_id);
  if (!item || item.pack_id !== pack.pack_id) {
    throw new BusinessError('NOT_FOUND', '交接包引用不存在');
  }
  const note = normalizeTaskBody(input.note, '授权说明', LIMITS.taskHandoffNoteBytes);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      pack_id: pack.pack_id,
      item_id: item.item_id,
      action: input.action,
      note,
      assignment_id: input.assignment_id,
      assignment_version: input.assignment_version,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskHandoffPackResult;

  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'in_progress' && task.status !== 'blocked') {
    throw new BusinessError('CONFLICT', '任务已不在执行阶段，不能修改交接授权', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = await requireCurrentAssignment(
    db,
    task,
    context.caller,
    input.assignment_id,
    input.assignment_version,
  );
  const at = nowMs();
  let nextItem: TaskHandoffItemRow;

  if (input.action === 'grant') {
    if (item.kind !== 'file' && item.kind !== 'message') {
      throw invalid('只有消息或文件引用需要显式授权');
    }
    if (item.kind === 'file') {
      const roomFile = await getRoomFile(db, item.reference);
      if (roomFile) {
        const sourceRoomId = item.source_room_id ?? pack.room_id;
        if (sourceRoomId === pack.room_id) {
          throw invalid('同一任务房间的材料不需要跨范围授权');
        }
        if (roomFile.room_id !== sourceRoomId) {
          throw new BusinessError('NOT_FOUND', '引用的文件不存在或不属于该范围');
        }
        if (!roomFileUsable(roomFile)) {
          throw new BusinessError('FILE_UNAVAILABLE', '引用的文件已删除或过期');
        }
        if (
          !(await canAuthorizeFileFromSource(db, sourceRoomId, context.caller, roomFile, at))
        ) {
          throw new BusinessError('PERMISSION_DENIED', '只有源文件上传者或源房间 owner 可以授权');
        }
      } else {
        const drive = await getDriveFile(db, item.reference);
        if (!drive || !driveFileUsable(drive, at) || drive.uploader_id !== context.caller) {
          throw new BusinessError('PERMISSION_DENIED', '只有文件上传者可以授权');
        }
        if (item.source_room_id === pack.room_id) {
          throw invalid('同一任务房间的材料不需要跨范围授权');
        }
      }
    } else {
      const sourceRoomId = item.source_room_id ?? pack.room_id;
      if (sourceRoomId === pack.room_id) {
        throw invalid('同一任务房间的材料不需要跨范围授权');
      }
      const message = await getMessage(db, item.reference);
      if (!message || message.room_id !== sourceRoomId) {
        throw new BusinessError('NOT_FOUND', '引用的消息不存在或不属于该范围');
      }
      if (!(await sourceScopeValid(db, sourceRoomId, context.caller, null, message, at))) {
        throw new BusinessError('PERMISSION_DENIED', '当前身份已不能访问该源消息');
      }
    }
    nextItem = {
      ...item,
      authorized: 1,
      authorized_by: context.caller,
      authorized_at: at,
      revoked_by: null,
      revoked_at: null,
      note: note || item.note,
    };
  } else {
    nextItem = {
      ...item,
      authorized: 0,
      revoked_by: context.caller,
      revoked_at: at,
      note: note || item.note,
    };
  }

  const itemRows = (await listTaskHandoffItems(db, pack.pack_id)).map((row) =>
    row.item_id === item.item_id ? nextItem : row,
  );
  const result: TaskHandoffPackResult = {
    pack: await buildPackView(
      db,
      pack,
      {
        actor: context.caller,
        room: context.room,
        member: context.member,
        boundary: context.boundary,
      },
      { publicOrigin, ticketSecret, at },
      { items: itemRows },
    ),
  };

  const eventType =
    input.action === 'grant' ? 'task_handoff_item_authorized' : 'task_handoff_item_revoked';
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
          "status IN ('in_progress', 'blocked') AND current_assignment_id = ? AND owner_actor_id = ?",
          assignment.assignment_id,
          context.caller,
        ),
        activeAssignmentGuard(db, assignment),
        db
          .prepare(
            guardSql(
              'handoffConflict',
              `NOT EXISTS (
                 SELECT 1 FROM task_handoff_pack_items WHERE item_id = ? AND pack_id = ?
               )`,
            ),
          )
          .bind(item.item_id, pack.pack_id),
        db
          .prepare(
            `UPDATE task_handoff_pack_items
                SET authorized = ?, authorized_by = ?, authorized_at = ?,
                    revoked_by = ?, revoked_at = ?, note = ?
              WHERE item_id = ? AND pack_id = ?`,
          )
          .bind(
            nextItem.authorized,
            nextItem.authorized_by,
            nextItem.authorized_at,
            nextItem.revoked_by,
            nextItem.revoked_at,
            nextItem.note,
            item.item_id,
            pack.pack_id,
          ),
        ...taskRoomEvent(
          db,
          task,
          eventType,
          `task:handoff-item:${item.item_id}:${input.action}:${at}`,
          at,
          {
            changed_by: context.caller,
            pack_id: pack.pack_id,
            version: pack.version,
            item_id: item.item_id,
            kind: item.kind,
            action: input.action,
            required: item.required === 1,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowHandoffConflict(db, task.task_id, error);
  }
  return result;
}

async function rethrowHandoffConflict(
  db: D1Database,
  taskId: string,
  error: unknown,
): Promise<never> {
  if (isHandoffVersionConflict(error)) {
    throw new BusinessError('CONFLICT', '交接包状态已变化，请刷新后重试', {
      ...(await actualTaskState(db, taskId)),
    });
  }
  throw error;
}

export async function taskHandoffRequestMore(
  db: D1Database,
  principal: Principal,
  input: TaskHandoffRequestMoreInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<TaskHandoffRequestResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const pack = input.pack_id
    ? await getTaskHandoffPack(db, input.pack_id)
    : await getLatestTaskHandoffPack(db, task.task_id);
  if (!pack || pack.task_id !== task.task_id) {
    throw new BusinessError('NOT_FOUND', '交接包不存在');
  }
  const note = normalizeTaskBody(input.note, '补充上下文说明', LIMITS.taskHandoffNoteBytes);
  if (!note) throw invalid('补充上下文说明不能为空');
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      pack_id: pack.pack_id,
      transfer_id: input.transfer_id ?? null,
      note,
      assignment_id: input.assignment_id ?? null,
      assignment_version: input.assignment_version ?? null,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskHandoffRequestResult;

  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'in_progress' && task.status !== 'blocked') {
    throw new BusinessError('CONFLICT', '任务已不在执行阶段，不能请求补充上下文', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (!assignment || assignment.status !== 'active') {
    throw new BusinessError('ASSIGNMENT_STALE', '当前执行资格已失效', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const at = nowMs();
  let transfer: TaskTransferRow | null = null;

  if (input.transfer_id) {
    transfer = await getTaskTransfer(db, input.transfer_id);
    if (!transfer || transfer.task_id !== task.task_id) {
      throw new BusinessError('NOT_FOUND', '交接提议不存在');
    }
    if (transfer.to_actor_id !== context.caller) {
      throw new BusinessError('PERMISSION_DENIED', '只有提议的目标可以请求补充上下文');
    }
    if (transfer.status !== 'pending') {
      throw new BusinessError('CONFLICT', '交接提议已结束', {
        transfer_id: transfer.transfer_id,
        status: transfer.status,
      });
    }
    if (transfer.expires_at <= at) {
      throw new BusinessError('REQUEST_EXPIRED', '交接提议已过期', {
        transfer_id: transfer.transfer_id,
      });
    }
    if (
      transfer.from_assignment_id !== assignment.assignment_id ||
      transfer.from_assignment_version !== assignment.assignment_version
    ) {
      throw new BusinessError('ASSIGNMENT_STALE', '交接提议对应的执行资格已失效');
    }
  } else {
    if (input.assignment_id === undefined || input.assignment_version === undefined) {
      throw invalid('当前负责人请求补充上下文时必须提供 assignment_id 与 assignment_version');
    }
    if (
      assignment.assignment_id !== input.assignment_id ||
      assignment.assignment_version !== input.assignment_version ||
      assignment.owner_actor_id !== context.caller ||
      task.owner_actor_id !== context.caller
    ) {
      throw new BusinessError('ASSIGNMENT_STALE', '只有当前负责人可以请求补充上下文');
    }
  }

  const request: TaskHandoffContextRequestRow = {
    context_request_id: newId('hcr'),
    pack_id: pack.pack_id,
    task_id: task.task_id,
    requested_by: context.caller,
    note,
    created_at: at,
  };
  const existingRequests = await listTaskHandoffContextRequests(
    db,
    pack.pack_id,
    LIMITS.taskHandoffRequestListMax,
  );
  const requestRows = [request, ...existingRequests].slice(0, LIMITS.taskHandoffRequestListMax);
  const names = await actorNames(db, [context.caller]);
  const result: TaskHandoffRequestResult = {
    pack: await buildPackView(
      db,
      pack,
      {
        actor: context.caller,
        room: context.room,
        member: context.member,
        boundary: context.boundary,
      },
      { publicOrigin, ticketSecret, at },
      { requests: requestRows },
    ),
    request: {
      context_request_id: request.context_request_id,
      requested_by: request.requested_by,
      requested_by_name: names.get(context.caller) ?? context.caller,
      note: request.note,
      created_at: String(request.created_at),
    },
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
          "status IN ('in_progress', 'blocked') AND current_assignment_id = ? AND owner_actor_id = ?",
          assignment.assignment_id,
          assignment.owner_actor_id,
        ),
        activeAssignmentGuard(db, assignment),
        ...(transfer
          ? [
              db
                .prepare(
                  guardSql(
                    'requestExpired',
                    `EXISTS (
                       SELECT 1 FROM task_transfers
                        WHERE transfer_id = ? AND status = 'pending' AND expires_at <= ?
                     )`,
                  ),
                )
                .bind(transfer.transfer_id, at),
              db
                .prepare(
                  guardSql(
                    'assignmentStale',
                    `NOT EXISTS (
                       SELECT 1 FROM task_transfers
                        WHERE transfer_id = ? AND task_id = ? AND to_actor_id = ?
                          AND status = 'pending' AND from_assignment_id = ?
                          AND from_assignment_version = ? AND expires_at > ?
                     )`,
                  ),
                )
                .bind(
                  transfer.transfer_id,
                  task.task_id,
                  context.caller,
                  assignment.assignment_id,
                  assignment.assignment_version,
                  at,
                ),
            ]
          : []),
        db
          .prepare(
            `INSERT INTO task_handoff_context_requests
               (context_request_id, pack_id, task_id, requested_by, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            request.context_request_id,
            request.pack_id,
            request.task_id,
            request.requested_by,
            request.note,
            request.created_at,
          ),
        ...taskRoomEvent(
          db,
          task,
          'task_handoff_context_requested',
          `task:handoff-context:${request.context_request_id}`,
          at,
          {
            changed_by: context.caller,
            pack_id: pack.pack_id,
            version: pack.version,
            context_request_id: request.context_request_id,
            ...(transfer ? { transfer_id: transfer.transfer_id } : {}),
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowHandoffConflict(db, task.task_id, error);
  }
  return result;
}

/**
 * 供 D04 交接提议读取：最新包对该提议目标是否就绪。
 *
 * 没有包时 `context_ready=false`，保持 D04 兼容；有包时按目标身份重新校验
 * required 引用与 current_result 的 submission 版本。
 */
export async function handoffReadinessForTransfer(
  db: D1Database,
  task: TaskRow,
  assignmentId: string | null,
  targetActor: string,
): Promise<HandoffReadiness> {
  const pack = await getTaskHandoffPackForAssignment(db, task.task_id, assignmentId);
  if (!pack) {
    return {
      context_ready: false,
      has_pack: false,
      pack_id: null,
      pack_version: null,
      required_missing: 0,
    };
  }
  const room = await getRoom(db, pack.room_id);
  const successor = room ? await viewerScope(db, room, targetActor) : null;
  const readiness = await readinessFor(db, pack, successor, Date.now());
  return {
    context_ready: readiness.ready,
    has_pack: true,
    pack_id: pack.pack_id,
    pack_version: pack.version,
    required_missing: readiness.requiredMissing.length,
  };
}
