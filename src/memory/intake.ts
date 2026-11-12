/**
 * MF05：业务写入同批追加的 Memory 来源、控制记录与预热意图。
 *
 * 三条硬边界：
 * 1. 这里只生成纯 SQL 语句，调用方把语句追加到原业务 `db.batch()`；Memory
 *    本地写入失败时业务与来源一起回滚，外部引擎调用永远不在事务内。
 * 2. 消息、任务 offer、文件使用稳定业务 key；同一业务写入重放不会重复登记。
 * 3. 业务路径只创建 `warmup_only=1` 的 RecallRequest，不写经历、不写 retain
 *    资格；个人经历只能由合格 ExposureReceipt 路径接纳。
 *
 * `capture=false`（MEMORY_CAPTURE=0）时停止新增来源与预热，但撤回/删除屏障
 * 仍会执行，确保已存在的来源不会被后续读取重新放行。
 */
import { LIMITS } from '../contracts/limits';
import { newId } from '../storage/db';
import type { D1Like } from '../storage/queries';
import type { MemorySha256, MemorySourceKind } from './contracts';
import {
  memorySourceMutationStatements,
  tombstoneStatement,
  type MemorySourceMutationInput,
} from './statements';

export interface MemoryIntakeOptions {
  instanceId: string;
  /** MEMORY_CAPTURE 关闭时仍执行撤回/删除屏障，但不登记新来源、不产生预热。 */
  capture: boolean;
}

/** 从 Env 读取可选 Memory 运行时；未启用或尚未启动时返回 null。 */
export function memoryIntakeFromEnv(env: {
  MEMORY?: { instanceId: string | null; captureEnabled: boolean } | null;
}): MemoryIntakeOptions | null {
  const runtime = env.MEMORY;
  if (!runtime || !runtime.instanceId) return null;
  return { instanceId: runtime.instanceId, capture: runtime.captureEnabled };
}

/** 来源的 origin scope；成员代次/策略版本/历史边界都取写入时的同一快照。 */
export interface MemoryOriginInput {
  roomId: string;
  memberGeneration: number;
  policyRevision: number;
  joinedSeq: number;
  joinedAt: number;
  archiveHeadSeq: number | null;
}

export interface MemoryWarmupDelivery {
  deliveryId: string;
  recipientId: string;
}

export type MemoryRetractionReason =
  | 'recall'
  | 'forget'
  | 'permission'
  | 'file_deleted'
  | 'transfer'
  | 'policy';

export function memoryMessageSourceKey(messageId: string): string {
  return `message:${messageId}`;
}

export function memoryTaskOfferSourceKey(messageId: string): string {
  return `task_offer:${messageId}`;
}

export function memoryFileSourceKey(fileId: string): string {
  return `file:${fileId}`;
}

/** 消息/任务/文件共用的来源插入；调用方保证 revision 由业务身份决定。 */
function sourceStatements(
  db: D1Like,
  options: { instanceId: string; now: number },
  input: {
    sourceKey: string;
    sourceKind: MemorySourceKind;
    businessRefKind: string;
    businessRefJson: string;
    origin: MemoryOriginInput;
    authorActorId: string | null;
    revision: number;
    originSeq: number | null;
    contentText: string | null;
    contentSha256: MemorySha256 | null;
    contentBytes: number;
  },
): D1PreparedStatement[] {
  const mutation: MemorySourceMutationInput = {
    instanceId: options.instanceId,
    sourceId: newId('msrc'),
    sourceKey: input.sourceKey,
    sourceKind: input.sourceKind,
    businessRefKind: input.businessRefKind,
    businessRefJson: input.businessRefJson,
    originRoomId: input.origin.roomId,
    originMemberGeneration: input.origin.memberGeneration,
    originPolicyRevision: input.origin.policyRevision,
    originJoinedSeq: input.origin.joinedSeq,
    originJoinedAt: input.origin.joinedAt,
    originArchiveHeadSeq: input.origin.archiveHeadSeq,
    originSeq: input.originSeq,
    originCreatedAt: options.now,
    authorActorId: input.authorActorId,
    revision: input.revision,
    contentText: input.contentText,
    contentSha256: input.contentSha256,
    contentBytes: input.contentBytes,
    now: options.now,
  };
  return memorySourceMutationStatements(db, mutation);
}

