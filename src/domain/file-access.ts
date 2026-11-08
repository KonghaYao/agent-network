import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { FilePublishInput } from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import {
  getDriveFile,
  getMember,
  getRoom,
  getRoomFile,
} from '../storage/queries';
import type { DriveFileRow, RoomFileRow, RoomMemberRow, RoomRow } from '../storage/rows';
import {
  operationsStatement,
  runIdempotent,
} from '../storage/transactions/runner';
import {
  historyBoundary,
  visibleCreated,
  type HistoryBoundary,
} from './room-history';
import {
  appendFileTicket,
  issuePrivateFileTicket,
  issueRoomFileTicket,
  verifyFileTicket,
} from './file-ticket';
import { handoffFileGrantForRoom } from './handoff-file-grant';
import { actorId, type Principal } from './principal';

/**
 * 私有文件的应用层授权模型。
 *
 * - 每个 MCPP Files 上传在 `drive_files` 登记；上传即上传者私有草稿。
 * - 绑定房间后，读取必须同时满足成员资格、成员代次与历史边界；裸 `/f` 链接
 *   不构成群授权。
 * - 公开发布是独立字段，只有上传者或群 owner 可切换；默认关闭。
 * - 有效任务/成果通过 `file_references` 把文件标记为 retained，禁止 TTL 清理。
 */

export interface FileQuota {
  used_bytes: number;
  limit_bytes: number;
  used_files: number;
  limit_files: number;
  retained_bytes: number;
}

export interface FileAccessUrls {
  public_url: string;
  preview_url: string;
  download_url: string;
}

export function publicFileUrl(publicOrigin: string, fileId: string): string {
  return `${publicOrigin.replace(/\/+$/u, '')}/f/${fileId}`;
}

export interface DriveFileSourceRecord {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  ownerScope: string;
}

export function driveExpiry(drive: DriveFileRow): number | null {
  if (drive.retained === 1) return null;
  return drive.expires_at;
}

export function driveFileUsable(drive: DriveFileRow, at = Date.now()): boolean {
  if (drive.state === 'deleted') return false;
  const expiresAt = driveExpiry(drive);
  return expiresAt === null || expiresAt > at;
}

export function roomFileUsable(row: RoomFileRow, at = Date.now()): boolean {
  if (row.deleted_at !== null) return false;
  return row.retained === 1 || row.expires_at > at;
}

/**
 * 登记一次上传或旧文件。
 *
 * - 新上传：`draftTtlMs` 为 24 小时，`expiresAt` 取草稿期限与底层记录有效期
 *   的较小值。
 * - 旧文件首次通过授权客户端访问：`expiresAt` 保留底层记录原有效期，不因
 *   升级突然延长或缩短；登记后旧裸 URL 立即需要票据。
 */
export async function registerDriveFile(
  db: D1Database,
  record: DriveFileSourceRecord,
  uploaderId: string | null,
  options: { draftTtlMs?: number; at?: number } = {},
): Promise<DriveFileRow> {
  let drive = await getDriveFile(db, record.fileId);
  const at = options.at ?? nowMs();
  if (!drive) {
    const storageExpiry = Date.parse(record.expiresAt);
    const draftExpiry =
      options.draftTtlMs === undefined
        ? storageExpiry
        : Math.min(at + options.draftTtlMs, storageExpiry);
    try {
      await db
        .prepare(
          `INSERT INTO drive_files
             (file_id, owner_scope, uploader_id, name, mime_type, size, sha256,
              state, visibility, room_id, created_at, expires_at, retained,
              deleted_at, deleted_by, purged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'private', NULL, ?, ?, 0, NULL, NULL, NULL)`,
        )
        .bind(
          record.fileId,
          record.ownerScope,
          uploaderId,
          record.name,
          record.mimeType,
          record.size,
          record.sha256,
          at,
          draftExpiry,
        )
        .run();
    } catch (error) {
      // 并发登记收敛到已存在的行；真正的存储错误继续抛出。
      drive = await getDriveFile(db, record.fileId);
      if (!drive) throw error;
    }
    drive = drive ?? (await getDriveFile(db, record.fileId));
    if (!drive) throw new BusinessError('FILE_UNAVAILABLE', '文件登记失败');
  }
  return alignDriveFileWithRoom(db, drive);
}

/**
 * 旧库里的房间附件没有 `drive_files` 行。首次登记时按 `room_files` 权威状态
 * 补齐，避免 `drive_file_info` 把已绑定文件当作草稿并签发无效的文件票据。
 */
