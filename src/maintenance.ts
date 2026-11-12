import { LIMITS } from './contracts/limits';
import { expireContactRequests } from './domain/contact-relations';
import { purgeFilePayloads } from './drive/service';
import { nowMs } from './storage/db';
import type { Env } from './env';

interface ExpiredScope {
  scope_kind: 'room' | 'inbox';
  scope_id: string;
  max_seq: number;
}

/**
 * 文件保留与 GC。
 *
 * 权威引用状态在 `file_references` / `artifacts` / `room_files.retained`：
 * 1. 只有无 active 引用、无 delivered 成果且未被 retained 的过期文件才软删；
 * 2. 软删后保留 `LIMITS.fileGcGraceMs` 再删除载荷，业务元数据永久保留；
 * 3. 删除载荷前再次检查引用，绑定/提交与 GC 由 SQLite 事务串行化，成果不会
 *    指向已清理字节。
 */
async function maintainFiles(env: Env, now: number): Promise<void> {
  const db = env.DB;

  // 引用全部释放后恢复普通 30 天 TTL；仍在保留中的文件保持 retained=1。
  await db
    .prepare(
      `UPDATE room_files
          SET retained = 0,
              expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END
        WHERE retained = 1 AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM file_references fr
                           WHERE fr.file_id = room_files.file_id AND fr.state = 'active')
          AND NOT EXISTS (SELECT 1 FROM artifacts a
                           WHERE a.file_id = room_files.file_id AND a.status = 'delivered')`,
    )
    .bind(now, now + LIMITS.roomFileTtlMs)
    .run();

  await db
    .prepare(
      `UPDATE drive_files
          SET retained = 0,
              expires_at = CASE
                WHEN expires_at IS NULL OR expires_at <= ? THEN ?
                ELSE expires_at END
        WHERE retained = 1 AND state != 'deleted'
          AND NOT EXISTS (SELECT 1 FROM file_references fr
                           WHERE fr.file_id = drive_files.file_id AND fr.state = 'active')
          AND NOT EXISTS (SELECT 1 FROM artifacts a
                           WHERE a.file_id = drive_files.file_id AND a.status = 'delivered')`,
    )
    .bind(now, now + LIMITS.roomFileTtlMs)
    .run();

  // 软删：先提交状态，保留元数据；载荷在宽限期后清理。
  await db
    .prepare(
      `UPDATE drive_files
          SET state = 'deleted', deleted_at = ?, deleted_by = 'retention', retained = 0
        WHERE file_id IN (
          SELECT df.file_id FROM drive_files df
           WHERE df.state IN ('draft', 'bound')
             AND df.expires_at IS NOT NULL AND df.expires_at < ?
             AND NOT EXISTS (SELECT 1 FROM file_references fr
                              WHERE fr.file_id = df.file_id AND fr.state = 'active')
             AND NOT EXISTS (SELECT 1 FROM artifacts a
                              WHERE a.file_id = df.file_id AND a.status = 'delivered')
             AND NOT EXISTS (SELECT 1 FROM room_files rf
                              WHERE rf.file_id = df.file_id
                                AND rf.retained = 1 AND rf.deleted_at IS NULL)
           LIMIT 100
        )`,
    )
    .bind(now, now)
    .run();

  // 宽限期后清理载荷；每次只取一批，失败留待下一轮重试。
  if (env.FILES) {
    const expired = await db
      .prepare(
        `SELECT file_id FROM drive_files
          WHERE state = 'deleted' AND purged_at IS NULL AND deleted_at < ?
          LIMIT 50`,
      )
      .bind(now - LIMITS.fileGcGraceMs)
      .all<{ file_id: string }>();
    for (const row of expired.results) {
      const active = await db
        .prepare(
          `SELECT 1 AS n FROM file_references
            WHERE file_id = ? AND state = 'active' LIMIT 1`,
        )
        .bind(row.file_id)
        .first<{ n: number }>();
      const delivered = await db
        .prepare(
          `SELECT 1 AS n FROM artifacts
            WHERE file_id = ? AND status = 'delivered' LIMIT 1`,
        )
        .bind(row.file_id)
        .first<{ n: number }>();
      if (active || delivered) continue;
      const complete = await purgeFilePayloads(env.FILES, row.file_id);
      if (!complete) continue;
      await db
        .prepare('UPDATE drive_files SET purged_at = ? WHERE file_id = ?')
        .bind(now, row.file_id)
        .run();
    }
  }

  // 最后清理房间文件墓碑的元数据；有效引用/成果仍在时永不删除，避免成果
  // 指向已不存在的房间文件行。顺序放在释放与载荷回收之后，GC 扫描不会
  // 与成果绑定产生“先删行、后绑定”的窗口。
  await db
    .prepare(
      `DELETE FROM room_files
        WHERE rowid IN (
          SELECT rf.rowid FROM room_files rf
           WHERE rf.retained = 0 AND rf.expires_at < ?
             AND NOT EXISTS (SELECT 1 FROM file_references fr
                              WHERE fr.file_id = rf.file_id AND fr.state = 'active')
             AND NOT EXISTS (SELECT 1 FROM artifacts a
                              WHERE a.file_id = rf.file_id AND a.status = 'delivered')
           LIMIT 100
        )`,
    )
    .bind(now - LIMITS.roomFileTombstoneGraceMs)
    .run();
}

