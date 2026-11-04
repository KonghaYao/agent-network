import {
  McpServer,
  ResourceNotFoundError,
} from '@modelcontextprotocol/server';

import { LIMITS } from '../contracts/limits';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';

const CACHE_HINT = { ttlMs: 0, cacheScope: 'private' as const };

function withUri(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(value),
      },
    ],
  };
}

/**
 * 只注册唯一 per-actor 资源 `agentnet://stream`。
 *
 * 旧 `agentnet://me`、inbox 与 room head 已在 cutover 中删除；对它们的
 * 读取由 `src/app.ts` 在进入 SDK 前返回 `INVALID_ARGUMENT`，这里不再提供
 * 兼容注册。
 */
export function registerResources(
  server: McpServer,
  env: Env,
  principal: Principal,
): void {
  const db = env.DB;

  server.registerResource(
    'stream',
    'agentnet://stream',
    {
      mimeType: 'application/json',
      description: '当前 actor 的统一投递流快照（身份、在线、待办与房间摘要）',
      cacheHint: CACHE_HINT,
    },
    async (uri) => {
      const actor = principal.actor;
      if (!actor) throw new ResourceNotFoundError(uri.href, '凭据尚未注册');
      const rooms = await db
        .prepare(
          `SELECT r.room_id, r.kind, r.title, r.head_seq, r.member_seq, m.last_read_seq
             FROM room_members m JOIN rooms r ON r.room_id = m.room_id
            WHERE m.actor_id = ? AND m.status = 'active'
            ORDER BY r.updated_at DESC, r.room_id DESC`,
        )
        .bind(actor.actor_id)
        .all<{
          room_id: string;
          kind: 'direct' | 'group';
          title: string;
          head_seq: number;
          member_seq: number;
          last_read_seq: number;
        }>();
      const online =
        actor.kind === 'agent'
          ? env.NOTIFICATION_HUB.actorPresence(actor.actor_id).online
          : null;

      return withUri(uri, {
        v: 1,
        stream_uri: 'agentnet://stream',
        actor_id: actor.actor_id,
        kind: actor.kind,
        name: actor.name,
        online,
        pending_count: actor.pending_count,
        inbox_head_seq: String(actor.inbox_head_seq),
        rooms: rooms.results.map((room) => ({
          room_id: room.room_id,
          kind: room.kind,
          title: room.title,
          head_seq: String(room.head_seq),
          my_last_read_seq: String(room.last_read_seq),
          unread: room.last_read_seq !== room.head_seq,
          member_seq: String(room.member_seq),
        })),
        limits: {
          stream_batch_max: LIMITS.streamBatchMax,
          stream_envelope_bytes: LIMITS.hintBytes,
        },
      });
    },
  );
}
