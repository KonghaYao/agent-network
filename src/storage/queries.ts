import type {
  ActorRow,
  ArtifactRow,
  DeliveryRow,
  DriveFileRow,
  FileReferenceRow,
  MessageRow,
  RoomFileRow,
  RoomMemberRow,
  RoomRow,
  RoomTaskRow,
  TaskAssignmentRow,
  TaskCardRow,
  TaskHandoffContextRequestRow,
  TaskHandoffItemRow,
  TaskHandoffPackRow,
  TaskRow,
  TaskTransferRow,
} from './rows';

export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export async function getActor(db: D1Like, actorId: string): Promise<ActorRow | null> {
  return db.prepare('SELECT * FROM actors WHERE actor_id = ?').bind(actorId).first<ActorRow>();
}

export async function getActorBySession(db: D1Like, sessionId: string): Promise<ActorRow | null> {
  return db
    .prepare('SELECT * FROM actors WHERE agent_session_id = ?')
    .bind(sessionId)
    .first<ActorRow>();
}

/** 历史/时间线只判定发送者类型；不要在这里读取 metadata 或管理字段。 */
export interface ActorKindRow {
  actor_id: string;
  kind: 'human' | 'agent';
}

/** 只按已知 actor_id 批量读取展示类型；调用方负责去重与数量上限。 */
export async function getActorsByIds(
  db: D1Like,
  actorIds: string[],
): Promise<ActorKindRow[]> {
  if (actorIds.length === 0) return [];
  const placeholders = actorIds.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT actor_id, kind FROM actors WHERE actor_id IN (${placeholders})`)
    .bind(...actorIds)
    .all<ActorKindRow>();
  return result.results;
}

/** Agent 管理摘要需要的字段；metadata 与收件箱计数不进入该列表。 */
export type ActorManagementRow = Pick<
  ActorRow,
  | 'actor_id'
  | 'kind'
  | 'agent_session_id'
  | 'name'
  | 'archived_at'
  | 'archived_by'
  | 'disabled_at'
  | 'disabled_by'
  | 'disabled_reason'
>;

/** 只按已知 actor_id 批量读取 Agent 管理摘要。 */
export async function getActorManagementByIds(
  db: D1Like,
  actorIds: string[],
): Promise<ActorManagementRow[]> {
  if (actorIds.length === 0) return [];
  const placeholders = actorIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT actor_id, kind, agent_session_id, name, archived_at, archived_by,
              disabled_at, disabled_by, disabled_reason
         FROM actors WHERE actor_id IN (${placeholders})`,
    )
    .bind(...actorIds)
    .all<ActorManagementRow>();
  return result.results;
}

export async function getRoom(db: D1Like, roomId: string): Promise<RoomRow | null> {
  return db.prepare('SELECT * FROM rooms WHERE room_id = ?').bind(roomId).first<RoomRow>();
}

export async function getMember(
  db: D1Like,
  roomId: string,
  actorId: string,
): Promise<RoomMemberRow | null> {
  return db
    .prepare('SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?')
    .bind(roomId, actorId)
    .first<RoomMemberRow>();
}

export async function isActiveMember(db: D1Like, roomId: string, actorId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'")
    .bind(roomId, actorId)
    .first<{ ok: number }>();
  return row !== null;
}

export async function getMessage(db: D1Like, messageId: string): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE message_id = ?').bind(messageId).first<MessageRow>();
}

/** 按 file_id 读取绑定记录；同一 file_id 全局唯一，含墓碑。 */
export async function getRoomFile(db: D1Like, fileId: string): Promise<RoomFileRow | null> {
  return db
    .prepare('SELECT * FROM room_files WHERE file_id = ?')
    .bind(fileId)
    .first<RoomFileRow>();
}

/** 按 file_id 读取应用层上传登记；旧库未登记的文件返回 null。 */
export async function getDriveFile(db: D1Like, fileId: string): Promise<DriveFileRow | null> {
  return db
    .prepare('SELECT * FROM drive_files WHERE file_id = ?')
    .bind(fileId)
    .first<DriveFileRow>();
}

