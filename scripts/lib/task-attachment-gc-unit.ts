/**
 * 任务附件保留与 GC 的本地 SQL 测试。
 *
 * 使用内存 SQLite 与真实 migrations，不访问服务端；验证 `taskCreate`
 * 会为附件建立 task 引用并把文件置为 retained，维护任务在任务存在时
 * 不会提前回收附件；任务删除后引用释放，文件恢复普通 TTL 并可被回收。
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import type { FileService } from '@peri-code/mcpp/files';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { LIMITS } from '../../src/contracts/limits';
import type { Principal } from '../../src/domain/principal';
import { taskCreate } from '../../src/domain/tasks';
import type { Env } from '../../src/env';
import { maintain } from '../../src/maintenance';
import type { ActorRow } from '../../src/storage/rows';
import { check, checkEqual } from './harness';

const MIGRATIONS = resolve(import.meta.dir, '../../migrations');
const OWNER = 'usr_task_gc_owner';
const ROOM = 'rm_task_gc_room';
const FILE = 'f_task_gc_attachment';
const AT = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

function principalFor(db: Database, actor: string): Principal {
  const row = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actor) as ActorRow;
  return {
    credentialHash: `gc:${actor}`,
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

function count(db: Database, sql: string, ...binds: string[]): number {
  return (db.prepare(sql).get(...binds) as { n: number }).n;
}

export async function runTaskAttachmentGcUnitChecks(): Promise<void> {
  const db = new Database(':memory:');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES ('${OWNER}', 'human', NULL, 'Task GC Owner', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq,
       created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'Task GC', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${AT});

    INSERT INTO room_files
      (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
       created_at, expires_at, deleted_at, deleted_by, retained)
    VALUES ('rf_task_gc', '${ROOM}', '${FILE}', '${OWNER}', 'attachment.txt', 'text/plain',
            16, '${'a'.repeat(64)}', ${AT - 40 * DAY}, ${AT - 30 * DAY}, NULL, NULL, 0);

    INSERT INTO drive_files
      (file_id, owner_scope, uploader_id, name, mime_type, size, sha256, state,
       visibility, room_id, created_at, expires_at, retained, deleted_at, deleted_by,
       purged_at)
    VALUES ('${FILE}', 'actor:${OWNER}', '${OWNER}', 'attachment.txt', 'text/plain', 16,
            '${'a'.repeat(64)}', 'bound', 'private', '${ROOM}', ${AT - 40 * DAY},
            ${AT - 30 * DAY}, 0, NULL, NULL, NULL);
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
  const env = { DB: d1, FILES: files } as unknown as Env;

  const created = await taskCreate(d1, principalFor(db, OWNER), {
    request_id: 'req_task_gc_create',
    room_id: ROOM,
    title: '带附件的任务',
    attachment_file_ids: [FILE],
  });
  const taskId = created.task.task_id;
  checkEqual('[D01-GC] 任务附件被记录', created.task.attachments.length, 1);
  checkEqual(
    '[D01-GC] 任务附件建立 active task 引用',
    count(
      db,
      "SELECT COUNT(*) AS n FROM file_references WHERE file_id = ? AND kind = 'task' AND ref_id = ? AND state = 'active'",
      FILE,
      taskId,
    ),
    1,
  );
  checkEqual(
    '[D01-GC] 任务附件房间文件 retained',
    count(db, 'SELECT retained AS n FROM room_files WHERE file_id = ?', FILE),
    1,
  );
  const retainedDrive = db
    .prepare('SELECT retained, expires_at FROM drive_files WHERE file_id = ?')
    .get(FILE) as { retained: number; expires_at: number | null };
  checkEqual('[D01-GC] 任务附件 Drive 文件 retained', retainedDrive.retained, 1);
  checkEqual('[D01-GC] retained Drive 文件不再过期', retainedDrive.expires_at, null);

  // 模拟原 TTL 已过：任务仍存在，维护任务不得释放引用或回收文件。
  db.prepare('UPDATE room_files SET expires_at = ? WHERE file_id = ?').run(AT - 30 * DAY, FILE);
  db.prepare('UPDATE drive_files SET expires_at = ? WHERE file_id = ?').run(AT - 30 * DAY, FILE);
  await maintain(env);
  checkEqual(
    '[D01-GC] 任务存在时引用保持 active',
    count(
      db,
      "SELECT COUNT(*) AS n FROM file_references WHERE file_id = ? AND state = 'active'",
      FILE,
    ),
    1,
  );
  checkEqual(
    '[D01-GC] 任务存在时 Drive 文件不软删',
    count(db, "SELECT COUNT(*) AS n FROM drive_files WHERE file_id = ? AND state = 'bound'", FILE),
    1,
  );
  checkEqual(
    '[D01-GC] 任务存在时房间文件不被删除',
    count(db, 'SELECT COUNT(*) AS n FROM room_files WHERE file_id = ? AND deleted_at IS NULL', FILE),
    1,
  );
  checkEqual('[D01-GC] 任务存在时不清理载荷', purged.length, 0);

  // 任务与附件移除后，引用释放，文件恢复普通 TTL 并可被正常回收。
  db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  await maintain(env);
  checkEqual(
    '[D01-GC] 任务删除后引用释放',
    count(
      db,
      "SELECT COUNT(*) AS n FROM file_references WHERE file_id = ? AND state = 'released'",
      FILE,
    ),
    1,
  );
  const releasedRoom = db
    .prepare('SELECT retained, expires_at FROM room_files WHERE file_id = ?')
    .get(FILE) as { retained: number; expires_at: number };
  checkEqual('[D01-GC] 释放后房间文件取消 retained', releasedRoom.retained, 0);
  check(
    '[D01-GC] 释放后房间文件恢复 TTL',
    releasedRoom.expires_at > AT,
    releasedRoom.expires_at,
  );
  const releasedDrive = db
    .prepare('SELECT retained, expires_at FROM drive_files WHERE file_id = ?')
    .get(FILE) as { retained: number; expires_at: number | null };
  checkEqual('[D01-GC] 释放后 Drive 文件取消 retained', releasedDrive.retained, 0);
  check(
    '[D01-GC] 释放后 Drive 文件恢复 TTL',
    (releasedDrive.expires_at ?? 0) > AT,
    releasedDrive.expires_at,
  );

  const past = Date.now() - LIMITS.roomFileTombstoneGraceMs - DAY;
  db.prepare('UPDATE room_files SET expires_at = ? WHERE file_id = ?').run(past, FILE);
  db.prepare('UPDATE drive_files SET expires_at = ? WHERE file_id = ?').run(past, FILE);
  await maintain(env);
  checkEqual(
    '[D01-GC] 释放后过期 Drive 文件被软删',
    count(db, "SELECT COUNT(*) AS n FROM drive_files WHERE file_id = ? AND state = 'deleted'", FILE),
    1,
  );
  checkEqual('[D01-GC] 软删后宽限期内不清理载荷', purged.length, 0);

  db.prepare('UPDATE drive_files SET deleted_at = ? WHERE file_id = ?').run(
    Date.now() - LIMITS.fileGcGraceMs - DAY,
    FILE,
  );
  await maintain(env);
  checkEqual('[D01-GC] 宽限期后清理三类载荷', purged.length, 3);
  checkEqual(
    '[D01-GC] 清理后写入 purged_at',
    count(
      db,
      'SELECT COUNT(*) AS n FROM drive_files WHERE file_id = ? AND purged_at IS NOT NULL',
      FILE,
    ),
    1,
  );
}
