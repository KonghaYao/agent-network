/**
 * Task Focus 个人卡读取与归档。
 *
 * 列表只返回 owner 自己的卡，按 `updated_at DESC, item_id DESC` keyset 分页；
 * 游标绑定 owner、归档维度与筛选条件。所有读路径都按当前权限重算证据：
 * 任一证据失权即遮蔽卡面正文与来源计数，全部失权则整卡 NOT_FOUND。
 */

import { decodeCursor, encodeCursor } from '../../contracts/cursor';
import { BusinessError } from '../../contracts/errors';
import type {
  FocusArchiveResult,
  FocusGetResult,
  FocusListItem,
  FocusListResult,
  FocusRevisionView,
} from '../../contracts/focus';
import { clampPage, LIMITS } from '../../contracts/limits';
import { nowMs, sha256Hex, stableStringify } from '../../storage/db';
import { guardSql } from '../../storage/guards';
import { operationsStatement, runIdempotent } from '../../storage/transactions/runner';
import type { Principal } from '../principal';
import { evidenceView, resolveEvidenceReads } from './evidence';
import { escapeLike, focusListCursorScope, focusOwner, parseJson, timeText } from './helpers';
import { focusUpdatedStatements } from './notify';
import type { FocusEvidenceRow, FocusItemRow, FocusRevisionRow } from './types';

export interface FocusListInput {
  column?: 'needs_me' | 'tracking' | 'done';
  archived?: boolean;
  query?: string;
  cursor?: string;
  limit?: number;
}

