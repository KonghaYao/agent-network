/**
 * I04 故障注入子进程：在本地提交后、外部响应前后强制退出。
 *
 * 运行：bun scripts/lib/memory-crash-child.ts <db-path> <mode>
 * mode=business        业务消息 + 共享来源同批提交后退出（尚无 ExposureReceipt）
 * mode=before_external 回执/经历/retain 意图已提交，作业 pending 时退出
 * mode=after_external  远端已受理（provider_job_id 已写）但本地完成前退出
 */
import { ensureMemoryInstance } from '../../src/memory/access';
import { admitExposureReceipt, ensureSpaceForAgent, sourceMutationStatements } from '../../src/memory/store';
import { registerRepresentation } from '../../src/memory/store-objects';
import { sha256Hex } from '../../src/storage/db';
import {
  createMemoryEnv,
  experienceEntry,
  experienceKey,
  exposureReceipt,
  privateTarget,
  rawRepresentation,
  seedActor,
  seedManagement,
  seedRoom,
  spaceRef,
} from './memory-unit';

const AT = 1_700_000_000_000;

async function seed(dbPath: string) {
  const env = createMemoryEnv(dbPath);
  const instanceId = await ensureMemoryInstance(env.d1, { configuredId: 'mni_crash', now: AT });
  const human = 'usr_crash_human';
  const agent = 'agt_crash_agent';
  const room = 'rm_crash_direct';
  seedActor(env, { actorId: human, kind: 'human' });
  seedActor(env, { actorId: agent, kind: 'agent' });
  seedManagement(env, { agentId: agent, managerId: human });
  seedRoom(env, {
    roomId: room,
    kind: 'direct',
    ownerId: human,
    members: [
      { actorId: agent, memberGeneration: 1 },
      { actorId: human, memberGeneration: 1 },
    ],
    policyRevision: 0,
  });
  const space = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agent, now: AT });
  return { env, instanceId, human, agent, room, space };
}

async function sourceStatements(env: ReturnType<typeof createMemoryEnv>, room: string) {
  const sourceId = 'msrc_crash_source';
  const text = 'CRASH-RECOVERABLE-SOURCE';
  const hash = await sha256Hex(text);
  return {
    sourceId,
    statements: sourceMutationStatements(env.d1, {
      instanceId: 'mni_crash',
      sourceId,
      sourceKey: `msg_${room}_crash`,
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: JSON.stringify({ message_id: `msg_${room}_crash` }),
      originRoomId: room,
      originMemberGeneration: 1,
      originPolicyRevision: 0,
      originJoinedSeq: 0,
      originJoinedAt: 0,
      originArchiveHeadSeq: null,
      originSeq: 1,
      originCreatedAt: AT + 1,
      authorActorId: 'usr_crash_human',
      revision: 1,
      contentText: text,
      contentSha256: hash,
      contentBytes: new TextEncoder().encode(text).length,
      now: AT,
    }),
    text,
  };
}

async function commitBusinessOnly(dbPath: string): Promise<void> {
  const { env, room } = await seed(dbPath);
  const source = await sourceStatements(env, room);
  await env.d1.batch([
    env.d1
      .prepare(
        `INSERT INTO messages
           (message_id, room_id, sender_id, client_message_id, created_seq, body,
            body_bytes, preview, reply_to, root_id, hop, root_invocations_used, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
      )
      .bind(
        `msg_${room}_crash`,
        room,
        'usr_crash_human',
        'client_crash_1',
        source.text,
        source.text.length,
        source.text.slice(0, 20),
        AT,
      ),
    ...source.statements,
  ]);
  env.db.close();
}

async function commitAdmission(dbPath: string, mode: 'before_external' | 'after_external'): Promise<void> {
  const { env, instanceId, agent, room, space } = await seed(dbPath);
  const source = await sourceStatements(env, room);
  await env.d1.batch(source.statements);
  const representation = await rawRepresentation({
    sourceId: source.sourceId,
    sourceRevision: 1,
    text: source.text,
  });
  const retainId = 'mrt_crash';
  const admitted = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt: exposureReceipt({
      receiptId: 'mrc_crash',
      space: spaceRef(space),
      agentId: agent,
      targetScope: privateTarget(),
      originScopes: [
        {
          room_id: room,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
      invocationId: 'inv_crash',
    }),
    representations: [representation],
    experiences: [
      experienceEntry({
        experienceId: 'mexp_crash',
        key: experienceKey({
          space: spaceRef(space),
          agentId: agent,
          originRoomId: room,
          originMemberGeneration: 1,
          sourceId: source.sourceId,
          sourceRevision: 1,
          representation,
        }),
        originRoomId: room,
      }),
    ],
    retain: [
      {
        retainId,
        experienceId: 'mexp_crash',
        representationId: representation.representation.representation_id,
        sourceId: source.sourceId,
        sourceRevision: 1,
        originKind: 'experienced',
        evidence: 'host_reported_submitted',
      },
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 2,
  });
  if (admitted.disposition.disposition !== 'applied') throw new Error('admission did not apply');
  if (mode === 'after_external') {
    // 模拟远端已受理：provider_job_id 已落库，但本地完成/租约清理前进程退出。
    await env.d1
      .prepare(
        `UPDATE memory_jobs
            SET status = 'leased', attempt = 1, lease_id = 'lease_crash',
                lease_until = ?, provider_job_id = 'remote_job_crash',
                stage = 'source_applied', updated_at = ?
          WHERE retain_intent_id = ?`,
      )
      .bind(AT + 3, AT + 3, retainId)
      .run();
  }
  env.db.close();
}

const [dbPath, mode] = process.argv.slice(2);
if (!dbPath || !mode) {
  console.error('usage: bun scripts/lib/memory-crash-child.ts <db-path> <mode>');
  process.exit(2);
}

if (mode === 'business') {
  await commitBusinessOnly(dbPath);
} else if (mode === 'before_external' || mode === 'after_external') {
  await commitAdmission(dbPath, mode);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
process.exit(0);