async function alignDriveFileWithRoom(
  db: D1Database,
  drive: DriveFileRow,
): Promise<DriveFileRow> {
  if (drive.state !== 'draft') return drive;
  const roomFile = await getRoomFile(db, drive.file_id);
  if (!roomFile) return drive;
  const deleted = roomFile.deleted_at !== null;
  const retained = roomFile.retained === 1;
  await db
    .prepare(
      `UPDATE drive_files
          SET state = ?, room_id = ?, retained = ?,
              expires_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
              deleted_at = COALESCE(?, deleted_at),
              deleted_by = COALESCE(?, deleted_by)
        WHERE file_id = ? AND state = 'draft'`,
    )
    .bind(
      deleted ? 'deleted' : 'bound',
      roomFile.room_id,
      retained ? 1 : 0,
      retained ? 1 : 0,
      roomFile.expires_at,
      roomFile.deleted_at,
      roomFile.deleted_by,
      drive.file_id,
    )
    .run();
  return (await getDriveFile(db, drive.file_id)) ?? drive;
}

export async function quotaForOwnerScope(
  db: D1Database,
  ownerScope: string,
  at = Date.now(),
): Promise<FileQuota> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
              COALESCE(SUM(CASE WHEN retained = 1 THEN size ELSE 0 END), 0) AS retained
         FROM drive_files
        WHERE owner_scope = ? AND state = 'draft'
          AND (retained = 1 OR expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(ownerScope, at)
    .first<{ files: number; bytes: number; retained: number }>();
  return {
    used_bytes: row?.bytes ?? 0,
    limit_bytes: LIMITS.draftBytesPerActor,
    used_files: row?.files ?? 0,
    limit_files: LIMITS.draftFilesPerActor,
    retained_bytes: row?.retained ?? 0,
  };
}

