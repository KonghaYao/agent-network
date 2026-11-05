import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { RoomMonitorGetInput, RoomMonitorSetInput } from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import { guardSql } from '../storage/guards';
import {
  getActorRoomMonitor,
  getMember,
  getOperation,
  getRoom,
} from '../storage/queries';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';

/**
 * 网页监控面板地址：按 human actor + room 私有保存。
 *
 * - 只有 human 可读写；Agent 没有网页 UI，调用返回 INVALID_ARGUMENT。
 * - 只保存用户填写的 http/https URL，服务端不抓取、不代理、不访问该地址。
 * - 写操作走 runIdempotent；不写 events/outbox，不改变 head、未读或 pending。
 * - URL 可能包含签名/访问令牌：错误信息与日志都不回显完整地址。
 */

export interface RoomMonitorView {
  room_id: string;
  url: string;
  updated_at: string;
}

export interface RoomMonitorResult {
  monitor: RoomMonitorView | null;
}

function requireHuman(principal: Principal): void {
  if (!principal.actor || principal.actor.kind !== 'human') {
    throw new BusinessError('INVALID_ARGUMENT', '网页监控仅支持 human 身份');
  }
}

async function requireRoomMember(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<string> {
  const caller = actorId(principal);
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  return caller;
}

/**
 * null / 空串 / 纯空白表示清除；只接受 http/https。
 * 返回值是 URL 规范化后的 href，存储与展示都以它为准。
 */
export function normalizeRoomMonitorUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BusinessError('INVALID_ARGUMENT', '网址格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BusinessError('INVALID_ARGUMENT', '只允许 http 或 https 网址');
  }
  if (utf8Bytes(parsed.href) > LIMITS.roomMonitorUrlMax) {
    throw new BusinessError('INVALID_ARGUMENT', '网址超过长度上限');
  }
  return parsed.href;
}

function monitorView(
  roomId: string,
  url: string,
  updatedAt: number,
): RoomMonitorView {
  return { room_id: roomId, url, updated_at: String(updatedAt) };
}

export async function roomMonitorGet(
  db: D1Database,
  principal: Principal,
  input: RoomMonitorGetInput,
): Promise<RoomMonitorResult> {
  requireHuman(principal);
  const caller = await requireRoomMember(db, principal, input.room_id);
  const row = await getActorRoomMonitor(db, caller, input.room_id);
  return { monitor: row ? monitorView(row.room_id, row.url, row.updated_at) : null };
}

export async function roomMonitorSet(
  db: D1Database,
  principal: Principal,
  input: RoomMonitorSetInput,
): Promise<RoomMonitorResult> {
  requireHuman(principal);
  const caller = await requireRoomMember(db, principal, input.room_id);
  const url = normalizeRoomMonitorUrl(input.url);
  const payloadHash = await sha256Hex(
    stableStringify({ room_id: input.room_id, url }),
  );

  // 幂等重放先于写入；与 room-files 一致，重放不依赖当前行状态。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) {
    return resolveOperation(replay, payloadHash) as RoomMonitorResult;
  }

  const at = nowMs();
  const result: RoomMonitorResult =
    url === null ? { monitor: null } : { monitor: monitorView(input.room_id, url, at) };

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'notMember',
            'NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = \'active\')',
          ),
        )
        .bind(input.room_id, caller),
      url === null
        ? db
            .prepare('DELETE FROM actor_room_monitors WHERE actor_id = ? AND room_id = ?')
            .bind(caller, input.room_id)
        : db
            .prepare(
              `INSERT INTO actor_room_monitors (actor_id, room_id, url, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(actor_id, room_id)
               DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
            )
            .bind(caller, input.room_id, url, at, at),
    ],
  });

  return result;
}
