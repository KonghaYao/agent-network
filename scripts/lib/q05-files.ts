/**
 * Q05-T01 场景五：文件绑定 × GC × 成员移除 × 成果引用。
 *
 * 100 轮，每轮真实上传、绑定、任务提交、成员移除与生产维护任务并发。
 * 断言无悬挂 file_reference、无越权下载、失败事务无残留、成功成果字节保留。
 */

import { Database } from 'bun:sqlite';

import { createD1 } from '../../src/bun/d1';
import { maintain } from '../../src/maintenance';
import type { Env } from '../../src/env';

import {
  createGroup,
  ensureRoomMember,
  newRequestId,
  q05Check,
  q05Equal,
  q05Tool,
  q05ToolOutcome,
  type Q05Actor,
  type Q05Db,
  type Q05Server,
  type RoundBody,
} from './q05-harness';
import { uploadTestFile } from './harness';

interface FileView {
  file: {
    file_id: string;
    public_url: string;
    preview_url: string;
    download_url: string;
    retained: boolean;
  };
}

export const q05FileStats = { total: 0, submitted: 0, rolledBack: 0, removed: 0 };

export function printQ05FileStats(): void {
  console.log(
    `  file-binding 结果分布：提交成功 ${q05FileStats.submitted}/${q05FileStats.total}，提交失败回滚 ${q05FileStats.rolledBack}，移除成功 ${q05FileStats.removed}`,
  );
}

function expireFile(db: Q05Db, fileId: string): void {
  const now = Date.now();
  db.exec(
    'UPDATE room_files SET created_at = ?, expires_at = ? WHERE file_id = ?',
    now - 86_400_000,
    now - 1_000,
    fileId,
  );
  db.exec(
    'UPDATE drive_files SET created_at = ?, expires_at = ? WHERE file_id = ?',
    now - 86_400_000,
    now - 1_000,
    fileId,
  );
}

async function runMaintenance(server: Q05Server, dbPath: string): Promise<void> {
  const raw = new Database(dbPath);
  raw.exec('PRAGMA busy_timeout = 5000');
  try {
    await maintain({
      DB: createD1(raw),
      ENVIRONMENT: 'test',
      PUBLIC_ORIGIN: server.base,
    } as Env);
  } finally {
    raw.close();
  }
}

async function statusOf(url: string): Promise<number> {
  try {
    return (await fetch(url)).status;
  } catch {
    return 0;
  }
}

export function q05FileBindingRound(
  server: Q05Server,
  db: Q05Db,
  owners: Q05Actor[],
  agentPools: Q05Actor[][],
  outsider: Q05Actor,
): RoundBody {
  const rooms = new Map<string, string>();
  return async (round) => {
    const ownerIndex = (round - 1) % owners.length;
    const owner = owners[ownerIndex]!;
    const pool = agentPools[ownerIndex]!;
    const executor = pool[0]!;
    const witness = pool[2]!;
    let sharedRoomId = rooms.get(owner.actor_id);
    if (!sharedRoomId) {
      sharedRoomId = await createGroup(
        server,
        owner,
        [executor, witness],
        `Q05 文件竞争固定群 ${owner.name}`,
      );
      rooms.set(owner.actor_id, sharedRoomId);
    }
    const roomId = sharedRoomId;
    await ensureRoomMember(server, db, owner, roomId, executor);
    try {
      const bytes = `Q05 成果字节 ${round}（合成文件）`;
    const uploaded = await uploadTestFile(executor.token, {
      name: `q05-${round}.txt`,
      mimeType: 'text/plain',
      body: bytes,
    });
    const bound = await q05Tool<FileView>(server, executor.token, 'network_room_file_bind', {
      request_id: newRequestId(`bind_${round}`),
      room_id: roomId,
      file_id: uploaded.fileId,
    });
    const before = await statusOf(bound.file.preview_url);
    q05Equal(`第 ${round} 轮上传者绑定票据可读`, before, 200);

    // 奇数轮让 GC 先看到过期文件参与竞争；偶数轮先让真实提交冻结文件，
    // 再过期并跑同一份生产维护任务，验证成果字节不会被清理。
    const expireBefore = round % 2 === 1;
    if (expireBefore) expireFile(db, uploaded.fileId);

    const [submitOutcome, removeOutcome, maintenanceOutcome] = await Promise.all([
      q05ToolOutcome(server, executor.token, 'network_artifact_submit', {
        request_id: newRequestId(`file_submit_${round}`),
        room_id: roomId,
        file_id: uploaded.fileId,
        summary: `Q05 文件成果 v1 ${round}`,
      }),
      q05ToolOutcome(server, owner.token, 'network_room_members_update', {
        request_id: newRequestId(`file_remove_${round}`),
        room_id: roomId,
        remove: [executor.actor_id],
      }),
      runMaintenance(server, server.dbPath).then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      ),
    ]);
    q05Check(`第 ${round} 轮维护任务完成`, maintenanceOutcome.ok);

    if (!expireBefore) {
      // 提交已提交完成（或已明确失败）；再让同一文件过期并跑真实 GC。
      expireFile(db, uploaded.fileId);
      await runMaintenance(server, server.dbPath);
    }
    q05FileStats.total += 1;
    if (submitOutcome.ok) q05FileStats.submitted += 1;
    else q05FileStats.rolledBack += 1;
    if (removeOutcome.ok) q05FileStats.removed += 1;

    const artifacts = db.rows<{ artifact_id: string; status: string }>(
      'SELECT artifact_id, status FROM artifacts WHERE file_id = ?',
      uploaded.fileId,
    );
    const activeRefs = db.rows<{ reference_id: string; state: string }>(
      "SELECT * FROM file_references WHERE file_id = ? AND state = 'active'",
      uploaded.fileId,
    );
    const drive = db.row<{ state: string; purged_at: number | null }>(
      'SELECT state, purged_at FROM drive_files WHERE file_id = ?',
      uploaded.fileId,
    )!;
    const roomFile = db.row<{ retained: number; deleted_at: number | null }>(
      'SELECT retained, deleted_at FROM room_files WHERE file_id = ?',
      uploaded.fileId,
    )!;

    q05Check(
      `第 ${round} 轮无悬挂 active file_reference`,
      activeRefs.every(() => drive.state !== 'deleted' && drive.purged_at === null && roomFile.deleted_at === null),
      { activeRefs: activeRefs.length, drive, roomFile },
    );

    if (submitOutcome.ok) {
      q05Equal(`第 ${round} 轮提交成功后成果唯一`, artifacts.length, 1);
      q05Equal(`第 ${round} 轮成果为 delivered`, artifacts[0]?.status, 'delivered');
      q05Check(`第 ${round} 轮成果引用 active`, activeRefs.length >= 1);
      q05Equal(`第 ${round} 轮成果文件 retained`, roomFile.retained, 1);
      q05Check(`第 ${round} 轮成果未被 GC 删除`, drive.state !== 'deleted' && drive.purged_at === null);
      const witnessFile = await q05Tool<FileView>(server, witness.token, 'network_room_file_get', {
        room_id: roomId,
        file_id: uploaded.fileId,
      });
      const witnessRead = await fetch(witnessFile.file.preview_url);
      q05Equal(`第 ${round} 轮合法成员仍可读取成果字节`, witnessRead.status, 200);
      q05Equal(`第 ${round} 轮成果字节完整`, await witnessRead.text(), bytes);
    } else {
      q05Equal(`第 ${round} 轮提交失败不留下成果`, artifacts.length, 0);
      q05Equal(`第 ${round} 轮提交失败无 active 成果引用`, activeRefs.length, 0);
    }

    // 被移除的执行者旧票据立即失效；外部身份始终无法读取私有字节。
    q05Equal(`第 ${round} 轮移除后旧票据失效`, await statusOf(bound.file.preview_url), 404);
    q05Equal(`第 ${round} 轮移除后 executor 读取被拒`, (
      await q05ToolOutcome(server, executor.token, 'network_room_file_get', {
        room_id: roomId,
        file_id: uploaded.fileId,
      })
    ).ok, false);
    q05Equal(`第 ${round} 轮外部身份裸链接 404`, await statusOf(uploaded.publicUrl), 404);
    q05Equal(`第 ${round} 轮 witness 未被误移除`, removeOutcome.ok, true);
    const witnessRoom = await q05Tool<{ members: { actor_id: string }[] }>(
      server,
      witness.token,
      'network_room_get',
      { room_id: roomId },
    );
    q05Check(
      `第 ${round} 轮 witness 仍在群`,
      witnessRoom.members.some((member) => member.actor_id === witness.actor_id),
    );
    } finally {
      // 固定群复用；移除/重新加入由下一轮 ensureRoomMember 处理。
    }
    void outsider;
  };
}