export async function quotaForRoom(
  db: D1Database,
  roomId: string,
  at = Date.now(),
): Promise<FileQuota> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
              COALESCE(SUM(CASE WHEN retained = 1 THEN size ELSE 0 END), 0) AS retained
         FROM room_files
        WHERE room_id = ? AND deleted_at IS NULL AND (retained = 1 OR expires_at > ?)`,
    )
    .bind(roomId, at)
    .first<{ files: number; bytes: number; retained: number }>();
  return {
    used_bytes: row?.bytes ?? 0,
    limit_bytes: LIMITS.roomFileBytesPerRoom,
    used_files: row?.files ?? 0,
    limit_files: LIMITS.roomFilesPerRoom,
    retained_bytes: row?.retained ?? 0,
  };
}

export function accessUrls(
  publicOrigin: string,
  fileId: string,
  ticket: string,
): FileAccessUrls {
  const publicUrl = publicFileUrl(publicOrigin, fileId);
  const previewUrl = appendFileTicket(publicUrl, ticket);
  return {
    public_url: publicUrl,
    preview_url: previewUrl,
    download_url: appendFileTicket(`${publicUrl}?download=1`, ticket),
  };
}

export function privateFileUrls(
  secret: string,
  publicOrigin: string,
  fileId: string,
  ownerScope: string,
  ticketTtlMs = LIMITS.fileTicketTtlMs,
): FileAccessUrls {
  const ticket = issuePrivateFileTicket(secret, {
    fileId,
    ownerScope,
    expiresAt: Date.now() + ticketTtlMs,
  });
  return accessUrls(publicOrigin, fileId, ticket);
}

export function roomFileUrls(
  secret: string,
  publicOrigin: string,
  fileId: string,
  roomId: string,
  viewerId: string,
  boundary: HistoryBoundary,
  ticketTtlMs = LIMITS.fileTicketTtlMs,
): FileAccessUrls {
  const ticket = issueRoomFileTicket(secret, {
    fileId,
    roomId,
    actorId: viewerId,
    memberGeneration: boundary.memberGeneration,
    policyRevision: boundary.policyRevision,
    expiresAt: Date.now() + ticketTtlMs,
  });
  return accessUrls(publicOrigin, fileId, ticket);
}

export interface FileAccessDecision {
  drive: DriveFileRow | null;
  roomFile: RoomFileRow | null;
  via: 'public' | 'room-ticket' | 'file-ticket' | 'handoff-ticket';
  /** 仅 room-ticket/file-ticket/handoff-ticket 时有值。 */
  ticketSubject: string | null;
}

/** 交接授权读取仍要求目标房间成员有效、代次与策略版本一致。 */
async function targetRoomTicketValid(
  db: D1Database,
  roomId: string,
  payload: NonNullable<ReturnType<typeof verifyFileTicket>>,
): Promise<boolean> {
  const [room, member] = await Promise.all([
    getRoom(db, roomId),
    getMember(db, roomId, payload.subject),
  ]);
  if (!room || !member || member.status !== 'active') return false;
  if (member.member_generation !== payload.memberGeneration) return false;
  return room.policy_revision === payload.policyRevision;
}

/**
 * `/f` 的唯一授权入口。
 *
 * 返回 null 时统一 404，不区分“文件不存在/无票据/权限已撤销”。
 * 已绑定房间的文件只接受 room 票据；file 票据不能绕过房间撤权。
 */
export async function authorizeFileDownload(
  db: D1Database,
  fileId: string,
  ownerScope: string,
  ticket: string | null,
  secret: string,
  at = Date.now(),
): Promise<FileAccessDecision | null> {
  const [drive, roomFile] = await Promise.all([
    getDriveFile(db, fileId),
    getRoomFile(db, fileId),
  ]);
  const payload = ticket ? verifyFileTicket(secret, ticket, at) : null;

  if (drive && drive.state === 'deleted') return null;
  if (roomFile && roomFile.deleted_at !== null) return null;

  if (roomFile) {
    if (!roomFileUsable(roomFile, at)) return null;
    if (drive?.visibility === 'public') {
      return { drive, roomFile, via: 'public', ticketSubject: null };
    }
    if (
      !payload ||
      payload.scope !== 'room' ||
      payload.fileId !== fileId ||
      payload.roomId === null
    ) {
      return null;
    }
    if (payload.roomId === roomFile.room_id) {
      const [room, member] = await Promise.all([
        getRoom(db, roomFile.room_id),
        getMember(db, roomFile.room_id, payload.subject),
      ]);
      if (!room || !member || member.status !== 'active') return null;
      if (member.member_generation !== payload.memberGeneration) return null;
      if (room.policy_revision !== payload.policyRevision) return null;
      const boundary = historyBoundary(room, member);
      if (!visibleCreated(roomFile, boundary)) return null;
      return { drive, roomFile, via: 'room-ticket', ticketSubject: payload.subject };
    }
    // 跨范围交接：目标房间票据 + 包项显式授权；授权人失权或文件删除后失效。
    const grant = await handoffFileGrantForRoom(db, fileId, payload.roomId, at);
    if (!grant || !(await targetRoomTicketValid(db, payload.roomId, payload))) return null;
    return { drive, roomFile, via: 'handoff-ticket', ticketSubject: payload.subject };
  }

  if (drive) {
    if (!driveFileUsable(drive, at)) return null;
    if (drive.visibility === 'public') {
      return { drive, roomFile: null, via: 'public', ticketSubject: null };
    }
    if (
      payload &&
      payload.scope === 'file' &&
      payload.fileId === fileId &&
      payload.subject === drive.owner_scope
    ) {
      return { drive, roomFile: null, via: 'file-ticket', ticketSubject: payload.subject };
    }
    // 草稿也可被显式授权到目标房间；仍要求目标成员有效且代次/策略一致。
    if (payload && payload.scope === 'room' && payload.fileId === fileId && payload.roomId) {
      const grant = await handoffFileGrantForRoom(db, fileId, payload.roomId, at);
      if (!grant || !(await targetRoomTicketValid(db, payload.roomId, payload))) return null;
      return { drive, roomFile: null, via: 'handoff-ticket', ticketSubject: payload.subject };
    }
    return null;
  }

  // 旧库未登记的文件：同样收紧为私有，只有上传身份的文件票据可以读取。
  if (
    !payload ||
    payload.scope !== 'file' ||
    payload.fileId !== fileId ||
    payload.subject !== ownerScope
  ) {
    return null;
  }
  return { drive: null, roomFile: null, via: 'file-ticket', ticketSubject: payload.subject };
}

/** 房间 owner 或上传者可以管理文件；单聊只有上传者。 */
export function canManageFile(
  principal: Principal,
  room: RoomRow,
  row: RoomFileRow,
): boolean {
  const caller = actorId(principal);
  if (row.uploader_id === caller) return true;
  return room.kind === 'group' && room.owner_id === caller;
}

export interface ActiveMembership {
  caller: string;
  room: RoomRow;
  member: RoomMemberRow;
  boundary: HistoryBoundary;
}

export async function requireActiveMember(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<ActiveMembership> {
  const caller = actorId(principal);
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  return { caller, room, member, boundary: historyBoundary(room, member) };
}

export interface FilePublishResult {
  file_id: string;
  public: boolean;
  public_url: string;
  preview_url: string;
  download_url: string;
}

/**
 * 显式公开发布 / 撤销发布。
 *
 * - 已绑定房间：调用者必须是有效成员，且是上传者或群 owner（单聊只有上传者）。
 * - 未绑定草稿：只有上传身份可以操作。
 * - 发布不延长 TTL；公开文件仍受草稿/附件期限约束，避免无限免费空间。
 */
export async function publishFile(
  db: D1Database,
  principal: Principal,
  input: FilePublishInput,
  secret: string,
  publicOrigin: string,
): Promise<FilePublishResult> {
  const caller = actorId(principal);
  const drive = await getDriveFile(db, input.file_id);
  if (!drive || drive.state === 'deleted') {
    throw new BusinessError('FILE_UNAVAILABLE', '文件不存在或已删除', {
      file_id: input.file_id,
    });
  }
  const roomFile = await getRoomFile(db, input.file_id);
  const at = nowMs();
  let urls: FileAccessUrls;
  let boundary: HistoryBoundary | null = null;

  if (roomFile) {
    if (input.room_id && input.room_id !== roomFile.room_id) {
      throw new BusinessError('FILE_UNAVAILABLE', '文件不在该房间', {
        file_id: input.file_id,
      });
    }
    if (roomFile.deleted_at !== null) {
      throw new BusinessError('FILE_UNAVAILABLE', '文件已从房间删除', {
        file_id: input.file_id,
      });
    }
    const membership = await requireActiveMember(db, principal, roomFile.room_id);
    boundary = membership.boundary;
    // 加入前（或重新加入前的代次）文件不在当前历史边界内，不能接管发布状态。
    if (!visibleCreated(roomFile, boundary)) {
      throw new BusinessError('FILE_UNAVAILABLE', '文件不存在或当前不可见', {
        file_id: input.file_id,
      });
    }
    if (!canManageFile(principal, membership.room, roomFile)) {
      throw new BusinessError('NOT_OWNER', '只有上传者或群 owner 可以发布该文件');
    }
  } else {
    if (input.room_id) {
      throw new BusinessError('FILE_UNAVAILABLE', '文件尚未绑定到该房间', {
        file_id: input.file_id,
      });
    }
    if (drive.owner_scope !== `actor:${caller}` && drive.uploader_id !== caller) {
      throw new BusinessError('NOT_OWNER', '只有上传者可以发布该文件');
    }
  }

  if (input.public) {
    urls = {
      public_url: publicFileUrl(publicOrigin, input.file_id),
      preview_url: publicFileUrl(publicOrigin, input.file_id),
      download_url: `${publicFileUrl(publicOrigin, input.file_id)}?download=1`,
    };
  } else if (roomFile && boundary) {
    urls = roomFileUrls(
      secret,
      publicOrigin,
      input.file_id,
      roomFile.room_id,
      caller,
      boundary,
    );
  } else {
    urls = privateFileUrls(secret, publicOrigin, input.file_id, drive.owner_scope);
  }

  const payloadHash = await sha256Hex(stableStringify(input));
  const result: FilePublishResult = {
    file_id: input.file_id,
    public: input.public,
    ...urls,
  };
  // 发布是可反复切换的状态动作；event_key 必须每次唯一，不能按 file_id 复用，
  // 否则同一文件第二次发布（撤销后重新发布）会撞 events 唯一键整批回滚。
  const eventKey = `room_file:${input.public ? 'published' : 'unpublished'}:${input.file_id}:${crypto.randomUUID().replace(/-/g, '')}`;
  const stored = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      roomFile
        ? db
            .prepare(
              guardSql(
                'notMember',
                'NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = \'active\')',
              ),
            )
            .bind(roomFile.room_id, caller)
        : db.prepare('SELECT 1'),
      roomFile
        ? db
            .prepare(
              guardSql(
                'notFileOwner',
                `NOT EXISTS (
                   SELECT 1 FROM room_files rf
                     JOIN rooms r ON r.room_id = rf.room_id
                    WHERE rf.file_id = ? AND rf.room_id = ?
                      AND (rf.uploader_id = ? OR (r.kind = 'group' AND r.owner_id = ?))
                 )`,
              ),
            )
            .bind(input.file_id, roomFile.room_id, caller, caller)
        : db
            .prepare(
              guardSql(
                'fileUnavailable',
                'NOT EXISTS (SELECT 1 FROM drive_files WHERE file_id = ? AND state != \'deleted\' AND owner_scope = ?)',
              ),
            )
            .bind(input.file_id, `actor:${caller}`),
      db
        .prepare('UPDATE drive_files SET visibility = ? WHERE file_id = ? AND state != \'deleted\'')
        .bind(input.public ? 'public' : 'private', input.file_id),
      ...(roomFile
        ? [
            eventStatement(
              db,
              {
                eventKey,
                scopeKind: 'room' as const,
                scopeId: roomFile.room_id,
                eventType: input.public ? 'room_file_published' : 'room_file_unpublished',
                refId: roomFile.room_file_id,
                metadata: { file_id: input.file_id, public: input.public, actor_id: caller },
              },
              at,
            ),
            outboxStatement(db, { topic: roomTopic(roomFile.room_id), eventKey }, at),
          ]
        : []),
    ],
  });
  return stored as FilePublishResult;
}
