import { z } from 'zod';
import { BusinessError } from '../contracts/errors';
import { encodeCursor } from '../contracts/cursor';
import { LIMITS } from '../contracts/limits';
import {
  buildSearchSnippet,
  findExactRanges,
  normalizeFuzzyQuery,
  type SearchMatchRange,
} from '../contracts/message-search-match';
import {
  FUZZY_CURSOR_VERSION,
  findFuzzyMatchWithSynonyms,
} from '../contracts/message-search-synonyms';
import { sha256Hex } from '../storage/db';
import { getMessageContextAnchor, listMessageContextWindow } from '../storage/queries';
import { avatarUrl } from './avatar';
import { decodeHistoryCursor, historyBoundary, historyCursorScope } from './room-history';
import { actorId, type Principal } from './principal';
import { loadRoomAccess } from './room-access';
import { messageSearchFtsPhrase } from './message-search-fts';
import {
  globalMessageSearch,
  roomDisplayNameFor,
  type GlobalSearchInput,
} from './message-search-global';

const messageSearchModeSchema = z.enum(['exact', 'fuzzy']);
const messageSearchScopeSchema = z.enum(['room', 'all']);

export const messageSearchSchema = z.object({
  room_id: z.string().min(1).max(128).optional(),
  scope: messageSearchScopeSchema.optional(),
  query: z.string().trim().min(1).max(LIMITS.messageSearchQueryMax),
  mode: messageSearchModeSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.messageSearchPageMax).optional(),
  cursor: z.string().max(LIMITS.messageSearchCursorMax).optional(),
}).strict();
export const messageContextSchema = z.object({
  room_id: z.string().min(1).max(128),
  message_id: z.string().min(1).max(128),
  before: z.number().int().min(0).max(LIMITS.messageContextMax).optional(),
  after: z.number().int().min(0).max(LIMITS.messageContextMax).optional(),
}).strict();
const messageViewSchema = z.object({
  message_id: z.string(), room_id: z.string(), sender_id: z.string(), sender_name: z.string(), sender_kind: z.string(),
  body_bytes: z.number().int(), preview: z.string(), created_at: z.number().int(), created_seq: z.number().int(), reply_to: z.string().nullable(),
}).strict();
const authorizationSchema = z.object({ policy_revision: z.number().int(), history_from_seq: z.string(), member_generation: z.string() }).strict();
const globalAuthorizationSchema = z.object({ scope: z.literal('all'), authorization_digest: z.string() }).strict();
const searchMatchRangeSchema = z
  .object({
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .strict()
  .refine((range) => range.end > range.start, { message: 'match range end 必须大于 start' });
const messageSearchItemSchema = messageViewSchema
  .extend({
    snippet: z.string(),
    /** `snippet` 内 UTF-16 左闭右开区间；已排序、合并重叠/相邻区间。 */
    match_ranges: z.array(searchMatchRangeSchema).optional(),
    room_kind: z.enum(['direct', 'group']),
    /** 服务端已授权 JOIN 的展示名；direct 为对端名，group 为标题或「群聊」。 */
    room_display_name: z.string(),
    /** 发送者头像；无头像为 null，不返回文件元数据。 */
    sender_avatar_url: z.string().nullable(),
  })
  .strict();
export const messageSearchOutputSchema = z.object({
  items: z.array(messageSearchItemSchema), next_cursor: z.string().nullable(), has_more: z.boolean(), snapshot: z.string(),
  authorization: z.union([authorizationSchema, globalAuthorizationSchema]),
  scope: messageSearchScopeSchema,
  mode: messageSearchModeSchema.optional(),
  /** 仅 fuzzy 可能为 true：本页因扫描预算停止，不代表房间/全局已搜索完。 */
  scan_limited: z.boolean().optional(),
  /** fuzzy 本页实际完成匹配检查的候选数。 */
  scanned_count: z.number().int().min(0).optional(),
}).strict();
export const messageContextOutputSchema = z.object({ items: z.array(messageViewSchema), authorization: authorizationSchema }).strict();

type SearchInput = z.infer<typeof messageSearchSchema>;
type RoomSearchInput = SearchInput & { room_id: string };
type SearchMode = z.infer<typeof messageSearchModeSchema>;
type ContextInput = z.infer<typeof messageContextSchema>;
interface MessageRow { message_id: string; room_id: string; sender_id: string; sender_name: string; sender_kind: string; avatar_file_id: string | null; body_bytes: number; preview: string; created_at: number; created_seq: number; reply_to: string | null; }
interface SearchRow extends MessageRow { snippet: string; }
interface SearchItem extends Omit<SearchRow, 'avatar_file_id'> { match_ranges: SearchMatchRange[]; room_kind: 'direct' | 'group'; room_display_name: string; sender_avatar_url: string | null; }
async function authorized(db: D1Database, principal: Principal, roomId: string) {
  const { room, member } = await loadRoomAccess(db, roomId, actorId(principal));
  return { room, boundary: historyBoundary(room, member) };
}

/** 搜索游标只允许向前，且序号必须落在固定快照内。 */
function decodeSearchCursor(value: string, scope: string, roomId: string, snapshot: number) {
  const cursor = decodeHistoryCursor(value, scope, roomId);
  if (cursor.dir !== 'before') {
    throw new BusinessError('INVALID_ARGUMENT', '搜索游标只支持 before 方向');
  }
  if (
    !Number.isSafeInteger(cursor.seq) ||
    cursor.seq < 0 ||
    !Number.isSafeInteger(cursor.snapshot) ||
    cursor.snapshot < 0 ||
    cursor.seq > snapshot + 1
  ) {
    throw new BusinessError('INVALID_ARGUMENT', '搜索游标序号超出快照范围');
  }
  return cursor;
}

function authorizationOf(boundary: ReturnType<typeof historyBoundary>) {
  return {
    policy_revision: boundary.policyRevision,
    history_from_seq: String(boundary.fromSeq),
    member_generation: String(boundary.memberGeneration),
  };
}

export interface MessageSearchOptions {
  /** FTS 索引缺失或回滚时关闭；默认开启，1–2 字始终走 instr。 */
  ftsEnabled?: boolean;
}

/**
 * 搜索消息正文；`scope` 缺省为 `room`，保持旧 `{room_id, query}` 行为。
 *
 * `scope='all'` 不接受 `room_id`，授权集合每页由 SQL 重新计算；
 * `scope='room'` 继续要求 `room_id` 并维持既有房间游标语义。
 */
export async function messageSearch(
  db: D1Database,
  principal: Principal,
  input: SearchInput,
  options: MessageSearchOptions = {},
) {
  const scope = input.scope ?? 'room';
  if (scope === 'room' && input.room_id === undefined) {
    throw new BusinessError('INVALID_ARGUMENT', 'scope=room 必须提供 room_id');
  }
  if (scope === 'all' && input.room_id !== undefined) {
    throw new BusinessError('INVALID_ARGUMENT', 'scope=all 不得提供 room_id');
  }
  if (scope === 'all') {
    return globalMessageSearch(
      db,
      principal,
      input as GlobalSearchInput,
      { ftsEnabled: options.ftsEnabled },
    );
  }
  const roomInput = input as RoomSearchInput;
  const { room, boundary } = await authorized(db, principal, roomInput.room_id);
  const mode: SearchMode = input.mode ?? 'exact';
  const displayName = await roomDisplayNameFor(db, room, actorId(principal));
  return mode === 'fuzzy'
    ? fuzzyMessageSearch(db, room, boundary, roomInput, displayName)
    : exactMessageSearch(db, room, boundary, roomInput, options, displayName);
}

async function exactMessageSearch(
  db: D1Database,
  room: Awaited<ReturnType<typeof authorized>>['room'],
  boundary: Awaited<ReturnType<typeof authorized>>['boundary'],
  input: RoomSearchInput,
  options: MessageSearchOptions,
  displayName: string,
) {
  const queryHash = await sha256Hex(input.query.toLowerCase());
  const scope = `${historyCursorScope('search', room.room_id, boundary.memberGeneration)}:p${boundary.policyRevision}:q${queryHash}`;
  const limit = input.limit ?? LIMITS.messageSearchPageDefault;
  const readHead = Math.min(room.head_seq, boundary.toSeq ?? room.head_seq);
  const cursor = input.cursor ? decodeSearchCursor(input.cursor, scope, room.room_id, readHead) : null;
  const snapshot = cursor ? Math.min(cursor.snapshot, readHead) : readHead;
  const start = cursor?.seq ?? snapshot + 1;
  const lowerSql = boundary.full ? '1=1' : 'm.created_seq>=?';
  const ftsPhrase = messageSearchFtsPhrase(input.query, options.ftsEnabled ?? true);
  const matchSql = ftsPhrase === null
    ? 'instr(lower(m.body), lower(?))>0'
    : "m.rowid IN (SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?) AND instr(lower(m.body), lower(?))>0";
  // 片段窗口按查询长度收缩前置上下文，保证最多 200 码点的完整命中不被截断。
  const snippetLeft = Math.min(
    LIMITS.messageSearchSnippetContextChars,
    Math.max(0, LIMITS.messageSearchSnippetChars - Array.from(input.query).length),
  );
  const binds: unknown[] = [
    input.query,
    snippetLeft,
    LIMITS.messageSearchSnippetChars,
    room.room_id,
    snapshot,
    ...(ftsPhrase === null ? [] : [ftsPhrase]),
    input.query,
    ...(boundary.full ? [] : [boundary.fromSeq]),
    start,
    limit + 1,
  ];
  const columns = `m.message_id, m.room_id, m.sender_id, a.name AS sender_name, a.kind AS sender_kind,
    a.avatar_file_id, substr(m.body, max(1, instr(lower(m.body), lower(?))-?), ?) AS snippet,
    m.body_bytes, m.preview, m.created_at, m.created_seq, m.reply_to`;
  const rows = await db.prepare(`SELECT ${columns} FROM messages m JOIN actors a ON a.actor_id=m.sender_id
    WHERE m.room_id=? AND m.body_bytes>0 AND m.created_seq<=? AND ${matchSql} AND ${lowerSql} AND m.created_seq<?
    ORDER BY m.created_seq DESC LIMIT ?`).bind(...binds).all<SearchRow>();
  const page = rows.results.slice(0, limit);
  const items: SearchItem[] = page.map((row) => {
    const { avatar_file_id, ...rest } = row;
    return {
      ...rest,
      sender_avatar_url: avatarUrl(avatar_file_id),
      match_ranges: findExactRanges(row.snippet, input.query),
      room_kind: room.kind,
      room_display_name: displayName,
    };
  });
  const hasMore = rows.results.length > limit;
  return {
    items,
    next_cursor: hasMore && items.length ? encodeCursor({ v: 1, scope, dir: 'before', seq: items.at(-1)!.created_seq, snapshot }) : null,
    has_more: hasMore,
    snapshot: String(snapshot),
    authorization: authorizationOf(boundary),
    scope: 'room' as const,
    mode: 'exact' as const,
    scan_limited: false,
  } as const;
}


interface FuzzyCandidateRow {
  message_id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  avatar_file_id: string | null;
  body_bytes: number;
  preview: string;
  created_at: number;
  created_seq: number;
  reply_to: string | null;
}

/**
 * 模糊搜索：不使用 FTS/连续子串预筛，按房间序号索引有界扫描。
 *
 * 每请求最多检查 `messageSearchFuzzyScanMax` 条候选与
 * `messageSearchFuzzyScanBytes` 正文；cursor 推进到最后实际检查的消息，
 * 预取但未检查的行留到下一页重读。
 */
async function fuzzyMessageSearch(
  db: D1Database,
  room: Awaited<ReturnType<typeof authorized>>['room'],
  boundary: Awaited<ReturnType<typeof authorized>>['boundary'],
  input: RoomSearchInput,
  displayName: string,
) {
  const normalizedQuery = normalizeFuzzyQuery(input.query);
  if (normalizedQuery.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', '模糊搜索至少需要一个非空白、非标点字符');
  }
  const queryHash = await sha256Hex(normalizedQuery);
  const scope = `${historyCursorScope('search', room.room_id, boundary.memberGeneration)}:p${boundary.policyRevision}:${FUZZY_CURSOR_VERSION}:q${queryHash}`;
  const limit = input.limit ?? LIMITS.messageSearchPageDefault;
  const readHead = Math.min(room.head_seq, boundary.toSeq ?? room.head_seq);
  const cursor = input.cursor ? decodeSearchCursor(input.cursor, scope, room.room_id, readHead) : null;
  const snapshot = cursor ? Math.min(cursor.snapshot, readHead) : readHead;
  const lowerPredicate = boundary.full ? '' : ' AND m.created_seq>=?';
  const boundaryBinds = boundary.full ? [] : [boundary.fromSeq];
  const scanMax = LIMITS.messageSearchFuzzyScanMax;
  const scanBytes = LIMITS.messageSearchFuzzyScanBytes;
  const batchMax = LIMITS.messageSearchFuzzyBatchMax;
  const snippetChars = LIMITS.messageSearchSnippetChars;
  const contextChars = LIMITS.messageSearchSnippetContextChars;

  let lastExamined: number | null = cursor?.seq ?? null;
  let scannedCount = 0;
  let scannedBytes = 0;
  const items: SearchItem[] = [];

  const loadCandidates = async (upperExclusive: number) => {
    const rows = await db
      .prepare(
        `SELECT m.message_id, m.room_id, m.sender_id, a.name AS sender_name, a.kind AS sender_kind,
                a.avatar_file_id, m.body_bytes, m.preview, m.created_at, m.created_seq, m.reply_to
           FROM messages m JOIN actors a ON a.actor_id=m.sender_id
          WHERE m.room_id=? AND m.body_bytes>0 AND m.created_seq<=?${lowerPredicate}
            AND m.created_seq<?
          ORDER BY m.created_seq DESC
          LIMIT ?`,
      )
      .bind(room.room_id, snapshot, ...boundaryBinds, upperExclusive, batchMax)
      .all<FuzzyCandidateRow>();
    return rows.results;
  };

  const loadBodies = async (candidateIds: string[], upperExclusive: number) => {
    if (candidateIds.length === 0) return new Map<string, string>();
    const placeholders = candidateIds.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT m.message_id, m.body FROM messages m
          WHERE m.room_id=? AND m.body_bytes>0 AND m.created_seq<=?${lowerPredicate}
            AND m.created_seq<? AND m.message_id IN (${placeholders})`,
      )
      .bind(room.room_id, snapshot, ...boundaryBinds, upperExclusive, ...candidateIds)
      .all<{ message_id: string; body: string }>();
    return new Map(rows.results.map((row) => [row.message_id, row.body]));
  };

  const hasCandidateBelow = async (seq: number) => {
    const row = await db
      .prepare(
        `SELECT 1 AS found FROM messages m
          WHERE m.room_id=? AND m.body_bytes>0 AND m.created_seq<=?${lowerPredicate}
            AND m.created_seq<?
          LIMIT 1`,
      )
      .bind(room.room_id, snapshot, ...boundaryBinds, seq)
      .first<{ found: number }>();
    return row !== null;
  };

  while (items.length < limit && scannedCount < scanMax && scannedBytes < scanBytes) {
    const upperExclusive = lastExamined === null ? snapshot + 1 : lastExamined;
    const candidates = await loadCandidates(upperExclusive);
    if (candidates.length === 0) break;

    // 先按 metadata 选出本预算可处理的连续前缀；body 批量读取不超过 batchMax。
    const selected: FuzzyCandidateRow[] = [];
    let selectedBytes = 0;
    for (const candidate of candidates) {
      if (scannedCount + selected.length >= scanMax) break;
      if (scannedBytes + selectedBytes + candidate.body_bytes > scanBytes) break;
      selected.push(candidate);
      selectedBytes += candidate.body_bytes;
    }
    if (selected.length === 0) break;

    const bodies = await loadBodies(
      selected.map((candidate) => candidate.message_id),
      upperExclusive,
    );
    for (const candidate of selected) {
      if (items.length >= limit) break;
      // 并发撤回会删除正文：该候选仍算已检查，但不再返回旧片段。
      const body = bodies.get(candidate.message_id);
      lastExamined = candidate.created_seq;
      scannedCount += 1;
      scannedBytes += candidate.body_bytes;
      if (body === undefined) continue;
      const match = findFuzzyMatchWithSynonyms(body, normalizedQuery);
      if (match === null) continue;
      const { snippet, match_ranges } = buildSearchSnippet(
        body,
        match.ranges,
        snippetChars,
        contextChars,
      );
      items.push({
        message_id: candidate.message_id,
        room_id: candidate.room_id,
        sender_id: candidate.sender_id,
        sender_name: candidate.sender_name,
        sender_kind: candidate.sender_kind,
        sender_avatar_url: avatarUrl(candidate.avatar_file_id),
        body_bytes: candidate.body_bytes,
        preview: candidate.preview,
        created_at: candidate.created_at,
        created_seq: candidate.created_seq,
        reply_to: candidate.reply_to,
        snippet,
        match_ranges,
        room_kind: room.kind,
        room_display_name: displayName,
      });
    }
  }

  // fuzzy 的 has_more 只表示仍有未扫描的可见候选，不保证还有匹配。
  const hasMore = lastExamined === null ? false : await hasCandidateBelow(lastExamined);
  return {
    items,
    next_cursor: hasMore
      ? encodeCursor({ v: 1, scope, dir: 'before', seq: lastExamined!, snapshot })
      : null,
    has_more: hasMore,
    snapshot: String(snapshot),
    authorization: authorizationOf(boundary),
    scope: 'room' as const,
    mode: 'fuzzy' as const,
    scan_limited: items.length < limit && hasMore,
    scanned_count: scannedCount,
  };
}


/** Load a bounded window around a message ID without walking the room's oldest history. */
export async function messageContext(db: D1Database, principal: Principal, input: ContextInput) {
  const { room, boundary } = await authorized(db, principal, input.room_id);
  const base = await getMessageContextAnchor(db, room.room_id, input.message_id);
  if (!base || base.created_seq < boundary.fromSeq || (boundary.toSeq !== null && base.created_seq > boundary.toSeq)) throw new BusinessError('NOT_FOUND', '消息不存在或当前历史授权不可见');
  const before = Math.min(input.before ?? LIMITS.messageContextDefault, LIMITS.messageContextMax);
  const after = Math.min(input.after ?? LIMITS.messageContextDefault, LIMITS.messageContextMax);
  const window = { roomId: room.room_id, pivotSeq: base.created_seq, fromSeq: boundary.full ? null : boundary.fromSeq, toSeq: boundary.toSeq };
  const [prior, following] = await Promise.all([
    before ? listMessageContextWindow(db, { ...window, direction: 'before', limit: before }) : Promise.resolve([]),
    after ? listMessageContextWindow(db, { ...window, direction: 'after', limit: after }) : Promise.resolve([]),
  ]);
  return { items: [...prior.reverse(), base, ...following], authorization: { policy_revision: boundary.policyRevision, history_from_seq: String(boundary.fromSeq), member_generation: String(boundary.memberGeneration) } };
}
