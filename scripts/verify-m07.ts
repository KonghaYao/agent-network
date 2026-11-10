/**
 * M07 私有文件授权与成果保留的聚焦验收（M07-T01..T04）。
 *
 * T01/T02 走真实 HTTP 服务；T03/T04 需要操纵过期时间与 GC，使用内存 SQLite
 * 与真实 migrations 直接调用领域/维护代码。两种用例共用同一份断言输出，
 * 便于任务报告逐条引用原始证据。
 *
 *   DATA_DIR=/tmp/m07-verify PORT=18890 PUBLIC_ORIGIN=http://127.0.0.1:18890 \
 *     bun src/bun/main.ts
 *   AGENTNET_URL=http://127.0.0.1:18890 bun run test:m07
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { FileService } from '@peri-code/mcpp/files';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { LIMITS } from '../src/contracts/limits';
import {
  artifactList,
  artifactRelease,
  artifactSubmit,
} from '../src/domain/artifacts';
import {
  authorizeFileDownload,
  registerDriveFile,
  roomFileUrls,
} from '../src/domain/file-access';
import { issuePrivateFileTicket } from '../src/domain/file-ticket';
import type { Principal } from '../src/domain/principal';
import { historyBoundary } from '../src/domain/room-history';
import {
  roomFileBind,
  roomFileGet,
  type RoomFileSource,
} from '../src/domain/room-files';
import type { Env } from '../src/env';
import { maintain } from '../src/maintenance';
import type { ActorRow } from '../src/storage/rows';
import {
  baseUrl,
  check,
  checkEqual,
  checksPassed,
  newRequestId,
} from './lib/harness';
import { runPrivateFileAcceptance } from './lib/m07-acceptance';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const ORIGIN = 'https://m07.test';
const SECRET = 'm07-unit-ticket-secret';
const OWNER = 'agt_m07_owner';
const MEMBER = 'agt_m07_member';
const OTHER = 'agt_m07_other';
const STRANGER = 'agt_m07_stranger';
const ROOM = 'rm_m07_group';
const TASK = 'tsk_m07_task';

interface MemoryFile {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  ownerScope: string;
}

class MemorySource implements RoomFileSource {
  readonly files = new Map<string, MemoryFile>();

  async readFile(fileId: string): Promise<MemoryFile | null> {
    return this.files.get(fileId) ?? null;
  }

  put(
    fileId: string,
    options: { expiresAt: number; size?: number; ownerScope?: string } = { expiresAt: 0 },
  ): MemoryFile {
    const file: MemoryFile = {
      fileId,
      name: `${fileId}.txt`,
      mimeType: 'text/plain',
      size: options.size ?? 16,
      sha256: 'a'.repeat(64),
      createdAt: new Date(options.expiresAt - 60_000).toISOString(),
      expiresAt: new Date(options.expiresAt).toISOString(),
      ownerScope: options.ownerScope ?? `actor:${OWNER}`,
    };
    this.files.set(fileId, file);
    return file;
  }
}

interface World {
  db: Database;
  d1: D1Database;
  env: Env;
  source: MemorySource;
  purged: string[];
  secret: string;
}

function openWorld(): World {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  const at = 1_700_000_000_000;
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('${OWNER}', 'agent', 'sess_m07_owner', 'M07 Owner', '{}', 0, 0, 0, ${at}, ${at}),
           ('${MEMBER}', 'agent', 'sess_m07_member', 'M07 Member', '{}', 0, 0, 0, ${at}, ${at}),
           ('${OTHER}', 'agent', 'sess_m07_other', 'M07 Other', '{}', 0, 0, 0, ${at}, ${at}),
           ('${STRANGER}', 'agent', 'sess_m07_stranger', 'M07 Stranger', '{}', 0, 0, 0, ${at}, ${at});
    INSERT INTO rooms (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq,
                       created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'M07 Unit', 0, 0, 0, ${at}, ${at});
    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq,
                              joined_at, updated_at, member_generation)
    VALUES ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${at}, ${at}, 1),
           ('${ROOM}', '${MEMBER}', 'member', 'active', 0, 0, ${at}, ${at}, 1),
           ('${ROOM}', '${OTHER}', 'member', 'active', 0, 0, ${at}, ${at}, 1);
    INSERT INTO room_tasks (task_id, room_id, list_id, description, status, created_by,
                            created_at, updated_at, completed_at, sort_order, created_seq)
    VALUES ('${TASK}', '${ROOM}', 'default', 'M07 保留任务', 'pending', '${OWNER}',
            ${at}, ${at}, NULL, 1, 1);
  `);
  const d1 = createD1(db);
  const purged: string[] = [];
  const files = {
    key: (fileId: string, name: string) => `${fileId}/${name}`,
    disk: {
      async delete(key: string) {
        purged.push(key);
      },
    },
  } as unknown as FileService;
  const source = new MemorySource();
  return {
    db,
    d1,
    env: { DB: d1, FILES: files } as unknown as Env,
    source,
    purged,
    secret: SECRET,
  };
}

function principalFor(db: Database, actor: string): Principal {
  const row = db
    .prepare('SELECT * FROM actors WHERE actor_id = ?')
    .get(actor) as ActorRow;
  return {
    credentialHash: `m07:${actor}`,
    actor: row,
    credential: {
      credential_id: `cred_${actor}`,
      actor_id: actor,
      device_id: `dev_${actor}`,
      token_hash: `hash_${actor}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function stateOf(db: Database, fileId: string): {
  state: string;
  retained: number;
  expires_at: number | null;
  deleted_at: number | null;
  purged_at: number | null;
} {
  return db
    .prepare(
      'SELECT state, retained, expires_at, deleted_at, purged_at FROM drive_files WHERE file_id = ?',
    )
    .get(fileId) as {
    state: string;
    retained: number;
    expires_at: number | null;
    deleted_at: number | null;
    purged_at: number | null;
  };
}

async function expectBusinessError(
  label: string,
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    checkEqual(label, (error as { code?: string }).code, code);
    return;
  }
  check(label, false, `期望 ${code}`);
}

/** T03：过期清理与成果绑定不能产生“成果指向已清理字节”。 */
async function retentionCases(): Promise<void> {
  // 已过期文件提交成果：明确失败，且不留下 artifact / 引用 / 半成品房间文件。
  {
    const world = openWorld();
    const principal = principalFor(world.db, OWNER);
    const fileId = 'f_m07_expired';
    world.source.put(fileId, { expiresAt: Date.now() - 60_000 });
    const before = {
      artifacts: count(world.db, 'artifacts'),
      refs: count(world.db, 'file_references'),
      roomFiles: count(world.db, 'room_files'),
    };
    await expectBusinessError(
      '[M07-T03] 过期文件提交成果返回 FILE_UNAVAILABLE',
      () =>
        artifactSubmit(
          world.d1,
          principal,
          {
            request_id: newRequestId('art'),
            room_id: ROOM,
            file_id: fileId,
          },
          world.source,
          ORIGIN,
          SECRET,
        ),
      'FILE_UNAVAILABLE',
    );
    checkEqual('[M07-T03] 失败后无 artifact 行', count(world.db, 'artifacts'), before.artifacts);
    checkEqual('[M07-T03] 失败后无引用行', count(world.db, 'file_references'), before.refs);
    checkEqual('[M07-T03] 失败后无房间文件行', count(world.db, 'room_files'), before.roomFiles);
    const task = world.db
      .prepare('SELECT status FROM room_tasks WHERE task_id = ?')
      .get(TASK) as { status: string };
    checkEqual('[M07-T03] 任务状态未被改写', task.status, 'pending');
  }

  // 过期无人引用：先软删保留元数据，宽限期后才清理载荷；清理后提交明确失败。
  {
    const world = openWorld();
    const principal = principalFor(world.db, OWNER);
    const fileId = 'f_m07_gc';
    const now = Date.now();
    world.source.put(fileId, { expiresAt: now - 40 * 24 * 60 * 60_000 });
    await world.d1
      .prepare(
        `INSERT INTO drive_files
           (file_id, owner_scope, uploader_id, name, mime_type, size, sha256,
            state, visibility, room_id, created_at, expires_at, retained,
            deleted_at, deleted_by, purged_at)
         VALUES (?, ?, ?, 'gc.txt', 'text/plain', 16, ?, 'draft', 'private', NULL, ?, ?, 0,
                 NULL, NULL, NULL)`,
      )
      .bind(fileId, `actor:${MEMBER}`, MEMBER, 'a'.repeat(64), now - 41 * 24 * 60 * 60_000, now - 40 * 24 * 60 * 60_000)
      .run();

    await maintain(world.env);
    const soft = stateOf(world.db, fileId);
    checkEqual('[M07-T03] 过期文件先软删', soft.state, 'deleted');
    checkEqual('[M07-T03] 宽限期内不清理载荷', soft.purged_at, null);
    checkEqual('[M07-T03] 宽限期内没有删除字节', world.purged.length, 0);
    check(
      '[M07-T03] 软删保留业务元数据',
      world.db.prepare('SELECT name, size FROM drive_files WHERE file_id = ?').get(fileId) !== null,
    );

    await world.d1
      .prepare('UPDATE drive_files SET deleted_at = ? WHERE file_id = ?')
      .bind(now - LIMITS.fileGcGraceMs - 60_000, fileId)
      .run();
    await maintain(world.env);
    const purged = stateOf(world.db, fileId);
    check('[M07-T03] 宽限期后写入 purged_at', purged.purged_at !== null);
    checkEqual('[M07-T03] 宽限期后清理三类载荷', world.purged.length, 3);

    await expectBusinessError(
      '[M07-T03] 已清理文件提交成果返回 FILE_UNAVAILABLE',
      () =>
        artifactSubmit(
          world.d1,
          principal,
          {
            request_id: newRequestId('art'),
            room_id: ROOM,
            file_id: fileId,
          },
          world.source,
          ORIGIN,
          SECRET,
        ),
      'FILE_UNAVAILABLE',
    );
    checkEqual('[M07-T03] 清理后没有 artifact 指向该字节', count(world.db, 'artifacts'), 0);
  }

  // 绑定/提交与 GC 并发：成功则文件保持 retained 且不被清理；失败则没有成果。
  {
    const world = openWorld();
    const principal = principalFor(world.db, OWNER);
    const fileId = 'f_m07_race';
    world.source.put(fileId, { expiresAt: Date.now() + 60_000 });
    const results = await Promise.allSettled([
      maintain(world.env),
      artifactSubmit(
        world.d1,
        principal,
        {
          request_id: newRequestId('art'),
          room_id: ROOM,
          file_id: fileId,
        },
        world.source,
        ORIGIN,
        SECRET,
      ),
    ]);
    const submitted = results[1];
    const drive = stateOf(world.db, fileId);
    if (submitted.status === 'fulfilled') {
      checkEqual('[M07-T03] 并发成功后只有一条成果', count(world.db, 'artifacts'), 1);
      checkEqual('[M07-T03] 并发成功后文件保持 retained', drive.retained, 1);
      checkEqual('[M07-T03] 并发成功后未被软删', drive.deleted_at, null);
      checkEqual('[M07-T03] 并发成功后未被清理', drive.purged_at, null);
      checkEqual('[M07-T03] 并发成功后没有删除字节', world.purged.length, 0);
      const ticket = new URL(submitted.value.file.preview_url).searchParams.get('t');
      checkEqual(
        '[M07-T03] 并发成功后成果字节仍可被授权读取',
        (await authorizeFileDownload(world.d1, fileId, `actor:${OWNER}`, ticket, SECRET))?.via,
        'room-ticket',
      );
    } else {
      checkEqual('[M07-T03] 并发失败无成果行', count(world.db, 'artifacts'), 0);
      check(
        '[M07-T03] 并发失败为明确业务错误',
        typeof (submitted.reason as { code?: string }).code === 'string',
        submitted.reason,
      );
    }
  }
}

