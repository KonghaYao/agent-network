import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';

import { orm, schema, toD1, type D1Queryable } from './drizzle';
import type {
  MemoryCatchupItemRow,
  MemoryCatchupPlanRow,
  MemoryContextRow,
  MemoryExperienceRow,
  MemoryHostBindingRow,
  MemoryManifestItemRow,
  MemoryManifestRow,
  MemoryRecallRequestRow,
  MemoryReceiptRow,
  MemoryRepresentationDependencyRow,
  MemoryRepresentationRow,
  MemorySelectionRow,
  MemorySourceRow,
  MemorySpaceRow,
} from '../memory/rows';
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
} from './rows';

export interface D1Like extends D1Queryable {
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * 存储层语义化查询入口。
 *
 * 已迁移的只读路径（actors / credentials / rooms / room_members 与 memory 表）
 * 由 Drizzle 构建 SQL，再经 `toD1()` 回到 D1 shim 执行。其余未迁移域
 * （messages / deliveries / files / events / tasks）与所有写路径继续 raw SQL；
 * 具体 raw 边界见 `storage/drizzle.ts` 顶部清单。
 *
 * 禁止在这里调用 Drizzle 的 insert/update/delete 或自带事务；写操作必须走
 * `runIdempotent` 的 raw batch。
 */

export async function getActor(db: D1Like, actorId: string): Promise<ActorRow | null> {
  const query = orm(db)
    .select()
    .from(schema.actors)
    .where(eq(schema.actors.actor_id, actorId));
  return toD1(db, query).first<ActorRow>();
}

export async function getActorBySession(db: D1Like, sessionId: string): Promise<ActorRow | null> {
  const query = orm(db)
    .select()
    .from(schema.actors)
    .where(eq(schema.actors.agent_session_id, sessionId));
  return toD1(db, query).first<ActorRow>();
}

/** 历史/时间线只判定发送者类型；不要在这里读取 metadata 或管理字段。 */
export interface ActorKindRow {
  actor_id: string;
  kind: 'human' | 'agent';
}

/**
 * 列举 actor 时隐藏已归档 Agent 的 SQL 条件。
 *
 * `alias` 必须是代码内固定的列别名，不能来自用户输入。人类不受归档影响；
 * 未归档 Agent 与停用 Agent 仍可见。只用于成员/联系人之类的列举查询，
 * 详情读取（`network_agents_get`）与 direct 会话对端解析不得套用。
 */
export function visibleActorSql(alias: string): string {
  return `(${alias}.kind <> 'agent' OR ${alias}.archived_at IS NULL)`;
}

/** 只按已知 actor_id 批量读取展示类型；调用方负责去重与数量上限。 */
export async function getActorsByIds(
  db: D1Like,
  actorIds: string[],
): Promise<ActorKindRow[]> {
  if (actorIds.length === 0) return [];
  const query = orm(db)
    .select({ actor_id: schema.actors.actor_id, kind: schema.actors.kind })
    .from(schema.actors)
    .where(inArray(schema.actors.actor_id, actorIds));
  const result = await toD1(db, query).all<ActorKindRow>();
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
  const query = orm(db)
    .select({
      actor_id: schema.actors.actor_id,
      kind: schema.actors.kind,
      agent_session_id: schema.actors.agent_session_id,
      name: schema.actors.name,
      archived_at: schema.actors.archived_at,
      archived_by: schema.actors.archived_by,
      disabled_at: schema.actors.disabled_at,
      disabled_by: schema.actors.disabled_by,
      disabled_reason: schema.actors.disabled_reason,
    })
    .from(schema.actors)
    .where(inArray(schema.actors.actor_id, actorIds));
  const result = await toD1(db, query).all<ActorManagementRow>();
  return result.results;
}

export async function getRoom(db: D1Like, roomId: string): Promise<RoomRow | null> {
  const query = orm(db).select().from(schema.rooms).where(eq(schema.rooms.room_id, roomId));
  return toD1(db, query).first<RoomRow>();
}

export async function getMember(
  db: D1Like,
  roomId: string,
  actorId: string,
): Promise<RoomMemberRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomMembers)
    .where(
      and(eq(schema.roomMembers.room_id, roomId), eq(schema.roomMembers.actor_id, actorId)),
    );
  return toD1(db, query).first<RoomMemberRow>();
}

