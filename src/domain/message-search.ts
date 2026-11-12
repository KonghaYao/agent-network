import { z } from 'zod';
import { BusinessError } from '../contracts/errors';
import { encodeCursor } from '../contracts/cursor';
import { LIMITS } from '../contracts/limits';
import { sha256Hex } from '../storage/db';
import { decodeHistoryCursor, historyBoundary, historyCursorScope } from './room-history';
import { actorId, type Principal } from './principal';
import { getMember, getRoom } from '../storage/queries';
import { messageSearchFtsPhrase } from './message-search-fts';

export const messageSearchSchema = z.object({
  room_id: z.string().min(1).max(128),
  query: z.string().trim().min(1).max(LIMITS.messageSearchQueryMax),
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
export const messageSearchOutputSchema = z.object({
  items: z.array(messageViewSchema.extend({ snippet: z.string() }).strict()), next_cursor: z.string().nullable(), has_more: z.boolean(), snapshot: z.string(), authorization: authorizationSchema,
}).strict();
export const messageContextOutputSchema = z.object({ items: z.array(messageViewSchema), authorization: authorizationSchema }).strict();

type SearchInput = z.infer<typeof messageSearchSchema>;
type ContextInput = z.infer<typeof messageContextSchema>;
interface MessageRow { message_id: string; room_id: string; sender_id: string; sender_name: string; sender_kind: string; body_bytes: number; preview: string; created_at: number; created_seq: number; reply_to: string | null; }
interface SearchRow extends MessageRow { snippet: string; }
async function authorized(db: D1Database, principal: Principal, roomId: string) {
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, roomId, actorId(principal));
  if (!member || member.status !== 'active') throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  return { room, boundary: historyBoundary(room, member) };
}

export interface MessageSearchOptions {
  /** FTS 索引缺失或回滚时关闭；默认开启，1–2 字始终走 instr。 */
  ftsEnabled?: boolean;
}

/** Full-text substring search over persisted message bodies; authorization is recomputed on every page. */
export async function messageSearch(
  db: D1Database,
  principal: Principal,
  input: SearchInput,
  options: MessageSearchOptions = {},
) {
  const { room, boundary } = await authorized(db, principal, input.room_id);
  const queryHash = await sha256Hex(input.query.toLowerCase());
  const scope = `${historyCursorScope('search', room.room_id, boundary.memberGeneration)}:p${boundary.policyRevision}:q${queryHash}`;
  const limit = input.limit ?? LIMITS.messageSearchPageDefault;
  const cursor = input.cursor ? decodeHistoryCursor(input.cursor, scope, room.room_id) : null;
  const readHead = Math.min(room.head_seq, boundary.toSeq ?? room.head_seq);
  const snapshot = cursor ? Math.min(cursor.snapshot, readHead) : readHead;
  const start = cursor?.seq ?? snapshot + 1;
  const lowerSql = boundary.full ? '1=1' : 'm.created_seq>=?';
  const ftsPhrase = messageSearchFtsPhrase(input.query, options.ftsEnabled ?? true);
  const matchSql = ftsPhrase === null
    ? 'instr(lower(m.body), lower(?))>0'
    : "m.rowid IN (SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?) AND instr(lower(m.body), lower(?))>0";
  const binds: unknown[] = [
    input.query,
    room.room_id,
    snapshot,
    ...(ftsPhrase === null ? [] : [ftsPhrase]),
    input.query,
    ...(boundary.full ? [] : [boundary.fromSeq]),
    start,
    limit + 1,
  ];
  const columns = `m.message_id, m.room_id, m.sender_id, a.name AS sender_name, a.kind AS sender_kind,
    substr(m.body, max(1, instr(lower(m.body), lower(?))-100), ${LIMITS.messageSearchSnippetChars}) AS snippet, m.body_bytes, m.preview, m.created_at, m.created_seq, m.reply_to`;
  const rows = await db.prepare(`SELECT ${columns} FROM messages m JOIN actors a ON a.actor_id=m.sender_id
    WHERE m.room_id=? AND m.body_bytes>0 AND m.created_seq<=? AND ${matchSql} AND ${lowerSql} AND m.created_seq<?
    ORDER BY m.created_seq DESC LIMIT ?`).bind(...binds).all<SearchRow>();
  const items = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  return { items, next_cursor: hasMore && items.length ? encodeCursor({ v: 1, scope, dir: 'before', seq: items.at(-1)!.created_seq, snapshot }) : null, has_more: hasMore, snapshot: String(snapshot), authorization: { policy_revision: boundary.policyRevision, history_from_seq: String(boundary.fromSeq), member_generation: String(boundary.memberGeneration) } };
}

/** Load a bounded window around a message ID without walking the room's oldest history. */
export async function messageContext(db: D1Database, principal: Principal, input: ContextInput) {
  const { room, boundary } = await authorized(db, principal, input.room_id);
  const columns = `m.message_id, m.room_id, m.sender_id, a.name AS sender_name, a.kind AS sender_kind,
    m.body_bytes, m.preview, m.created_at, m.created_seq, m.reply_to`;
  const base = await db.prepare(`SELECT ${columns} FROM messages m JOIN actors a ON a.actor_id=m.sender_id WHERE m.room_id=? AND m.message_id=?`).bind(room.room_id, input.message_id).first<MessageRow>();
  if (!base || base.created_seq < boundary.fromSeq || (boundary.toSeq !== null && base.created_seq > boundary.toSeq)) throw new BusinessError('NOT_FOUND', '消息不存在或当前历史授权不可见');
  const before = Math.min(input.before ?? LIMITS.messageContextDefault, LIMITS.messageContextMax);
  const after = Math.min(input.after ?? LIMITS.messageContextDefault, LIMITS.messageContextMax);
  const lower = boundary.full ? '1=1' : 'm.created_seq>=?';
  const bindsBefore: unknown[] = [room.room_id, base.created_seq, ...(boundary.full ? [] : [boundary.fromSeq]), before];
  const bindsAfter: unknown[] = [room.room_id, base.created_seq, ...(boundary.full ? [] : [boundary.fromSeq]), ...(boundary.toSeq === null ? [] : [boundary.toSeq]), after];
  const upper = boundary.toSeq === null ? '1=1' : 'm.created_seq<=?';
  const [prior, following] = await Promise.all([
    before ? db.prepare(`SELECT ${columns} FROM messages m JOIN actors a ON a.actor_id=m.sender_id WHERE m.room_id=? AND m.created_seq<? AND ${lower} ORDER BY m.created_seq DESC LIMIT ?`).bind(...bindsBefore).all<MessageRow>() : Promise.resolve({ results: [] as MessageRow[] }),
    after ? db.prepare(`SELECT ${columns} FROM messages m JOIN actors a ON a.actor_id=m.sender_id WHERE m.room_id=? AND m.created_seq>? AND ${lower} AND ${upper} ORDER BY m.created_seq ASC LIMIT ?`).bind(...bindsAfter).all<MessageRow>() : Promise.resolve({ results: [] as MessageRow[] }),
  ]);
  return { items: [...prior.results.reverse(), base, ...following.results], authorization: { policy_revision: boundary.policyRevision, history_from_seq: String(boundary.fromSeq), member_generation: String(boundary.memberGeneration) } };
}
