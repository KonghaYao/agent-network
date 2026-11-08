/**
 * 长历史性能基准的确定性数据夹具。
 *
 * 直接写 SQLite 文件，不经过业务工具调用：同一份 fixture 可以在任何提交上
 * 复现，基线（改动前）与优化后使用完全相同的数据分布。所有时间值都是固定
 * 基准时间加偏移，游标与分页稳定，不受运行时钟影响。
 *
 * 规模：
 * - small：10,000 条主房间消息、1,000 条 presence、约 10,100 条投递；
 * - full：100,000 条主房间消息、10,000 条 presence、约 100,100 条投递。
 *
 * 正文长度按真实长消息场景分布：每 20 条一条大消息（small 8 KiB /
 * full 2 KiB），其余为短消息。夹具只用于测量查询路径，不写生产库。
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { migrate } from '../../src/bun/migrate';

export type PerfScale = 'small' | 'full';

export interface PerfCounts {
  mainMessages: number;
  totalMessages: number;
  presence: number;
  deliveries: number;
  rooms: number;
  actors: number;
}

export interface PerfFixture {
  db: Database;
  dbPath: string;
  scale: PerfScale;
  viewerId: string;
  agentIds: string[];
  roomId: string;
  counts: PerfCounts;
  cleanup: () => void;
}

const BASE_AT = 1_760_000_000_000;
const MAIN_ROOM = 'room_perf_main';
const EXTRA_ROOMS = 20;
const EXTRA_MESSAGES_PER_ROOM = 5;

function messageBody(scale: PerfScale, index: number): string {
  const largeBytes = scale === 'small' ? 8 * 1024 : 2 * 1024;
  if (index % 20 === 0) {
    // 可读前缀 + 重复字符，避免 JSON/UTF-8 边界带来的特殊处理。
    return `large-${index}-` + 'x'.repeat(largeBytes);
  }
  return `message-${index}-` + 'y'.repeat(160);
}

function deliveryState(index: number): string {
  // 每个 recipient 至多一条 claimed（0001 的部分唯一索引）；只给前 20 条。
  if (index < 20) return 'claimed';
  return ['pending', 'completed', 'failed', 'cancelled'][index % 4]!;
}

export function createPerfFixture(scale: PerfScale): PerfFixture {
  const mainMessages = scale === 'small' ? 10_000 : 100_000;
  const presenceCount = mainMessages / 10;
  const extraMessages = EXTRA_ROOMS * EXTRA_MESSAGES_PER_ROOM;
  // 20 个接收者；每条消息一条投递，claimed 固定落在前 20 条且 recipient 唯一。
  const recipientCount = 20;
  const viewerId = 'actor_perf_human';
  const agentIds = ['actor_perf_agent_a', 'actor_perf_agent_b', 'actor_perf_agent_c'];
  const dir = mkdtempSync(join(tmpdir(), 'agent-network-perf-'));
  const dbPath = join(dir, 'perf.sqlite');
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;');
  migrate(db, resolve(import.meta.dir, '../../migrations'));

  const actors = [viewerId, ...agentIds];
  for (let i = 0; i < recipientCount; i += 1) actors.push(`actor_perf_recipient_${i}`);
  const insertActor = db.prepare(
    `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?)`,
  );
  const insertRoom = db.prepare(
    `INSERT INTO rooms (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq,
                        last_message_id, created_at, updated_at)
     VALUES (?, 'direct', ?, ?, ?, 0, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
     VALUES (?, ?, ?, 'active', 0, 0, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                           body, body_bytes, preview, reply_to, root_id, hop,
                           root_invocations_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
  );
  const insertPresence = db.prepare(
    `INSERT INTO room_presence_events (presence_event_id, room_id, agent_id, generation_id,
                                       transition, occurred_at, recorded_at, timeline_seq, time_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observed')`,
  );
  const insertDelivery = db.prepare(
    `INSERT INTO deliveries (delivery_id, recipient_id, message_id, room_id, state, attempt,
                             claim_id, claimed_at, progress_at, created_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const actorId of actors) {
      const kind = actorId.startsWith('actor_perf_agent_') ? 'agent' : 'human';
      insertActor.run(
        actorId,
        kind,
        kind === 'agent' ? `session_${actorId}` : null,
        actorId,
        BASE_AT,
        BASE_AT,
      );
    }

    const totalMainSeq = mainMessages;
    insertRoom.run(
      MAIN_ROOM,
      viewerId,
      '性能主房间',
      totalMainSeq,
      totalMainSeq,
      null,
      BASE_AT,
      BASE_AT + totalMainSeq * 1_000,
    );
    insertMember.run(MAIN_ROOM, viewerId, 'owner', BASE_AT);
    for (const agentId of agentIds) insertMember.run(MAIN_ROOM, agentId, 'member', BASE_AT);

    for (let i = 0; i < mainMessages; i += 1) {
      const index = i + 1;
      const body = messageBody(scale, i);
      insertMessage.run(
        `msg_perf_${index}`,
        MAIN_ROOM,
        i % 3 === 0 ? viewerId : agentIds[i % agentIds.length]!,
        `client_perf_${index}`,
        index,
        body,
        Buffer.byteLength(body, 'utf8'),
        body.slice(0, 160),
        BASE_AT + index * 1_000,
      );
      insertDelivery.run(
        `del_perf_${index}`,
        `actor_perf_recipient_${i % recipientCount}`,
        `msg_perf_${index}`,
        MAIN_ROOM,
        deliveryState(i),
        BASE_AT + index * 1_000,
        index,
        BASE_AT + index * 1_000,
        BASE_AT + index * 1_000,
      );
    }
    db.prepare('UPDATE rooms SET last_message_id = ? WHERE room_id = ?').run(
      `msg_perf_${mainMessages}`,
      MAIN_ROOM,
    );

    for (let j = 0; j < presenceCount; j += 1) {
      // 与消息时间交错，覆盖 timeline 的双源展示顺序。
      const timelineSeq = Math.max(1, Math.floor(((j + 1) * mainMessages) / (presenceCount + 1)));
      insertPresence.run(
        `pres_perf_${j + 1}`,
        MAIN_ROOM,
        agentIds[j % agentIds.length]!,
        `generation_perf_${j + 1}`,
        j % 2 === 0 ? 'online' : 'offline',
        BASE_AT + (j + 1) * 5_000,
        BASE_AT + (j + 1) * 5_000,
        timelineSeq,
      );
    }

    // 额外房间只用于 rooms_list 的成员/最后消息 join，各带 5 条消息。
    for (let r = 0; r < EXTRA_ROOMS; r += 1) {
      const roomId = `room_perf_extra_${r}`;
      let lastMessageId: string | null = null;
      for (let m = 0; m < EXTRA_MESSAGES_PER_ROOM; m += 1) {
        const seq = m + 1;
        const messageId = `msg_perf_extra_${r}_${seq}`;
        const body = `extra-${r}-${seq}`;
        insertMessage.run(
          messageId,
          roomId,
          agentIds[r % agentIds.length]!,
          `client_perf_extra_${r}_${seq}`,
          seq,
          body,
          Buffer.byteLength(body, 'utf8'),
          body,
          BASE_AT + r * 10_000 + seq * 1_000,
        );
        lastMessageId = messageId;
      }
      insertRoom.run(
        roomId,
        viewerId,
        `性能房间 ${r}`,
        EXTRA_MESSAGES_PER_ROOM,
        EXTRA_MESSAGES_PER_ROOM,
        lastMessageId,
        BASE_AT + r * 10_000,
        BASE_AT + r * 10_000 + EXTRA_MESSAGES_PER_ROOM * 1_000,
      );
      insertMember.run(roomId, viewerId, 'owner', BASE_AT);
    }
  })();

  db.exec('ANALYZE;');

  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    db,
    dbPath,
    scale,
    viewerId,
    agentIds,
    roomId: MAIN_ROOM,
    counts: {
      mainMessages,
      totalMessages: mainMessages + extraMessages,
      presence: presenceCount,
      deliveries: mainMessages,
      rooms: EXTRA_ROOMS + 1,
      actors: actors.length,
    },
    cleanup,
  };
}