export async function isActiveMember(db: D1Like, roomId: string, actorId: string): Promise<boolean> {
  const query = orm(db)
    .select({ ok: sql<number>`1`.as('ok') })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.room_id, roomId),
        eq(schema.roomMembers.actor_id, actorId),
        eq(schema.roomMembers.status, 'active'),
      ),
    )
    .limit(1);
  const row = await toD1(db, query).first<{ ok: number }>();
  return row !== null;
}

/** 会话列表的只读对端：当前页 direct 房间的另一位 active 成员。 */
export interface RoomPeerRow {
  room_id: string;
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
}

/**
 * 按当前页房间批量读取对端；不在服务端逐房间调用 roomGet。
 *
 * 同一房间若存在多个对端（遗留数据），调用方保持“按 room_id 首次命中”的原有
 * 语义；这里仍按 room_id、actor_id 排序，保证结果稳定。
 */
export async function listActiveRoomPeers(
  db: D1Like,
  roomIds: string[],
  viewerId: string,
): Promise<RoomPeerRow[]> {
  if (roomIds.length === 0) return [];
  const query = orm(db)
    .select({
      room_id: schema.roomMembers.room_id,
      actor_id: schema.actors.actor_id,
      name: schema.actors.name,
      kind: schema.actors.kind,
    })
    .from(schema.roomMembers)
    .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomMembers.actor_id))
    .where(
      and(
        inArray(schema.roomMembers.room_id, roomIds),
        eq(schema.roomMembers.status, 'active'),
        ne(schema.roomMembers.actor_id, viewerId),
      ),
    )
    .orderBy(schema.roomMembers.room_id, schema.actors.actor_id);
  const result = await toD1(db, query).all<RoomPeerRow>();
  return result.results;
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
  const query = orm(db)
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.token_hash, tokenHash));
  return toD1(db, query).first<import('./rows').CredentialRow>();
}

export async function activeRoomCount(db: D1Like, actorId: string): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.actor_id, actorId),
        eq(schema.roomMembers.status, 'active'),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
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

// ---------------------------------------------------------------------------
// 4C-6 Memory 只读查询
//
// 只迁移单表、等值/排序/分页语义明确的 SELECT；作业/租约、治理命令流、
// 复杂聚合（proof rank）、依赖递归与 `INSERT ... SELECT` 写路径继续 raw。
// 返回行类型由 schema 推导，列顺序与迁移 SQL 的物理列顺序一致。
// ---------------------------------------------------------------------------

type MemoryInstanceLookup = {
  instance_id: string;
  capture_default: 'enabled' | 'disabled';
};
type MemorySourceRecord = MemorySourceRow;
type MemoryRepresentationRecord = MemoryRepresentationRow;
type MemoryExperienceRecord = MemoryExperienceRow;
type MemoryContextRecord = MemoryContextRow;
type MemoryManifestRecord = MemoryManifestRow;
type MemorySelectionRecord = MemorySelectionRow;
type MemoryReceiptRecord = MemoryReceiptRow;
type MemoryHostBindingRecord = MemoryHostBindingRow;
type MemoryCatchupPlanRecord = MemoryCatchupPlanRow;
type MemoryCatchupItemRecord = MemoryCatchupItemRow;
type MemoryRecallRequestRecord = MemoryRecallRequestRow;

export type MemoryTombstoneTargetKind =
  (typeof schema.memoryTombstones.target_kind.enumValues)[number];