/**
 * Memory 短期对象清理。
 *
 * 只清理未消费的 prepared selection、过期 catchup 计划与已完成作业的审计
 * 副本；`memory_sources`、`memory_receipts`、`memory_experiences`、
 * `memory_retain_intents` 与 `memory_tombstones` 不随通用 TTL 删除。
 */
async function maintainMemory(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM memory_selections
        WHERE state = 'available' AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .bind(now)
    .run();

  await db
    .prepare(
      `UPDATE memory_catchup_plans
          SET status = 'expired', updated_at = ?
        WHERE status IN ('ready', 'partial', 'missing_required')
          AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .bind(now, now)
    .run();

  // 租约到期的 host binding 只能重新绑定，不能继续签发新 Context。
  await db
    .prepare(
      `UPDATE memory_host_bindings
          SET state = 'expired', updated_at = ?
        WHERE state = 'active' AND lease_until IS NOT NULL AND lease_until < ?`,
    )
    .bind(now, now)
    .run();

  await db
    .prepare(
      `DELETE FROM memory_jobs
        WHERE rowid IN (
          SELECT j.rowid FROM memory_jobs j
           WHERE j.status IN ('completed', 'cancelled')
             AND j.updated_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM memory_retain_intents ri
                WHERE ri.job_id = j.job_id
                  AND ri.status IN ('pending', 'leased', 'unknown')
             )
           LIMIT 100
        )`,
    )
    .bind(now - LIMITS.memoryJobRetentionMs)
    .run();
}

/**
 * 分批清理 event / operations / outbox / recovery ticket。
 *
 * 删除 event 前先把对应 scope 的有效游标下界推进到本批最大 event_seq，
 * 使过期 cursor 明确返回 reset_required，而不是假装历史仍完整。
 */
export async function maintain(env: Env): Promise<void> {
  const db = env.DB;
  const now = nowMs();

  // Memory informational actor 事件只删除自身，不能推进 inbox_min_seq：
  // actor 游标是业务收件箱的下界，不是所有 actor scope 事件的统一游标。
  await db
    .prepare(
      `DELETE FROM events
        WHERE rowid IN (
          SELECT rowid FROM events
           WHERE scope_kind = 'actor' AND event_type LIKE 'memory.%' AND created_at < ?
           LIMIT 200
        )`,
    )
    .bind(now - LIMITS.eventsRetentionMs)
    .run();

  const scopes = await db
    .prepare(
      `SELECT scope_kind, scope_id, MAX(event_seq) AS max_seq
         FROM events
        WHERE created_at < ?
          AND NOT (scope_kind = 'actor' AND event_type LIKE 'memory.%')
        GROUP BY scope_kind, scope_id
        LIMIT 20`,
    )
    .bind(now - LIMITS.eventsRetentionMs)
    .all<ExpiredScope>();

  for (const scope of scopes.results) {
    if (scope.scope_kind === 'room') {
      await db
        .prepare('UPDATE rooms SET events_min_seq = MAX(events_min_seq, ?) WHERE room_id = ?')
        .bind(scope.max_seq, scope.scope_id)
        .run();
    } else {
      // 夹到 inbox_head_seq，避免 min > head 让尚未过期的业务游标被误判重置。
      await db
        .prepare(
          'UPDATE actors SET inbox_min_seq = MAX(inbox_min_seq, MIN(?, inbox_head_seq)) WHERE actor_id = ?',
        )
        .bind(scope.max_seq, scope.scope_id)
        .run();
    }
    await db
      .prepare('DELETE FROM events WHERE scope_kind = ? AND scope_id = ? AND created_at < ?')
      .bind(scope.scope_kind, scope.scope_id, now - LIMITS.eventsRetentionMs)
      .run();
  }

  await db
    .prepare(
      'DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations WHERE created_at < ? LIMIT 100)',
    )
    .bind(now - LIMITS.operationsRetentionMs)
    .run();

  await db
    .prepare(
      "DELETE FROM outbox WHERE rowid IN (SELECT rowid FROM outbox WHERE status = 'completed' AND completed_at < ? LIMIT 100)",
    )
    .bind(now - LIMITS.outboxRetentionMs)
    .run();

  await db
    .prepare(
      'DELETE FROM recovery_tickets WHERE rowid IN (SELECT rowid FROM recovery_tickets WHERE expires_at < ? LIMIT 100)',
    )
    .bind(now - 24 * 60 * 60_000)
    .run();

  // 房间文件墓碑与载荷由 maintainFiles 按引用状态统一回收。
  await maintainFiles(env, now);

  // Memory 短期准备包可清理；来源、回执、经历、tombstone 与未知作业不在此列。
  await maintainMemory(env.DB, now);

  // MCP Events：先停用过期订阅，再在宽限期后删除（级联清投递）。
  await db
    .prepare(
      'UPDATE mcp_event_subscriptions SET active = 0, updated_at = ? WHERE active = 1 AND refresh_before < ?',
    )
    .bind(now, now)
    .run();

  await db
    .prepare(
      `DELETE FROM mcp_event_subscriptions
        WHERE rowid IN (
          SELECT rowid FROM mcp_event_subscriptions
           WHERE refresh_before < ? LIMIT 100
        )`,
    )
    .bind(now - LIMITS.eventsSubscriptionGraceMs)
    .run();

  await db
    .prepare(
      `UPDATE mcp_event_subscriptions
          SET previous_secret_ciphertext = NULL,
              previous_secret_nonce = NULL,
              previous_secret_expires_at = NULL
        WHERE previous_secret_expires_at IS NOT NULL
          AND previous_secret_expires_at < ?`,
    )
    .bind(now)
    .run();

  await db
    .prepare(
      `DELETE FROM mcp_event_deliveries
        WHERE rowid IN (
          SELECT rowid FROM mcp_event_deliveries
           WHERE status IN ('delivered', 'abandoned')
             AND created_at < ?
           LIMIT 100
        )`,
    )
    .bind(now - LIMITS.eventsDeliveryRetentionMs)
    .run();

  await db
    .prepare(
      `DELETE FROM webhook_verifications
        WHERE rowid IN (
          SELECT rowid FROM webhook_verifications
           WHERE expires_at < ? LIMIT 100
        )`,
    )
    .bind(now)
    .run();

  // 好友申请到期只改变状态并写持久事件，不产生 delivery。
  await expireContactRequests(db, now);
}
