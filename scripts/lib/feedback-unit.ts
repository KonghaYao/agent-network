/**
 * 问题反馈的本地事务、迁移与安全错误测试。
 *
 * 使用内存 SQLite + 真实 migrations 目录，不依赖正在运行的服务；
 * 由协议验收调用。所有 canary 只在进程内生成，断言失败只打印字段名或布尔值。
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { migrate } from '../../src/bun/migrate';
import { createD1 } from '../../src/bun/d1';
import { BusinessError } from '../../src/contracts/errors';
import { LIMITS } from '../../src/contracts/limits';
import { feedbackCreateSchema, type FeedbackCreateInput } from '../../src/contracts/schemas';
import {
  createFeedback,
  redactFeedbackText,
  type FeedbackCreateResult,
} from '../../src/domain/feedback';
import type { Principal } from '../../src/domain/principal';
import { feedbackCreateResultSchema } from '../../src/mcp/outputs';
import { register } from '../../src/mcp/tools';
import type { ActorRow } from '../../src/storage/rows';
import { CheckFailure, check, checkEqual } from './harness';

const MIGRATIONS = resolveMigrations();

function resolveMigrations(): string {
  return join(import.meta.dir, '../../migrations');
}

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  return db;
}

function seedActors(db: Database): void {
  const at = 1_700_000_000_000;
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('usr_feedback', 'human', NULL, 'Feedback Human', '{}', 0, 0, 0, ${at}, ${at}),
           ('agt_feedback', 'agent', 'sess_feedback', 'Feedback Agent', '{}', 0, 0, 0, ${at}, ${at}),
           ('usr_feedback_other', 'human', NULL, 'Other Feedback Human', '{}', 0, 0, 0, ${at}, ${at});
  `);
}

function getActorRow(db: Database, actor: string): ActorRow {
  return db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actor) as ActorRow;
}

function principalFor(actor: ActorRow): Principal {
  return {
    credentialHash: 'feedback-unit-credential',
    actor,
    credential: {
      credential_id: 'cred_feedback_unit',
      actor_id: actor.actor_id,
      device_id: 'dev_feedback_unit',
      token_hash: 'feedback-unit-token-hash',
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function makeInput(overrides: Partial<FeedbackCreateInput> = {}): FeedbackCreateInput {
  return {
    request_id: `fb_${crypto.randomUUID().replaceAll('-', '')}`,
    environment: 'os=Unit kernel=test arch=test bash=5.2 cli=1.0.0',
    harness: 'unit',
    problem: '普通问题描述',
    ...overrides,
  };
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function feedbackRow(db: Database, feedbackId: string): {
  actor_id: string;
  environment: string;
  harness: string;
  problem: string;
  created_at: number;
} {
  return db
    .prepare(
      'SELECT actor_id, environment, harness, problem, created_at FROM feedback WHERE feedback_id = ?',
    )
    .get(feedbackId) as {
    actor_id: string;
    environment: string;
    harness: string;
    problem: string;
    created_at: number;
  };
}

function operationRow(db: Database, actor: string, requestId: string): {
  payload_hash: string;
  result_json: string;
} {
  return db
    .prepare('SELECT payload_hash, result_json FROM operations WHERE actor_id = ? AND request_id = ?')
    .get(actor, requestId) as { payload_hash: string; result_json: string };
}

function businessSnapshot(db: Database): string {
  return JSON.stringify({
    events: count(db, 'events'),
    outbox: count(db, 'outbox'),
    actors: db
      .prepare('SELECT actor_id, pending_count, inbox_head_seq FROM actors ORDER BY actor_id')
      .all(),
    rooms: db.prepare('SELECT room_id, head_seq, last_message_id FROM rooms ORDER BY room_id').all(),
  });
}

async function expectBusinessError(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<BusinessError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BusinessError) {
      checkEqual(label, error.code, code);
      return error;
    }
    throw error;
  }
  throw new CheckFailure(label, `期望业务错误 ${code}，但调用成功`);
}

function checkSchemaShape(db: Database): void {
  const columns = db
    .prepare('PRAGMA table_info(feedback)')
    .all() as { name: string; type: string; notnull: number; pk: number }[];
  checkEqual(
    'feedback 表列与类型按计划',
    columns.map((column) => `${column.name}:${column.type}:${column.notnull}:${column.pk}`).join(','),
    [
      'feedback_id:TEXT:0:1',
      'actor_id:TEXT:1:0',
      'environment:TEXT:1:0',
      'harness:TEXT:1:0',
      'problem:TEXT:1:0',
      'created_at:INTEGER:1:0',
    ].join(','),
  );
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(feedback)').all() as {
    table: string;
    from: string;
    to: string;
  }[];
  checkEqual('feedback.actor_id 外键指向 actors', foreignKeys.length, 1);
  checkEqual(
    'feedback 外键列与目标',
    `${foreignKeys[0]?.table}.${foreignKeys[0]?.from}->${foreignKeys[0]?.to}`,
    'actors.actor_id->actor_id',
  );
  const indexColumns = db.prepare('PRAGMA index_info(idx_feedback_created)').all() as {
    name: string;
  }[];
  checkEqual(
    'feedback 时间索引按 created_at DESC + feedback_id',
    indexColumns.map((column) => column.name).join(','),
    'created_at,feedback_id',
  );
}

function checkMigrationUpgrade(): void {
  const old = new Database(':memory:');
  old.exec('PRAGMA foreign_keys = ON;');
  old.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const legacyMigrations = [
    '0001_initial.sql',
    '0002_named_guards.sql',
    '0003_room_files.sql',
    '0004_mcp_events.sql',
    '0005_agent_archive.sql',
    '0006_agent_presence.sql',
    '0007_agent_presence_activity.sql',
    '0008_actor_room_monitors.sql',
  ];
  for (const name of legacyMigrations) {
    old.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    old.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, 1);
  }
  old.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('usr_legacy', 'human', NULL, 'Legacy Human', '{}', 0, 0, 3, 1, 1);
  `);
  const legacyColumns =
    'actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq, ' +
    'pending_count, created_at, updated_at';
  const before = JSON.stringify(
    old.prepare(`SELECT ${legacyColumns} FROM actors WHERE actor_id = ?`).get('usr_legacy'),
  );

  const applied = migrate(old, MIGRATIONS);
  checkEqual(
    '旧库升级按顺序应用剩余迁移',
    applied.join(','),
    '0009_feedback.sql,0010_room_tasks.sql,0011_delivery_reminders.sql,' +
      '0012_identity_management_devices.sql,0017_task_workflow.sql,0018_p0_guards.sql,' +
      '0019_contact_relations.sql,' +
      '0020_group_roles.sql,0021_owner_leave_guard.sql,0022_contact_blocks_reports.sql,' +
      '0023_room_invitations.sql,0024_room_owner_transfers.sql,0025_group_history_boundary.sql,' +
      '0026_private_files_retention.sql,0027_group_invite_links.sql,0028_message_mentions.sql,' +
      '0029_task_progress.sql,0030_task_initial_assignee.sql,' +
      '0031_task_initial_assignee_known.sql,0032_task_submission_sources.sql,' +
      '0033_task_review_acceptance.sql,0034_task_handoff_packs.sql,' +
      '0035_task_recovery.sql,0036_device_pairing_sync.sql,0037_room_lifecycle.sql,' +
      '0038_ownerless_room_guard.sql,0039_delivery_message_state_index.sql,' +
      '0040_contact_invite_links.sql,0041_message_task_trace.sql,' +
      '0042_drop_legacy_tasks.sql,0043_group_history_full_backfill.sql,' +
      '0044_files_public_backfill.sql,0045_memory_ledger.sql',
  );
  checkEqual(
    '旧库升级保留原业务数据',
    JSON.stringify(
      old.prepare(`SELECT ${legacyColumns} FROM actors WHERE actor_id = ?`).get('usr_legacy'),
    ),
    before,
  );
  checkEqual('旧库升级后 feedback 表可用', count(old, 'feedback'), 0);
  const schema = (table: string): number =>
    (
      old
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { n: number }
    ).n;
  for (const table of [
    'room_tasks',
    'tasks',
    'task_assignments',
    'task_cards',
    'task_handoff_packs',
  ]) {
    checkEqual(`旧库升级后 ${table} 已删除`, schema(table), 0);
  }
  const artifactColumns = old.prepare('PRAGMA table_info(artifacts)').all() as {
    name: string;
  }[];
  check(
    '旧库升级后 artifacts.task_id 已删除',
    !artifactColumns.some((column) => column.name === 'task_id'),
  );
  const roomColumns = old.prepare('PRAGMA table_info(rooms)').all() as { name: string }[];
  check(
    '旧库升级后 rooms.member_task_policy 已删除',
    !roomColumns.some((column) => column.name === 'member_task_policy'),
  );
  const deliveryColumns = old.prepare('PRAGMA table_info(deliveries)').all() as {
    name: string;
  }[];
  check(
    '旧库升级后 deliveries.last_reminded_at 可用',
    deliveryColumns.some((column) => column.name === 'last_reminded_at'),
  );
  const deliveryIndexes = old.prepare('PRAGMA index_list(deliveries)').all() as {
    name: string;
  }[];
  check(
    '旧库升级后提醒扫描索引可用',
    deliveryIndexes.some((index) => index.name === 'idx_deliveries_claimed_progress'),
  );
  old.close();
}

async function checkDomainWrites(): Promise<void> {
  const db = openDb();
  seedActors(db);
  const d1 = createD1(db);
  const principal = principalFor(getActorRow(db, 'usr_feedback'));
  const otherPrincipal = principalFor(getActorRow(db, 'usr_feedback_other'));

  const canaryToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const canaryUrl = `https://example.test/private?token=${canaryToken}#fragment`;
  const firstInput = makeInput({
    environment: `os=Unit AGENTNET_MCP_URL=${canaryUrl} AGENTNET_TOKEN=${canaryToken}`,
    harness: 'unit',
    problem: `多行问题\nAuthorization: Bearer ${canaryToken}\napi_key=${canaryToken}\n见 ${canaryUrl}`,
  });
  const beforeBusiness = businessSnapshot(db);

  const first = (await createFeedback(d1, principal, firstInput)) as FeedbackCreateResult;
  const row = feedbackRow(db, first.feedback_id);
  checkEqual('反馈 actor_id 来自 principal', row.actor_id, principal.actor!.actor_id);
  checkEqual('反馈 created_at 为服务器毫秒字符串', first.created_at, String(row.created_at));
  check('反馈 created_at 为整数毫秒', Number.isInteger(row.created_at), row.created_at);
  check(
    'environment 不保存完整 URL 或 token',
    !row.environment.includes(canaryUrl) &&
      !row.environment.includes(canaryToken) &&
      row.environment.includes('[REDACTED]'),
  );
  check(
    'problem 保留换行并替换 Bearer/token/URL',
    row.problem.includes('多行问题') &&
      row.problem.includes('\n') &&
      !row.problem.includes(canaryToken) &&
      !row.problem.includes(canaryUrl) &&
      row.problem.includes('[REDACTED]') &&
      row.problem.includes('[REDACTED_URL]'),
  );
  checkEqual(
    '反馈结果只含 feedback_id/created_at',
    Object.keys(first).sort().join(','),
    'created_at,feedback_id',
  );
  const operation = operationRow(db, principal.actor!.actor_id, firstInput.request_id);
  const operationResult = JSON.parse(operation.result_json) as Record<string, unknown>;
  checkEqual(
    'operations 只保存安全结果字段',
    Object.keys(operationResult).sort().join(','),
    'created_at,feedback_id',
  );
  check(
    'operations 不保存反馈正文或原始凭据',
    !operation.result_json.includes(canaryToken) &&
      !operation.result_json.includes(canaryUrl) &&
      !operation.result_json.includes('多行问题'),
  );
  checkEqual('payload_hash 为 64 位十六进制', operation.payload_hash.length, 64);
  checkEqual('首次反馈写入一行', count(db, 'feedback'), 1);
  checkEqual('首次反馈写入一条 operations', count(db, 'operations'), 1);
  checkEqual('反馈不产生 events/outbox 或未读变化', businessSnapshot(db), beforeBusiness);

  const replay = await createFeedback(d1, principal, firstInput);
  checkEqual('同参重放返回原 feedback_id', replay.feedback_id, first.feedback_id);
  checkEqual('同参重放返回原 created_at', replay.created_at, first.created_at);
  checkEqual('同参重放不新增反馈行', count(db, 'feedback'), 1);

  const conflict = makeInput({ request_id: firstInput.request_id, problem: '另一个问题' });
  await expectBusinessError(
    '同 request_id 改正文返回 IDEMPOTENCY_CONFLICT',
    createFeedback(d1, principal, conflict),
    'IDEMPOTENCY_CONFLICT',
  );

  const other = await createFeedback(d1, otherPrincipal, {
    ...firstInput,
    problem: '另一个 actor 的相同 request_id',
  });
  check('不同 actor 的相同 request_id 独立', other.feedback_id !== first.feedback_id);
  checkEqual('不同 actor 写入独立反馈行', count(db, 'feedback'), 2);

  await expectBusinessError(
    'environment 多字节超长返回 PAYLOAD_TOO_LARGE',
    createFeedback(d1, principal, makeInput({ environment: '字'.repeat(1366) })),
    'PAYLOAD_TOO_LARGE',
  );
  await expectBusinessError(
    'harness 超长返回 PAYLOAD_TOO_LARGE',
    createFeedback(d1, principal, makeInput({ harness: 'a'.repeat(129) })),
    'PAYLOAD_TOO_LARGE',
  );
  await expectBusinessError(
    'problem 多字节超长返回 PAYLOAD_TOO_LARGE',
    createFeedback(d1, principal, makeInput({ problem: '问'.repeat(5462) })),
    'PAYLOAD_TOO_LARGE',
  );
  await expectBusinessError(
    '全空白 environment 返回 INVALID_ARGUMENT',
    createFeedback(d1, principal, makeInput({ environment: ' \n\t ' })),
    'INVALID_ARGUMENT',
  );
  await expectBusinessError(
    'harness 控制字符返回 INVALID_ARGUMENT',
    createFeedback(d1, principal, makeInput({ harness: 'codex\nperi' })),
    'INVALID_ARGUMENT',
  );
  await expectBusinessError(
    'request_id 含空格返回 INVALID_ARGUMENT',
    createFeedback(d1, principal, makeInput({ request_id: 'bad request id' })),
    'INVALID_ARGUMENT',
  );
  await expectBusinessError(
    'request_id 含非 ASCII 返回 INVALID_ARGUMENT',
    createFeedback(d1, principal, makeInput({ request_id: '反馈id' })),
    'INVALID_ARGUMENT',
  );

  const injection = "x'); DROP TABLE feedback;--";
  const injected = await createFeedback(
    d1,
    principal,
    makeInput({ problem: injection, environment: 'injection', harness: 'unit' }),
  );
  checkEqual(
    'SQL 注入样式文本按普通数据保存',
    feedbackRow(db, injected.feedback_id).problem,
    injection,
  );
  checkEqual('注入样式文本未删除 feedback 表', count(db, 'feedback'), 3);

  const beforeFailure = businessSnapshot(db);
  const beforeFeedback = count(db, 'feedback');
  const beforeOperations = count(db, 'operations');
  db.exec(
    "CREATE TRIGGER feedback_unit_fail BEFORE INSERT ON feedback BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
  );
  const failingInput = makeInput({ problem: `触发回滚 ${canaryToken}` });
  let failed = false;
  try {
    await createFeedback(d1, principal, failingInput);
  } catch {
    failed = true;
  }
  db.exec('DROP TRIGGER feedback_unit_fail;');
  check('feedback 插入失败抛出异常', failed);
  checkEqual('batch 失败不留下 feedback 行', count(db, 'feedback'), beforeFeedback);
  checkEqual('batch 失败不留下 operations 行', count(db, 'operations'), beforeOperations);
  checkEqual('batch 失败不改变业务状态', businessSnapshot(db), beforeFailure);

  const rebuilt = await createFeedback(d1, principal, firstInput);
  checkEqual('重建 D1 适配器重放仍取原结果', rebuilt.feedback_id, first.feedback_id);

  db.prepare('DELETE FROM operations WHERE actor_id = ? AND request_id = ?').run(
    principal.actor!.actor_id,
    firstInput.request_id,
  );
  const afterCleanup = await createFeedback(d1, principal, firstInput);
  check('operations 清理后同 request_id 可再提交', afterCleanup.feedback_id !== first.feedback_id);
  checkEqual('清理后重新提交新增反馈行', count(db, 'feedback'), beforeFeedback + 1);

  const redacted = redactFeedbackText(
    `Authorization: Bearer ${canaryToken} AGENTNET_TOKEN=${canaryToken} secret: ${canaryToken}`,
  );
  check(
    '脱敏 helper 替换 Bearer 与常见赋值',
    !redacted.includes(canaryToken) &&
      redacted.includes('Bearer [REDACTED]') &&
      redacted.includes('AGENTNET_TOKEN=[REDACTED]'),
    redacted,
  );

  db.close();
}

async function checkSafeToolErrors(): Promise<void> {
  const canary = `canary-${crypto.randomUUID()}`;
  const logs: unknown[][] = [];
  const originalError = console.error;
  let callback: ((args: unknown) => Promise<unknown>) | undefined;
  const fakeServer = {
    registerTool(
      _name: string,
      _config: Record<string, unknown>,
      handler: (args: unknown) => Promise<unknown>,
    ) {
      callback = handler;
    },
  } as unknown as McpServer;

  try {
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    register(
      fakeServer,
      'network_feedback_create',
      'unit safe error check',
      feedbackCreateSchema,
      feedbackCreateResultSchema,
      async () => {
        throw new Error(`unexpected ${canary} SQLITE_BIND_VALUE`);
      },
      undefined,
      { safeErrors: true },
    );
    if (!callback) throw new CheckFailure('safe error', '未捕获注册回调');
    const response = (await callback({})) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    const text = response.content?.[0]?.text ?? '';
    checkEqual('未知异常返回固定 INTERNAL_ERROR', JSON.parse(text).code, 'INTERNAL_ERROR');
    check('未知异常响应不含 canary', !JSON.stringify(response).includes(canary));
    check('未知异常日志不含 canary 或原始错误', !JSON.stringify(logs).includes(canary));
    checkEqual('未知异常只记录一次固定分类', logs.length, 1);
  } finally {
    console.error = originalError;
  }

  try {
    register(
      fakeServer,
      'network_feedback_create',
      'unit business error check',
      feedbackCreateSchema,
      feedbackCreateResultSchema,
      async () => {
        throw new BusinessError('INVALID_ARGUMENT', 'bad input');
      },
      undefined,
      { safeErrors: true },
    );
    if (!callback) throw new CheckFailure('safe error', '未捕获注册回调');
    const response = (await callback({})) as { content?: { text?: string }[] };
    checkEqual(
      '安全路径仍返回业务错误码',
      JSON.parse(response.content?.[0]?.text ?? '{}').code,
      'INVALID_ARGUMENT',
    );
  } finally {
    console.error = originalError;
  }
}

export async function runFeedbackUnitChecks(): Promise<void> {
  const db = openDb();
  check(
    '新库应用 0009_feedback.sql',
    (db.prepare("SELECT name FROM schema_migrations WHERE name = '0009_feedback.sql'").get() as
      | { name: string }
      | null) !== null,
  );
  checkEqual('二次 migrate 无变更', migrate(db, MIGRATIONS).length, 0);
  checkSchemaShape(db);
  db.close();

  checkMigrationUpgrade();
  await checkDomainWrites();
  await checkSafeToolErrors();

  // 阈值常量与工具 schema 描述保持一致，避免文档/测试各自复制数字。
  const schemaText = JSON.stringify(z.toJSONSchema(feedbackCreateSchema));
  check(
    'schema 描述包含 UTF-8 字节上限',
    schemaText.includes(String(LIMITS.feedbackEnvironmentBytes)) &&
      schemaText.includes(String(LIMITS.feedbackHarnessBytes)) &&
      schemaText.includes(String(LIMITS.feedbackProblemBytes)),
  );
}