/** 部署稳定 instance；`memory_instances` 至多一行。 */
export async function getMemoryInstance(
  db: D1Like,
): Promise<MemoryInstanceLookup | null> {
  const query = orm(db)
    .select({
      instance_id: schema.memoryInstances.instance_id,
      capture_default: schema.memoryInstances.capture_default,
    })
    .from(schema.memoryInstances)
    .limit(1);
  return toD1(db, query).first<MemoryInstanceLookup>();
}

export async function getActiveMemorySpace(
  db: D1Like,
  agentId: string,
): Promise<MemorySpaceRow | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySpaces)
    .where(
      and(
        eq(schema.memorySpaces.agent_actor_id, agentId),
        eq(schema.memorySpaces.active, 1),
      ),
    );
  return toD1(db, query).first<MemorySpaceRow>();
}

export async function memorySpaceExists(db: D1Like, spaceId: string): Promise<boolean> {
  const query = orm(db)
    .select({ space_id: schema.memorySpaces.space_id })
    .from(schema.memorySpaces)
    .where(eq(schema.memorySpaces.space_id, spaceId))
    .limit(1);
  return (await toD1(db, query).first<{ space_id: string }>()) !== null;
}

export async function getMemorySpaceById(
  db: D1Like,
  spaceId: string,
): Promise<MemorySpaceRow | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySpaces)
    .where(eq(schema.memorySpaces.space_id, spaceId));
  return toD1(db, query).first<MemorySpaceRow>();
}

export async function isMemoryTombstonedBySourceKey(
  db: D1Like,
  sourceKey: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
    .from(schema.memoryTombstones)
    .where(
      and(
        eq(schema.memoryTombstones.source_key, sourceKey),
        inArray(schema.memoryTombstones.target_kind, ['source_key', 'source']),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ tombstone_id: string }>()) !== null;
}

export async function isMemoryTargetTombstoned(
  db: D1Like,
  kind: MemoryTombstoneTargetKind,
  targetId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
    .from(schema.memoryTombstones)
    .where(
      and(
        eq(schema.memoryTombstones.target_kind, kind),
        eq(schema.memoryTombstones.target_id, targetId),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ tombstone_id: string }>()) !== null;
}

export async function getMemorySourceRevision(
  db: D1Like,
  sourceId: string,
  revision: number,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(
      and(
        eq(schema.memorySources.source_id, sourceId),
        eq(schema.memorySources.revision, revision),
      ),
    );
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getLatestMemorySource(
  db: D1Like,
  sourceId: string,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(eq(schema.memorySources.source_id, sourceId))
    .orderBy(desc(schema.memorySources.revision))
    .limit(1);
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getActiveMemorySourceByKey(
  db: D1Like,
  instanceId: string,
  sourceKey: string,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(
      and(
        eq(schema.memorySources.instance_id, instanceId),
        eq(schema.memorySources.source_key, sourceKey),
        eq(schema.memorySources.state, 'active'),
      ),
    )
    .limit(1);
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getMemoryRepresentation(
  db: D1Like,
  representationId: string,
): Promise<MemoryRepresentationRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRepresentations)
    .where(eq(schema.memoryRepresentations.representation_id, representationId));
  return toD1(db, query).first<MemoryRepresentationRecord>();
}

export async function getMemoryRepresentationSourceId(
  db: D1Like,
  representationId: string,
): Promise<{ source_id: string | null } | null> {
  const query = orm(db)
    .select({ source_id: schema.memoryRepresentations.source_id })
    .from(schema.memoryRepresentations)
    .where(eq(schema.memoryRepresentations.representation_id, representationId));
  return toD1(db, query).first<{ source_id: string | null }>();
}

export async function listMemoryRepresentationDependencyLinks(
  db: D1Like,
  representationId: string,
): Promise<{ source_id: string; depends_on_representation_id: string | null }[]> {
  const query = orm(db)
    .select({
      source_id: schema.memoryRepresentationDependencies.source_id,
      depends_on_representation_id:
        schema.memoryRepresentationDependencies.depends_on_representation_id,
    })
    .from(schema.memoryRepresentationDependencies)
    .where(
      eq(
        schema.memoryRepresentationDependencies.representation_id,
        representationId,
      ),
    );
  const result = await toD1(db, query).all<{
    source_id: string;
    depends_on_representation_id: string | null;
  }>();
  return result.results;
}

export async function listMemoryRepresentationDependencies(
  db: D1Like,
  representationId: string,
): Promise<MemoryRepresentationDependencyRow[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryRepresentationDependencies)
    .where(
      eq(
        schema.memoryRepresentationDependencies.representation_id,
        representationId,
      ),
    )
    .orderBy(schema.memoryRepresentationDependencies.dependency_index);
  const result = await toD1(db, query).all<MemoryRepresentationDependencyRow>();
  return result.results;
}

