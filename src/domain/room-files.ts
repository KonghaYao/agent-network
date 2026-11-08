import { BusinessError } from '../contracts/errors';
import { encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomFileBindInput,
  RoomFileDeleteInput,
  RoomFileGetInput,
  RoomFileListInput,
} from '../contracts/schemas';
import { filePreviewKind, type FilePreviewKind } from '../drive/service';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import {
  getDriveFile,
  getMember,
  getOperation,
  getRoom,
  getRoomFile,
} from '../storage/queries';
import type { RoomFileRow, RoomMemberRow, RoomRow } from '../storage/rows';
import {
  isRoomFileConflict,
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import {
  driveFileUsable,
  quotaForRoom,
  registerDriveFile,
  roomFileUsable,
  roomFileUrls,
  type FileQuota,
} from './file-access';
import {
  createdHistoryFilter,
  decodeHistoryCursor,
  historyBoundary,
  historyCursorScope,
  historySnapshot,
  visibleCreated,
  type HistoryBoundary,
  type HistorySnapshot,
} from './room-history';
import { assertRoomWritable, roomDissolvedGuardStatement } from './room-access';

/**
 * 聊天绑定文件（room_files）。
 *
 * - 绑定只记录元数据，载荷仍由 MCPP Files 持有；`public_url` 由 PUBLIC_ORIGIN 派生。
 * - 删除写墓碑，保留到 `expires_at`，使已分享 URL 立即 404 且不会复活。
 * - 文件事件是 informational，不创建 delivery、不推进 `rooms.head_seq`。
 */

export interface RoomFileView {
  room_file_id: string;
  room_id: string;
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  public_url: string;
  preview_url: string;
  download_url: string;
  preview_kind: FilePreviewKind;
  uploader_id: string;
  uploader_name: string;
  can_delete: boolean;
  /** 被有效任务/成果引用，不随 expires_at 清理。 */
  retained: boolean;
  created_at: string;
  expires_at: string;
}

/** 绑定前置：当前身份自己的、未过期的 MCPP Files 记录。 */
export interface RoomFileSource {
  readFile(fileId: string): Promise<{
    fileId: string;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    createdAt: string;
    expiresAt: string;
    ownerScope: string;
  } | null>;
}

export interface ViewContext {
  publicOrigin: string;
  viewerId: string;
  room: RoomRow;
  uploaderName: string;
  boundary: HistoryBoundary;
  ticketSecret: string;
}

function canDelete(row: RoomFileRow, context: ViewContext): boolean {
  if (!visibleCreated(row, context.boundary)) return false;
  if (row.uploader_id === context.viewerId) return true;
  return context.room.kind === 'group' && context.room.owner_id === context.viewerId;
}

export function roomFileView(row: RoomFileRow, context: ViewContext): RoomFileView {
  const urls = roomFileUrls(
    context.ticketSecret,
    context.publicOrigin,
    row.file_id,
    row.room_id,
    context.viewerId,
    context.boundary,
  );
  return {
    room_file_id: row.room_file_id,
    room_id: row.room_id,
    file_id: row.file_id,
    name: row.name,
    mime_type: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    public_url: urls.public_url,
    preview_url: urls.preview_url,
    download_url: urls.download_url,
    preview_kind: filePreviewKind(row.mime_type),
    uploader_id: row.uploader_id,
    uploader_name: context.uploaderName,
    can_delete: canDelete(row, context),
    retained: row.retained === 1,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
  };
}

async function actorName(db: D1Database, actor: string): Promise<string> {
  const row = await db
    .prepare('SELECT name FROM actors WHERE actor_id = ?')
    .bind(actor)
    .first<{ name: string }>();
  return row?.name ?? '';
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

function memberGuard(db: D1Database, roomId: string, actor: string): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'notMember',
        'NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = \'active\')',
      ),
    )
    .bind(roomId, actor);
}

