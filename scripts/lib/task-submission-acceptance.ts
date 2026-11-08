/**
 * D06 成果提交与不可混淆的版本验收（D06-T01..T03）。
 *
 * 实时部分只通过公开 MCP 工具验证提交、退回与版本历史；配额、文件绑定与
 * 事务中断无法在实时服务里稳定制造，改用内存 SQLite 与真实 migrations
 * 直接调用 domain，确认失败路径不会留下 submitted 任务或空提交。
 *
 * 覆盖：
 * - D06-T01 旧执行资格、旧 revision、非负责人提交被拒；提交关闭投递与
 *   pending 交接；重复 request_id 只产生一个版本；
 * - D06-T02 文件绑定失败、过期材料、房间配额与事务中断全部回滚；
 * - D06-T03 退回后原负责人以新 assignment_version 继续，v1 保留，v2
 *   成为当前版本，旧回执不能覆盖新版本，任务卡片/列表指向当前版本。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { McpSubscription } from '@modelcontextprotocol/client';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import type { Principal } from '../../src/domain/principal';
import { taskAccept, taskCreate } from '../../src/domain/tasks';
import {
  taskSubmissionGet,
  taskSubmissionList,
  taskSubmissionReturn,
  taskSubmit,
} from '../../src/domain/task-submissions';
import type { ActorRow } from '../../src/storage/rows';
import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  sleep,
  uploadTestFile,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  registerIdentity,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';
const MIGRATIONS = join(import.meta.dir, '../../migrations');

interface SubmissionSummary {
  submission_id: string;
  version: number;
  status: string;
  submitted_at: string;
}

interface SubmissionMaterial {
  file_id: string;
  label: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  available: boolean;
}

interface SubmissionLink {
  url: string;
  title: string | null;
  version: string | null;
  digest: string | null;
  availability: 'unverified' | 'declared_reachable';
}

interface SubmissionReview {
  reviewer_actor_id: string;
  reviewer_name: string;
  decision: 'accept' | 'return';
  reason: string;
  created_at: string;
}

interface SubmissionView {
  submission_id: string;
  task_id: string;
  room_id: string;
  version: number;
  status: string;
  summary: string;
  materials: SubmissionMaterial[];
  links: SubmissionLink[];
  commit_sha: string | null;
  evidence: string[];
  known_limits: string;
  assignment_id: string;
  assignment_version: number;
  submitted_by: string;
  submitted_by_name: string;
  submitted_at: string;
  reviewed_at: string | null;
  review: SubmissionReview | null;
  is_current: boolean;
}

interface TaskAssignmentView {
  assignment_id: string;
  assignment_version: number;
  owner_actor_id: string;
  status: string;
}

interface TaskView {
  task_id: string;
  room_id: string;
  title: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  reviewer_actor_id: string;
  blocked_reason: string | null;
  assignment: TaskAssignmentView | null;
  delivery_ids: string[];
  current_submission: SubmissionSummary | null;
  can_submit: boolean;
  can_return: boolean;
}

interface TaskResult {
  task: TaskView;
}

interface SubmissionResult {
  submission: SubmissionView;
  task: TaskView;
}

interface SubmissionList {
  submissions: SubmissionView[];
  has_more: boolean;
}

interface StreamItemView {
  source?: string;
  attention?: string;
  task_id?: string;
  change?: string;
  status?: string;
  revision?: number;
  submission_id?: string;
  submission_version?: number;
}

type Collector = ReturnType<typeof notificationCollector>;

function streamItems(collector: Collector, from: number): StreamItemView[] {
  const items: StreamItemView[] = [];
  for (const event of collector.events.slice(from)) {
    if (event.params.uri !== STREAM_URI) continue;
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
    if (payload?.items) items.push(...payload.items);
  }
  return items;
}

async function waitForStreamItem(
  collector: Collector,
  from: number,
  predicate: (item: StreamItemView) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<StreamItemView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = streamItems(collector, from).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      const seen = streamItems(collector, from).map((item) => ({
        task_id: item.task_id,
        change: item.change,
        source: item.source,
      }));
      throw new Error(`${label}: 等待 stream item 超时 (${JSON.stringify(seen)})`);
    }
    await sleep(100);
  }
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (await callTool<TaskResult>(connection.client, 'network_task_get', { task_id: taskId }))
    .task;
}

async function createOfferedTask(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_create', {
      request_id: newRequestId('d06_create'),
      ...args,
    })
  ).task;
}

async function acceptOffer(connection: McpConnection, task: TaskView): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_accept', {
      request_id: newRequestId('d06_accept'),
      task_id: task.task_id,
      ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
      expected_revision: task.revision,
    })
  ).task;
}

async function createOwnedTask(
  creatorConn: McpConnection,
  assigneeConn: McpConnection,
  roomId: string,
  title: string,
  assignee: string,
  reviewer: string,
): Promise<TaskView> {
  const offered = await createOfferedTask(creatorConn, {
    room_id: roomId,
    title,
    assignee_actor_id: assignee,
    reviewer_actor_id: reviewer,
  });
  return acceptOffer(assigneeConn, offered);
}

function submitInput(
  task: TaskView,
  summary: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    request_id: newRequestId('d06_submit'),
    task_id: task.task_id,
    summary,
    expected_revision: task.revision,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    ...(task.assignment ? { assignment_version: task.assignment.assignment_version } : {}),
    ...extra,
  };
}

function submitTask(
  connection: McpConnection,
  task: TaskView,
  summary: string,
  extra: Record<string, unknown> = {},
): Promise<SubmissionResult> {
  return callTool<SubmissionResult>(
    connection.client,
    'network_task_submit',
    submitInput(task, summary, extra),
  );
}

function returnSubmission(
  connection: McpConnection,
  task: TaskView,
  submissionId: string,
  reason: string,
  options: { requestId?: string; expectedRevision?: number } = {},
): Promise<SubmissionResult> {
  return callTool<SubmissionResult>(connection.client, 'network_task_submission_return', {
    request_id: options.requestId ?? newRequestId('d06_return'),
    task_id: task.task_id,
    submission_id: submissionId,
    reason,
    ...(options.expectedRevision === undefined
      ? {}
      : { expected_revision: options.expectedRevision }),
  });
}

async function getSubmission(
  connection: McpConnection,
  taskId: string,
  version?: number,
): Promise<SubmissionView> {
  return (
    await callTool<{ submission: SubmissionView }>(
      connection.client,
      'network_task_submission_get',
      { task_id: taskId, ...(version === undefined ? {} : { version }) },
    )
  ).submission;
}

async function listSubmissions(
  connection: McpConnection,
  taskId: string,
): Promise<SubmissionList> {
  return callTool<SubmissionList>(connection.client, 'network_task_submission_list', {
    task_id: taskId,
  });
}

async function bindRoomFile(
  connection: McpConnection,
  roomId: string,
  fileId: string,
): Promise<void> {
  await callTool(connection.client, 'network_room_file_bind', {
    request_id: newRequestId('d06_bind'),
    room_id: roomId,
    file_id: fileId,
  });
}

async function roomHead(connection: McpConnection, roomId: string): Promise<string> {
  const detail = await callTool<RoomDetail>(connection.client, 'network_room_get', { room_id: roomId });
  return detail.room.head_seq;
}

// ---------------------------------------------------------------------------
// 内存 SQLite：配额、绑定失败、过期材料与事务中断。
// ---------------------------------------------------------------------------

const UNIT_REVIEWER = 'usr_d06_unit_reviewer';
const UNIT_OWNER = 'agt_d06_unit_owner';
const UNIT_ROOM = 'rm_d06_unit';
const UNIT_OTHER_ROOM = 'rm_d06_unit_other';
const UNIT_VALID_FILE = 'file_d06_unit_valid';
const UNIT_FOREIGN_FILE = 'file_d06_unit_foreign';
const UNIT_EXPIRED_FILE = 'file_d06_unit_expired';
const UNIT_AT = 1_700_000_000_000;
const UNIT_SHA = 'a'.repeat(64);

function principalFor(db: Database, actorId: string): Principal {
  const row = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
  return {
    credentialHash: `d06:${actorId}`,
    actor: row,
    credential: {
      credential_id: `cred_${actorId}`,
      actor_id: actorId,
      device_id: `dev_${actorId}`,
      token_hash: `hash_${actorId}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function unitDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${UNIT_REVIEWER}', 'human', NULL, 'D06 Unit Reviewer', '{}', 0, 0, 0, ${UNIT_AT}, ${UNIT_AT}),
      ('${UNIT_OWNER}', 'agent', 'sess_d06_unit_owner', 'D06 Unit Owner', '{}', 0, 0, 0, ${UNIT_AT}, ${UNIT_AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES
      ('${UNIT_ROOM}', 'group', '${UNIT_REVIEWER}', 'D06 Unit Room', NULL, 0, 0, 0, NULL,
       ${UNIT_AT}, ${UNIT_AT}),
      ('${UNIT_OTHER_ROOM}', 'group', '${UNIT_REVIEWER}', 'D06 Other Room', NULL, 0, 0, 0, NULL,
       ${UNIT_AT}, ${UNIT_AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES
      ('${UNIT_ROOM}', '${UNIT_REVIEWER}', 'owner', 'active', 0, 0, ${UNIT_AT}),
      ('${UNIT_ROOM}', '${UNIT_OWNER}', 'member', 'active', 0, 0, ${UNIT_AT}),
      ('${UNIT_OTHER_ROOM}', '${UNIT_REVIEWER}', 'owner', 'active', 0, 0, ${UNIT_AT});

    INSERT INTO room_files
      (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
       created_at, expires_at, deleted_at, deleted_by, retained)
    VALUES
      ('rf_d06_valid', '${UNIT_ROOM}', '${UNIT_VALID_FILE}', '${UNIT_OWNER}',
       'd06-valid.txt', 'text/plain', 12, '${UNIT_SHA}', ${UNIT_AT}, ${UNIT_AT + 60_000}, NULL, NULL, 1),
      ('rf_d06_foreign', '${UNIT_OTHER_ROOM}', '${UNIT_FOREIGN_FILE}', '${UNIT_OWNER}',
       'd06-foreign.txt', 'text/plain', 13, '${UNIT_SHA}', ${UNIT_AT}, ${UNIT_AT + 60_000}, NULL, NULL, 1),
      ('rf_d06_expired', '${UNIT_ROOM}', '${UNIT_EXPIRED_FILE}', '${UNIT_OWNER}',
       'd06-expired.txt', 'text/plain', 14, '${UNIT_SHA}', ${UNIT_AT - 100_000}, ${UNIT_AT - 1_000}, NULL, NULL, 0);

    INSERT INTO drive_files
      (file_id, owner_scope, uploader_id, name, mime_type, size, sha256, state, visibility,
       room_id, created_at, expires_at, retained, deleted_at, deleted_by, purged_at)
    VALUES
      ('${UNIT_VALID_FILE}', 'actor:${UNIT_OWNER}', '${UNIT_OWNER}', 'd06-valid.txt',
       'text/plain', 12, '${UNIT_SHA}', 'bound', 'private', '${UNIT_ROOM}', ${UNIT_AT}, NULL, 1,
       NULL, NULL, NULL),
      ('${UNIT_FOREIGN_FILE}', 'actor:${UNIT_OWNER}', '${UNIT_OWNER}', 'd06-foreign.txt',
       'text/plain', 13, '${UNIT_SHA}', 'bound', 'private', '${UNIT_OTHER_ROOM}', ${UNIT_AT}, NULL, 1,
       NULL, NULL, NULL),
      ('${UNIT_EXPIRED_FILE}', 'actor:${UNIT_OWNER}', '${UNIT_OWNER}', 'd06-expired.txt',
       'text/plain', 14, '${UNIT_SHA}', 'bound', 'private', '${UNIT_ROOM}', ${UNIT_AT - 100_000},
       ${UNIT_AT - 1_000}, 0, NULL, NULL, NULL);
  `);
  return db;
}

async function expectBusinessError(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check(
      label,
      error instanceof BusinessError && error.code === code,
      error instanceof Error ? error.message : error,
    );
    return;
  }
  check(label, false, `期望 ${code}，实际成功`);
}

async function unitTask(
  db: Database,
  d1: ReturnType<typeof createD1>,
  title: string,
): Promise<{ taskId: string; assignmentId: string; assignmentVersion: number; revision: number }> {
  const reviewer = principalFor(db, UNIT_REVIEWER);
  const owner = principalFor(db, UNIT_OWNER);
  const created = await taskCreate(d1, reviewer, {
    request_id: newRequestId('unit_create'),
    room_id: UNIT_ROOM,
    title,
    assignee_actor_id: UNIT_OWNER,
    reviewer_actor_id: UNIT_REVIEWER,
  });
  const accepted = await taskAccept(d1, owner, {
    request_id: newRequestId('unit_accept'),
    task_id: created.task.task_id,
    assignment_id: created.task.assignment?.assignment_id,
    expected_revision: created.task.revision,
  });
  check('D06-T02 单元任务进入 in_progress', accepted.task.status === 'in_progress', accepted.task);
  check('D06-T02 单元任务持有 active assignment', Boolean(accepted.task.assignment));
  return {
    taskId: accepted.task.task_id,
    assignmentId: accepted.task.assignment?.assignment_id ?? '',
    assignmentVersion: accepted.task.assignment?.assignment_version ?? 0,
    revision: accepted.task.revision,
  };
}

async function operationCount(
  db: Database,
  actorId: string,
  requestId: string,
): Promise<number> {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM operations WHERE actor_id = ? AND request_id = ?')
    .get(actorId, requestId) as { count: number };
  return row.count;
}

async function runSubmissionUnitChecks(): Promise<void> {
  console.log('  D06-T02 配额/绑定/过期/事务中断');
  const db = unitDb();
  const d1 = createD1(db);
  const owner = principalFor(db, UNIT_OWNER);
  const reviewer = principalFor(db, UNIT_REVIEWER);
  const task = await unitTask(db, d1, 'D06-T02 回滚任务');

  // 绑定失败：跨房间文件不能冻结为成果。
  await expectBusinessError(
    'D06-T02 跨房间材料返回 FILE_UNAVAILABLE',
    taskSubmit(d1, owner, {
      request_id: newRequestId('unit_foreign'),
      task_id: task.taskId,
      summary: '跨房间材料',
      materials: [{ file_id: UNIT_FOREIGN_FILE }],
      assignment_id: task.assignmentId,
      assignment_version: task.assignmentVersion,
      expected_revision: task.revision,
    }),
    'FILE_UNAVAILABLE',
  );

  // 过期材料：未保活的房间文件即使还绑定也不能成为成果。
  await expectBusinessError(
    'D06-T02 过期材料返回 FILE_UNAVAILABLE',
    taskSubmit(d1, owner, {
      request_id: newRequestId('unit_expired'),
      task_id: task.taskId,
      summary: '过期材料',
      materials: [{ file_id: UNIT_EXPIRED_FILE }],
      assignment_id: task.assignmentId,
      assignment_version: task.assignmentVersion,
      expected_revision: task.revision,
    }),
    'FILE_UNAVAILABLE',
  );

  const failedState = await d1
    .prepare('SELECT status, revision FROM tasks WHERE task_id = ?')
    .bind(task.taskId)
    .first<{ status: string; revision: number }>();
  checkEqual('D06-T02 绑定/过期失败后任务仍为 in_progress', failedState?.status, 'in_progress');
  checkEqual('D06-T02 绑定/过期失败不递增 revision', failedState?.revision, task.revision);
  const failedSubmissions = await d1
    .prepare('SELECT COUNT(*) AS count FROM task_submissions WHERE task_id = ?')
    .bind(task.taskId)
    .first<{ count: number }>();
  checkEqual('D06-T02 绑定/过期失败不留下提交', failedSubmissions?.count, 0);

  // 配额：填充到 201 个房间文件，提交必须整批回滚。
  const insertQuota = db.prepare(
    `INSERT INTO room_files
       (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
        created_at, expires_at, deleted_at, deleted_by, retained)
     VALUES (?, ?, ?, ?, ?, 'text/plain', 1, ?, ?, ?, NULL, NULL, 0)`,
  );
  for (let index = 0; index < 201; index += 1) {
    const suffix = String(index).padStart(3, '0');
    insertQuota.run(
      `rf_d06_quota_${suffix}`,
      UNIT_ROOM,
      `file_d06_quota_${suffix}`,
      UNIT_OWNER,
      `quota-${suffix}.txt`,
      UNIT_SHA,
      UNIT_AT,
      UNIT_AT + 60_000,
    );
  }
  const quotaRequestId = newRequestId('unit_quota');
  await expectBusinessError(
    'D06-T02 房间配额失败返回 QUOTA_EXCEEDED',
    taskSubmit(d1, owner, {
      request_id: quotaRequestId,
      task_id: task.taskId,
      summary: '配额失败',
      materials: [{ file_id: UNIT_VALID_FILE }],
      assignment_id: task.assignmentId,
      assignment_version: task.assignmentVersion,
      expected_revision: task.revision,
    }),
    'QUOTA_EXCEEDED',
  );
  checkEqual(
    'D06-T02 配额失败回滚 operations',
    await operationCount(db, UNIT_OWNER, quotaRequestId),
    0,
  );
  const quotaSubmissions = await d1
    .prepare('SELECT COUNT(*) AS count FROM task_submissions WHERE task_id = ?')
    .bind(task.taskId)
    .first<{ count: number }>();
  checkEqual('D06-T02 配额失败不留下提交', quotaSubmissions?.count, 0);
  const quotaTask = await d1
    .prepare('SELECT status, revision FROM tasks WHERE task_id = ?')
    .bind(task.taskId)
    .first<{ status: string; revision: number }>();
  checkEqual('D06-T02 配额失败不进入 submitted', quotaTask?.status, 'in_progress');
  checkEqual('D06-T02 配额失败不递增 revision', quotaTask?.revision, task.revision);
  const quotaMaterials = await d1
    .prepare('SELECT COUNT(*) AS count FROM file_references WHERE kind = ? AND ref_id = ?')
    .bind('task', task.taskId)
    .first<{ count: number }>();
  checkEqual('D06-T02 配额失败不冻结材料引用', quotaMaterials?.count, 0);
  db.exec("DELETE FROM room_files WHERE room_file_id LIKE 'rf_d06_quota_%'");

  // 成功提交：冻结校验值、建立保留引用、任务与 assignment 同事务结束。
  const success = await taskSubmit(d1, owner, {
    request_id: newRequestId('unit_success'),
    task_id: task.taskId,
    summary: 'D06-T02 成功提交',
    materials: [{ file_id: UNIT_VALID_FILE, label: '单元材料' }],
    links: [
      {
        url: 'https://example.com/d06/unit',
        title: 'D06 单元报告',
        version: 'v1',
        digest: 'sha256:unit',
        availability: 'declared_reachable',
      },
    ],
    commit_sha: 'ABCDEF1',
    evidence: ['单元证据'],
    known_limits: '仅单元库验证',
    assignment_id: task.assignmentId,
    assignment_version: task.assignmentVersion,
    expected_revision: task.revision,
  });
  checkEqual('D06-T02 成功提交版本为 1', success.submission.version, 1);
  checkEqual('D06-T02 成功提交状态为 pending', success.submission.status, 'pending');
  checkEqual('D06-T02 材料校验值来自文件元数据', success.submission.materials[0]?.sha256, UNIT_SHA);
  checkEqual('D06-T02 材料大小来自文件元数据', success.submission.materials[0]?.size, 12);
  checkEqual('D06-T02 材料 mime 来自文件元数据', success.submission.materials[0]?.mime_type, 'text/plain');
  checkEqual('D06-T02 外链保留声明可达性', success.submission.links[0]?.availability, 'declared_reachable');
  checkEqual('D06-T02 commit_sha 归一化为小写', success.submission.commit_sha, 'abcdef1');
  checkEqual('D06-T02 提交后任务为 submitted', success.task.status, 'submitted');
  checkEqual('D06-T02 提交后 revision 递增', success.task.revision, task.revision + 1);
  const frozenRef = await d1
    .prepare('SELECT state FROM file_references WHERE kind = ? AND ref_id = ? AND file_id = ?')
    .bind('task', task.taskId, UNIT_VALID_FILE)
    .first<{ state: string }>();
  checkEqual('D06-T02 成功提交建立 active 任务引用', frozenRef?.state, 'active');
  const retainedRoomFile = await d1
    .prepare('SELECT retained FROM room_files WHERE file_id = ?')
    .bind(UNIT_VALID_FILE)
    .first<{ retained: number }>();
  checkEqual('D06-T02 成功提交保留房间文件', retainedRoomFile?.retained, 1);
  const retainedDriveFile = await d1
    .prepare('SELECT retained, expires_at FROM drive_files WHERE file_id = ?')
    .bind(UNIT_VALID_FILE)
    .first<{ retained: number; expires_at: number | null }>();
  checkEqual('D06-T02 成功提交保留驱动文件', retainedDriveFile?.retained, 1);
  checkEqual('D06-T02 成功提交清空驱动文件 TTL', retainedDriveFile?.expires_at, null);

  // 事务中断：用触发器让提交 INSERT 在 batch 内失败，验证整批回滚。
  const interruptedTask = await unitTask(db, d1, 'D06-T02 中断任务');
  db.exec(`
    CREATE TRIGGER d06_interrupt_submission
    BEFORE INSERT ON task_submissions
    WHEN NEW.summary = 'D06 模拟事务中断'
    BEGIN
      SELECT RAISE(ABORT, 'D06 simulated interruption');
    END;
  `);
  const interruptedRequestId = newRequestId('unit_interrupt');
  let interruption: unknown = null;
  try {
    await taskSubmit(d1, owner, {
      request_id: interruptedRequestId,
      task_id: interruptedTask.taskId,
      summary: 'D06 模拟事务中断',
      materials: [{ file_id: UNIT_VALID_FILE }],
      assignment_id: interruptedTask.assignmentId,
      assignment_version: interruptedTask.assignmentVersion,
      expected_revision: interruptedTask.revision,
    });
  } catch (error) {
    interruption = error;
  }
  check(
    'D06-T02 事务中断抛出原始错误',
    String(interruption instanceof Error ? interruption.message : interruption).includes(
      'D06 simulated interruption',
    ),
    interruption,
  );
  db.exec('DROP TRIGGER d06_interrupt_submission');
  checkEqual(
    'D06-T02 中断后不留下 operations',
    await operationCount(db, UNIT_OWNER, interruptedRequestId),
    0,
  );
  const interruptedSubmissions = await d1
    .prepare('SELECT COUNT(*) AS count FROM task_submissions WHERE task_id = ?')
    .bind(interruptedTask.taskId)
    .first<{ count: number }>();
  checkEqual('D06-T02 中断后不留下提交', interruptedSubmissions?.count, 0);
  const interruptedState = await d1
    .prepare('SELECT status, revision FROM tasks WHERE task_id = ?')
    .bind(interruptedTask.taskId)
    .first<{ status: string; revision: number }>();
  checkEqual('D06-T02 中断后任务仍为 in_progress', interruptedState?.status, 'in_progress');
  checkEqual('D06-T02 中断后 revision 不变', interruptedState?.revision, interruptedTask.revision);
  const interruptedRefs = await d1
    .prepare('SELECT COUNT(*) AS count FROM file_references WHERE kind = ? AND ref_id = ?')
    .bind('task', interruptedTask.taskId)
    .first<{ count: number }>();
  checkEqual('D06-T02 中断后材料引用回滚', interruptedRefs?.count, 0);

  // 退回时原负责人已失权：任务转 blocked，等待重派而不是自动完成。
  const lostTask = await unitTask(db, d1, 'D06-T02 失权任务');
  const lostSubmit = await taskSubmit(d1, owner, {
    request_id: newRequestId('unit_lost_submit'),
    task_id: lostTask.taskId,
    summary: 'D06-T02 失权前提交',
    materials: [{ file_id: UNIT_VALID_FILE }],
    assignment_id: lostTask.assignmentId,
    assignment_version: lostTask.assignmentVersion,
    expected_revision: lostTask.revision,
  });
  db.prepare('DELETE FROM room_members WHERE room_id = ? AND actor_id = ?').run(
    UNIT_ROOM,
    UNIT_OWNER,
  );
  const lostReturn = await taskSubmissionReturn(d1, reviewer, {
    request_id: newRequestId('unit_lost_return'),
    task_id: lostTask.taskId,
    submission_id: lostSubmit.submission.submission_id,
    reason: '负责人已离开房间',
    expected_revision: lostSubmit.task.revision,
  });
  checkEqual('D06-T03 失权退回后任务 blocked', lostReturn.task.status, 'blocked');
  checkEqual(
    'D06-T03 失权退回原因记录为 owner_lost_eligibility',
    lostReturn.task.blocked_reason,
    'owner_lost_eligibility',
  );
  checkEqual('D06-T03 失权退回不保留负责人', lostReturn.task.owner_actor_id, null);
  checkEqual('D06-T03 失权退回不生成 assignment', lostReturn.task.assignment, null);
  checkEqual('D06-T03 失权退回版本为 returned', lostReturn.submission.status, 'returned');
  const lostVersions = await taskSubmissionList(d1, reviewer, { task_id: lostTask.taskId });
  checkEqual('D06-T03 失权退回仍保留原提交', lostVersions.submissions.length, 1);
  const lostGet = await taskSubmissionGet(d1, reviewer, {
    task_id: lostTask.taskId,
    version: 1,
  });
  checkEqual('D06-T03 失权后仍可读取 v1', lostGet.submission.status, 'returned');
}

// ---------------------------------------------------------------------------
// 实时 MCP 验收。
// ---------------------------------------------------------------------------

export async function runTaskSubmissionAcceptance(): Promise<void> {
  console.log('· D06 成果提交与不可混淆的版本');
  const u1Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D06 验收人 U1' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D06 Agent B1',
      sessionId: `d06_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'D06 Agent B2',
      sessionId: `d06_b2_${crypto.randomUUID()}`,
    });
    check(
      'D06 身份注册成功',
      Boolean(u1.actor_id && b1.actor_id && b2.actor_id),
      { u1, b1, b2 },
    );

    for (const [connection, identity] of [
      [b1Conn, b1],
      [b2Conn, b2],
    ] as Array<[McpConnection, Identity]>) {
      const peerId = (await callTool<Identity>(connection.client, 'network_me', {})).actor_id;
      await befriend(u1Conn, u1.actor_id, connection, peerId);
      checkEqual('D06 好友关系建立', peerId, identity.actor_id);
    }

    const group = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d06_room'),
      kind: 'group',
      title: 'D06 成果提交验收群',
      members: [b1.actor_id, b2.actor_id],
    });
    const roomId = group.room.room_id;
    await acceptGroupInvites(b1Conn, roomId);
    await acceptGroupInvites(b2Conn, roomId);

    const u1Collector = notificationCollector(u1Conn.client);
    const b1Collector = notificationCollector(b1Conn.client);
    subscriptions.push(await openSubscription(u1Conn.client, [STREAM_URI]));
    subscriptions.push(await openSubscription(b1Conn.client, [STREAM_URI]));
    await callTool(b1Conn.client, 'network_login', {});
    await sleep(200);

    const materialUpload = await uploadTestFile(b1Conn.token, {
      name: 'd06-material.txt',
      mimeType: 'text/plain',
      body: 'D06 material for task submission',
    });
    await bindRoomFile(b1Conn, roomId, materialUpload.fileId);
    checkEqual('D06 材料上传并绑定到房间', materialUpload.name, 'd06-material.txt');

    // ---------- D06-T01：提交资格、旧版本与唯一版本 ----------
    const t01 = await createOwnedTask(
      u1Conn,
      b1Conn,
      roomId,
      'D06-T01 提交资格',
      b1.actor_id,
      u1.actor_id,
    );
    checkEqual('D06-T01 初始负责人为 B1', t01.owner_actor_id, b1.actor_id);
    const t01Proposal = await callTool<{
      transfer: { transfer_id: string; status: string };
      task: TaskView;
    }>(b1Conn.client, 'network_task_transfer_propose', {
      request_id: newRequestId('d06_transfer'),
      task_id: t01.task_id,
      to_actor_id: b2.actor_id,
      expected_revision: t01.revision,
      assignment_id: t01.assignment?.assignment_id,
      assignment_version: t01.assignment?.assignment_version,
    });
    checkEqual('D06-T01 交接提议已建立', t01Proposal.transfer.status, 'pending');
    const t01Accepted = await callTool<{ task: TaskView }>(
      b2Conn.client,
      'network_task_transfer_accept',
      {
        request_id: newRequestId('d06_transfer_accept'),
        transfer_id: t01Proposal.transfer.transfer_id,
        expected_revision: t01Proposal.task.revision,
        from_assignment_version: t01.assignment?.assignment_version,
      },
    );
    checkEqual('D06-T01 交接后负责人为 B2', t01Accepted.task.owner_actor_id, b2.actor_id);
    checkEqual(
      'D06-T01 交接后 assignment_version 递增',
      t01Accepted.task.assignment?.assignment_version,
      (t01.assignment?.assignment_version ?? 0) + 1,
    );

    await expectToolError(
      'D06-T01 旧负责人提交返回 ASSIGNMENT_STALE',
      callTool(b1Conn.client, 'network_task_submit', {
        request_id: newRequestId('d06_stale_owner'),
        task_id: t01.task_id,
        summary: '旧负责人提交',
        commit_sha: 'abcdef1',
        assignment_id: t01.assignment?.assignment_id,
        assignment_version: t01.assignment?.assignment_version,
        expected_revision: t01Accepted.task.revision,
      }),
      'ASSIGNMENT_STALE',
    );
    await expectToolError(
      'D06-T01 非负责人提交返回 PERMISSION_DENIED',
      callTool(u1Conn.client, 'network_task_submit', {
        request_id: newRequestId('d06_non_owner'),
        task_id: t01.task_id,
        summary: '验收人冒充负责人',
        commit_sha: 'abcdef1',
        assignment_id: t01Accepted.task.assignment?.assignment_id,
        assignment_version: t01Accepted.task.assignment?.assignment_version,
        expected_revision: t01Accepted.task.revision,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'D06-T01 旧 revision 提交返回 VERSION_CONFLICT',
      callTool(b2Conn.client, 'network_task_submit', {
        request_id: newRequestId('d06_old_revision'),
        task_id: t01.task_id,
        summary: '旧 revision 提交',
        commit_sha: 'abcdef1',
        assignment_id: t01Accepted.task.assignment?.assignment_id,
        assignment_version: t01Accepted.task.assignment?.assignment_version,
        expected_revision: t01Accepted.task.revision - 1,
      }),
      'VERSION_CONFLICT',
    );

    const t01PendingTransfer = await callTool<{ transfer: { transfer_id: string } }>(
      b2Conn.client,
      'network_task_transfer_propose',
      {
        request_id: newRequestId('d06_t01_transfer'),
        task_id: t01.task_id,
        to_actor_id: b1.actor_id,
        expected_revision: t01Accepted.task.revision,
        assignment_id: t01Accepted.task.assignment?.assignment_id,
        assignment_version: t01Accepted.task.assignment?.assignment_version,
      },
    );
    check(
      'D06-T01 提交前存在 pending 交接',
      Boolean(t01PendingTransfer.transfer.transfer_id),
      t01PendingTransfer,
    );

    const t01HeadBefore = await roomHead(u1Conn, roomId);
    const t01PendingBefore = (await inbox(b2Conn, 'pending')).pending_count;
    const t01RequestId = newRequestId('d06_t01_submit');
    const t01Input = {
      request_id: t01RequestId,
      task_id: t01.task_id,
      summary: 'D06-T01 提交数据核对结果',
      links: [
        {
          url: 'https://example.com/d06/t01-report',
          title: 'D06-T01 报告',
          version: 'v1',
          digest: 'sha256:t01',
          availability: 'declared_reachable' as const,
        },
      ],
      commit_sha: 'ABC1234',
      evidence: ['协议验收通过'],
      known_limits: '仅覆盖本地数据集',
      assignment_id: t01Accepted.task.assignment?.assignment_id,
      assignment_version: t01Accepted.task.assignment?.assignment_version,
      expected_revision: t01Accepted.task.revision,
    };
    const t01Submit = await callTool<SubmissionResult>(
      b2Conn.client,
      'network_task_submit',
      t01Input,
    );
    checkEqual('D06-T01 提交生成 v1', t01Submit.submission.version, 1);
    checkEqual('D06-T01 提交状态为 pending', t01Submit.submission.status, 'pending');
    checkEqual('D06-T01 提交后任务为 submitted', t01Submit.task.status, 'submitted');
    checkEqual('D06-T01 提交后 revision 递增', t01Submit.task.revision, t01Accepted.task.revision + 1);
    checkEqual('D06-T01 提交人记录为 B2', t01Submit.submission.submitted_by, b2.actor_id);
    checkEqual('D06-T01 commit_sha 归一化', t01Submit.submission.commit_sha, 'abc1234');
    checkEqual(
      'D06-T01 外链记录版本与可达性',
      t01Submit.submission.links[0]?.version,
      'v1',
    );
    checkEqual(
      'D06-T01 外链可达性是提交者声明',
      t01Submit.submission.links[0]?.availability,
      'declared_reachable',
    );
    const t01HeadAfter = await roomHead(u1Conn, roomId);
    checkEqual('D06-T01 提交不推进房间 head', t01HeadAfter, t01HeadBefore);
    const t01PendingAfter = (await inbox(b2Conn, 'pending')).pending_count;
    check(
      'D06-T01 提交关闭旧投递但不增加 pending_count',
      t01PendingAfter <= t01PendingBefore,
      { before: t01PendingBefore, after: t01PendingAfter },
    );
    const t01TransferGet = await callTool<{
      transfer: { status: string; effective_status: string };
    }>(u1Conn.client, 'network_task_transfer_get', {
      transfer_id: t01PendingTransfer.transfer.transfer_id,
    });
    checkEqual(
      'D06-T01 提交取消 pending 交接',
      t01TransferGet.transfer.status,
      'cancelled',
    );
    // 同一批 drain 中 transfer_cancelled 与 task_submitted 可能合并到一帧；
    // 流提示允许丢失并带 dropped，提交事件本身在 T03 的干净路径单独验证。
    const b1TaskEvents = streamItems(b1Collector, 0).filter(
      (item) => item.task_id === t01.task_id && item.source === 'task.updated',
    );
    checkEqual('D06-T01 Agent 不接收任务事件', b1TaskEvents.length, 0);

    const t01Replay = await callTool<SubmissionResult>(
      b2Conn.client,
      'network_task_submit',
      t01Input,
    );
    checkEqual(
      'D06-T01 相同 request_id 重放同一 submission',
      t01Replay.submission.submission_id,
      t01Submit.submission.submission_id,
    );
    checkEqual('D06-T01 重放不生成新版本', t01Replay.submission.version, 1);
    const t01List = await listSubmissions(u1Conn, t01.task_id);
    checkEqual('D06-T01 重复提交只留下一个版本', t01List.submissions.length, 1);
    await expectToolError(
      'D06-T01 新 request_id 重复提交返回 CONFLICT',
      callTool(b2Conn.client, 'network_task_submit', {
        ...t01Input,
        request_id: newRequestId('d06_duplicate'),
        expected_revision: t01Submit.task.revision,
      }),
      'CONFLICT',
    );
    const t01Get = await getSubmission(u1Conn, t01.task_id);
    checkEqual('D06-T01 默认读取最新版本', t01Get.version, 1);
    const t01TaskGet = await getTask(u1Conn, t01.task_id);
    checkEqual('D06-T01 任务卡片指向当前提交', t01TaskGet.current_submission?.version, 1);
    checkEqual('D06-T01 验收人可以退回', t01TaskGet.can_return, true);
    const t01TaskForOwner = await getTask(b2Conn, t01.task_id);
    checkEqual('D06-T01 提交后负责人不能再提交', t01TaskForOwner.can_submit, false);
    await expectToolError(
      'D06-T01 负责人不能验收自己的提交',
      returnSubmission(b2Conn, t01TaskForOwner, t01Submit.submission.submission_id, '自己验收'),
      'PERMISSION_DENIED',
    );

    // ---------- D06-T03：退回、v2 与历史不可覆盖 ----------
    const t03 = await createOwnedTask(
      u1Conn,
      b1Conn,
      roomId,
      'D06-T03 退回与重提',
      b1.actor_id,
      u1.actor_id,
    );
    const t03DeliveryId = t03.delivery_ids[0] ?? '';
    check('D06-T03 初始 assignment 生成 delivery', Boolean(t03DeliveryId), t03.delivery_ids);
    const t03HeadBefore = await roomHead(u1Conn, roomId);
    const t03PendingBefore = (await inbox(b1Conn, 'pending')).pending_count;
    const t03V1StreamStart = u1Collector.events.length;
    const t03V1RequestId = newRequestId('d06_t03_v1');
    const t03V1Input = {
      request_id: t03V1RequestId,
      task_id: t03.task_id,
      summary: 'D06-T03 v1 初版',
      materials: [{ file_id: materialUpload.fileId, label: 'D06 材料' }],
      links: [
        {
          url: 'https://example.com/d06/t03-report',
          title: 'D06-T03 报告',
          version: 'v1',
          digest: 'sha256:v1',
        },
      ],
      commit_sha: 'ABCDEF1',
      evidence: ['协议验收 912 项'],
      known_limits: '仅本地验证',
      assignment_id: t03.assignment?.assignment_id,
      assignment_version: t03.assignment?.assignment_version,
      expected_revision: t03.revision,
    };
    const t03V1 = await callTool<SubmissionResult>(
      b1Conn.client,
      'network_task_submit',
      t03V1Input,
    );
    checkEqual('D06-T03 初次提交生成 v1', t03V1.submission.version, 1);
    checkEqual(
      'D06-T03 材料冻结上传校验值',
      t03V1.submission.materials[0]?.sha256,
      materialUpload.sha256.toLowerCase(),
    );
    checkEqual('D06-T03 材料冻结大小', t03V1.submission.materials[0]?.size, materialUpload.size);
    checkEqual(
      'D06-T03 材料冻结 mime',
      t03V1.submission.materials[0]?.mime_type,
      materialUpload.mimeType,
    );
    checkEqual('D06-T03 材料读取时可用', t03V1.submission.materials[0]?.available, true);
    checkEqual(
      'D06-T03 外链未声明时标记 unverified',
      t03V1.submission.links[0]?.availability,
      'unverified',
    );
    const t03PendingAfterSubmit = (await inbox(b1Conn, 'pending')).pending_count;
    check(
      'D06-T03 提交关闭负责人投递',
      t03PendingAfterSubmit <= t03PendingBefore,
      { before: t03PendingBefore, after: t03PendingAfterSubmit },
    );
    const t03DeliveryRow = (await inbox(b1Conn, 'all')).items.find(
      (item) => item.delivery_id === t03DeliveryId,
    );
    checkEqual('D06-T03 提交关闭该 assignment 的投递', t03DeliveryRow?.state, 'cancelled');
    const t03V1Event = await waitForStreamItem(
      u1Collector,
      t03V1StreamStart,
      (item) => item.task_id === t03.task_id && item.change === 'submitted',
      'D06-T03 v1 提交事件',
    );
    checkEqual('D06-T03 提交事件为 informational', t03V1Event.attention, 'informational');
    checkEqual('D06-T03 提交事件来源 task.updated', t03V1Event.source, 'task.updated');
    checkEqual('D06-T03 提交事件携带 v1 版本号', t03V1Event.submission_version, 1);
    checkEqual(
      'D06-T03 提交事件携带 submission_id',
      t03V1Event.submission_id,
      t03V1.submission.submission_id,
    );

    await expectToolError(
      'D06-T03 非验收人退回返回 PERMISSION_DENIED',
      returnSubmission(b2Conn, t03V1.task, t03V1.submission.submission_id, '无关 Agent 退回'),
      'PERMISSION_DENIED',
    );
    const t03ReturnStreamStart = u1Collector.events.length;
    const t03ReturnRequestId = newRequestId('d06_t03_return');
    const t03Returned = await returnSubmission(
      u1Conn,
      t03V1.task,
      t03V1.submission.submission_id,
      '缺少边界数据说明，请补充后重提',
      { requestId: t03ReturnRequestId, expectedRevision: t03V1.task.revision },
    );
    checkEqual('D06-T03 退回后任务回到 in_progress', t03Returned.task.status, 'in_progress');
    checkEqual('D06-T03 退回递增任务 revision', t03Returned.task.revision, t03V1.task.revision + 1);
    checkEqual('D06-T03 退回保留原负责人', t03Returned.task.owner_actor_id, b1.actor_id);
    checkEqual(
      'D06-T03 退回重建 assignment_version',
      t03Returned.task.assignment?.assignment_version,
      (t03V1.task.assignment?.assignment_version ?? 0) + 1,
    );
    check(
      'D06-T03 退回生成新的 assignment',
      Boolean(
        t03Returned.task.assignment &&
          t03Returned.task.assignment.assignment_id !== t03V1.task.assignment?.assignment_id,
      ),
      t03Returned.task.assignment,
    );
    checkEqual('D06-T03 v1 状态为 returned', t03Returned.submission.status, 'returned');
    checkEqual('D06-T03 退回记录 review 决策', t03Returned.submission.review?.decision, 'return');
    checkEqual(
      'D06-T03 退回原因写入 review',
      t03Returned.submission.review?.reason,
      '缺少边界数据说明，请补充后重提',
    );
    const t03ReturnEvent = await waitForStreamItem(
      u1Collector,
      t03ReturnStreamStart,
      (item) => item.task_id === t03.task_id && item.change === 'returned',
      'D06-T03 退回事件',
    );
    checkEqual('D06-T03 退回事件为 informational', t03ReturnEvent.attention, 'informational');
    checkEqual('D06-T03 退回事件携带 v1', t03ReturnEvent.submission_version, 1);
    const t03HeadAfterReturn = await roomHead(u1Conn, roomId);
    checkEqual('D06-T03 退回不推进房间 head', t03HeadAfterReturn, t03HeadBefore);
    const t03PendingAfterReturn = (await inbox(b1Conn, 'pending')).pending_count;
    checkEqual(
      'D06-T03 退回不新增 Agent 待办',
      t03PendingAfterReturn,
      t03PendingAfterSubmit,
    );
    const t03OwnerAfterReturn = await getTask(b1Conn, t03.task_id);
    checkEqual('D06-T03 原负责人可以重新提交', t03OwnerAfterReturn.can_submit, true);
    const t03V1Get = await getSubmission(u1Conn, t03.task_id, 1);
    checkEqual('D06-T03 退回后 v1 仍可读取', t03V1Get.status, 'returned');
    checkEqual('D06-T03 退回后 v1 材料不变', t03V1Get.materials[0]?.sha256, t03V1.submission.materials[0]?.sha256);

    const t03ReturnReplay = await returnSubmission(
      u1Conn,
      t03V1.task,
      t03V1.submission.submission_id,
      '缺少边界数据说明，请补充后重提',
      { requestId: t03ReturnRequestId, expectedRevision: t03V1.task.revision },
    );
    checkEqual(
      'D06-T03 退回重放不新增 revision',
      t03ReturnReplay.task.revision,
      t03Returned.task.revision,
    );
    await expectToolError(
      'D06-T03 新 request_id 再退同一版本返回 CONFLICT',
      returnSubmission(u1Conn, t03Returned.task, t03V1.submission.submission_id, '再次退回'),
      'CONFLICT',
    );
    const t03OldReplay = await callTool<SubmissionResult>(
      b1Conn.client,
      'network_task_submit',
      t03V1Input,
    );
    checkEqual(
      'D06-T03 旧提交重放返回 v1 快照',
      t03OldReplay.submission.submission_id,
      t03V1.submission.submission_id,
    );
    checkEqual('D06-T03 旧提交重放不覆盖当前任务', t03OldReplay.task.status, 'submitted');
    const t03AfterOldReplay = await getTask(b1Conn, t03.task_id);
    checkEqual('D06-T03 旧重放后任务仍为 in_progress', t03AfterOldReplay.status, 'in_progress');

    await expectToolError(
      'D06-T03 旧 assignment_id 提交 v2 返回 ASSIGNMENT_STALE',
      callTool(b1Conn.client, 'network_task_submit', {
        request_id: newRequestId('d06_stale_assignment'),
        task_id: t03.task_id,
        summary: '旧执行资格重提',
        commit_sha: 'abcdef2',
        assignment_id: t03V1.submission.assignment_id,
        assignment_version: t03V1.submission.assignment_version,
        expected_revision: t03Returned.task.revision,
      }),
      'ASSIGNMENT_STALE',
    );
    await expectToolError(
      'D06-T03 旧 revision 提交 v2 返回 VERSION_CONFLICT',
      callTool(b1Conn.client, 'network_task_submit', {
        request_id: newRequestId('d06_stale_revision'),
        task_id: t03.task_id,
        summary: '旧 revision 重提',
        commit_sha: 'abcdef2',
        assignment_id: t03OwnerAfterReturn.assignment?.assignment_id,
        assignment_version: t03OwnerAfterReturn.assignment?.assignment_version,
        expected_revision: t03V1.task.revision,
      }),
      'VERSION_CONFLICT',
    );

    const t03V2StreamStart = u1Collector.events.length;
    const t03V2Input = {
      request_id: newRequestId('d06_t03_v2'),
      task_id: t03.task_id,
      summary: 'D06-T03 v2 补充边界说明',
      materials: [{ file_id: materialUpload.fileId, label: 'D06 材料 v2' }],
      links: [
        {
          url: 'https://example.com/d06/t03-report',
          title: 'D06-T03 报告',
          version: 'v2',
          digest: 'sha256:v2',
          availability: 'declared_reachable' as const,
        },
      ],
      commit_sha: 'ABCDEF2',
      evidence: ['协议验收与端到端验收通过'],
      known_limits: '仅本地验证；未覆盖生产数据',
      assignment_id: t03OwnerAfterReturn.assignment?.assignment_id,
      assignment_version: t03OwnerAfterReturn.assignment?.assignment_version,
      expected_revision: t03Returned.task.revision,
    };
    const t03V2 = await callTool<SubmissionResult>(
      b1Conn.client,
      'network_task_submit',
      t03V2Input,
    );
    checkEqual('D06-T03 重提生成 v2', t03V2.submission.version, 2);
    checkEqual('D06-T03 v2 为当前版本', t03V2.submission.is_current, true);
    checkEqual('D06-T03 v2 提交后任务再次 submitted', t03V2.task.status, 'submitted');
    const t03V2Event = await waitForStreamItem(
      u1Collector,
      t03V2StreamStart,
      (item) => item.task_id === t03.task_id && item.change === 'submitted',
      'D06-T03 v2 提交事件',
    );
    checkEqual('D06-T03 v2 事件携带版本号', t03V2Event.submission_version, 2);
    const t03HeadAfterV2 = await roomHead(u1Conn, roomId);
    checkEqual('D06-T03 v2 提交不推进房间 head', t03HeadAfterV2, t03HeadBefore);
    const t03PendingAfterV2 = (await inbox(b1Conn, 'pending')).pending_count;
    checkEqual('D06-T03 v2 提交不新增 Agent 待办', t03PendingAfterV2, t03PendingAfterReturn);

    const t03History = await listSubmissions(u1Conn, t03.task_id);
    checkEqual('D06-T03 历史保留两个版本', t03History.submissions.length, 2);
    checkEqual('D06-T03 历史按版本倒序', t03History.submissions[0]?.version, 2);
    checkEqual('D06-T03 最新版本标记 is_current', t03History.submissions[0]?.is_current, true);
    checkEqual('D06-T03 v1 保留 returned', t03History.submissions[1]?.status, 'returned');
    checkEqual('D06-T03 v1 不是当前版本', t03History.submissions[1]?.is_current, false);
    checkEqual(
      'D06-T03 v1 外链快照不被 v2 覆盖',
      t03History.submissions[1]?.links[0]?.version,
      'v1',
    );
    checkEqual(
      'D06-T03 v2 外链记录新版本',
      t03History.submissions[0]?.links[0]?.version,
      'v2',
    );
    const t03TaskAfterV2 = await getTask(u1Conn, t03.task_id);
    checkEqual('D06-T03 任务卡片指向 v2', t03TaskAfterV2.current_submission?.version, 2);
    const t03TaskList = await callTool<{ tasks: TaskView[] }>(
      u1Conn.client,
      'network_task_list',
      { room_id: roomId },
    );
    const t03ListItem = t03TaskList.tasks.find((item) => item.task_id === t03.task_id);
    checkEqual('D06-T03 任务列表指向当前提交版本', t03ListItem?.current_submission?.version, 2);

    const t03V2Replay = await callTool<SubmissionResult>(
      b1Conn.client,
      'network_task_submit',
      t03V2Input,
    );
    checkEqual(
      'D06-T03 v2 相同 request_id 重放同一版本',
      t03V2Replay.submission.submission_id,
      t03V2.submission.submission_id,
    );
    checkEqual('D06-T03 v2 重放不新增版本', t03V2Replay.submission.version, 2);
    await expectToolError(
      'D06-T03 旧 v1 回执不能覆盖 v2',
      returnSubmission(u1Conn, t03V2.task, t03V1.submission.submission_id, '旧回执'),
      'CONFLICT',
    );
    const t03FinalHistory = await listSubmissions(u1Conn, t03.task_id);
    checkEqual('D06-T03 失败回执不新增版本', t03FinalHistory.submissions.length, 2);
    checkEqual('D06-T03 当前版本仍为 v2', t03FinalHistory.submissions[0]?.version, 2);

    const b1TaskEventsT03 = streamItems(b1Collector, 0).filter(
      (item) => item.task_id === t03.task_id && item.source === 'task.updated',
    );
    checkEqual('D06-T03 Agent 不接收退回/提交事件', b1TaskEventsT03.length, 0);

    await runSubmissionUnitChecks();
    console.log('D06 成果提交与版本验收通过');
  } finally {
    await Promise.all(
      subscriptions.map((subscription) => subscription.close().catch(() => undefined)),
    );
    await Promise.all([u1Conn.close(), b1Conn.close(), b2Conn.close()]);
  }
}
