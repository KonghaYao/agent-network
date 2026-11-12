/**
 * MF11 验收共享夹具：内存 SQLite、真实迁移、HostBinding 与消息/来源播种。
 *
 * 两个验收脚本共用，避免重复定义身份、空间、manifest 与补读 fixture。
 */
import { BusinessError } from '../../src/contracts/errors';
import { sha256Hex } from '../../src/storage/db';
import { requireCurrentMemorySpace } from '../../src/memory/access';
import { bindMemoryHost } from '../../src/memory/store-objects';
import {
  ensureSpaceForAgent,
  runMemoryBatch,
  sourceMutationStatements,
} from '../../src/memory/store';
import type {
  MemoryContextTarget,
  MemoryExactRepresentation,
  MemoryInvocationIdentity,
  MemorySpaceRef,
  MemoryTargetScope,
} from '../../src/memory/contracts';
import { check, checkEqual } from './harness';
import {
  privateTarget,
  seedActor,
  seedManagement,
  seedRoom,
  spaceRef,
  unique,
  type MemoryTestEnv,
} from './memory-unit';

export const AT = 1_700_000_000_000;
export const instanceId = 'mni_mf11';

export async function expectCode(label: string, promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    check(label, false, 'expected BusinessError');
  } catch (error) {
    checkEqual(label, error instanceof BusinessError ? error.code : 'UNKNOWN', code);
  }
}

export async function addSource(
  env: MemoryTestEnv,
  input: {
    sourceId?: string;
    sourceKey: string;
    roomId: string;
    memberGeneration?: number;
    policyRevision?: number;
    seq?: number;
    text?: string;
    authorActorId?: string | null;
  },
): Promise<{ sourceId: string; text: string; revision: number }> {
  const sourceId = input.sourceId ?? unique('msrc');
  const text = input.text ?? `SOURCE-${sourceId}`;
  const hash = await sha256Hex(text);
  const bytes = new TextEncoder().encode(text).length;
  await runMemoryBatch(
    env.d1,
    sourceMutationStatements(env.d1, {
      instanceId,
      sourceId,
      sourceKey: input.sourceKey,
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: JSON.stringify({ message_id: input.sourceKey }),
      originRoomId: input.roomId,
      originMemberGeneration: input.memberGeneration ?? 1,
      originPolicyRevision: input.policyRevision ?? 0,
      originJoinedSeq: 0,
      originJoinedAt: 0,
      originArchiveHeadSeq: null,
      originSeq: input.seq ?? 1,
      originCreatedAt: AT + (input.seq ?? 1),
      authorActorId: input.authorActorId ?? null,
      revision: 1,
      contentText: text,
      contentSha256: hash,
      contentBytes: bytes,
      now: AT,
    }),
  );
  return { sourceId, text, revision: 1 };
}

export function insertMessage(
  env: MemoryTestEnv,
  input: {
    messageId: string;
    roomId: string;
    senderId: string;
    seq: number;
    body: string;
  },
): void {
  const bytes = new TextEncoder().encode(input.body).length;
  env.db
    .prepare(
      `INSERT INTO messages
         (message_id, room_id, sender_id, client_message_id, created_seq, body,
          body_bytes, preview, reply_to, root_id, hop, root_invocations_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
    )
    .run(
      input.messageId,
      input.roomId,
      input.senderId,
      unique('cmid'),
      input.seq,
      input.body,
      bytes,
      input.body.slice(0, 20),
      AT + input.seq,
    );
  env.db
    .prepare(
      `UPDATE rooms
          SET head_seq = MAX(head_seq, ?), last_message_id = ?, updated_at = ?
        WHERE room_id = ?`,
    )
    .run(input.seq, input.messageId, AT + input.seq, input.roomId);
}

export async function setupAgentRoom(env: MemoryTestEnv, name: string) {
  const agent = unique(`agent_${name}`);
  const manager = unique(`human_${name}`);
  const room = unique(`room_${name}`);
  seedActor(env, { actorId: agent, kind: 'agent', name: agent });
  seedActor(env, { actorId: manager, kind: 'human', name: manager });
  seedManagement(env, { agentId: agent, managerId: manager });
  seedRoom(env, {
    roomId: room,
    kind: 'direct',
    ownerId: manager,
    members: [
      { actorId: agent, role: 'member' },
      { actorId: manager, role: 'owner' },
    ],
    now: AT,
  });
  const spaceRow = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agent, now: AT });
  return { agent, manager, room, space: spaceRef(spaceRow) };
}

export async function bindHost(
  env: MemoryTestEnv,
  input: {
    agentId: string;
    space: MemorySpaceRef;
    trustLevel?: 'api_tool_only' | 'adapted_host' | 'controlled_gateway';
    session?: string;
  },
) {
  return bindMemoryHost(env.d1, {
    instanceId,
    agentId: input.agentId,
    space: input.space,
    credentialId: unique('cred'),
    sessionIncarnation: input.session ?? unique('session'),
    declaredCapabilities: [
      'explicit_lookup',
      'run_binding',
      'async_supplement',
      'final_manifest_report',
      'submission_evidence',
      'gateway_observation',
      'history_isolation',
    ],
    trustLevel: input.trustLevel ?? 'controlled_gateway',
    leaseUntil: null,
    now: AT,
  });
}

export function invocation(bindingId: string, generation: number, id: string): MemoryInvocationIdentity {
  return {
    host_binding_id: bindingId,
    host_generation: generation,
    session_incarnation: 'sess_bound',
    run_id: `run_${id}`,
    input_id: `input_${id}`,
    input_revision: 1,
    invocation_id: `inv_${id}`,
  };
}

export async function messageTarget(
  env: MemoryTestEnv,
  input: {
    agentId: string;
    space: MemorySpaceRef;
    bindingId: string;
    generation: number;
    inv: MemoryInvocationIdentity;
    targetScope: MemoryTargetScope;
    roomId: string;
  },
): Promise<MemoryContextTarget> {
  const context = await requireCurrentMemorySpace(env.d1, {
    agentId: input.agentId,
    instanceId,
    expected: input.space,
    roomIds: [input.roomId],
    at: AT,
  });
  return {
    kind: 'message',
    agent_actor_id: input.agentId,
    space: input.space,
    host_binding_id: input.bindingId,
    host_generation: input.generation,
    session_incarnation: input.inv.session_incarnation,
    run_id: input.inv.run_id,
    input_id: input.inv.input_id,
    input_revision: input.inv.input_revision,
    target_scope: input.targetScope,
    versions: context.versions,
    message: {
      message_id: 'msg_target',
      delivery_id: 'dlv_target',
      attempt: 0,
      claim_id: 'clm_target',
    },
  };
}

export async function authoredRepresentation(input: {
  sourceId: string;
  sourceRevision: number;
  text: string;
  producerKind: 'agent_text' | 'server_template' | 'mixed';
}): Promise<MemoryExactRepresentation> {
  const bytes = new TextEncoder().encode(input.text).length;
  return {
    representation: {
      representation_id: unique('mrp_authored'),
      kind: 'authored',
      source_id: input.sourceId,
      source_revision: input.sourceRevision,
      producer_kind: input.producerKind,
      lineage: 'run_bound',
      depends_on: [],
      text_bytes: bytes,
      text_sha256: await sha256Hex(input.text),
      verbatim: true,
    },
    text: input.text,
  };
}