export async function getMemoryExperience(
  db: D1Like,
  experienceId: string,
): Promise<MemoryExperienceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryExperiences)
    .where(eq(schema.memoryExperiences.experience_id, experienceId));
  return toD1(db, query).first<MemoryExperienceRecord>();
}

export async function getMemoryExperienceByDedupe(
  db: D1Like,
  dedupeKey: string,
): Promise<{ experience_id: string } | null> {
  const query = orm(db)
    .select({ experience_id: schema.memoryExperiences.experience_id })
    .from(schema.memoryExperiences)
    .where(eq(schema.memoryExperiences.dedupe_key, dedupeKey));
  return toD1(db, query).first<{ experience_id: string }>();
}

export async function getMemoryContext(
  db: D1Like,
  contextId: string,
): Promise<MemoryContextRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryContexts)
    .where(eq(schema.memoryContexts.context_id, contextId));
  return toD1(db, query).first<MemoryContextRecord>();
}

export async function listMemoryContextItems(
  db: D1Like,
  contextId: string,
): Promise<{ representation_id: string; evidence: string | null; origin_scope_json: string }[]> {
  const query = orm(db)
    .select({
      representation_id: schema.memoryContextItems.representation_id,
      evidence: schema.memoryContextItems.evidence,
      origin_scope_json: schema.memoryContextItems.origin_scope_json,
    })
    .from(schema.memoryContextItems)
    .where(eq(schema.memoryContextItems.context_id, contextId))
    .orderBy(schema.memoryContextItems.item_index);
  const result = await toD1(db, query).all<{
    representation_id: string;
    evidence: string | null;
    origin_scope_json: string;
  }>();
  return result.results;
}

export interface MemoryContextPageQuery {
  spaceId: string;
  ownershipEpoch: number;
  agentId: string;
  kind?: 'lookup' | 'bound' | null;
  cursor?: { seq: number; key: string } | null;
  limit: number;
}

export interface MemoryContextSummaryRow {
  context_id: string;
  recall_id: string | null;
  kind: 'lookup' | 'bound';
  body_sha256: string;
  body_bytes: number;
  status: 'ready' | 'invalidated' | 'expired' | 'purged';
  created_at: number;
  expires_at: number | null;
}

export async function listMemoryContextSummaries(
  db: D1Like,
  input: MemoryContextPageQuery,
): Promise<MemoryContextSummaryRow[]> {
  const conditions = [
    eq(schema.memoryContexts.space_id, input.spaceId),
    eq(schema.memoryContexts.ownership_epoch, input.ownershipEpoch),
    eq(schema.memoryContexts.agent_actor_id, input.agentId),
  ];
  if (input.kind) conditions.push(eq(schema.memoryContexts.kind, input.kind));
  if (input.cursor) {
    conditions.push(
      or(
        lt(schema.memoryContexts.created_at, input.cursor.seq),
        and(
          eq(schema.memoryContexts.created_at, input.cursor.seq),
          lt(schema.memoryContexts.context_id, input.cursor.key),
        ),
      )!,
    );
  }
  const query = orm(db)
    .select({
      context_id: schema.memoryContexts.context_id,
      recall_id: schema.memoryContexts.recall_id,
      kind: schema.memoryContexts.kind,
      body_sha256: schema.memoryContexts.body_sha256,
      body_bytes: schema.memoryContexts.body_bytes,
      status: schema.memoryContexts.status,
      created_at: schema.memoryContexts.created_at,
      expires_at: schema.memoryContexts.expires_at,
    })
    .from(schema.memoryContexts)
    .where(and(...conditions))
    .orderBy(desc(schema.memoryContexts.created_at), desc(schema.memoryContexts.context_id))
    .limit(input.limit);
  const result = await toD1(db, query).all<MemoryContextSummaryRow>();
  return result.results;
}