/**
 * 事件序号在业务 INSERT 之后才可用；同一 batch 内用子查询补齐。
 *
 * `businessRefHasCreatedSeq` 只用于消息来源：business_ref 需要与
 * `origin_seq` 一起暴露 `created_seq`，文件引用则只保存 file_id + sha256。
 */
function eventSeqUpdateStatements(
  db: D1Like,
  input: {
    instanceId: string;
    sourceKey: string;
    revision: number;
    eventKey: string;
    now: number;
    businessRefHasCreatedSeq: boolean;
  },
): D1PreparedStatement[] {
  const businessRef = input.businessRefHasCreatedSeq
    ? `business_ref_json = CASE
         WHEN json_extract(business_ref_json, '$.created_seq') IS NULL
           THEN json_set(business_ref_json, '$.created_seq',
                         (SELECT event_seq FROM events WHERE event_key = ?))
         ELSE business_ref_json
       END,`
    : '';
  const binds = input.businessRefHasCreatedSeq
    ? [input.eventKey]
    : [];
  return [
    db
      .prepare(
        `UPDATE memory_sources
            SET origin_seq = COALESCE(origin_seq,
                  (SELECT event_seq FROM events WHERE event_key = ?)),
                ${businessRef}
                updated_at = ?
          WHERE instance_id = ? AND source_key = ? AND revision = ?`,
      )
      .bind(
        input.eventKey,
        ...binds,
        input.now,
        input.instanceId,
        input.sourceKey,
        input.revision,
      ),
  ];
}

export interface MemoryMessageSourceInput {
  messageId: string;
  /** 已知 created_seq 时直接写入；新消息在 batch 内由 eventKey 子查询补齐。 */
  createdSeq?: number | null;
  /** 消息事件 key；事件已在本 batch 更早写入时用于补 created_seq。 */
  eventKey: string;
  senderId: string;
  body: string;
  bodyBytes: number;
  digest: MemorySha256 | null;
  createdAt: number;
  origin: MemoryOriginInput;
}

function messageSourceStatements(
  db: D1Like,
  options: MemoryIntakeOptions & { now: number },
  input: MemoryMessageSourceInput,
): D1PreparedStatement[] {
  const sourceKey = memoryMessageSourceKey(input.messageId);
  const createdSeq = input.createdSeq ?? null;
  const statements = sourceStatements(db, { instanceId: options.instanceId, now: input.createdAt }, {
    sourceKey,
    sourceKind: 'message',
    businessRefKind: 'message',
    businessRefJson: JSON.stringify({
      message_id: input.messageId,
      ...(createdSeq === null ? {} : { created_seq: createdSeq }),
    }),
    origin: input.origin,
    authorActorId: input.senderId,
    revision: 1,
    originSeq: createdSeq,
    contentText: input.body.length > 0 ? input.body : null,
    contentSha256: input.digest,
    contentBytes: input.bodyBytes,
  });
  if (createdSeq === null) {
    statements.push(
      ...eventSeqUpdateStatements(db, {
        instanceId: options.instanceId,
        sourceKey,
        revision: 1,
        eventKey: input.eventKey,
        now: input.createdAt,
        businessRefHasCreatedSeq: true,
      }),
    );
  }
  return statements;
}

/**
 * 真实 message delivery 的预热；只写 RecallRequest，不产生个人经历或 retain。
 *
 * requestKey 由业务身份决定；同一消息的重放/任务补登记不会重复准备。
 */