function itemView(row: FocusItemRow, restricted: boolean, sourceCount: number): FocusListItem {
  return {
    item_id: row.item_id,
    // 失权时不返回依赖证据的卡面内容，也不泄露来源数量。
    title: restricted ? '' : row.title,
    column_key: row.column_key,
    next_step: restricted ? '' : row.next_step,
    waiting_on: restricted ? null : row.waiting_on,
    due_at: restricted ? null : timeText(row.due_at),
    due_text: restricted ? null : row.due_text,
    summary: restricted ? '' : row.summary,
    version: row.version,
    source_count: restricted ? 0 : sourceCount,
    restricted,
    archived_at: timeText(row.archived_at),
    updated_at: String(row.updated_at),
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

async function evidenceByItem(
  db: D1Database,
  owner: string,
  itemIds: string[],
): Promise<Map<string, { rows: FocusEvidenceRow[]; restricted: boolean; allUnreadable: boolean }>> {
  const result = new Map<
    string,
    { rows: FocusEvidenceRow[]; restricted: boolean; allUnreadable: boolean }
  >();
  if (itemIds.length === 0) return result;
  const rows = await db
    .prepare(
      `SELECT * FROM focus_evidence
        WHERE owner_actor_id = ? AND item_id IN (${placeholders(itemIds.length)})
        ORDER BY item_id, created_at, evidence_id`,
    )
    .bind(owner, ...itemIds)
    .all<FocusEvidenceRow>();
  const reads = await resolveEvidenceReads(db, owner, rows.results);
  for (const row of rows.results) {
    const entry = result.get(row.item_id) ?? { rows: [], restricted: false, allUnreadable: true };
    entry.rows.push(row);
    if (reads.get(row.evidence_id)?.readable !== true) entry.restricted = true;
    else entry.allUnreadable = false;
    result.set(row.item_id, entry);
  }
  return result;
}

async function listItems(
  db: D1Database,
  owner: string,
  input: FocusListInput,
): Promise<FocusListResult> {
  const archived = input.archived ?? false;
  const column = input.column ?? null;
  const query = input.query ?? null;
  const limit = clampPage(input.limit, LIMITS.focusListPageDefault, LIMITS.focusListPageMax);
  const scope = await focusListCursorScope(owner, archived, column, query);

  const filters = ['owner_actor_id = ?', archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const binds: Array<string | number> = [owner];
  if (column) {
    filters.push('column_key = ?');
    binds.push(column);
  }
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    // 除卡面文本外，也允许按「来源会话名」命中；只匹配 owner 仍是 active 成员、
    // 消息未撤回且落在当前历史边界内的来源，避免用搜索结果探测失权会话。
    filters.push(
      "(title LIKE ? ESCAPE '\\' OR next_step LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'" +
        ` OR EXISTS (
          SELECT 1
            FROM focus_evidence fe
            JOIN rooms r ON r.room_id = fe.room_id
            JOIN room_members rm
              ON rm.room_id = fe.room_id AND rm.actor_id = ? AND rm.status = 'active'
            JOIN messages m ON m.message_id = fe.message_id AND m.room_id = r.room_id
           WHERE fe.item_id = focus_items.item_id
             AND fe.owner_actor_id = ?
             AND m.body_bytes > 0
             AND (r.kind = 'direct' OR r.member_history_policy = 'full' OR m.created_seq >= rm.joined_seq)
             AND (r.dissolved_at IS NULL OR r.archive_head_seq IS NULL OR m.created_seq <= r.archive_head_seq)
             AND r.title LIKE ? ESCAPE '\\'
        ))`,
    );
    binds.push(pattern, pattern, pattern, owner, owner, pattern);
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, scope);
    filters.push('(updated_at < ? OR (updated_at = ? AND item_id < ?))');
    binds.push(cursor.seq, cursor.seq, cursor.key ?? '');
  }

  const rows = (
    await db
      .prepare(
        `SELECT * FROM focus_items
          WHERE ${filters.join(' AND ')}
          ORDER BY updated_at DESC, item_id DESC
          LIMIT ?`,
      )
      .bind(...binds, limit + 1)
      .all<FocusItemRow>()
  ).results;

  const page = rows.slice(0, limit);
  const evidence = await evidenceByItem(
    db,
    owner,
    page.map((row) => row.item_id),
  );
  const items = page
    // 无证据或证据全部失权的卡都不可见，不返回空壳。
    .filter((row) => {
      const entry = evidence.get(row.item_id);
      return entry !== undefined && !entry.allUnreadable;
    })
    .map((row) => {
      const entry = evidence.get(row.item_id);
      return itemView(row, entry?.restricted ?? false, entry?.rows.length ?? 0);
    });
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({
          v: 1,
          scope,
          dir: 'before',
          seq: last.updated_at,
          key: last.item_id,
          snapshot: 0,
        })
      : null;
  return { items, next_cursor: nextCursor };
}

async function findItem(
  db: D1Database,
  owner: string,
  itemId: string,
): Promise<FocusItemRow | null> {
  return db
    .prepare('SELECT * FROM focus_items WHERE item_id = ? AND owner_actor_id = ?')
    .bind(itemId, owner)
    .first<FocusItemRow>();
}

function revisionView(row: FocusRevisionRow): FocusRevisionView {
  return {
    revision_id: row.revision_id,
    version: row.version,
    reason: row.reason,
    changes: parseJson(row.changes_json, {}),
    evidence: parseJson(row.evidence_json, []),
    created_at: String(row.created_at),
  };
}

async function getItem(
  db: D1Database,
  owner: string,
  itemId: string,
): Promise<FocusGetResult> {
  const row = await findItem(db, owner, itemId);
  if (!row) throw new BusinessError('NOT_FOUND', '事项不存在或当前不可见');
  const evidence = await evidenceByItem(db, owner, [itemId]);
  const entry = evidence.get(itemId);
  if (!entry || entry.rows.length === 0 || entry.allUnreadable) {
    // 不泄露「存在但全部失权」与「不存在」的区别；无证据卡同样不可见。
    throw new BusinessError('NOT_FOUND', '事项不存在或当前不可见');
  }
  const reads = await resolveEvidenceReads(db, owner, entry.rows);
  const revisions = await db
    .prepare(
      `SELECT * FROM focus_revisions
        WHERE item_id = ? ORDER BY created_at, revision_id`,
    )
    .bind(itemId)
    .all<FocusRevisionRow>();
  return {
    item: itemView(row, entry.restricted, entry.rows.length),
    evidence: entry.rows.map((item) => evidenceView(item, reads.get(item.evidence_id))),
    // 失权时不返回修订：evidence_json 可能包含已不可读的 room/message 定位。
    revisions: entry.restricted ? [] : revisions.results.map(revisionView),
  };
}

async function persistArchive(
  db: D1Database,
  owner: string,
  requestId: string,
  payloadHash: string,
  result: FocusArchiveResult,
  at: number,
): Promise<unknown> {
  return runIdempotent(db, {
    actorId: owner,
    requestId,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, requestId, payloadHash, resultJson, at),
    ],
  });
}

