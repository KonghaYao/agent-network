import { BusinessError } from '../contracts/errors';
import { encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  ArtifactListInput,
  ArtifactReleaseInput,
  ArtifactSubmitInput,
} from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import {
  getArtifact,
  getDriveFile,
  getOperation,
  getRoomFile,
} from '../storage/queries';
import type { ArtifactRow, RoomFileRow } from '../storage/rows';
import {
  isArtifactConflict,
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import {
  driveFileUsable,
  quotaForRoom,
  registerDriveFile,
  requireActiveMember,
  roomFileUsable,
  type FileQuota,
} from './file-access';
import {
  roomFileView,
  type RoomFileSource,
  type RoomFileView,
} from './room-files';
import {
  createdHistoryFilter,
  decodeHistoryCursor,
  historyCursorScope,
  historySnapshot,
  visibleCreated,
  type HistorySnapshot,
} from './room-history';

/**
 * 成果版本与文件保留。
 *
 * - 提交成果把上传者自己的文件绑定到房间，并把 `room_files.retained` 置 1；
 *   同时写入 artifact 引用，供 GC 判断可达性。
 * - 配额在事务内先检查：超限整批回滚，不产生半成品 artifact 或 room_files。
 * - 释放只撤销成果引用；若仍有其他有效引用，文件继续保留。
 * - 成果列表按成员历史边界过滤，旧成员不能读取加入前的成果。
 */

export interface ArtifactView {
  artifact_id: string;
  room_id: string;
  version: number;
  file_id: string;
  summary: string;
  status: 'delivered' | 'released';
  created_by: string;
  created_at: string;
  released_at: string | null;
}

export interface ArtifactPageItem {
  artifact: ArtifactView;
  file: RoomFileView;
}

export interface ArtifactPage {
  items: ArtifactPageItem[];
  next_cursor: string | null;
  has_more: boolean;
  authorization: HistorySnapshot;
  quota: FileQuota;
}

function artifactView(row: ArtifactRow): ArtifactView {
  return {
    artifact_id: row.artifact_id,
    room_id: row.room_id,
    version: row.version,
    file_id: row.file_id,
    summary: row.summary,
    status: row.status,
    created_by: row.created_by,
    created_at: String(row.created_at),
    released_at: row.released_at === null ? null : String(row.released_at),
  };
}

async function uploaderName(db: D1Database, actor: string): Promise<string> {
  const row = await db
    .prepare('SELECT name FROM actors WHERE actor_id = ?')
    .bind(actor)
    .first<{ name: string }>();
  return row?.name ?? '';
}

function fileRetained(db: D1Database, fileId: string): Promise<{ n: number } | null> {
  return db
    .prepare(
      `SELECT 1 AS n FROM file_references
        WHERE file_id = ? AND state = 'active' LIMIT 1`,
    )
    .bind(fileId)
    .first<{ n: number }>();
}

/** 释放当前成果时，排除它自己的引用后再判断是否仍被其他工作引用。 */
function fileRetainedExcept(
  db: D1Database,
  fileId: string,
  artifactId: string,
): Promise<{ n: number } | null> {
  return db
    .prepare(
      `SELECT 1 AS n FROM file_references
        WHERE file_id = ? AND state = 'active'
          AND NOT (kind = 'artifact' AND ref_id = ?)
        LIMIT 1`,
    )
    .bind(fileId, artifactId)
    .first<{ n: number }>();
}

function deliveredArtifactExcept(
  db: D1Database,
  fileId: string,
  artifactId: string,
): Promise<{ n: number } | null> {
  return db
    .prepare(
      `SELECT 1 AS n FROM artifacts
        WHERE file_id = ? AND status = 'delivered' AND artifact_id != ? LIMIT 1`,
    )
    .bind(fileId, artifactId)
    .first<{ n: number }>();
}

export async function artifactSubmit(
  db: D1Database,
  principal: Principal,
  input: ArtifactSubmitInput,
  source: RoomFileSource,
  publicOrigin: string,
  ticketSecret: string,
): Promise<{
  artifact: ArtifactView;
  file: RoomFileView;
  authorization: HistorySnapshot;
  quota: FileQuota;
}> {
  const { caller, room, boundary } = await requireActiveMember(db, principal, input.room_id);
  const payloadHash = await sha256Hex(stableStringify(input));

  const replay = await getOperation(db, caller, input.request_id);
  if (replay) {
    const replayed = resolveOperation(replay, payloadHash) as {
      artifact: ArtifactView;
      file: RoomFileView;
    };
    return {
      ...replayed,
      authorization: historySnapshot(boundary),
      quota: await quotaForRoom(db, room.room_id),
    };
  }

  const file = await source.readFile(input.file_id);
  const at = nowMs();
  if (!file || file.ownerScope !== `actor:${caller}`) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不存在或不属于当前身份', {
      file_id: input.file_id,
    });
  }
  const drive = await registerDriveFile(db, file, caller, { at });
  if (drive.state === 'deleted' || drive.owner_scope !== `actor:${caller}`) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件已删除或不属于当前身份', {
      file_id: input.file_id,
    });
  }
  if (drive.state === 'bound' && drive.room_id !== room.room_id) {
    throw new BusinessError('CONFLICT', '该文件已绑定到其他房间', {
      file_id: input.file_id,
      room_id: drive.room_id,
    });
  }
  if (!driveFileUsable(drive, at)) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件已过期或已删除', {
      file_id: input.file_id,
    });
  }

  if (input.version !== undefined && input.version !== 1) {
    throw new BusinessError('VERSION_CONFLICT', '成果版本只能为 1', {
      actual: input.version,
    });
  }
  const version = 1;

  const existing = await getRoomFile(db, input.file_id);
  if (existing && existing.room_id !== room.room_id) {
    throw new BusinessError('CONFLICT', '该文件已绑定到其他房间', {
      file_id: input.file_id,
      room_id: existing.room_id,
    });
  }
  if (existing && !roomFileUsable(existing, at)) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件已过期或已删除', {
      file_id: input.file_id,
    });
  }
  if (existing && !visibleCreated(existing, boundary)) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不存在或当前不可见', {
      file_id: input.file_id,
    });
  }

  // 保留中的文件不受 TTL 限制；这里仍记录一个合理的恢复期限，释放成果后
  // 会重新按普通附件 30 天计算，而不是继承草稿的 24 小时。
  const expiresAt =
    existing?.expires_at ??
    Math.min(at + LIMITS.roomFileTtlMs, Date.parse(file.expiresAt));
  if (expiresAt <= at) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件已过期', { file_id: input.file_id });
  }

  const artifactId = `art_${crypto.randomUUID().replace(/-/g, '')}`;
  const artifact: ArtifactRow = {
    artifact_id: artifactId,
    room_id: room.room_id,
    version,
    file_id: input.file_id,
    created_by: caller,
    summary: input.summary ?? '',
    status: 'delivered',
    created_at: at,
    created_seq: null,
    released_at: null,
    released_by: null,
  };
  const roomRow: RoomFileRow = {
    room_file_id: existing?.room_file_id ?? `rf_${crypto.randomUUID().replace(/-/g, '')}`,
    room_id: room.room_id,
    file_id: input.file_id,
    uploader_id: existing?.uploader_id ?? caller,
    name: file.name,
    mime_type: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    created_at: existing?.created_at ?? at,
    created_seq: existing?.created_seq ?? null,
    expires_at: existing?.expires_at ?? expiresAt,
    retained: 1,
    deleted_at: null,
    deleted_by: null,
  };

  const fileView = roomFileView(roomRow, {
    publicOrigin,
    viewerId: caller,
    room,
    uploaderName: principal.actor?.name ?? (await uploaderName(db, caller)),
    boundary,
    ticketSecret,
  });
  const result = {
    artifact: artifactView(artifact),
    file: fileView,
    authorization: historySnapshot(boundary),
    quota: await quotaForRoom(db, room.room_id),
  };

  const eventKey = `artifact:submitted:${artifactId}`;
  const stored = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'notMember',
            'NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = \'active\')',
          ),
        )
        .bind(room.room_id, caller),
      db
        .prepare(
          guardSql(
            'fileUnavailable',
            `NOT EXISTS (
               SELECT 1 FROM drive_files
                WHERE file_id = ? AND state != 'deleted' AND owner_scope = ?
                  AND (retained = 1 OR expires_at IS NULL OR expires_at > ?)
             ) OR EXISTS (
               SELECT 1 FROM room_files
                WHERE file_id = ? AND (deleted_at IS NOT NULL OR (retained = 0 AND expires_at <= ?))
             )`,
          ),
        )
        .bind(input.file_id, `actor:${caller}`, at, input.file_id, at),
      // 超配额在任何写入前失败；已在房间内的同一文件不重复计入数量。
      db
        .prepare(
          guardSql(
            'roomFileLimit',
            `(NOT EXISTS (SELECT 1 FROM room_files WHERE file_id = ?)
              AND (SELECT COUNT(*) FROM room_files
                    WHERE room_id = ? AND deleted_at IS NULL
                      AND (retained = 1 OR expires_at > ?)) >= ?)
             OR ((SELECT COALESCE(SUM(size), 0) FROM room_files
                    WHERE room_id = ? AND deleted_at IS NULL
                      AND (retained = 1 OR expires_at > ?) AND file_id != ?) + ? > ?)`,
          ),
        )
        .bind(
          input.file_id,
          room.room_id,
          at,
          LIMITS.roomFilesPerRoom,
          room.room_id,
          at,
          input.file_id,
          file.size,
          LIMITS.roomFileBytesPerRoom,
        ),
      db
        .prepare(
          guardSql(
            'artifactConflict',
            'EXISTS (SELECT 1 FROM artifacts WHERE file_id = ?)',
          ),
        )
        .bind(input.file_id),
      // 用 upsert 消除“读后在事务前被 GC 删除”的竞态：无论 room_files 行是否
      // 仍存在，成果事务要么写入保留行，要么在 guard 处整批失败。
      db
        .prepare(
          `INSERT INTO room_files
             (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
              created_at, expires_at, retained, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)
           ON CONFLICT(file_id) DO UPDATE SET retained = 1`,
        )
        .bind(
          roomRow.room_file_id,
          roomRow.room_id,
          roomRow.file_id,
          roomRow.uploader_id,
          roomRow.name,
          roomRow.mime_type,
          roomRow.size,
          roomRow.sha256,
          roomRow.created_at,
          roomRow.expires_at,
        ),
      db
        .prepare(
          `INSERT INTO artifacts
             (artifact_id, room_id, version, file_id, created_by, summary,
              status, created_at, created_seq, released_at, released_by)
           VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, NULL, NULL, NULL)`,
        )
        .bind(
          artifact.artifact_id,
          artifact.room_id,
          artifact.version,
          artifact.file_id,
          artifact.created_by,
          artifact.summary,
          artifact.created_at,
        ),
      db
        .prepare(
          `INSERT INTO file_references
             (reference_id, file_id, kind, ref_id, room_id, actor_id, state, created_at,
              released_at, released_by)
           VALUES (?, ?, 'artifact', ?, ?, ?, 'active', ?, NULL, NULL)
           ON CONFLICT(kind, ref_id, file_id) DO UPDATE SET
             state = 'active', released_at = NULL, released_by = NULL`,
        )
        .bind(
          `ref_${crypto.randomUUID().replace(/-/g, '')}`,
          input.file_id,
          artifactId,
          room.room_id,
          caller,
          at,
        ),
      db
        .prepare(
          `UPDATE drive_files
              SET state = 'bound', room_id = ?, retained = 1, expires_at = NULL
            WHERE file_id = ? AND state != 'deleted'`,
        )
        .bind(room.room_id, input.file_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'artifact_submitted',
          refId: artifactId,
          metadata: {
            artifact_id: artifactId,
            file_id: input.file_id,
            version,
            summary: artifact.summary,
          },
        },
        at,
      ),
      db
        .prepare(
          `UPDATE artifacts
              SET created_seq = (SELECT event_seq FROM events WHERE event_key = ?)
            WHERE artifact_id = ? AND created_seq IS NULL`,
        )
        .bind(eventKey, artifactId),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
    ],
    onUniqueConflict: async (error) => {
      if (!isArtifactConflict(error)) return undefined;
      const existingArtifact = await db
        .prepare('SELECT * FROM artifacts WHERE file_id = ?')
        .bind(input.file_id)
        .first<ArtifactRow>();
      if (existingArtifact) {
        throw new BusinessError('CONFLICT', '该文件已作为成果提交', {
          file_id: input.file_id,
          artifact_id: existingArtifact.artifact_id,
        });
      }
      throw new BusinessError('VERSION_CONFLICT', '成果版本已被并发提交，请重试');
    },
  });

  return stored as {
    artifact: ArtifactView;
    file: RoomFileView;
    authorization: HistorySnapshot;
    quota: FileQuota;
  };
}