export function memoryWarmupStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: {
    messageId: string;
    roomId: string;
    eventKey: string;
    requestKey: string;
    mode: 'related' | 'task';
    taskRootId: string | null;
    deliveries: readonly MemoryWarmupDelivery[];
    now: number;
  },
): D1PreparedStatement[] {
  if (!options.capture || input.deliveries.length === 0) return [];
  const expiresAt = input.now + LIMITS.memoryPreparedTtlMs;
  return input.deliveries.map((delivery) =>
    db
      .prepare(
        `INSERT INTO memory_recall_requests
           (recall_id, space_id, ownership_epoch, agent_actor_id, request_key, mode,
            dispatch, status, target_json, warmup_only, created_at, updated_at, expires_at)
         SELECT ?, s.space_id, s.ownership_epoch, s.agent_actor_id, ?, ?, 'auto', 'pending',
                json_object(
                  'kind', 'message',
                  'message', json_object(
                    'room_id', ?,
                    'message_id', ?,
                    'created_seq', (SELECT event_seq FROM events WHERE event_key = ?),
                    'delivery_id', ?,
                    'recipient_id', ?
                  ),
                  'task_root_id', ?
                ),
                1, ?, ?, ?
           FROM memory_spaces s
           JOIN memory_instances mi ON mi.instance_id = s.instance_id
          WHERE s.agent_actor_id = ?
            AND s.instance_id = ?
            AND s.active = 1
            AND s.capture IN ('pending', 'extracted')
            AND mi.capture_default = 'enabled'
            AND NOT EXISTS (
              SELECT 1 FROM memory_recall_requests r
               WHERE r.space_id = s.space_id AND r.request_key = ?
            )`,
      )
      .bind(
        newId('mrc'),
        input.requestKey,
        input.mode,
        input.roomId,
        input.messageId,
        input.eventKey,
        delivery.deliveryId,
        delivery.recipientId,
        input.taskRootId,
        input.now,
        input.now,
        expiresAt,
        delivery.recipientId,
        options.instanceId,
        input.requestKey,
      ),
  );
}

/** 消息成功提交：共享来源 + 真实 delivery 的预热资格。 */
export function memoryMessageChangeStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: MemoryMessageSourceInput & {
    roomId: string;
    deliveries: readonly MemoryWarmupDelivery[];
    taskRootId: string | null;
    now: number;
  },
): D1PreparedStatement[] {
  if (!options.capture) return [];
  return [
    ...messageSourceStatements(db, { ...options, now: input.createdAt }, input),
    ...memoryWarmupStatements(db, options, {
      messageId: input.messageId,
      roomId: input.roomId,
      eventKey: input.eventKey,
      requestKey: `auto:message:${input.messageId}`,
      mode: 'related',
      taskRootId: input.taskRootId,
      deliveries: input.deliveries,
      now: input.now,
    }),
  ];
}

/**
 * 消息式 Task 起点：消息来源（缺失时补齐）+ task_offer 角色来源 + 任务预热。
 *
 * task_offer 与 message 共用正文与 digest，但使用独立 source_kind/business_ref，
 * 便于后续按任务角色取证；同一消息不会因此产生第二份经历或 retain。
 */
export function memoryTaskOfferChangeStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: MemoryMessageSourceInput & {
    roomId: string;
    deliveries: readonly MemoryWarmupDelivery[];
    now: number;
    taskRevision: number;
  },
): D1PreparedStatement[] {
  if (!options.capture) return [];
  const taskKey = memoryTaskOfferSourceKey(input.messageId);
  const origin = input.origin;
  const createdSeq = input.createdSeq ?? null;
  const statements = [
    ...messageSourceStatements(db, { ...options, now: input.createdAt }, input),
    ...sourceStatements(db, { instanceId: options.instanceId, now: input.createdAt }, {
      sourceKey: taskKey,
      sourceKind: 'task_offer',
      businessRefKind: 'task',
      businessRefJson: JSON.stringify({
        task_id: input.messageId,
        revision: input.taskRevision,
        message_id: input.messageId,
        created_seq: createdSeq,
      }),
      origin,
      authorActorId: input.senderId,
      revision: input.taskRevision,
      originSeq: createdSeq,
      // task_offer 是同一消息的角色来源，不复制正文；下游通过 message 来源
      // 与这里的 digest/created_seq 核对，避免同一段内容被重复提炼。
      contentText: null,
      contentSha256: input.digest,
      contentBytes: input.bodyBytes,
    }),
  ];
  if (createdSeq === null) {
    statements.push(
      ...eventSeqUpdateStatements(db, {
        instanceId: options.instanceId,
        sourceKey: taskKey,
        revision: input.taskRevision,
        eventKey: input.eventKey,
        now: input.createdAt,
        businessRefHasCreatedSeq: true,
      }),
    );
  }
  statements.push(
    ...memoryWarmupStatements(db, options, {
      messageId: input.messageId,
      roomId: input.roomId,
      eventKey: input.eventKey,
      requestKey: `auto:task_offer:${input.messageId}`,
      mode: 'task',
      taskRootId: input.messageId,
      deliveries: input.deliveries,
      now: input.now,
    }),
  );
  return statements;
}