/** 按 artifact_id 读取成果版本。 */
export async function getArtifact(db: D1Like, artifactId: string): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
    .bind(artifactId)
    .first<ArtifactRow>();
}

/** 按 file_id 读取成果版本；一个文件至多一个成果。 */
export async function getArtifactByFile(db: D1Like, fileId: string): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE file_id = ?')
    .bind(fileId)
    .first<ArtifactRow>();
}

/** 读取某文件的一条有效保留引用。 */
export async function getActiveFileReference(
  db: D1Like,
  fileId: string,
  kind: FileReferenceRow['kind'],
  refId: string,
): Promise<FileReferenceRow | null> {
  return db
    .prepare(
      "SELECT * FROM file_references WHERE file_id = ? AND kind = ? AND ref_id = ? AND state = 'active'",
    )
    .bind(fileId, kind, refId)
    .first<FileReferenceRow>();
}

/** 读取当前 actor 在房间内的网页监控配置；无行表示未配置。 */
export async function getActorRoomMonitor(
  db: D1Like,
  actorId: string,
  roomId: string,
): Promise<import('./rows').ActorRoomMonitorRow | null> {
  return db
    .prepare('SELECT * FROM actor_room_monitors WHERE actor_id = ? AND room_id = ?')
    .bind(actorId, roomId)
    .first<import('./rows').ActorRoomMonitorRow>();
}

/** 按 task_id 读取任务；房间归属由调用方校验。 */
export async function getRoomTask(db: D1Like, taskId: string): Promise<RoomTaskRow | null> {
  return db.prepare('SELECT * FROM room_tasks WHERE task_id = ?').bind(taskId).first<RoomTaskRow>();
}

/** 按 task_id 读取 D01 任务；房间归属与可见性由调用方校验。 */
export async function getTask(db: D1Like, taskId: string): Promise<TaskRow | null> {
  return db.prepare('SELECT * FROM tasks WHERE task_id = ?').bind(taskId).first<TaskRow>();
}

/** 来源消息到任务的唯一映射；用于把重复创建收敛到同一任务。 */
export async function getTaskBySourceMessage(
  db: D1Like,
  messageId: string,
): Promise<TaskRow | null> {
  return db
    .prepare('SELECT * FROM tasks WHERE source_message_id = ?')
    .bind(messageId)
    .first<TaskRow>();
}

export async function getTaskCard(db: D1Like, taskId: string): Promise<TaskCardRow | null> {
  return db.prepare('SELECT * FROM task_cards WHERE task_id = ?').bind(taskId).first<TaskCardRow>();
}

export async function getTaskAssignment(
  db: D1Like,
  assignmentId: string,
): Promise<TaskAssignmentRow | null> {
  return db
    .prepare('SELECT * FROM task_assignments WHERE assignment_id = ?')
    .bind(assignmentId)
    .first<TaskAssignmentRow>();
}

/** D08：按任务内稳定 action_id 读取外部动作对账记录。 */
export async function getTaskExternalAction(
  db: D1Like,
  taskId: string,
  actionId: string,
): Promise<import('./rows').TaskExternalActionRow | null> {
  return db
    .prepare('SELECT * FROM task_external_actions WHERE task_id = ? AND action_id = ?')
    .bind(taskId, actionId)
    .first<import('./rows').TaskExternalActionRow>();
}

export async function getTaskTransfer(
  db: D1Like,
  transferId: string,
): Promise<TaskTransferRow | null> {
  return db
    .prepare('SELECT * FROM task_transfers WHERE transfer_id = ?')
    .bind(transferId)
    .first<TaskTransferRow>();
}

/** 按 pack_id 读取交接包版本；任务归属与可见性由调用方校验。 */
export async function getTaskHandoffPack(
  db: D1Like,
  packId: string,
): Promise<TaskHandoffPackRow | null> {
  return db
    .prepare('SELECT * FROM task_handoff_packs WHERE pack_id = ?')
    .bind(packId)
    .first<TaskHandoffPackRow>();
}