export async function getMemoryManifest(
  db: D1Like,
  manifestId: string,
): Promise<MemoryManifestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifests)
    .where(eq(schema.memoryManifests.manifest_id, manifestId));
  return toD1(db, query).first<MemoryManifestRecord>();
}

export async function getMemoryManifestByInvocation(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    hostBindingId: string;
    invocationId: string;
  },
): Promise<MemoryManifestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifests)
    .where(
      and(
        eq(schema.memoryManifests.space_id, input.spaceId),
        eq(schema.memoryManifests.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryManifests.agent_actor_id, input.agentId),
        eq(schema.memoryManifests.host_binding_id, input.hostBindingId),
        eq(schema.memoryManifests.invocation_id, input.invocationId),
      ),
    );
  return toD1(db, query).first<MemoryManifestRecord>();
}

export async function listMemoryManifestItems(
  db: D1Like,
  manifestId: string,
): Promise<MemoryManifestItemRow[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifestItems)
    .where(eq(schema.memoryManifestItems.manifest_id, manifestId))
    .orderBy(schema.memoryManifestItems.item_index);
  const result = await toD1(db, query).all<MemoryManifestItemRow>();
  return result.results;
}

export async function getMemorySelection(
  db: D1Like,
  selectionId: string,
): Promise<MemorySelectionRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySelections)
    .where(eq(schema.memorySelections.selection_id, selectionId));
  return toD1(db, query).first<MemorySelectionRecord>();
}

export async function getMemoryReceiptByIdempotencyKey(
  db: D1Like,
  idempotencyKey: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(eq(schema.memoryReceipts.idempotency_key, idempotencyKey));
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function getMemoryReceipt(
  db: D1Like,
  receiptId: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(eq(schema.memoryReceipts.receipt_id, receiptId));
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function getMemoryReceiptByInvocation(
  db: D1Like,
  input: {
    kind: 'input_exposure' | 'context_delivery';
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    hostBindingId: string;
    invocationId: string;
  },
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, input.kind),
        eq(schema.memoryReceipts.space_id, input.spaceId),
        eq(schema.memoryReceipts.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryReceipts.agent_actor_id, input.agentId),
        eq(schema.memoryReceipts.host_binding_id, input.hostBindingId),
        eq(schema.memoryReceipts.invocation_id, input.invocationId),
      ),
    );
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function hasMemoryReceiptForManifest(
  db: D1Like,
  manifestId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ receipt_id: schema.memoryReceipts.receipt_id })
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, 'input_exposure'),
        eq(schema.memoryReceipts.manifest_id, manifestId),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ receipt_id: string }>()) !== null;
}

export async function getLatestMemoryReceiptForManifest(
  db: D1Like,
  manifestId: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, 'input_exposure'),
        eq(schema.memoryReceipts.manifest_id, manifestId),
      ),
    )
    .orderBy(desc(schema.memoryReceipts.recorded_at))
    .limit(1);
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function hasMemoryGatewayProof(
  db: D1Like,
  manifestId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ proof_id: schema.memoryExperienceProofs.proof_id })
    .from(schema.memoryExperienceProofs)
    .where(
      and(
        eq(schema.memoryExperienceProofs.manifest_id, manifestId),
        eq(schema.memoryExperienceProofs.evidence, 'gateway_observed_submitted'),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ proof_id: string }>()) !== null;
}