/** 任务取消/重派：只让旧 task_offer 角色不可读，不写永久 tombstone。 */
export function memoryTaskOfferRetractionStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: { messageId: string; now: number },
): D1PreparedStatement[] {
  return memorySourceRetractionStatements(db, options, {
    sourceKey: memoryTaskOfferSourceKey(input.messageId),
    reason: 'policy',
    permanent: false,
    now: input.now,
  });
}

export interface MemoryFileSourceInput {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploaderId: string;
  eventKey: string;
  origin: MemoryOriginInput;
  now: number;
}

/** 文件绑定到房间：file_id + sha256 作为稳定来源，不保存会过期的下载票据。 */
export function memoryFileChangeStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: MemoryFileSourceInput,
): D1PreparedStatement[] {
  if (!options.capture) return [];
  const sourceKey = memoryFileSourceKey(input.fileId);
  const statements = sourceStatements(db, { instanceId: options.instanceId, now: input.now }, {
    sourceKey,
    sourceKind: 'file',
    businessRefKind: 'file',
    businessRefJson: JSON.stringify({
      file_id: input.fileId,
      sha256: input.sha256,
      name: input.name,
      mime_type: input.mimeType,
      size: input.size,
    }),
    origin: input.origin,
    authorActorId: input.uploaderId,
    revision: 1,
    originSeq: null,
    contentText: null,
    contentSha256: input.sha256,
    contentBytes: input.size,
  });
  statements.push(
    ...eventSeqUpdateStatements(db, {
      instanceId: options.instanceId,
      sourceKey,
      revision: 1,
      eventKey: input.eventKey,
      now: input.now,
      businessRefHasCreatedSeq: false,
    }),
  );
  return statements;
}

/**
 * 逻辑撤回/删除屏障。
 *
 * permanent=true 时同事务写永久 tombstone，已排除来源不能重新导入；任务取消
 * 使用 permanent=false，只让旧角色来源不可读，之后重新标记可生成新 revision。
 */
export function memorySourceRetractionStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: {
    sourceKey: string;
    reason: MemoryRetractionReason;
    permanent: boolean;
    now: number;
    tombstoneId?: string;
  },
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `UPDATE memory_sources
            SET state = 'retracted',
                retracted_at = COALESCE(retracted_at, ?),
                updated_at = ?
          WHERE instance_id = ? AND source_key = ? AND state <> 'retracted'`,
      )
      .bind(input.now, input.now, options.instanceId, input.sourceKey),
  ];
  if (input.permanent) {
    statements.push(
      tombstoneStatement(db, {
        tombstoneId: input.tombstoneId ?? newId('mtb'),
        instanceId: options.instanceId,
        targetKind: 'source_key',
        targetId: input.sourceKey,
        sourceKey: input.sourceKey,
        reason: input.reason,
        now: input.now,
      }),
    );
  }
  return statements;
}

/** 消息撤回：message 与 task_offer 两个角色来源同时建立永久排除。 */
export function memoryMessageRetractionStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: { messageId: string; now: number },
): D1PreparedStatement[] {
  return [
    ...memorySourceRetractionStatements(db, options, {
      sourceKey: memoryMessageSourceKey(input.messageId),
      reason: 'recall',
      permanent: true,
      now: input.now,
    }),
    ...memorySourceRetractionStatements(db, options, {
      sourceKey: memoryTaskOfferSourceKey(input.messageId),
      reason: 'recall',
      permanent: true,
      now: input.now,
    }),
  ];
}

export function memoryFileRetractionStatements(
  db: D1Like,
  options: MemoryIntakeOptions,
  input: { fileId: string; now: number },
): D1PreparedStatement[] {
  return memorySourceRetractionStatements(db, options, {
    sourceKey: memoryFileSourceKey(input.fileId),
    reason: 'file_deleted',
    permanent: true,
    now: input.now,
  });
}

/**
 * task_offer revision：
 * - 已有 active 来源时复用原 revision，重复标记不会制造新版本；
 * - 只有取消后重新标记才取 max+1，避免旧 revision 被覆盖读取。
 */
export async function nextTaskOfferRevision(
  db: D1Like,
  options: MemoryIntakeOptions,
  messageId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT revision, state
         FROM memory_sources
        WHERE instance_id = ? AND source_key = ?
        ORDER BY revision DESC
        LIMIT 1`,
    )
    .bind(options.instanceId, memoryTaskOfferSourceKey(messageId))
    .first<{ revision: number; state: string }>();
  if (!row) return 1;
  return row.state === 'active' ? row.revision : row.revision + 1;
}