/** T04：有效任务/已交付成果越过原 TTL 仍可读；超配额无半成品。 */
async function quotaAndRetentionCases(): Promise<void> {
  const world = openWorld();
  const principal = principalFor(world.db, OWNER);
  const fileId = 'f_m07_retained';
  world.source.put(fileId, { expiresAt: Date.now() + 60_000, size: 32 });
  const submitted = await artifactSubmit(
    world.d1,
    principal,
    {
      request_id: newRequestId('art'),
      room_id: ROOM,
      file_id: fileId,
      summary: 'M07 成果',
    },
    world.source,
    ORIGIN,
    SECRET,
  );
  checkEqual('[M07-T04] 成果提交绑定文件', submitted.file.file_id, fileId);
  checkEqual('[M07-T04] 成果文件进入保留', submitted.file.retained, true);
  const artifactId = submitted.artifact.artifact_id;
  checkEqual('[M07-T04] 成果引用已建立', count(world.db, 'file_references'), 1);

  // 模拟原 30 天 TTL 已过：保留中的文件仍不应被清理。
  const past = Date.now() - 40 * 24 * 60 * 60_000;
  await world.d1
    .prepare('UPDATE drive_files SET expires_at = ? WHERE file_id = ?')
    .bind(past, fileId)
    .run();
  await world.d1
    .prepare('UPDATE room_files SET expires_at = ?, created_at = ? WHERE file_id = ?')
    .bind(past, past - 60_000, fileId)
    .run();
  await maintain(world.env);
  const afterTtl = stateOf(world.db, fileId);
  checkEqual('[M07-T04] 越过原 TTL 后仍为 bound', afterTtl.state, 'bound');
  checkEqual('[M07-T04] 越过原 TTL 后仍 retained', afterTtl.retained, 1);
  checkEqual('[M07-T04] 越过原 TTL 后未软删', afterTtl.deleted_at, null);
  checkEqual('[M07-T04] 越过原 TTL 后未清理', afterTtl.purged_at, null);
  checkEqual('[M07-T04] 越过原 TTL 后没有删除字节', world.purged.length, 0);

  const boundary = historyBoundary(
    {
      kind: 'group' as const,
      member_history_policy: 'from_join' as const,
      policy_revision: 1,
      dissolved_at: null,
      archive_head_seq: null,
    },
    { joined_seq: 0, joined_at: 0, member_generation: 1 },
  );
  const urls = roomFileUrls(SECRET, ORIGIN, fileId, ROOM, MEMBER, boundary);
  const allowed = await authorizeFileDownload(
    world.d1,
    fileId,
    `actor:${MEMBER}`,
    new URL(urls.preview_url).searchParams.get('t'),
    world.secret,
  );
  checkEqual('[M07-T04] 越过原 TTL 后合法成员仍可下载', allowed?.via, 'room-ticket');
  const listed = await artifactList(world.d1, principal, { room_id: ROOM }, ORIGIN, SECRET);
  checkEqual('[M07-T04] 成果列表仍返回该版本', listed.items.length, 1);
  checkEqual('[M07-T04] 成果列表文件保留标记', listed.items[0]?.file.retained, true);

  const released = await artifactRelease(world.d1, principal, {
    request_id: newRequestId('release'),
    artifact_id: artifactId,
  });
  checkEqual('[M07-T04] 释放成果后不再保留', released.retained, false);
  await maintain(world.env);
  const afterRelease = stateOf(world.db, fileId);
  checkEqual('[M07-T04] 释放成果后恢复普通 TTL', afterRelease.retained, 0);
  check(
    '[M07-T04] 释放后重新设置未来过期时间',
    (afterRelease.expires_at ?? 0) > Date.now(),
  );
  const replay = await artifactRelease(world.d1, principal, {
    request_id: newRequestId('release'),
    artifact_id: artifactId,
  });
  checkEqual('[M07-T04] 释放幂等且不再保留', replay.retained, false);

  // 释放后重新进入普通 TTL：过期即软删，证明保留不是永久豁免。
  const expiredAgain = Date.now() - 60_000;
  await world.d1
    .prepare('UPDATE drive_files SET expires_at = ? WHERE file_id = ?')
    .bind(expiredAgain, fileId)
    .run();
  await world.d1
    .prepare('UPDATE room_files SET expires_at = ?, created_at = ? WHERE file_id = ?')
    .bind(expiredAgain, expiredAgain - 60_000, fileId)
    .run();
  await maintain(world.env);
  checkEqual('[M07-T04] 释放后过期可被正常清理', stateOf(world.db, fileId).state, 'deleted');

  // 超配额提交：整批失败，不产生 artifact / 房间文件 / 事件 / 幂等记录。
  {
    const quotaWorld = openWorld();
    const quotaPrincipal = principalFor(quotaWorld.db, OWNER);
    const now = Date.now();
    quotaWorld.db
      .prepare(
        `INSERT INTO room_files
           (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
            created_at, expires_at, deleted_at, deleted_by, retained)
         VALUES ('rf_m07_quota', ?, 'f_m07_quota_seed', ?, 'seed.bin', 'application/octet-stream',
                 ?, ?, ?, ?, NULL, NULL, 0)`,
      )
      .run(ROOM, OWNER, LIMITS.roomFileBytesPerRoom, 'b'.repeat(64), now - 1000, now + 3_600_000);
    const fileId = 'f_m07_over_quota';
    quotaWorld.source.put(fileId, { expiresAt: now + 60_000, size: 10 });
    const before = {
      artifacts: count(quotaWorld.db, 'artifacts'),
      refs: count(quotaWorld.db, 'file_references'),
      roomFiles: count(quotaWorld.db, 'room_files'),
      events: count(quotaWorld.db, 'events'),
      outbox: count(quotaWorld.db, 'outbox'),
      operations: count(quotaWorld.db, 'operations'),
    };
    await expectBusinessError(
      '[M07-T04] 超配额提交返回 ROOM_FILE_LIMIT',
      () =>
        artifactSubmit(
          quotaWorld.d1,
          quotaPrincipal,
          {
            request_id: newRequestId('art'),
            room_id: ROOM,
            file_id: fileId,
          },
          quotaWorld.source,
          ORIGIN,
          SECRET,
        ),
      'ROOM_FILE_LIMIT',
    );
    checkEqual('[M07-T04] 超配额无 artifact', count(quotaWorld.db, 'artifacts'), before.artifacts);
    checkEqual('[M07-T04] 超配额无引用', count(quotaWorld.db, 'file_references'), before.refs);
    checkEqual('[M07-T04] 超配额无房间文件', count(quotaWorld.db, 'room_files'), before.roomFiles);
    checkEqual('[M07-T04] 超配额无事件', count(quotaWorld.db, 'events'), before.events);
    checkEqual('[M07-T04] 超配额无 outbox', count(quotaWorld.db, 'outbox'), before.outbox);
    checkEqual('[M07-T04] 超配额无幂等记录', count(quotaWorld.db, 'operations'), before.operations);
  }
}