export async function getMemoryHostBinding(
  db: D1Like,
  bindingId: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(eq(schema.memoryHostBindings.binding_id, bindingId));
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function getActiveMemoryHostBindingBySession(
  db: D1Like,
  spaceId: string,
  sessionIncarnation: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.session_incarnation, sessionIncarnation),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function getLatestActiveMemoryHostBinding(
  db: D1Like,
  spaceId: string,
  agentId: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.agent_actor_id, agentId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    )
    .orderBy(desc(schema.memoryHostBindings.created_at))
    .limit(1);
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function listActiveMemoryHostBindingIds(
  db: D1Like,
  agentId: string,
): Promise<{ binding_id: string }[]> {
  const query = orm(db)
    .select({ binding_id: schema.memoryHostBindings.binding_id })
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.agent_actor_id, agentId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  const result = await toD1(db, query).all<{ binding_id: string }>();
  return result.results;
}

export async function countActiveMemoryHostBindings(
  db: D1Like,
  spaceId: string,
): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getCurrentCuratedRevision(
  db: D1Like,
  curatedId: string,
): Promise<{ revision: number } | null> {
  const query = orm(db)
    .select({ revision: schema.memoryCurated.revision })
    .from(schema.memoryCurated)
    .where(
      and(
        eq(schema.memoryCurated.curated_id, curatedId),
        eq(schema.memoryCurated.current, 1),
      ),
    );
  return toD1(db, query).first<{ revision: number }>();
}

export interface MemoryCuratedListRow {
  curated_id: string;
  revision: number;
  title: string;
  content: string;
  content_sha256: string;
  origin: 'manual' | 'imported_external_knowledge';
  created_at: number;
  updated_at: number;
}

export async function listCurrentCuratedMemories(
  db: D1Like,
  spaceId: string,
  ownershipEpoch: number,
  limit?: number,
): Promise<MemoryCuratedListRow[]> {
  const base = orm(db)
    .select({
      curated_id: schema.memoryCurated.curated_id,
      revision: schema.memoryCurated.revision,
      title: schema.memoryCurated.title,
      content: schema.memoryCurated.content,
      content_sha256: schema.memoryCurated.content_sha256,
      origin: schema.memoryCurated.origin,
      created_at: schema.memoryCurated.created_at,
      updated_at: schema.memoryCurated.updated_at,
    })
    .from(schema.memoryCurated)
    .where(
      and(
        eq(schema.memoryCurated.space_id, spaceId),
        eq(schema.memoryCurated.ownership_epoch, ownershipEpoch),
        eq(schema.memoryCurated.current, 1),
      ),
    );
  const query =
    limit === undefined
      ? base.orderBy(desc(schema.memoryCurated.updated_at))
      : base
          .orderBy(desc(schema.memoryCurated.updated_at), schema.memoryCurated.curated_id)
          .limit(limit);
  const result = await toD1(db, query).all<MemoryCuratedListRow>();
  return result.results;
}

export async function getMemoryCatchupPlan(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupPlanRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupPlans)
    .where(eq(schema.memoryCatchupPlans.plan_id, planId));
  return toD1(db, query).first<MemoryCatchupPlanRecord>();
}

export async function getMemoryCatchupPlanByRequestKey(
  db: D1Like,
  spaceId: string,
  agentId: string,
  requestKey: string,
): Promise<MemoryCatchupPlanRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupPlans)
    .where(
      and(
        eq(schema.memoryCatchupPlans.space_id, spaceId),
        eq(schema.memoryCatchupPlans.agent_actor_id, agentId),
        eq(schema.memoryCatchupPlans.request_key, requestKey),
      ),
    );
  return toD1(db, query).first<MemoryCatchupPlanRecord>();
}

export async function listMemoryCatchupItems(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupItemRecord[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupItems)
    .where(eq(schema.memoryCatchupItems.plan_id, planId))
    .orderBy(schema.memoryCatchupItems.item_index);
  const result = await toD1(db, query).all<MemoryCatchupItemRecord>();
  return result.results;
}