export async function roomFileBind(
  db: D1Database,
  principal: Principal,
  input: RoomFileBindInput,
  source: RoomFileSource,
  publicOrigin: string,
  ticketSecret: string,
): Promise<{ file: RoomFileView; authorization: HistorySnapshot }> {
  const { caller, room, boundary } = await requireRoomMember(db, principal, input.room_id);
  const payloadHash = await sha256Hex(stableStringify(input));

  // 先查幂等重放，再读文件：重放不依赖文件是否仍然可读。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) {
    const replayed = resolveOperation(replay, payloadHash) as { file: RoomFileView };
    return { ...replayed, authorization: historySnapshot(boundary) };
  }
  assertRoomWritable(room);

  const file = await source.readFile(input.file_id);
  const at = nowMs();
  if (
    !file ||
    file.ownerScope !== `actor:${caller}` ||
    Date.parse(file.expiresAt) <= at
  ) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不存在、已过期或不属于当前身份', {
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
  // 绑定把草稿转成普通附件：按绑定时间重新给 30 天，而不是继续沿用草稿的
  // 24 小时期限；底层 MCPP 记录更早到期时仍以底层记录为准。
  const expiresAt = Math.min(
    at + LIMITS.roomFileTtlMs,
    Date.parse(file.expiresAt),
  );
  if (expiresAt <= at) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件已过期', { file_id: input.file_id });
  }

  const roomFileId = `rf_${crypto.randomUUID().replace(/-/g, '')}`;
  const row: RoomFileRow = {
    room_file_id: roomFileId,
    room_id: room.room_id,
    file_id: input.file_id,
    uploader_id: caller,
    name: file.name,
    mime_type: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    created_at: at,
    created_seq: null,
    expires_at: expiresAt,
    retained: 0,
    deleted_at: null,
    deleted_by: null,
  };
  const context: ViewContext = {
    publicOrigin,
    viewerId: caller,
    room,
    uploaderName: principal.actor?.name ?? '',
    boundary,
    ticketSecret,
  };
  const result = { file: roomFileView(row, context), authorization: historySnapshot(boundary) };
  const eventKey = `room_file:added:${roomFileId}`;

  // 唯一键恢复分支返回已存在的行；必须使用 runIdempotent 的返回值。
  const stored = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      roomDissolvedGuardStatement(db, room.room_id),
      db
        .prepare(
          guardSql(
            'roomFileLimit',
            '(SELECT COUNT(*) FROM room_files WHERE room_id = ? AND deleted_at IS NULL AND (retained = 1 OR expires_at > ?)) >= ?',
          ),
        )
        .bind(room.room_id, at, LIMITS.roomFilesPerRoom),
      db
        .prepare(
          guardSql(
            'roomFileLimit',
            '(SELECT COALESCE(SUM(size), 0) FROM room_files WHERE room_id = ? AND deleted_at IS NULL AND (retained = 1 OR expires_at > ?)) + ? > ?',
          ),
        )
        .bind(room.room_id, at, row.size, LIMITS.roomFileBytesPerRoom),
      db
        .prepare(
          guardSql(
            'fileUnavailable',
            'NOT EXISTS (SELECT 1 FROM drive_files WHERE file_id = ? AND state != \'deleted\' AND owner_scope = ?)',
          ),
        )
        .bind(row.file_id, `actor:${caller}`),
      db
        .prepare(
          `INSERT INTO room_files
             (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
              created_at, expires_at, retained, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
        )
        .bind(
          row.room_file_id,
          row.room_id,
          row.file_id,
          row.uploader_id,
          row.name,
          row.mime_type,
          row.size,
          row.sha256,
          row.created_at,
          row.expires_at,
        ),
      db
        .prepare(
          `UPDATE drive_files
              SET state = 'bound', room_id = ?, expires_at = ?,
                  retained = CASE WHEN retained = 1 THEN 1 ELSE 0 END
            WHERE file_id = ? AND state != 'deleted'`,
        )
        .bind(room.room_id, expiresAt, row.file_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'room_file_added',
          refId: roomFileId,
          metadata: {
            file_id: row.file_id,
            name: row.name,
            mime_type: row.mime_type,
            size: row.size,
          },
        },
        at,
      ),
      // 文件的历史边界取绑定事件序号；与事件同一事务，读取方不会看到
      // 已绑定但缺少序号的半状态。
      db
        .prepare(
          `UPDATE room_files
              SET created_seq = (SELECT event_seq FROM events WHERE event_key = ?)
            WHERE room_file_id = ? AND created_seq IS NULL`,
        )
        .bind(eventKey, roomFileId),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
    ],
    onUniqueConflict: async (error) => {
      if (!isRoomFileConflict(error)) return undefined;
      const existing = await getRoomFile(db, input.file_id);
      if (!existing) return undefined;
      if (existing.room_id !== room.room_id) {
        throw new BusinessError('CONFLICT', '该文件已绑定到其他房间', {
          file_id: input.file_id,
          room_id: existing.room_id,
        });
      }
      if (existing.deleted_at !== null) {
        throw new BusinessError('FILE_UNAVAILABLE', '文件已从房间删除', {
          file_id: input.file_id,
        });
      }
      // 同房间重复绑定收敛到已存在的行，不重复发事件。
      return {
        file: roomFileView(existing, {
          ...context,
          uploaderName: await actorName(db, existing.uploader_id),
        }),
        authorization: historySnapshot(boundary),
      };
    },
  });

  return stored as { file: RoomFileView; authorization: HistorySnapshot };
}

interface RoomFileListRow extends RoomFileRow {
  uploader_name: string;
}

export async function roomFileList(
  db: D1Database,
  principal: Principal,
  input: RoomFileListInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<{
  items: RoomFileView[];
  next_cursor: string | null;
  has_more: boolean;
  authorization: HistorySnapshot;
  quota: FileQuota;
}> {
  const { caller, room, boundary } = await requireRoomMember(db, principal, input.room_id);
  const limit = clampPage(input.limit, LIMITS.roomFilePageDefault, LIMITS.roomFilePageMax);
  const scope = historyCursorScope('files', room.room_id, boundary.memberGeneration);
  const cursor = input.cursor ? decodeHistoryCursor(input.cursor, scope, room.room_id) : null;
  const keyset = cursor
    ? 'AND (rf.created_at < ? OR (rf.created_at = ? AND rf.room_file_id < ?))'
    : '';
  const history = createdHistoryFilter('rf', boundary);
  const binds: unknown[] = cursor
    ? [
        room.room_id,
        Date.now(),
        ...history.binds,
        cursor.seq,
        cursor.seq,
        cursor.key ?? '',
      ]
    : [room.room_id, Date.now(), ...history.binds];

  const rows = await db
    .prepare(
      `SELECT rf.*, a.name AS uploader_name
         FROM room_files rf
         JOIN actors a ON a.actor_id = rf.uploader_id
        WHERE rf.room_id = ? AND rf.deleted_at IS NULL
          AND (rf.retained = 1 OR rf.expires_at > ?)
          AND (${history.sql}) ${keyset}
        ORDER BY rf.created_at DESC, rf.room_file_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<RoomFileListRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) =>
      roomFileView(row, {
        publicOrigin,
        viewerId: caller,
        room,
        uploaderName: row.uploader_name,
        boundary,
        ticketSecret,
      }),
    ),
    authorization: historySnapshot(boundary),
    quota: await quotaForRoom(db, room.room_id),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.room_file_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

