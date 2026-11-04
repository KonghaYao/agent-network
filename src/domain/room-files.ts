import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
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
  getMember,
  getOperation,
  getRoom,
  getRoomFile,
} from '../storage/queries';
import type { RoomFileRow, RoomRow } from '../storage/rows';
import {
  isRoomFileConflict,
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';

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
  created_at: string;
  expires_at: string;
}

/** 绑定前置：当前身份自己的、未过期的 MCPP Files 记录。 */
export interface RoomFileSource {
  readFile(fileId: string): Promise<{
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    expiresAt: string;
    ownerScope: string;
  } | null>;
}

function publicFileUrl(publicOrigin: string, fileId: string): string {
  return `${publicOrigin.replace(/\/+$/u, '')}/f/${fileId}`;
}

interface ViewContext {
  publicOrigin: string;
  viewerId: string;
  room: Pick<RoomRow, 'kind' | 'owner_id'>;
  uploaderName: string;
}

function canDelete(row: RoomFileRow, context: ViewContext): boolean {
  if (row.uploader_id === context.viewerId) return true;
  return context.room.kind === 'group' && context.room.owner_id === context.viewerId;
}

function roomFileView(row: RoomFileRow, context: ViewContext): RoomFileView {
  const publicUrl = publicFileUrl(context.publicOrigin, row.file_id);
  return {
    room_file_id: row.room_file_id,
    room_id: row.room_id,
    file_id: row.file_id,
    name: row.name,
    mime_type: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    public_url: publicUrl,
    preview_url: publicUrl,
    download_url: `${publicUrl}?download=1`,
    preview_kind: filePreviewKind(row.mime_type),
    uploader_id: row.uploader_id,
    uploader_name: context.uploaderName,
    can_delete: canDelete(row, context),
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
): Promise<{ caller: string; room: RoomRow }> {
  const caller = actorId(principal);
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  return { caller, room };
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
): Promise<{ file: RoomFileView }> {
  const { caller, room } = await requireRoomMember(db, principal, input.room_id);
  const payloadHash = await sha256Hex(stableStringify(input));

  // 先查幂等重放，再读文件：重放不依赖文件是否仍然可读。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as { file: RoomFileView };

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

  const expiresAt = Math.min(at + LIMITS.roomFileTtlMs, Date.parse(file.expiresAt));
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
    expires_at: expiresAt,
    deleted_at: null,
    deleted_by: null,
  };
  const context: ViewContext = {
    publicOrigin,
    viewerId: caller,
    room,
    uploaderName: principal.actor?.name ?? '',
  };
  const result = { file: roomFileView(row, context) };
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
      db
        .prepare(
          guardSql(
            'roomFileLimit',
            '(SELECT COUNT(*) FROM room_files WHERE room_id = ? AND deleted_at IS NULL AND expires_at > ?) >= ?',
          ),
        )
        .bind(room.room_id, at, LIMITS.roomFilesPerRoom),
      db
        .prepare(
          guardSql(
            'roomFileLimit',
            '(SELECT COALESCE(SUM(size), 0) FROM room_files WHERE room_id = ? AND deleted_at IS NULL AND expires_at > ?) + ? > ?',
          ),
        )
        .bind(room.room_id, at, row.size, LIMITS.roomFileBytesPerRoom),
      db
        .prepare(
          `INSERT INTO room_files
             (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
              created_at, expires_at, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
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
      };
    },
  });

  return stored as { file: RoomFileView };
}

interface RoomFileListRow extends RoomFileRow {
  uploader_name: string;
}

export async function roomFileList(
  db: D1Database,
  principal: Principal,
  input: RoomFileListInput,
  publicOrigin: string,
): Promise<{ items: RoomFileView[]; next_cursor: string | null; has_more: boolean }> {
  const { caller, room } = await requireRoomMember(db, principal, input.room_id);
  const limit = clampPage(input.limit, LIMITS.roomFilePageDefault, LIMITS.roomFilePageMax);
  const scope = `room_files:${room.room_id}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const keyset = cursor ? 'AND (rf.created_at < ? OR (rf.created_at = ? AND rf.room_file_id < ?))' : '';
  const binds: unknown[] = cursor
    ? [room.room_id, Date.now(), cursor.seq, cursor.seq, cursor.key ?? '']
    : [room.room_id, Date.now()];

  const rows = await db
    .prepare(
      `SELECT rf.*, a.name AS uploader_name
         FROM room_files rf
         JOIN actors a ON a.actor_id = rf.uploader_id
        WHERE rf.room_id = ? AND rf.deleted_at IS NULL AND rf.expires_at > ? ${keyset}
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
      roomFileView(row, { publicOrigin, viewerId: caller, room, uploaderName: row.uploader_name }),
    ),
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
): Promise<{ file: RoomFileView }> {
  const { caller, room } = await requireRoomMember(db, principal, input.room_id);
  const row = await getRoomFile(db, input.file_id);
  if (
    !row ||
    row.room_id !== room.room_id ||
    row.deleted_at !== null ||
    row.expires_at <= Date.now()
  ) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不存在、已过期或已删除', {
      file_id: input.file_id,
    });
  }
  return {
    file: roomFileView(row, {
      publicOrigin,
      viewerId: caller,
      room,
      uploaderName: await actorName(db, row.uploader_id),
    }),
  };
}

export async function roomFileDelete(
  db: D1Database,
  principal: Principal,
  input: RoomFileDeleteInput,
): Promise<{ file_id: string; deleted: true }> {
  const { caller, room } = await requireRoomMember(db, principal, input.room_id);
  const row = await getRoomFile(db, input.file_id);
  if (!row || row.room_id !== room.room_id) {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不在该房间', { file_id: input.file_id });
  }
  const allowed = row.uploader_id === caller || (room.kind === 'group' && room.owner_id === caller);
  if (!allowed) {
    throw new BusinessError('NOT_OWNER', '只有上传者或群 owner 可以删除该文件');
  }
  // 已删除：结果已经达成，重复调用直接成功且不重复发事件。
  if (row.deleted_at !== null) return { file_id: input.file_id, deleted: true };
  if (row.expires_at <= Date.now()) {
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
          `UPDATE room_files SET deleted_at = ?, deleted_by = ?
            WHERE file_id = ? AND room_id = ? AND deleted_at IS NULL`,
        )
        .bind(at, caller, input.file_id, room.room_id),
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

/** 供 `/f` 路由复用：墓碑或过期都视为不可下载。 */
export async function roomFileIsDownloadable(
  db: D1Database,
  fileId: string,
  at = Date.now(),
): Promise<boolean> {
  const row = await getRoomFile(db, fileId);
  if (!row) return true;
  return row.deleted_at === null && row.expires_at > at;
}