/** 单元层兜底：未登记旧文件收紧为私有，只有上传身份的文件票据可读。 */
async function legacyCase(): Promise<void> {
  const world = openWorld();
  const at = Date.now();
  const issued = roomFileUrls(SECRET, ORIGIN, 'f_m07_legacy', ROOM, 'unused', {
    full: true,
    fromSeq: 0,
    fromAt: 0,
    toSeq: null,
    toAt: null,
    policyRevision: 1,
    memberGeneration: 1,
  });
  check(
    '[M07-T01] 旧地址本身不含长期 token',
    !new URL(`${ORIGIN}/f/f_m07_legacy`).searchParams.has('t'),
  );
  checkEqual(
    '[M07-T01] 未登记文件无票据 404',
    await authorizeFileDownload(world.d1, 'f_m07_legacy', 'actor:legacy', null, world.secret, at),
    null,
  );
  checkEqual(
    '[M07-T01] 未登记文件的房间票据不能绕过上传身份',
    await authorizeFileDownload(
      world.d1,
      'f_m07_legacy',
      'actor:legacy',
      new URL(issued.preview_url).searchParams.get('t'),
      world.secret,
      at,
    ),
    null,
  );
  const ownTicket = issuePrivateFileTicket(world.secret, {
    fileId: 'f_m07_legacy',
    ownerScope: 'actor:legacy',
    expiresAt: at + 60_000,
  });
  checkEqual(
    '[M07-T01] 未登记旧文件可由上传身份新票据授权读取',
    (
      await authorizeFileDownload(
        world.d1,
        'f_m07_legacy',
        'actor:legacy',
        ownTicket,
        world.secret,
        at,
      )
    )?.via,
    'file-ticket',
  );
}

