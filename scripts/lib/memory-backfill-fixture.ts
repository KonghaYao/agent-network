/**
 * 定时回填验收的共享 fixture。
 *
 * 只放跨脚本复用的固定时间、环境构造与消息/成员插入；具体断言留在各
 * verify-memory-backfill*.ts 中，避免测试脚本互相导入断言。
 */
import { MemoryBackfill } from '../../src/memory/backfill';
import { createBackfillWindow } from '../../src/memory/backfill-window';
import { ensureMemoryInstance } from '../../src/memory/access';
import { ensureSpaceForAgent } from '../../src/memory/store';
import { createMemoryEnv, seedActor, seedManagement, seedRoom, spaceRef, unique } from './memory-unit';

export const AT = 1_700_000_000_000;
export const W = 3_600_000;
export const WINDOW = createBackfillWindow(AT, W);
export const MESSAGE_AT = WINDOW.from + 60_000;

export type Env = ReturnType<typeof createMemoryEnv>;

export { unique };

export function count(env: Env, sql: string, ...binds: (string | number)[]): number {
  const row = env.db.prepare(sql).get(...binds) as { n: number } | null;
  return row?.n ?? 0;
}

/** 与 `collectSources` 相同的 experience 关联门。 */
export function sourceGateCount(
  env: Env,
  input: { roomId: string; spaceId: string; epoch: number; agentId: string },
): number {
  return count(
    env,
    `SELECT COUNT(*) AS n FROM memory_sources s
      WHERE s.state = 'active'
        AND s.origin_room_id = ?
        AND EXISTS (
              SELECT 1 FROM memory_experiences e
               WHERE e.source_id = s.source_id
                 AND e.source_revision = s.revision
                 AND e.space_id = ?
                 AND e.ownership_epoch = ?
                 AND e.agent_actor_id = ?
                 AND e.available = 1
                 AND e.origin_room_id = ?
            )`,
    input.roomId,
    input.spaceId,
    input.epoch,
    input.agentId,
    input.roomId,
  );
}

export function insertMessage(
  env: Env,
  input: {
    messageId: string;
    roomId: string;
    senderId: string;
    seq: number;
    body: string;
    createdAt: number;
    bodyBytes?: number;
  },
): void {
  const bytes = new TextEncoder().encode(input.body).length;
  env.db
    .prepare(
      `INSERT INTO messages
         (message_id, room_id, sender_id, client_message_id, created_seq, body,
          body_bytes, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.roomId,
      input.senderId,
      `client_${input.messageId}`,
      input.seq,
      input.body,
      input.bodyBytes ?? bytes,
      input.body.slice(0, 32),
      input.createdAt,
    );
}

export function addMember(
  env: Env,
  roomId: string,
  input: { actorId: string; memberGeneration?: number; joinedSeq?: number; joinedAt?: number },
): void {
  env.db
    .prepare(
      `INSERT INTO room_members
         (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
          member_generation, role_revision, updated_at)
       VALUES (?, ?, 'member', 'active', ?, 0, ?, ?, 1, ?)`,
    )
    .run(
      roomId,
      input.actorId,
      input.joinedSeq ?? 0,
      input.joinedAt ?? AT,
      input.memberGeneration ?? 1,
      AT,
    );
}

export interface BackfillFixture {
  env: Env;
  instanceId: string;
  human: string;
  agentA: string;
  agentB: string;
  roomOne: string;
  roomTwo: string;
  spaceA: { space_id: string; ownership_epoch: number; backend_binding_epoch: number };
  spaceB: { space_id: string; ownership_epoch: number; backend_binding_epoch: number };
}

export async function seedFixture(
  options: { agents?: number; captureDefault?: 'enabled' | 'disabled' } = {},
): Promise<BackfillFixture> {
  const env = createMemoryEnv(':memory:');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const instanceId = await ensureMemoryInstance(env.d1, {
    configuredId: `mni_bf_${suffix}`,
    now: AT,
    captureDefault: options.captureDefault ?? 'enabled',
  });
  const human = `usr_bf_human_${suffix}`;
  const agentA = `agt_bf_a_${suffix}`;
  const agentB = `agt_bf_b_${suffix}`;
  const roomOne = `rm_bf_one_${suffix}`;
  const roomTwo = `rm_bf_two_${suffix}`;
  seedActor(env, { actorId: human, kind: 'human' });
  seedActor(env, { actorId: agentA, kind: 'agent' });
  seedActor(env, { actorId: agentB, kind: 'agent' });
  seedManagement(env, { agentId: agentA, managerId: human });
  seedManagement(env, { agentId: agentB, managerId: human });
  seedRoom(env, {
    roomId: roomOne,
    kind: 'group',
    ownerId: human,
    policyRevision: 0,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentA, memberGeneration: 1 },
      { actorId: agentB, memberGeneration: 1 },
    ],
  });
  seedRoom(env, {
    roomId: roomTwo,
    kind: 'direct',
    ownerId: human,
    policyRevision: 0,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentB, memberGeneration: 1 },
    ],
  });
  const spaceA = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agentA, now: AT });
  const spaceB = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agentB, now: AT });
  return {
    env,
    instanceId,
    human,
    agentA,
    agentB,
    roomOne,
    roomTwo,
    spaceA: spaceRef(spaceA),
    spaceB: spaceRef(spaceB),
  };
}

export function backfill(fixture: BackfillFixture, logs: string[] = []): MemoryBackfill {
  return new MemoryBackfill({
    db: fixture.env.d1,
    instanceId: fixture.instanceId,
    now: () => AT,
    log: (message, detail) => {
      logs.push(`${message} ${JSON.stringify(detail)}`);
    },
  });
}