export async function getMemoryRecallRequest(
  db: D1Like,
  recallId: string,
): Promise<MemoryRecallRequestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRecallRequests)
    .where(eq(schema.memoryRecallRequests.recall_id, recallId));
  return toD1(db, query).first<MemoryRecallRequestRecord>();
}

export async function getMemoryRecallRequestByKey(
  db: D1Like,
  spaceId: string,
  requestKey: string,
): Promise<MemoryRecallRequestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRecallRequests)
    .where(
      and(
        eq(schema.memoryRecallRequests.space_id, spaceId),
        eq(schema.memoryRecallRequests.request_key, requestKey),
      ),
    );
  return toD1(db, query).first<MemoryRecallRequestRecord>();
}

export interface MemoryRecallCandidateRow {
  experience_id: string;
  origin_room_id: string | null;
  origin_member_generation: number;
  representation_id: string;
  evidence: string | null;
  created_at: number;
}

export async function listMemoryRecallCandidates(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    limit: number;
  },
): Promise<MemoryRecallCandidateRow[]> {
  const query = orm(db)
    .select({
      experience_id: schema.memoryExperiences.experience_id,
      origin_room_id: schema.memoryExperiences.origin_room_id,
      origin_member_generation: schema.memoryExperiences.origin_member_generation,
      representation_id: schema.memoryExperiences.representation_id,
      evidence: schema.memoryExperiences.evidence,
      created_at: schema.memoryExperiences.created_at,
    })
    .from(schema.memoryExperiences)
    .where(
      and(
        eq(schema.memoryExperiences.space_id, input.spaceId),
        eq(schema.memoryExperiences.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryExperiences.agent_actor_id, input.agentId),
        eq(schema.memoryExperiences.available, 1),
        eq(schema.memoryExperiences.origin_kind, 'experienced'),
      ),
    )
    .orderBy(desc(schema.memoryExperiences.created_at))
    .limit(input.limit);
  const result = await toD1(db, query).all<MemoryRecallCandidateRow>();
  return result.results;
}

export interface MemoryCoverageRangeRow {
  source_id: string;
  source_revision: number;
  range_start: number;
  range_end: number;
  text_sha256: string;
}

export async function listMemoryCoverageRanges(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    roomId: string;
    memberGeneration: number;
    sourceId?: string | null;
    sourceRevision?: number | null;
  },
): Promise<MemoryCoverageRangeRow[]> {
  const conditions = [
    eq(schema.memoryCoverageRanges.space_id, input.spaceId),
    eq(schema.memoryCoverageRanges.ownership_epoch, input.ownershipEpoch),
    eq(schema.memoryCoverageRanges.agent_actor_id, input.agentId),
    eq(schema.memoryCoverageRanges.origin_room_id, input.roomId),
    eq(schema.memoryCoverageRanges.origin_member_generation, input.memberGeneration),
  ];
  if (input.sourceId) {
    conditions.push(eq(schema.memoryCoverageRanges.source_id, input.sourceId));
  }
  if (input.sourceRevision !== null && input.sourceRevision !== undefined) {
    conditions.push(eq(schema.memoryCoverageRanges.source_revision, input.sourceRevision));
  }
  const query = orm(db)
    .select({
      source_id: schema.memoryCoverageRanges.source_id,
      source_revision: schema.memoryCoverageRanges.source_revision,
      range_start: schema.memoryCoverageRanges.range_start,
      range_end: schema.memoryCoverageRanges.range_end,
      text_sha256: schema.memoryCoverageRanges.text_sha256,
    })
    .from(schema.memoryCoverageRanges)
    .where(and(...conditions))
    .orderBy(
      schema.memoryCoverageRanges.source_id,
      schema.memoryCoverageRanges.source_revision,
      schema.memoryCoverageRanges.range_start,
      schema.memoryCoverageRanges.range_end,
    );
  const result = await toD1(db, query).all<MemoryCoverageRangeRow>();
  return result.results;
}