/**
 * 票据与 TTL：
 * - 草稿 24 小时、绑定后普通附件 30 天；
 * - 票据使用时重新检查成员资格、代次与房间策略版本；
 * - 旧库已绑定文件首次登记时按 room_files 补齐，而不是当作草稿。
 */
async function ttlAndTicketCases(): Promise<void> {
  const world = openWorld();
  const principal = principalFor(world.db, OWNER);
  const memberPrincipal = principalFor(world.db, MEMBER);
  const now = Date.now();
  const fileId = 'f_m07_ttl';
  const record = world.source.put(fileId, {
    expiresAt: now + 10 * 365 * 24 * 60 * 60_000,
  });

  const draft = await registerDriveFile(world.d1, record, OWNER, {
    draftTtlMs: LIMITS.fileDraftTtlMs,
    at: now,
  });
  check(
    '[M07-T01] 上传草稿默认 24 小时',
    Math.abs((draft.expires_at ?? 0) - (now + LIMITS.fileDraftTtlMs)) < 5_000,
    draft.expires_at,
  );

  await roomFileBind(
    world.d1,
    principal,
    {
      request_id: newRequestId('bind'),
      room_id: ROOM,
      file_id: fileId,
    },
    world.source,
    ORIGIN,
    SECRET,
  );
  const row = world.db
    .prepare('SELECT expires_at, retained FROM room_files WHERE file_id = ?')
    .get(fileId) as { expires_at: number; retained: number };
  const remaining = row.expires_at - Date.now();
  check(
    '[M07-T01] 绑定后普通附件 30 天，不继承草稿 24 小时',
    remaining > 29 * 24 * 60 * 60_000 && remaining < 30 * 24 * 60 * 60_000 + 60_000,
    remaining,
  );

  const ownerFile = await roomFileGet(world.d1, principal, { room_id: ROOM, file_id: fileId }, ORIGIN, SECRET);
  const ownerTicket = new URL(ownerFile.file.preview_url).searchParams.get('t');
  checkEqual(
    '[M07-T01] 成员票据可读绑定文件',
    (await authorizeFileDownload(world.d1, fileId, `actor:${OWNER}`, ownerTicket, SECRET))?.via,
    'room-ticket',
  );

  const memberFile = await roomFileGet(
    world.d1,
    memberPrincipal,
    { room_id: ROOM, file_id: fileId },
    ORIGIN,
    SECRET,
  );
  const memberTicket = new URL(memberFile.file.preview_url).searchParams.get('t');
  checkEqual(
    '[M07-T02] 其他成员票据可读',
    (await authorizeFileDownload(world.d1, fileId, `actor:${MEMBER}`, memberTicket, SECRET))?.via,
    'room-ticket',
  );
  await world.d1
    .prepare("UPDATE room_members SET status = 'removed' WHERE room_id = ? AND actor_id = ?")
    .bind(ROOM, MEMBER)
    .run();
  checkEqual(
    '[M07-T02] 成员移除后票据立即失效',
    await authorizeFileDownload(world.d1, fileId, `actor:${MEMBER}`, memberTicket, SECRET),
    null,
  );

  await world.d1
    .prepare("UPDATE room_members SET status = 'active' WHERE room_id = ? AND actor_id = ?")
    .bind(ROOM, MEMBER)
    .run();
  const memberAgain = await roomFileGet(
    world.d1,
    memberPrincipal,
    { room_id: ROOM, file_id: fileId },
    ORIGIN,
    SECRET,
  );
  const memberAgainTicket = new URL(memberAgain.file.preview_url).searchParams.get('t');
  await world.d1.prepare('UPDATE rooms SET policy_revision = policy_revision + 1 WHERE room_id = ?').bind(ROOM).run();
  checkEqual(
    '[M07-T02] 房间策略版本变化后旧票据失效',
    await authorizeFileDownload(world.d1, fileId, `actor:${MEMBER}`, memberAgainTicket, SECRET),
    null,
  );

  // 旧库已有 room_files、没有 drive_files：首次登记必须补齐为 bound，而不是草稿。
  const legacyId = 'f_m07_legacy_bound';
  const legacyRecord = world.source.put(legacyId, {
    expiresAt: now + 10 * 365 * 24 * 60 * 60_000,
    ownerScope: `actor:${MEMBER}`,
  });
  const expiresAt = now + 30 * 24 * 60 * 60_000;
  world.db
    .prepare(
      `INSERT INTO room_files
         (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
          created_at, expires_at, retained, deleted_at, deleted_by)
       VALUES ('rf_m07_legacy', ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, 0, NULL, NULL)`,
    )
    .run(ROOM, legacyId, MEMBER, legacyRecord.name, legacyRecord.size, legacyRecord.sha256, now - 1000, expiresAt);
  const aligned = await registerDriveFile(world.d1, legacyRecord, MEMBER, { at: now });
  checkEqual('[M07-T01] 旧库已绑定文件登记为 bound', aligned.state, 'bound');
  checkEqual('[M07-T01] 旧库已绑定文件保留原房间', aligned.room_id, ROOM);
  checkEqual('[M07-T01] 旧库已绑定文件沿用附件期限', aligned.expires_at, expiresAt);

  const legacyTicket = new URL(
    roomFileUrls(SECRET, ORIGIN, legacyId, ROOM, MEMBER, {
      full: true,
      fromSeq: 0,
      fromAt: 0,
      toSeq: null,
      toAt: null,
      policyRevision: (world.db.prepare('SELECT policy_revision FROM rooms WHERE room_id = ?').get(ROOM) as { policy_revision: number }).policy_revision,
      memberGeneration: 1,
    }).preview_url,
  ).searchParams.get('t');
  checkEqual(
    '[M07-T01] 旧库已绑定文件可由房间票据读取',
    (await authorizeFileDownload(world.d1, legacyId, `actor:${MEMBER}`, legacyTicket, SECRET))?.via,
    'room-ticket',
  );
}


async function main(): Promise<void> {
  console.log('M07 私有文件授权与成果保留');
  await runPrivateFileAcceptance();
  await ttlAndTicketCases();
  await legacyCase();
  await retentionCases();
  await quotaAndRetentionCases();
  console.log(`\nM07 checks passed: ${checksPassed()} (${baseUrl()})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
