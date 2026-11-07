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