/** 归档卡主自己的事项；重复归档返回同一次归档，版本不一致返回 CONFLICT。 */
async function archiveItem(
  db: D1Database,
  owner: string,
  input: { item_id: string; request_id: string; expected_version: number },
): Promise<FocusArchiveResult> {
  const payloadHash = await sha256Hex(stableStringify(input));
  const at = nowMs();
  const row = await findItem(db, owner, input.item_id);
  if (!row) throw new BusinessError('NOT_FOUND', '事项不存在或当前不可见');

  if (row.archived_at !== null) {
    const existing: FocusArchiveResult = {
      item_id: row.item_id,
      archived_at: String(row.archived_at),
      version: row.version,
      idempotent: true,
    };
    return (await persistArchive(
      db,
      owner,
      input.request_id,
      payloadHash,
      existing,
      at,
    )) as FocusArchiveResult;
  }
  if (row.version !== input.expected_version) {
    throw new BusinessError('CONFLICT', '事项版本已变化，请刷新后重试', {
      expected_version: input.expected_version,
      actual_version: row.version,
    });
  }

  const nextVersion = row.version + 1;
  const result: FocusArchiveResult = {
    item_id: row.item_id,
    archived_at: String(at),
    version: nextVersion,
    idempotent: false,
  };
  try {
    return (await runIdempotent(db, {
      actorId: owner,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
        db
          .prepare(
            `UPDATE focus_items
                SET archived_at = ?, archived_by = ?, version = ?, updated_at = ?
              WHERE item_id = ? AND owner_actor_id = ? AND archived_at IS NULL AND version = ?`,
          )
          .bind(at, owner, nextVersion, at, row.item_id, owner, input.expected_version),
        db
          .prepare(
            guardSql(
              'focusArchiveConflict',
              'NOT EXISTS (SELECT 1 FROM focus_items WHERE item_id = ? AND owner_actor_id = ? AND archived_at = ? AND version = ?)',
            ),
          )
          .bind(row.item_id, owner, at, nextVersion),
        ...focusUpdatedStatements(db, {
          ownerActorId: owner,
          change: 'archived',
          itemId: row.item_id,
          version: nextVersion,
          eventKey: `focus_updated:${row.item_id}:archived`,
          at,
        }),
      ],
    })) as FocusArchiveResult;
  } catch (error) {
    if (!(error instanceof BusinessError) || error.code !== 'CONFLICT') throw error;
    // 并发归档已先提交：返回同一次归档，而不是把重复请求报成失败。
    const current = await findItem(db, owner, input.item_id);
    if (!current || current.archived_at === null) throw error;
    const existing: FocusArchiveResult = {
      item_id: current.item_id,
      archived_at: String(current.archived_at),
      version: current.version,
      idempotent: true,
    };
    return (await persistArchive(
      db,
      owner,
      input.request_id,
      payloadHash,
      existing,
      nowMs(),
    )) as FocusArchiveResult;
  }
}

export async function focusList(
  db: D1Database,
  principal: Principal,
  input: FocusListInput,
): Promise<FocusListResult> {
  return listItems(db, focusOwner(principal), input);
}

export async function focusGet(
  db: D1Database,
  principal: Principal,
  input: { item_id: string },
): Promise<FocusGetResult> {
  return getItem(db, focusOwner(principal), input.item_id);
}

export async function focusArchive(
  db: D1Database,
  principal: Principal,
  input: { item_id: string; request_id: string; expected_version: number },
): Promise<FocusArchiveResult> {
  return archiveItem(db, focusOwner(principal), input);
}