/** 配额不足时上传整体失败，不留下可用草稿或半提交。 */
export async function q05QuotaCheck(
  server: Q05Server,
  db: Q05Db,
  actor: Q05Actor,
): Promise<void> {
  const probe = await uploadTestFile(actor.token, {
    name: 'q05-quota-probe.txt',
    mimeType: 'text/plain',
    body: 'quota probe',
  });
  const drive = db.row<{ owner_scope: string }>(
    'SELECT owner_scope FROM drive_files WHERE file_id = ?',
    probe.fileId,
  )!;
  const dummyId = `f_q05_quota_${crypto.randomUUID().replaceAll('-', '')}`;
  db.exec(
    `INSERT INTO drive_files
       (file_id, owner_scope, uploader_id, name, mime_type, size, sha256, state, visibility,
        room_id, created_at, expires_at, retained, deleted_at, deleted_by, purged_at)
     VALUES (?, ?, ?, 'q05-quota.bin', 'application/octet-stream', ?, ?, 'draft', 'private',
             NULL, ?, NULL, 0, NULL, NULL, NULL)`,
    dummyId,
    drive.owner_scope,
    actor.actor_id,
    1024 * 1024 * 1024 + 1,
    '0'.repeat(64),
    Date.now(),
  );
  const rejected = await uploadTestFile(actor.token, {
    name: 'q05-quota-rejected.txt',
    mimeType: 'text/plain',
    body: 'must not persist',
  }).catch((error: unknown) => error);
  q05Check(
    '配额不足上传明确失败',
    rejected instanceof Error,
    rejected instanceof Error ? rejected.message : rejected,
  );
  const rejectedRows = db.rows<{ state: string; purged_at: number | null }>(
    "SELECT state, purged_at FROM drive_files WHERE uploader_id = ? AND name = 'q05-quota-rejected.txt'",
    actor.actor_id,
  );
  q05Check(
    '配额失败不留下可用草稿',
    rejectedRows.every((row) => row.state === 'deleted'),
    rejectedRows,
  );
  db.exec('DELETE FROM drive_files WHERE file_id = ?', dummyId);
  const recovered = await uploadTestFile(actor.token, {
    name: 'q05-quota-recovered.txt',
    mimeType: 'text/plain',
    body: 'quota recovered',
  });
  q05Check('配额恢复后上传成功', Boolean(recovered.fileId));
  q05Equal(
    '配额恢复后草稿可读',
    await statusOf(recovered.previewUrl),
    200,
  );
}
