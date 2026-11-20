/**
 * 跨房间全局消息搜索。
 *
 * 授权集合先由 `accessible_rooms` CTE 从 `room_members`/`rooms` 构造，消息只在
 * 该集合内 JOIN 并逐房间应用 `from_join`、归档上界与 `body_bytes` 过滤；不存在
 * “先全局搜再在 JS 里过滤”的窗口。排序固定为 `created_at DESC, message_id DESC`，
 * 游标只携带授权摘要，每页重新授权。
 */

import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor, type CursorPayload } from '../contracts/cursor';
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
import { listActiveRoomPeers } from '../storage/queries';
import type { RoomMemberRow, RoomRow } from '../storage/rows';
import { avatarUrl } from './avatar';
import { actorId, type Principal } from './principal';
import { historyBoundary, type HistoryBoundary } from './room-history';
import { messageSearchFtsPhrase } from './message-search-fts';

export type GlobalSearchScope = 'room' | 'all';
export type GlobalSearchMode = 'exact' | 'fuzzy';

export interface GlobalSearchInput {
  scope?: GlobalSearchScope;
  room_id?: string;
  query: string;
  mode?: GlobalSearchMode;
  limit?: number;
  cursor?: string;
}

export interface GlobalSearchOptions {
  ftsEnabled?: boolean;
}

interface GlobalRoomAuthRow
  extends Pick<
      RoomRow,
      | 'room_id'
      | 'kind'
      | 'title'
      | 'member_history_policy'
      | 'policy_revision'
      | 'dissolved_at'
      | 'archive_head_seq'
    >,
    Pick<RoomMemberRow, 'joined_seq' | 'joined_at' | 'member_generation'> {}

export interface GlobalRoomAuthorization {
  room_id: string;
  kind: 'direct' | 'group';
  title: string;
  boundary: HistoryBoundary;
}

interface GlobalAuthorization {
  rooms: GlobalRoomAuthorization[];
  roomSetDigest: string;
  authorizationDigest: string;
}

const GLOBAL_SEARCH_SCOPE = 'global:search';
const EXACT_MATCHER_VERSION = 'exact-v1';

const ACCESSIBLE_ROOMS_CTE = `accessible_rooms AS (
  SELECT r.room_id, r.kind, r.title, r.head_seq,
         r.policy_revision, r.member_history_policy, r.dissolved_at, r.archive_head_seq,
         rm.member_generation, rm.joined_seq, rm.joined_at,
         CASE
           WHEN r.kind = 'direct' OR r.member_history_policy = 'full' THEN 0
           ELSE rm.joined_seq
         END AS from_seq,
         CASE
           WHEN r.kind = 'group'
            AND r.dissolved_at IS NOT NULL
            AND r.archive_head_seq IS NOT NULL
           THEN r.archive_head_seq
           ELSE NULL
         END AS to_seq
    FROM rooms r
    JOIN room_members rm
      ON rm.room_id = r.room_id
     AND rm.actor_id = ?
     AND rm.status = 'active'
)`;

interface GlobalCursorState extends CursorPayload {
  mode: GlobalSearchMode;
  matcher_version: string;
  query_hash: string;
  authorization_digest: string;
  room_set_digest: string;
  snapshot_key: string;
  /**
   * 首次查询前捕获的插入水位（SQLite rowid 上界）。
   *
   * `created_at` 由写入方给出，可能在分页后回填更早的时间戳；只靠
   * `created_at <= snapshot` 无法排除这类迟到写入，因此额外固定 rowid 上界。
   */
  snapshot_rowid: number;
}

interface MessageKey {
  at: number;
  id: string;
}

function keyOf(at: number, id: string): MessageKey {
  return { at, id };
}

