/**
 * 回填的原子批语句。
 *
 * 每条语句都以 NOT EXISTS 条件插入；`operations` 行仍是整批所有权。回填不写
 * experiences/coverage，也不制造 events、outbox、pending_count 或 unread。
 */
import type { D1Like } from '../storage/queries';
import type { MemorySourceRow } from './rows';

export const BACKFILL_EVIDENCE = 'gateway_observed_room_history';
export const BACKFILL_ACTOR_ID = 'memory-backfill';

export function backfillSourceKey(messageId: string): string {
  return `message:${messageId}`;
}

export function backfillOperationKey(spaceId: string, messageId: string): string {
  return `backfill:${spaceId}:${messageId}:1`;
}

export function backfillReceiptIdempotencyKey(spaceId: string, messageId: string): string {
  return `memory_backfill:${spaceId}:${messageId}`;
}

/** 读取任意状态的消息来源；已 retracted/superseded 的来源不能被回填复活。 */
export async function loadBackfillMessageSource(
  db: D1Like,
  input: { instanceId: string; messageId: string },
): Promise<MemorySourceRow | null> {
  return db
    .prepare(
      `SELECT * FROM memory_sources
        WHERE instance_id = ? AND source_key = ? AND revision = 1`,
    )
    .bind(input.instanceId, backfillSourceKey(input.messageId))
    .first<MemorySourceRow>();
}

/** 同一来源修订已有逐字表示时复用，避免同一消息出现多份正文。 */
export async function findReusableRepresentationId(
  db: D1Like,
  input: { sourceId: string; sourceRevision: number; textSha256: string },
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT representation_id FROM memory_representations
        WHERE source_id = ? AND source_revision = ? AND text_sha256 = ? AND verbatim = 1
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(input.sourceId, input.sourceRevision, input.textSha256)
    .first<{ representation_id: string }>();
  return row?.representation_id ?? null;
}

export async function hasBackfillIntent(
  db: D1Like,
  input: { spaceId: string; operationKey: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT 1 AS yes FROM memory_retain_intents WHERE space_id = ? AND operation_key = ?',
    )
    .bind(input.spaceId, input.operationKey)
    .first<{ yes: number }>();
  return row !== null;
}

/**
 * 每个 (space, message) 一条 input_exposure 回执。
 *
 * `memory_retain_intents.evidence` 的 CHECK 只允许两种提交证据，因此意图证据留
 * NULL；真正的证据写在这里，由 `buildRetainRequest` 从 receipt 读取。回执只在
 * 同 operation_key 的意图尚不存在时插入，重跑不产生孤儿回执。
 */
export function backfillReceiptStatement(
  db: D1Like,
  input: {
    receiptId: string;
    proofId: string;
    spaceId: string;
    ownershipEpoch: number;
    agentActorId: string;
    messageId: string;
    operationKey: string;
    targetScopeJson: string;
    originScopesJson: string;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_receipts
         (receipt_id, kind, space_id, ownership_epoch, agent_actor_id,
          host_binding_id, host_generation, session_incarnation, run_id, input_id,
          input_revision, invocation_id, manifest_id, manifest_sha256, payload_sha256,
          context_id, context_sha256, target_scope_json, origin_scopes_json,
          evidence, proof_id, idempotency_key, disposition, reason, recorded_at, created_at)
       SELECT ?, 'input_exposure', ?, ?, ?,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              ?, ?, ?, ?, ?, 'applied', NULL, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_retain_intents WHERE space_id = ? AND operation_key = ?
        )`,
    )
    .bind(
      input.receiptId,
      input.spaceId,
      input.ownershipEpoch,
      input.agentActorId,
      input.targetScopeJson,
      input.originScopesJson,
      BACKFILL_EVIDENCE,
      input.proofId,
      backfillReceiptIdempotencyKey(input.spaceId, input.messageId),
      input.now,
      input.now,
      input.spaceId,
      input.operationKey,
    );
}