/** 读取任务的最新交接包版本；没有包时返回 null。 */
export async function getLatestTaskHandoffPack(
  db: D1Like,
  taskId: string,
): Promise<TaskHandoffPackRow | null> {
  return db
    .prepare(
      `SELECT * FROM task_handoff_packs
        WHERE task_id = ?
        ORDER BY version DESC
        LIMIT 1`,
    )
    .bind(taskId)
    .first<TaskHandoffPackRow>();
}

/** 读取指定 assignment 对应的最新交接包，用于交接提议的 context_ready。 */
export async function getTaskHandoffPackForAssignment(
  db: D1Like,
  taskId: string,
  assignmentId: string | null,
): Promise<TaskHandoffPackRow | null> {
  if (assignmentId === null) return getLatestTaskHandoffPack(db, taskId);
  return db
    .prepare(
      `SELECT * FROM task_handoff_packs
        WHERE task_id = ? AND from_assignment_id = ?
        ORDER BY version DESC
        LIMIT 1`,
    )
    .bind(taskId, assignmentId)
    .first<TaskHandoffPackRow>();
}

export async function listTaskHandoffItems(
  db: D1Like,
  packId: string,
): Promise<TaskHandoffItemRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM task_handoff_pack_items
        WHERE pack_id = ?
        ORDER BY created_at ASC, item_id ASC`,
    )
    .bind(packId)
    .all<TaskHandoffItemRow>();
  return rows.results;
}

export async function getTaskHandoffItem(
  db: D1Like,
  itemId: string,
): Promise<TaskHandoffItemRow | null> {
  return db
    .prepare('SELECT * FROM task_handoff_pack_items WHERE item_id = ?')
    .bind(itemId)
    .first<TaskHandoffItemRow>();
}

export async function listTaskHandoffContextRequests(
  db: D1Like,
  packId: string,
  limit: number,
): Promise<TaskHandoffContextRequestRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM task_handoff_context_requests
        WHERE pack_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(packId, limit)
    .all<TaskHandoffContextRequestRow>();
  return rows.results;
}

export async function getDelivery(db: D1Like, deliveryId: string): Promise<DeliveryRow | null> {
  return db
    .prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
    .bind(deliveryId)
    .first<DeliveryRow>();
}

export async function getDeliveryForMessage(
  db: D1Like,
  recipientId: string,
  messageId: string,
): Promise<DeliveryRow | null> {
  return db
    .prepare('SELECT * FROM deliveries WHERE recipient_id = ? AND message_id = ?')
    .bind(recipientId, messageId)
    .first<DeliveryRow>();
}

export async function getClaimedDelivery(
  db: D1Like,
  recipientId: string,
): Promise<DeliveryRow | null> {
  return db
    .prepare("SELECT * FROM deliveries WHERE recipient_id = ? AND state = 'claimed' LIMIT 1")
    .bind(recipientId)
    .first<DeliveryRow>();
}

export async function getOperation(
  db: D1Like,
  actorId: string,
  requestId: string,
): Promise<import('./rows').OperationRow | null> {
  return db
    .prepare('SELECT * FROM operations WHERE actor_id = ? AND request_id = ?')
    .bind(actorId, requestId)
    .first<import('./rows').OperationRow>();
}

export async function getCredentialByHash(
  db: D1Like,
  tokenHash: string,
): Promise<import('./rows').CredentialRow | null> {
  return db
    .prepare('SELECT * FROM credentials WHERE token_hash = ?')
    .bind(tokenHash)
    .first<import('./rows').CredentialRow>();
}

export async function activeRoomCount(db: D1Like, actorId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'",
    )
    .bind(actorId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getEventsMinSeq(
  db: D1Like,
  scopeKind: 'room' | 'inbox' | 'actor',
  scopeId: string,
): Promise<number> {
  if (scopeKind === 'room') {
    const room = await getRoom(db, scopeId);
    return room?.events_min_seq ?? 0;
  }
  if (scopeKind === 'inbox') {
    const actor = await getActor(db, scopeId);
    return actor?.inbox_min_seq ?? 0;
  }
  return 0;
}
