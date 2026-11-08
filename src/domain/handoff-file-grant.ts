/**
 * 交接包文件的跨范围读取判据。
 *
 * 单独成模块，避免 `file-access.ts` 与 `task-handoff-packs.ts` 互相导入。
 * 这里只回答一个问题：目标房间成员持有的房间票据，是否被某个仍有效的
 * 交接包文件项显式授权读取该文件。
 *
 * 每次下载都重新校验：
 * - 包项 `authorized=1` 且 `revoked_at IS NULL`；
 * - 包的目标房间就是票据房间；
 * - 源文件仍存在、未删除且未过期；
 * - 授权人仍是源范围有效成员，且仍能看到该文件（源撤回/失权立即生效）。
 */

import { getDriveFile, getMember, getRoom, getRoomFile } from '../storage/queries';
import type { DriveFileRow, RoomFileRow } from '../storage/rows';
import { historyBoundary, visibleCreated } from './room-history';

/** 与 `file-access.ts` 相同的可用性判据；复制三行避免模块循环依赖。 */
function roomFileUsable(row: RoomFileRow, at: number): boolean {
  if (row.deleted_at !== null) return false;
  return row.retained === 1 || row.expires_at > at;
}

function driveFileUsable(row: DriveFileRow, at: number): boolean {
  if (row.state === 'deleted') return false;
  if (row.retained === 1) return true;
  return row.expires_at === null || row.expires_at > at;
}

export interface HandoffFileGrant {
  item_id: string;
  pack_id: string;
  task_id: string;
  source_room_id: string;
  authorized_by: string;
}

interface GrantCandidate {
  item_id: string;
  pack_id: string;
  task_id: string;
  source_room_id: string | null;
  reference: string;
  authorized_by: string | null;
  pack_room_id: string;
}

/**
 * 查找目标房间可用的交接包文件授权。
 *
 * 未授权、已撤回、源文件删除/过期或授权人失权时返回 null；`/f` 统一 404。
 */
export async function handoffFileGrantForRoom(
  db: D1Database,
  fileId: string,
  targetRoomId: string,
  at = Date.now(),
): Promise<HandoffFileGrant | null> {
  const rows = await db
    .prepare(
      `SELECT i.item_id, i.pack_id, p.task_id, i.source_room_id,
              i.reference, i.authorized_by, p.room_id AS pack_room_id
         FROM task_handoff_pack_items i
         JOIN task_handoff_packs p ON p.pack_id = i.pack_id
        WHERE i.kind = 'file' AND i.reference = ?
          AND i.authorized = 1 AND i.revoked_at IS NULL
          AND p.room_id = ?
        ORDER BY i.created_at DESC`,
    )
    .bind(fileId, targetRoomId)
    .all<GrantCandidate>();
  if (!rows.results.length) return null;

  const [roomFile, drive] = await Promise.all([getRoomFile(db, fileId), getDriveFile(db, fileId)]);
  if (drive?.state === 'deleted') return null;
  if (roomFile && !roomFileUsable(roomFile, at)) return null;
  if (!roomFile && (!drive || !driveFileUsable(drive, at))) return null;

  for (const row of rows.results) {
    if (!row.authorized_by) continue;
    // 已绑定房间的文件必须来自源房间；同房间材料本来就走房间票据。
    if (roomFile) {
      const sourceRoomId = row.source_room_id ?? row.pack_room_id;
      if (sourceRoomId === targetRoomId) continue;
      if (roomFile.room_id !== sourceRoomId) continue;
      const [sourceRoom, member] = await Promise.all([
        getRoom(db, sourceRoomId),
        getMember(db, sourceRoomId, row.authorized_by),
      ]);
      if (!sourceRoom || !member || member.status !== 'active') continue;
      const boundary = historyBoundary(sourceRoom, member);
      if (!visibleCreated(roomFile, boundary)) continue;
      return {
        item_id: row.item_id,
        pack_id: row.pack_id,
        task_id: row.task_id,
        source_room_id: sourceRoomId,
        authorized_by: row.authorized_by,
      };
    }

    // 草稿文件没有房间归属，只允许上传者本人授权；显式写目标房间视为不跨范围。
    if (!drive || row.source_room_id === targetRoomId) continue;
    if (drive.uploader_id !== row.authorized_by) continue;
    return {
      item_id: row.item_id,
      pack_id: row.pack_id,
      task_id: row.task_id,
      source_room_id: row.source_room_id ?? '',
      authorized_by: row.authorized_by,
    };
  }
  return null;
}
