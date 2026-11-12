/**
 * 消息式 Task 的按起点聚合搜索（阶段 2）。
 *
 * 命中消息先映射到所属 Task：显式归属 / 线程根，以及“被某个处理消息明确引用”
 * 的来源；同一命中可同时属于多个 Task（跨 Task 引用不合并）。结果按每个 Task
 * 的最新命中倒序分页，游标用 `latest_seq + root_message_id` 保证同序号不丢项。
 * 单次扫描有上限，超过时返回 `truncated: true` 并停止分页，不静默全表扫描。
 */

import { encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import { sha256Hex } from '../storage/db';
import type { Principal } from './principal';
import { messageTaskSummaries, readableRoom, type TaskSummary } from './message-tasks';
import { messageSearchFtsPhrase } from './message-search-fts';
import {
  decodeHistoryCursor,
  historyCursorScope,
  historySnapshot,
  type HistorySnapshot,
} from './room-history';

export interface TaskSearchInput {
  room_id: string;
  query: string;
  cursor?: string;
  limit?: number;
}

export interface TaskSearchMatch {
  message_id: string;
  snippet: string;
  created_seq: string;
}

export interface TaskSearchItem {
  task: TaskSummary;
  hit_count: number;
  matches: TaskSearchMatch[];
}

export interface TaskSearchResult {
  items: TaskSearchItem[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  authorization: HistorySnapshot;
  /** 扫描达到上限时结果不完整，此时不再返回 next_cursor。 */
  truncated: boolean;
}

interface SearchGroupRow {
  root_id: string;
  hit_count: number;
  latest_seq: number;
}

interface SearchMatchRow {
  root_id: string;
  hit_id: string;
  hit_seq: number;
  snippet: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

export interface TaskSearchOptions {
  /** FTS 索引缺失或回滚时关闭；默认开启，1–2 字始终走 instr。 */
  ftsEnabled?: boolean;
}

export async function messageTaskSearch(
  db: D1Database,
  principal: Principal,
  input: TaskSearchInput,
  options: TaskSearchOptions = {},
): Promise<TaskSearchResult> {
  const { room, boundary } = await readableRoom(db, principal, input.room_id);
  const queryHash = await sha256Hex(input.query.toLowerCase());
  const scope = `${historyCursorScope('task', room.room_id, boundary.memberGeneration)}:search:p${boundary.policyRevision}:q${queryHash}`;
  const limit = clampPage(input.limit, LIMITS.taskSearchPageDefault, LIMITS.taskSearchPageMax);
  const cursor = input.cursor ? decodeHistoryCursor(input.cursor, scope, room.room_id) : null;
  const readHead =
    boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq);
  const snapshot = cursor ? Math.min(cursor.snapshot, readHead) : readHead;

  const ftsPhrase = messageSearchFtsPhrase(input.query, options.ftsEnabled ?? true);
  const matchedMatch =
    ftsPhrase === null
      ? 'instr(lower(m.body), lower(?)) > 0'
      : "m.rowid IN (SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?) AND instr(lower(m.body), lower(?)) > 0";
  const matchedSql = `matched AS (
      SELECT m.message_id AS hit_id, m.created_seq AS hit_seq,
             substr(m.body, max(1, instr(lower(m.body), lower(?)) - 100), ?) AS snippet
        FROM messages m
       WHERE m.room_id = ? AND m.body_bytes > 0
         AND m.created_seq <= ? AND m.created_seq >= ?
         AND ${matchedMatch}
       ORDER BY m.created_seq DESC
       LIMIT ?
    )`;
  const markedSql = `marked AS (
      SELECT m.message_id
        FROM messages m
       WHERE m.room_id = ? AND m.task_root_id = m.message_id AND m.body_bytes > 0
         AND m.created_seq >= ? AND m.created_seq <= ?
    )`;
  const hitSql = `hit AS (
      SELECT COALESCE(m.task_root_id, m.root_id) AS root_id,
             x.hit_id, x.hit_seq, x.snippet
        FROM matched x
        JOIN messages m ON m.message_id = x.hit_id
        JOIN marked r ON r.message_id = COALESCE(m.task_root_id, m.root_id)
      UNION
      SELECT COALESCE(p.task_root_id, p.root_id) AS root_id,
             x.hit_id, x.hit_seq, x.snippet
        FROM matched x
        JOIN messages p ON p.reply_to = x.hit_id AND p.room_id = ?
        JOIN marked r ON r.message_id = COALESCE(p.task_root_id, p.root_id)
       WHERE p.body_bytes > 0 AND p.created_seq >= ? AND p.created_seq <= ?
    )`;
  const matchBinds = [
    input.query,
    LIMITS.messageSearchSnippetChars,
    room.room_id,
    snapshot,
    boundary.fromSeq,
    ...(ftsPhrase === null ? [] : [ftsPhrase]),
    input.query,
    LIMITS.taskSearchScanMax + 1,
    room.room_id,
    boundary.fromSeq,
    snapshot,
    room.room_id,
    boundary.fromSeq,
    snapshot,
  ];

  const matchedCount = await db
    .prepare(`WITH ${matchedSql} SELECT COUNT(*) AS n FROM matched`)
    .bind(
      input.query,
      LIMITS.messageSearchSnippetChars,
      room.room_id,
      snapshot,
      boundary.fromSeq,
      ...(ftsPhrase === null ? [] : [ftsPhrase]),
      input.query,
      LIMITS.taskSearchScanMax + 1,
    )
    .first<{ n: number }>();
  const truncated = (matchedCount?.n ?? 0) > LIMITS.taskSearchScanMax;

  const cursorSeq = cursor?.seq ?? null;
  const cursorKey = cursor?.key ?? null;
  const groups = await db
    .prepare(
      `WITH ${matchedSql}, ${markedSql}, ${hitSql},
       grouped AS (
         SELECT root_id, COUNT(*) AS hit_count, MAX(hit_seq) AS latest_seq
           FROM hit GROUP BY root_id
       )
       SELECT root_id, hit_count, latest_seq FROM grouped
        WHERE (? IS NULL OR latest_seq < ? OR (latest_seq = ? AND root_id < ?))
        ORDER BY latest_seq DESC, root_id DESC
        LIMIT ?`,
    )
    .bind(...matchBinds, cursorSeq, cursorSeq, cursorSeq, cursorKey, limit + 1)
    .all<SearchGroupRow>();

  // 扫描已截断时无法保证后续页完整，停止分页并显式返回 truncated。
  const hasMore = !truncated && groups.results.length > limit;
  const pageGroups = groups.results.slice(0, limit);
  const roots = pageGroups.map((group) => group.root_id);
  const summaries = new Map<string, TaskSummary>();
  for (let index = 0; index < roots.length; index += LIMITS.taskSummaryRootsMax) {
    const chunk = roots.slice(index, index + LIMITS.taskSummaryRootsMax);
    const result = await messageTaskSummaries(db, principal, {
      room_id: room.room_id,
      root_message_ids: chunk,
    });
    for (const item of result.items) summaries.set(item.root_message_id, item);
  }

  const matchRows =
    roots.length === 0
      ? []
      : (
          await db
            .prepare(
              `WITH ${matchedSql}, ${markedSql}, ${hitSql}
               SELECT root_id, hit_id, hit_seq, snippet FROM hit
                WHERE root_id IN (${placeholders(roots.length)})
                ORDER BY root_id ASC, hit_seq DESC`,
            )
            .bind(...matchBinds, ...roots)
            .all<SearchMatchRow>()
        ).results;
  const matchesByRoot = new Map<string, TaskSearchMatch[]>();
  for (const row of matchRows) {
    const list = matchesByRoot.get(row.root_id) ?? [];
    if (list.length >= LIMITS.taskSearchMatchesMax) continue;
    list.push({
      message_id: row.hit_id,
      snippet: row.snippet,
      created_seq: String(row.hit_seq),
    });
    matchesByRoot.set(row.root_id, list);
  }

  const items: TaskSearchItem[] = [];
  for (const group of pageGroups) {
    const task = summaries.get(group.root_id);
    if (!task) continue;
    items.push({
      task,
      hit_count: group.hit_count,
      matches: matchesByRoot.get(group.root_id) ?? [],
    });
  }

  const lastGroup = pageGroups.at(-1);
  const nextCursor =
    hasMore && lastGroup
      ? encodeCursor({
          v: 1,
          scope,
          dir: 'after',
          seq: lastGroup.latest_seq,
          key: lastGroup.root_id,
          snapshot,
        })
      : null;

  return {
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    snapshot: String(snapshot),
    authorization: historySnapshot(boundary),
    truncated,
  };
}