function compareKeys(left: MessageKey, right: MessageKey): number {
  return left.at - right.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function isMessageKey(value: { at: unknown; id: unknown }): value is MessageKey {
  return (
    typeof value.at === 'number' &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

function snapshotString(key: MessageKey | null): string {
  return key === null ? '0:' : `${key.at}:${key.id}`;
}

function expired(): BusinessError {
  return new BusinessError(
    'CURSOR_EXPIRED',
    '搜索范围、排序快照或权限已变化，请重新搜索',
  );
}

/**
 * 捕获当前数据库的消息插入水位。
 *
 * 分组按 `created_at` 排序，但 `created_at` 可由发送方回填；rowid 只随插入
 * 递增（删除后可能复用，但不会倒退），用作固定快照的插入上界。
 */
async function messageRowidWatermark(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(rowid), 0) AS watermark FROM messages')
    .first<{ watermark: number }>();
  return row?.watermark ?? 0;
}

async function loadGlobalAuthorization(
  db: D1Database,
  actor: string,
): Promise<GlobalAuthorization> {
  const rows = await db
    .prepare(
      `SELECT r.room_id, r.kind, r.title, r.member_history_policy, r.policy_revision,
              r.dissolved_at, r.archive_head_seq,
              rm.joined_seq, rm.joined_at, rm.member_generation
         FROM rooms r
         JOIN room_members rm
           ON rm.room_id = r.room_id
          AND rm.actor_id = ?
          AND rm.status = 'active'
        ORDER BY r.room_id`,
    )
    .bind(actor)
    .all<GlobalRoomAuthRow>();
  const rooms = rows.results.map((row) => ({
    room_id: row.room_id,
    kind: row.kind,
    title: row.title,
    boundary: historyBoundary(row, row),
  }));
  const sorted = [...rooms].sort((left, right) =>
    left.room_id < right.room_id ? -1 : left.room_id > right.room_id ? 1 : 0,
  );
  const roomSetDigest = await sha256Hex(sorted.map((room) => room.room_id).join('\n'));
  const authorizationDigest = await sha256Hex(
    sorted
      .map((room) =>
        [
          room.room_id,
          room.kind,
          String(room.boundary.fromSeq),
          room.boundary.toSeq === null ? '' : String(room.boundary.toSeq),
          String(room.boundary.policyRevision),
          String(room.boundary.memberGeneration),
        ].join('|'),
      )
      .join('\n'),
  );
  return { rooms, roomSetDigest, authorizationDigest };
}

function decodeGlobalCursor(
  value: string,
  expected: {
    mode: GlobalSearchMode;
    matcherVersion: string;
    queryHash: string;
    authorization: GlobalAuthorization;
  },
): GlobalCursorState {
  let payload: CursorPayload;
  try {
    payload = decodeCursor(value, GLOBAL_SEARCH_SCOPE);
  } catch (error) {
    if (
      error instanceof BusinessError &&
      error.code === 'INVALID_ARGUMENT' &&
      typeof error.details?.actual === 'string'
    ) {
      throw expired();
    }
    throw error;
  }
  const record = payload as unknown as Partial<GlobalCursorState>;
  if (
    record.dir !== 'before' ||
    record.mode !== expected.mode ||
    record.matcher_version !== expected.matcherVersion ||
    record.query_hash !== expected.queryHash ||
    record.authorization_digest !== expected.authorization.authorizationDigest ||
    record.room_set_digest !== expected.authorization.roomSetDigest ||
    typeof record.key !== 'string' ||
    record.key.length === 0 ||
    typeof record.snapshot_key !== 'string' ||
    typeof record.snapshot_rowid !== 'number' ||
    !Number.isSafeInteger(record.snapshot_rowid) ||
    record.snapshot_rowid < 0
  ) {
    throw expired();
  }
  const last = keyOf(record.seq as number, record.key);
  const snapshot = keyOf(record.snapshot as number, record.snapshot_key);
  if (!isMessageKey(last) || !isMessageKey(snapshot) || compareKeys(last, snapshot) > 0) {
    throw expired();
  }
  return record as GlobalCursorState;
}

function encodeGlobalCursor(state: GlobalCursorState): string {
  const encoded = encodeCursor(state);
  if (encoded.length > LIMITS.messageSearchCursorMax) {
    throw new BusinessError('INVALID_ARGUMENT', '搜索游标超出长度上限');
  }
  return encoded;
}

/** direct 取对端名称，group 取标题；空标题回退到「群聊」/「单聊」。 */
export function roomDisplayName(
  kind: 'direct' | 'group',
  title: string,
  peerName: string | null | undefined,
): string {
  if (kind === 'group') return title.trim() ? title : '群聊';
  return peerName?.trim() ? peerName : '单聊';
}

/** 为房间模式解析一次展示名；direct 只查当前房间的对端。 */
export async function roomDisplayNameFor(
  db: D1Database,
  room: Pick<RoomRow, 'room_id' | 'kind' | 'title'>,
  actor: string,
): Promise<string> {
  if (room.kind === 'group') return roomDisplayName('group', room.title, null);
  const peers = await listActiveRoomPeers(db, [room.room_id], actor);
  return roomDisplayName('direct', room.title, peers[0]?.name);
}

async function peerNameMap(
  db: D1Database,
  actor: string,
  items: readonly { room_id: string; room_kind: 'direct' | 'group' }[],
): Promise<Map<string, string>> {
  const directRooms = [
    ...new Set(items.filter((item) => item.room_kind === 'direct').map((item) => item.room_id)),
  ];
  const result = new Map<string, string>();
  if (directRooms.length === 0) return result;
  const peers = await listActiveRoomPeers(db, directRooms, actor);
  for (const peer of peers) {
    if (!result.has(peer.room_id)) result.set(peer.room_id, peer.name);
  }
  return result;
}

interface GlobalRawItem {
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
  snippet: string;
  match_ranges: SearchMatchRange[];
  room_kind: 'direct' | 'group';
  room_title: string;
}

export interface GlobalSearchItem {
  message_id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  sender_avatar_url: string | null;
  body_bytes: number;
  preview: string;
  created_at: number;
  created_seq: number;
  reply_to: string | null;
  snippet: string;
  match_ranges: SearchMatchRange[];
  room_kind: 'direct' | 'group';
  room_display_name: string;
}

export interface GlobalSearchPage {
  items: GlobalSearchItem[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  authorization: { scope: 'all'; authorization_digest: string };
  scope: 'all';
  mode: GlobalSearchMode;
  scan_limited: boolean;
  scanned_count?: number;
}

async function decorateItems(
  db: D1Database,
  actor: string,
  rows: GlobalRawItem[],
): Promise<GlobalSearchItem[]> {
  const peers = await peerNameMap(db, actor, rows);
  return rows.map((row) => ({
    message_id: row.message_id,
    room_id: row.room_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    sender_kind: row.sender_kind,
    sender_avatar_url: avatarUrl(row.avatar_file_id),
    body_bytes: row.body_bytes,
    preview: row.preview,
    created_at: row.created_at,
    created_seq: row.created_seq,
    reply_to: row.reply_to,
    snippet: row.snippet,
    match_ranges: row.match_ranges,
    room_kind: row.room_kind,
    room_display_name: roomDisplayName(row.room_kind, row.room_title, peers.get(row.room_id)),
  }));
}

function globalAuthorizationView(authorization: GlobalAuthorization) {
  return { scope: 'all' as const, authorization_digest: authorization.authorizationDigest };
}

interface GlobalExactRow {
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
  snippet: string;
  room_kind: 'direct' | 'group';
  room_title: string;
}

async function exactGlobalSearch(
  db: D1Database,
  principal: Principal,
  input: GlobalSearchInput,
  options: GlobalSearchOptions,
): Promise<GlobalSearchPage> {
  const actor = actorId(principal);
  const authorization = await loadGlobalAuthorization(db, actor);
  const queryHash = await sha256Hex(input.query.toLowerCase());
  const cursor = input.cursor
    ? decodeGlobalCursor(input.cursor, {
        mode: 'exact',
        matcherVersion: EXACT_MATCHER_VERSION,
        queryHash,
        authorization,
      })
    : null;
  const limit = input.limit ?? LIMITS.messageSearchPageDefault;
  const ftsPhrase = messageSearchFtsPhrase(input.query, options.ftsEnabled ?? true);
  const snapshotRowid = cursor ? cursor.snapshot_rowid : await messageRowidWatermark(db);
  const cursorSql = cursor
    ? `AND (m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))
       AND (m.created_at < ? OR (m.created_at = ? AND m.message_id <= ?))`
    : '';
  const ftsSql =
    ftsPhrase === null
      ? ''
      : 'AND m.rowid IN (SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?)';
  const snippetLeft = Math.min(
    LIMITS.messageSearchSnippetContextChars,
    Math.max(0, LIMITS.messageSearchSnippetChars - Array.from(input.query).length),
  );
  const binds: unknown[] = [actor, snapshotRowid];
  if (cursor) binds.push(cursor.seq, cursor.seq, cursor.key, cursor.snapshot, cursor.snapshot, cursor.snapshot_key);
  if (ftsPhrase !== null) binds.push(ftsPhrase);
  binds.push(
    input.query,
    snippetLeft,
    LIMITS.messageSearchSnippetChars,
    input.query,
    limit + 1,
  );
  const rows = await db
    .prepare(
      `WITH ${ACCESSIBLE_ROOMS_CTE},
       visible_messages AS (
         SELECT m.message_id, m.room_id, m.sender_id, m.body, m.body_bytes, m.preview,
                m.created_at, m.created_seq, m.reply_to,
                ar.kind AS room_kind, ar.title AS room_title
           FROM messages m INDEXED BY idx_messages_global_order
           CROSS JOIN accessible_rooms ar ON ar.room_id = m.room_id
          WHERE m.body_bytes > 0
            AND m.created_seq >= ar.from_seq
            AND (ar.to_seq IS NULL OR m.created_seq <= ar.to_seq)
            AND m.rowid <= ?
            ${cursorSql}
            ${ftsSql}
       )
       SELECT vm.message_id, vm.room_id, vm.sender_id, a.name AS sender_name,
              a.kind AS sender_kind, a.avatar_file_id,
              substr(vm.body, max(1, instr(lower(vm.body), lower(?)) - ?), ?) AS snippet,
              vm.body_bytes, vm.preview, vm.created_at, vm.created_seq, vm.reply_to,
              vm.room_kind, vm.room_title
         FROM visible_messages vm
         JOIN actors a ON a.actor_id = vm.sender_id
        WHERE instr(lower(vm.body), lower(?)) > 0
        ORDER BY vm.created_at DESC, vm.message_id DESC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<GlobalExactRow>();
  const page = rows.results.slice(0, limit);
  const items = await decorateItems(
    db,
    actor,
    page.map((row) => ({
      ...row,
      match_ranges: findExactRanges(row.snippet, input.query),
    })),
  );
  const hasMore = rows.results.length > limit;
  const snapshot = cursor
    ? keyOf(cursor.snapshot, cursor.snapshot_key)
    : page.length > 0
      ? keyOf(page[0]!.created_at, page[0]!.message_id)
      : null;
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeGlobalCursor({
            v: 1,
            scope: GLOBAL_SEARCH_SCOPE,
            dir: 'before',
            seq: last.created_at,
            key: last.message_id,
            snapshot: snapshot?.at ?? 0,
            snapshot_key: snapshot?.id ?? '',
            snapshot_rowid: snapshotRowid,
            mode: 'exact',
            matcher_version: EXACT_MATCHER_VERSION,
            query_hash: queryHash,
            authorization_digest: authorization.authorizationDigest,
            room_set_digest: authorization.roomSetDigest,
          })
        : null,
    has_more: hasMore,
    snapshot: snapshotString(snapshot),
    authorization: globalAuthorizationView(authorization),
    scope: 'all' as const,
    mode: 'exact' as const,
    scan_limited: false,
  };
}

interface GlobalFuzzyCandidate {
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
  room_kind: 'direct' | 'group';
  room_title: string;
}

const FUZZY_VISIBILITY = `m.body_bytes > 0
  AND m.created_seq >= ar.from_seq
  AND (ar.to_seq IS NULL OR m.created_seq <= ar.to_seq)`;

async function fuzzyGlobalSearch(
  db: D1Database,
  principal: Principal,
  input: GlobalSearchInput,
): Promise<GlobalSearchPage> {
  const actor = actorId(principal);
  const normalizedQuery = normalizeFuzzyQuery(input.query);
  if (normalizedQuery.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', '模糊搜索至少需要一个非空白、非标点字符');
  }
  const authorization = await loadGlobalAuthorization(db, actor);
  const queryHash = await sha256Hex(normalizedQuery);
  const cursor = input.cursor
    ? decodeGlobalCursor(input.cursor, {
        mode: 'fuzzy',
        matcherVersion: FUZZY_CURSOR_VERSION,
        queryHash,
        authorization,
      })
    : null;
  const limit = input.limit ?? LIMITS.messageSearchPageDefault;
  const snapshotRowid = cursor ? cursor.snapshot_rowid : await messageRowidWatermark(db);
  let lastExamined: MessageKey | null = cursor
    ? keyOf(cursor.seq, cursor.key ?? '')
    : null;
  let snapshot: MessageKey | null = cursor
    ? keyOf(cursor.snapshot, cursor.snapshot_key)
    : null;
  let scannedCount = 0;
  let scannedBytes = 0;
  const rawItems: GlobalRawItem[] = [];

  const snapshotBound = (): string =>
    snapshot
      ? 'AND (m.created_at < ? OR (m.created_at = ? AND m.message_id <= ?))'
      : '';
  const snapshotBinds = (): unknown[] =>
    snapshot ? [snapshot.at, snapshot.at, snapshot.id] : [];

  const loadCandidates = async (upper: MessageKey | null): Promise<GlobalFuzzyCandidate[]> => {
    const keyset = upper
      ? 'AND (m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))'
      : '';
    const binds: unknown[] = [actor, snapshotRowid, ...snapshotBinds()];
    if (upper) binds.push(upper.at, upper.at, upper.id);
    binds.push(LIMITS.messageSearchFuzzyBatchMax);
    const rows = await db
      .prepare(
        `WITH ${ACCESSIBLE_ROOMS_CTE}
         SELECT m.message_id, m.room_id, m.sender_id, a.name AS sender_name,
                a.kind AS sender_kind, a.avatar_file_id, m.body_bytes, m.preview, m.created_at,
                m.created_seq, m.reply_to, ar.kind AS room_kind, ar.title AS room_title
           FROM messages m INDEXED BY idx_messages_global_order
           CROSS JOIN accessible_rooms ar ON ar.room_id = m.room_id
           JOIN actors a ON a.actor_id = m.sender_id
          WHERE ${FUZZY_VISIBILITY}
            AND m.rowid <= ?
            ${snapshotBound()}
            ${keyset}
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT ?`,
      )
      .bind(...binds)
      .all<GlobalFuzzyCandidate>();
    return rows.results;
  };

  const loadBodies = async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    // 从 ID 列表驱动主键查找；直接 JOIN accessible_rooms 会让规划器按房间索引
    // 扫描并逐条过滤，40 万条下每批 32 个 ID 需要遍历大量消息。
    const placeholders = ids.map(() => '(?)').join(',');
    const rows = await db
      .prepare(
        `WITH ${ACCESSIBLE_ROOMS_CTE},
         wanted(message_id) AS (VALUES ${placeholders})
         SELECT m.message_id, m.body
           FROM wanted w
           JOIN messages m ON m.message_id = w.message_id
           JOIN accessible_rooms ar ON ar.room_id = m.room_id
          WHERE ${FUZZY_VISIBILITY}`,
      )
      .bind(actor, ...ids)
      .all<{ message_id: string; body: string }>();
    return new Map(rows.results.map((row) => [row.message_id, row.body]));
  };

  const hasCandidateBelow = async (key: MessageKey): Promise<boolean> => {
    const row = await db
      .prepare(
        `WITH ${ACCESSIBLE_ROOMS_CTE}
         SELECT 1 AS found
           FROM messages m INDEXED BY idx_messages_global_order
           CROSS JOIN accessible_rooms ar ON ar.room_id = m.room_id
          WHERE ${FUZZY_VISIBILITY}
            AND m.rowid <= ?
            ${snapshotBound()}
            AND (m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))
          LIMIT 1`,
      )
      .bind(actor, snapshotRowid, ...snapshotBinds(), key.at, key.at, key.id)
      .first<{ found: number }>();
    return row !== null;
  };

  while (
    rawItems.length < limit &&
    scannedCount < LIMITS.messageSearchFuzzyScanMax &&
    scannedBytes < LIMITS.messageSearchFuzzyScanBytes
  ) {
    const candidates = await loadCandidates(lastExamined);
    if (candidates.length === 0) break;
    if (snapshot === null) {
      snapshot = keyOf(candidates[0]!.created_at, candidates[0]!.message_id);
    }
    const selected: GlobalFuzzyCandidate[] = [];
    let selectedBytes = 0;
    for (const candidate of candidates) {
      if (scannedCount + selected.length >= LIMITS.messageSearchFuzzyScanMax) break;
      if (
        scannedBytes + selectedBytes + candidate.body_bytes >
        LIMITS.messageSearchFuzzyScanBytes
      ) {
        break;
      }
      selected.push(candidate);
      selectedBytes += candidate.body_bytes;
    }
    if (selected.length === 0) break;
    const bodies = await loadBodies(selected.map((candidate) => candidate.message_id));
    for (const candidate of selected) {
      if (rawItems.length >= limit) break;
      // 并发撤回会删除正文：该候选仍算已检查，但不返回旧片段。
      const body = bodies.get(candidate.message_id);
      lastExamined = keyOf(candidate.created_at, candidate.message_id);
      scannedCount += 1;
      scannedBytes += candidate.body_bytes;
      if (body === undefined) continue;
      const match = findFuzzyMatchWithSynonyms(body, normalizedQuery);
      if (match === null) continue;
      const { snippet, match_ranges } = buildSearchSnippet(
        body,
        match.ranges,
        LIMITS.messageSearchSnippetChars,
        LIMITS.messageSearchSnippetContextChars,
      );
      rawItems.push({
        message_id: candidate.message_id,
        room_id: candidate.room_id,
        sender_id: candidate.sender_id,
        sender_name: candidate.sender_name,
        sender_kind: candidate.sender_kind,
        avatar_file_id: candidate.avatar_file_id,
        body_bytes: candidate.body_bytes,
        preview: candidate.preview,
        created_at: candidate.created_at,
        created_seq: candidate.created_seq,
        reply_to: candidate.reply_to,
        snippet,
        match_ranges,
        room_kind: candidate.room_kind,
        room_title: candidate.room_title,
      });
    }
  }

  const hasMore = lastExamined === null ? false : await hasCandidateBelow(lastExamined);
  const items = await decorateItems(db, actor, rawItems);
  return {
    items,
    next_cursor:
      hasMore && lastExamined
        ? encodeGlobalCursor({
            v: 1,
            scope: GLOBAL_SEARCH_SCOPE,
            dir: 'before',
            seq: lastExamined.at,
            key: lastExamined.id,
            snapshot: snapshot?.at ?? 0,
            snapshot_key: snapshot?.id ?? '',
            snapshot_rowid: snapshotRowid,
            mode: 'fuzzy',
            matcher_version: FUZZY_CURSOR_VERSION,
            query_hash: queryHash,
            authorization_digest: authorization.authorizationDigest,
            room_set_digest: authorization.roomSetDigest,
          })
        : null,
    has_more: hasMore,
    snapshot: snapshotString(snapshot),
    authorization: globalAuthorizationView(authorization),
    scope: 'all' as const,
    mode: 'fuzzy' as const,
    scan_limited: items.length < limit && hasMore,
    scanned_count: scannedCount,
  };
}

/** `scope='all'` 的入口；`room_id` 由调用方在进入前拒绝。 */
export async function globalMessageSearch(
  db: D1Database,
  principal: Principal,
  input: GlobalSearchInput,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchPage> {
  const mode = input.mode ?? 'exact';
  return mode === 'fuzzy'
    ? fuzzyGlobalSearch(db, principal, input)
    : exactGlobalSearch(db, principal, input, options);
}