export async function artifactList(
  db: D1Database,
  principal: Principal,
  input: ArtifactListInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<ArtifactPage> {
  const { caller, room, boundary } = await requireActiveMember(db, principal, input.room_id);
  const limit = clampPage(input.limit, LIMITS.artifactPageDefault, LIMITS.artifactPageMax);
  const scope = historyCursorScope('artifacts', room.room_id, boundary.memberGeneration);
  const cursor = input.cursor ? decodeHistoryCursor(input.cursor, scope, room.room_id) : null;
  const keyset = cursor
    ? 'AND (a.created_at < ? OR (a.created_at = ? AND a.artifact_id < ?))'
    : '';
  const history = createdHistoryFilter('a', boundary);
  const binds: unknown[] = [
    room.room_id,
    ...history.binds,
    ...(cursor ? [cursor.seq, cursor.seq, cursor.key ?? ''] : []),
  ];

  const rows = await db
    .prepare(
      `SELECT a.* FROM artifacts a
        WHERE a.room_id = ? AND (${history.sql}) ${keyset}
        ORDER BY a.created_at DESC, a.artifact_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<ArtifactRow>();
  const page = rows.results.slice(0, limit);
  const items: ArtifactPageItem[] = [];
  for (const artifact of page) {
    const roomRow = await getRoomFile(db, artifact.file_id);
    if (!roomRow || !roomFileUsable(roomRow)) continue;
    items.push({
      artifact: artifactView(artifact),
      file: roomFileView(roomRow, {
        publicOrigin,
        viewerId: caller,
        room,
        uploaderName: await uploaderName(db, roomRow.uploader_id),
        boundary,
        ticketSecret,
      }),
    });
  }
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      rows.results.length > limit && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.artifact_id,
            snapshot: 0,
          })
        : null,
    has_more: rows.results.length > limit,
    authorization: historySnapshot(boundary),
    quota: await quotaForRoom(db, room.room_id),
  };
}

export async function artifactRelease(
  db: D1Database,
  principal: Principal,
  input: ArtifactReleaseInput,
): Promise<{ artifact_id: string; released: true; retained: boolean }> {
  const artifact = await getArtifact(db, input.artifact_id);
  if (!artifact) throw new BusinessError('NOT_FOUND', '成果不存在');
  const { caller, room, boundary } = await requireActiveMember(db, principal, artifact.room_id);
  if (!visibleCreated(artifact, boundary)) {
    throw new BusinessError('NOT_FOUND', '成果不存在或当前不可见');
  }
  const roomRow = await getRoomFile(db, artifact.file_id);
  const allowed =
    artifact.created_by === caller ||
    (roomRow !== null && roomRow.uploader_id === caller) ||
    (room.kind === 'group' && room.owner_id === caller);
  if (!allowed) {
    throw new BusinessError('NOT_OWNER', '只有成果提交者、文件上传者或群 owner 可以释放成果');
  }
  if (artifact.status === 'released') {
    const active = await fileRetained(db, artifact.file_id);
    return { artifact_id: artifact.artifact_id, released: true, retained: Boolean(active) };
  }

  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `artifact:released:${artifact.artifact_id}`;
  // 当前成果自身的 artifact 引用会在同一批事务里释放，判断保留时必须排除。
  const active = await fileRetainedExcept(db, artifact.file_id, artifact.artifact_id);
  const delivered = await deliveredArtifactExcept(db, artifact.file_id, artifact.artifact_id);
  const willRetain = Boolean(active || delivered);
  const result = {
    artifact_id: artifact.artifact_id,
    released: true as const,
    retained: willRetain,
  };

  const stored = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'notMember',
            'NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = \'active\')',
          ),
        )
        .bind(room.room_id, caller),
      db
        .prepare(
          guardSql(
            'artifactConflict',
            'NOT EXISTS (SELECT 1 FROM artifacts WHERE artifact_id = ? AND status = \'delivered\')',
          ),
        )
        .bind(artifact.artifact_id),
      db
        .prepare(
          `UPDATE artifacts
              SET status = 'released', released_at = ?, released_by = ?
            WHERE artifact_id = ? AND status = 'delivered'`,
        )
        .bind(at, caller, artifact.artifact_id),
      db
        .prepare(
          `UPDATE file_references
              SET state = 'released', released_at = ?, released_by = ?
            WHERE kind = 'artifact' AND ref_id = ? AND file_id = ? AND state = 'active'`,
        )
        .bind(at, caller, artifact.artifact_id, artifact.file_id),
      // 没有其他 active 引用且没有其他 delivered 成果时，恢复普通 30 天 TTL。
      db
        .prepare(
          `UPDATE room_files
              SET retained = 0,
                  expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END
            WHERE file_id = ? AND deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM file_references
                               WHERE file_id = ? AND state = 'active')
              AND NOT EXISTS (SELECT 1 FROM artifacts
                               WHERE file_id = ? AND status = 'delivered')`,
        )
        .bind(at, at + LIMITS.roomFileTtlMs, artifact.file_id, artifact.file_id, artifact.file_id),
      db
        .prepare(
          `UPDATE drive_files
              SET retained = 0,
                  expires_at = CASE
                    WHEN expires_at IS NULL OR expires_at <= ? THEN ?
                    ELSE expires_at END
            WHERE file_id = ? AND state != 'deleted'
              AND NOT EXISTS (SELECT 1 FROM file_references
                               WHERE file_id = ? AND state = 'active')
              AND NOT EXISTS (SELECT 1 FROM artifacts
                               WHERE file_id = ? AND status = 'delivered')`,
        )
        .bind(
          at,
          at + LIMITS.roomFileTtlMs,
          artifact.file_id,
          artifact.file_id,
          artifact.file_id,
        ),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'artifact_released',
          refId: artifact.artifact_id,
          metadata: {
            artifact_id: artifact.artifact_id,
            file_id: artifact.file_id,
            version: artifact.version,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
    ],
  });

  return stored as { artifact_id: string; released: true; retained: boolean };
}
