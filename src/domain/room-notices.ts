import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type { RoomNoticeListInput } from '../contracts/schemas';
import type { RoomManagementAuditRow } from '../storage/rows';
import { loadRoomAccess } from './room-access';
import { actorId, type Principal } from './principal';

/**
 * 普通成员可见的管理事件。
 *
 * 数据源仍是追加写的 `room_management_audit`，但只返回：
 * - 影响调用者自身的事件（加入、移除、角色、群主转让目标）；
 * - 群公告与群策略变更（影响所有成员）。
 *
 * 详细管理记录（request_id、角色/版本、detail）只由 owner/admin 的
 * `network_room_role_history` 返回。两条路径都不包含凭据、消息正文或
 * 私密材料；这里额外用固定的 `summary` 取代原始 detail，避免把内部字段
 * 泄漏给普通成员。
 */

export interface RoomNoticeView {
  audit_id: string;
  action: RoomManagementAuditRow['action'];
  target_actor_id: string | null;
  changed_by: string;
  changed_by_name: string | null;
  summary: string;
  created_at: string;
}

export interface RoomNoticePage {
  items: RoomNoticeView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NoticeRow extends RoomManagementAuditRow {
  changed_by_name: string | null;
}

function noticeSummary(action: RoomManagementAuditRow['action']): string {
  switch (action) {
    case 'member_added':
      return '你已加入群聊';
    case 'member_removed':
      return '你已被移出群聊';
    case 'member_left':
      return '你已离开群聊';
    case 'admin_appointed':
      return '你已被设为群管理员';
    case 'admin_revoked':
      return '你的群管理员身份已撤销';
    case 'owner_transferred':
      return '群主已变更';
    case 'owner_transfer_proposed':
      return '你收到一条群主转让提议';
    case 'owner_transfer_accepted':
      return '群主转让已接受';
    case 'owner_transfer_rejected':
      return '群主转让已拒绝';
    case 'owner_transfer_cancelled':
      return '群主转让已取消';
    case 'owner_transfer_expired':
      return '群主转让提议已过期';
    case 'policy_updated':
      return '群策略已更新';
    case 'announcement_updated':
      return '群公告已更新';
    default:
      return '群管理事件已更新';
  }
}

export async function roomNoticeList(
  db: D1Database,
  principal: Principal,
  input: RoomNoticeListInput,
): Promise<RoomNoticePage> {
  const caller = actorId(principal);
  // 只要求 active 成员；管理员也走同一摘要视图，详细记录用 role_history。
  await loadRoomAccess(db, input.room_id, caller);
  const scope = `room_notices:${input.room_id}:${caller}`;
  const limit = clampPage(
    input.limit,
    LIMITS.roomRoleHistoryPageDefault,
    LIMITS.roomRoleHistoryPageMax,
  );
  let cursor;
  try {
    cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  } catch (error) {
    if (error instanceof BusinessError && error.code === 'INVALID_ARGUMENT') {
      throw new BusinessError('CURSOR_EXPIRED', '通知游标已失效，请重新读取', {
        scope,
      });
    }
    throw error;
  }
  const keyset = cursor
    ? 'AND (a.created_at < ? OR (a.created_at = ? AND a.audit_id < ?))'
    : '';
  const binds: unknown[] = cursor
    ? [input.room_id, caller, cursor.seq, cursor.seq, cursor.key ?? '']
    : [input.room_id, caller];

  const rows = await db
    .prepare(
      `SELECT a.*, changer.name AS changed_by_name
         FROM room_management_audit a
         LEFT JOIN actors changer ON changer.actor_id = a.changed_by
        WHERE a.room_id = ?
          AND (a.action IN ('policy_updated', 'announcement_updated')
            OR a.target_actor_id = ?)
          ${keyset}
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<NoticeRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      audit_id: row.audit_id,
      action: row.action,
      target_actor_id: row.target_actor_id,
      changed_by: row.changed_by,
      changed_by_name: row.changed_by_name,
      summary: noticeSummary(row.action),
      created_at: String(row.created_at),
    })),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.audit_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}
