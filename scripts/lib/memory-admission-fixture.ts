/**
 * MF10 集成夹具：真实迁移 + 来源 + 合格 ExposureReceipt + retain 意图。
 *
 * 只用于本地临时 SQLite；不连接服务端、不读取生产凭据。
 */
import { ensureMemoryInstance } from '../../src/memory/access';
import { admitExposureReceipt, ensureSpaceForAgent, sourceMutationStatements } from '../../src/memory/store';
import { registerRepresentation } from '../../src/memory/store-objects';
import { sha256Hex } from '../../src/storage/db';
import type { MemorySpaceRef } from '../../src/memory/contracts';
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
  type MemoryTestEnv,
} from './memory-unit';

export const MEMORY_INTEGRATION_AT = 1_700_000_000_000;

export interface MemoryAdmissionFixture {
  env: MemoryTestEnv;
  instanceId: string;
  human: string;
  agent: string;
  room: string;
  space: MemorySpaceRef;
  sourceId: string;
  sourceRevision: number;
  text: string;
  representationId: string;
  receiptId: string;
  retainId: string;
}

export async function seedMemoryAdmission(
  dbPath: string,
  options: {
    instanceId?: string;
    text?: string;
    agentId?: string;
    roomId?: string;
    now?: number;
  } = {},
): Promise<MemoryAdmissionFixture> {
  const at = options.now ?? MEMORY_INTEGRATION_AT;
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const instanceId = options.instanceId ?? `mni_integration_${suffix}`;
  const human = `usr_integration_human_${suffix}`;
  const agent = options.agentId ?? `agt_integration_agent_${suffix}`;
  const room = options.roomId ?? `rm_integration_direct_${suffix}`;
  const sourceId = `msrc_integration_${suffix}`;
  const text = options.text ?? `INTEGRATION-SOURCE-${suffix}`;
  const env = createMemoryEnv(dbPath);
  await ensureMemoryInstance(env.d1, { configuredId: instanceId, now: at });
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
  const space = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agent, now: at });
  const hash = await sha256Hex(text);
  await env.d1.batch(
    sourceMutationStatements(env.d1, {
      instanceId,
      sourceId,
      sourceKey: `msg_${room}_integration`,
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: JSON.stringify({ message_id: `msg_${room}_integration` }),
      originRoomId: room,
      originMemberGeneration: 1,
      originPolicyRevision: 0,
      originJoinedSeq: 0,
      originJoinedAt: 0,
      originArchiveHeadSeq: null,
      originSeq: 1,
      originCreatedAt: at + 1,
      authorActorId: human,
      revision: 1,
      contentText: text,
      contentSha256: hash,
      contentBytes: new TextEncoder().encode(text).length,
      now: at,
    }),
  );
  const representation = await rawRepresentation({
    sourceId,
    sourceRevision: 1,
    text,
  });
  await registerRepresentation(env.d1, { instanceId, exact: representation, now: at + 1 });
  const receiptId = `mrc_integration_${suffix}`;
  const retainId = `mrt_integration_${suffix}`;
  const admitted = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt: exposureReceipt({
      receiptId,
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
      invocationId: `inv_integration_${suffix}`,
    }),
    representations: [representation],
    experiences: [
      experienceEntry({
        experienceId: `mexp_integration_${suffix}`,
        key: experienceKey({
          space: spaceRef(space),
          agentId: agent,
          originRoomId: room,
          originMemberGeneration: 1,
          sourceId,
          sourceRevision: 1,
          representation,
        }),
        originRoomId: room,
      }),
    ],
    retain: [
      {
        retainId,
        experienceId: `mexp_integration_${suffix}`,
        representationId: representation.representation.representation_id,
        sourceId,
        sourceRevision: 1,
        originKind: 'experienced',
        evidence: 'host_reported_submitted',
      },
    ],
    minimumEvidence: 'host_reported_submitted',
    now: at + 2,
  });
  if (admitted.disposition.disposition !== 'applied') {
    throw new Error(`admission did not apply: ${admitted.disposition.reason ?? 'unknown'}`);
  }
  return {
    env,
    instanceId,
    human,
    agent,
    room,
    space,
    sourceId,
    sourceRevision: 1,
    text,
    representationId: representation.representation.representation_id,
    receiptId,
    retainId,
  };
}
