import { newId } from '../storage/db';
import type { RoomManagementAuditRow } from '../storage/rows';

export interface RoomAuditSpec {
  roomId: string;
  action: RoomManagementAuditRow['action'];
  targetActorId?: string | null;
  previousRole?: RoomManagementAuditRow['previous_role'];
  newRole?: RoomManagementAuditRow['new_role'];
  previousStatus?: RoomManagementAuditRow['previous_status'];
  newStatus?: RoomManagementAuditRow['new_status'];
  expectedRevision?: number | null;
  resultingRevision: number;
  changedBy: string;
  requestId: string;
  detail?: Record<string, unknown>;
}

/** 追加写管理审计；与角色/策略/转让变更在同一事务内提交。 */
export function roomAuditStatement(
  db: D1Database,
  spec: RoomAuditSpec,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO room_management_audit
         (audit_id, room_id, action, target_actor_id, previous_role, new_role,
          previous_status, new_status, expected_revision, resulting_revision,
          changed_by, request_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('raud'),
      spec.roomId,
      spec.action,
      spec.targetActorId ?? null,
      spec.previousRole ?? null,
      spec.newRole ?? null,
      spec.previousStatus ?? null,
      spec.newStatus ?? null,
      spec.expectedRevision ?? null,
      spec.resultingRevision,
      spec.changedBy,
      spec.requestId,
      JSON.stringify(spec.detail ?? {}),
      at,
    );
}

/**
 * 仅当本次转换事件真实写入时追加管理审计。
 *
 * 消息撤回/置顶/取消置顶是条件写入：并发操作可能已经完成同一状态，
 * 本批事件不存在时不能补记一条不属于本次请求的审计。调用方必须让
 * `eventKey` 指向同批已插入的事件；事件被并发的另一端抢先时整行跳过。
 */
export function roomAuditStatementIfEvent(
  db: D1Database,
  spec: RoomAuditSpec,
  eventKey: string,
  at: number,
  eventMetadata?: { key: string; value: string },
): D1PreparedStatement {
  const metadataCondition = eventMetadata
    ? 'AND json_extract(metadata, ?) = ?'
    : '';
  const statement = db.prepare(
    `INSERT INTO room_management_audit
       (audit_id, room_id, action, target_actor_id, previous_role, new_role,
        previous_status, new_status, expected_revision, resulting_revision,
        changed_by, request_id, detail_json, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM events WHERE event_key = ? ${metadataCondition})`,
  );
  const binds: unknown[] = [
    newId('raud'),
    spec.roomId,
    spec.action,
    spec.targetActorId ?? null,
    spec.previousRole ?? null,
    spec.newRole ?? null,
    spec.previousStatus ?? null,
    spec.newStatus ?? null,
    spec.expectedRevision ?? null,
    spec.resultingRevision,
    spec.changedBy,
    spec.requestId,
    JSON.stringify(spec.detail ?? {}),
    at,
    eventKey,
  ];
  if (eventMetadata) binds.push(`$.${eventMetadata.key}`, eventMetadata.value);
  return statement.bind(...binds);
}