export async function roomFileGet(
  db: D1Database,
  principal: Principal,
  input: RoomFileGetInput,
  publicOrigin: string,
  ticketSecret: string,
): Promise<{ file: RoomFileView; authorization: HistorySnapshot }> {
  const { caller, room, boundary } = await requireRoomMember(db, principal, input.room_id);
  const row = await getRoomFile(db, input.file_id);
  if (
    !row ||
    row.room_id !== room.room_id ||
    !roomFileUsable(row) ||
    !visibleCreated(row, boundary)
  ) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不存在、已过期、已删除或当前不可见', {
      file_id: input.file_id,
    });
  }
  return {
    file: roomFileView(row, {
      publicOrigin,
      viewerId: caller,
      room,
      uploaderName: await actorName(db, row.uploader_id),
      boundary,
      ticketSecret,
    }),
    authorization: historySnapshot(boundary),
  };
}

export async function roomFileDelete(
  db: D1Database,
  principal: Principal,
  input: RoomFileDeleteInput,
): Promise<{ file_id: string; deleted: true }> {
  const { caller, room, boundary } = await requireRoomMember(db, principal, input.room_id);
  assertRoomWritable(room);
  const row = await getRoomFile(db, input.file_id);
  if (!row || row.room_id !== room.room_id || !visibleCreated(row, boundary)) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不在该房间或当前不可见', {
      file_id: input.file_id,
    });
  }
  const allowed = row.uploader_id === caller || (room.kind === 'group' && room.owner_id === caller);
  if (!allowed) {
    throw new BusinessError('NOT_OWNER', '只有上传者或群 owner 可以删除该文件');
  }
  // 已删除：结果已经达成，重复调用直接成功且不重复发事件。
  if (row.deleted_at !== null) return { file_id: input.file_id, deleted: true };
  if (!roomFileUsable(row)) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件已过期', { file_id: input.file_id });
  }

  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const result = { file_id: input.file_id, deleted: true as const };
  const eventKey = `room_file:deleted:${row.room_file_id}`;

  const stored = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      roomDissolvedGuardStatement(db, room.room_id),
      db
        .prepare(
          guardSql(
            'notFileOwner',
            `NOT EXISTS (
               SELECT 1 FROM room_files rf
                 JOIN rooms r ON r.room_id = rf.room_id
                WHERE rf.file_id = ? AND rf.room_id = ?
                  AND rf.deleted_at IS NULL AND rf.expires_at > ?
                  AND (rf.uploader_id = ? OR (r.kind = 'group' AND r.owner_id = ?))
             )`,
          ),
        )
        .bind(input.file_id, room.room_id, at, caller, caller),
      db
        .prepare(
          guardSql(
            'fileReferenced',
            `EXISTS (SELECT 1 FROM file_references WHERE file_id = ? AND state = 'active')
               OR EXISTS (SELECT 1 FROM artifacts WHERE file_id = ? AND status = 'delivered')`,
          ),
        )
        .bind(input.file_id, input.file_id),
      db
        .prepare(
          `UPDATE room_files SET deleted_at = ?, deleted_by = ?, retained = 0
            WHERE file_id = ? AND room_id = ? AND deleted_at IS NULL`,
        )
        .bind(at, caller, input.file_id, room.room_id),
      db
        .prepare(
          `UPDATE drive_files
              SET state = 'deleted', deleted_at = ?, deleted_by = ?, retained = 0
            WHERE file_id = ? AND state != 'deleted'`,
        )
        .bind(at, caller, input.file_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'room_file_deleted',
          refId: row.room_file_id,
          metadata: {
            file_id: row.file_id,
            name: row.name,
            mime_type: row.mime_type,
            size: row.size,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
    ],
  });

  return stored as { file_id: string; deleted: true };
}
