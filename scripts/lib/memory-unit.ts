/**
 * MF02/MF03 本地验收夹具：内存 SQLite + 真实 migrations + D1 兼容层。
 *
 * 不访问服务端、不读写 `.data`。所有身份、房间与来源使用唯一合成标记。
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { migrate } from '../../src/bun/migrate';
import { createD1 } from '../../src/bun/d1';
import { newId, sha256Hex } from '../../src/storage/db';
import type {
  MemoryExactRepresentation,
  MemoryExposureReceipt,
  MemoryOriginKind,
  MemoryRepresentationKind,
  MemorySpaceRef,
  MemoryTargetScope,
} from '../../src/memory/contracts';

export interface MemoryTestEnv {
  db: Database;
  d1: D1Database;
}

const MIGRATIONS = join(import.meta.dir, '../../migrations');

export function createMemoryEnv(path = ':memory:'): MemoryTestEnv {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, MIGRATIONS);
  return { db, d1: createD1(db) };
}

let seq = 0;
export function unique(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function seedActor(
  env: MemoryTestEnv,
  input: {
    actorId: string;
    kind: 'human' | 'agent';
    name?: string;
    disabled?: boolean;
    sessionId?: string;
    now?: number;
  },
): void {
  const at = input.now ?? 1_700_000_000_000;
  env.db
    .prepare(
      `INSERT INTO actors
         (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
          pending_count, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, ?, '{}', 0, 0, 0, ?, ?, ?)`,
    )
    .run(
      input.actorId,
      input.kind,
      input.kind === 'agent' ? input.sessionId ?? `sess_${input.actorId}` : null,
      input.name ?? input.actorId,
      at,
      at,
      input.disabled ? at : null,
    );
}

export function seedManagement(
  env: MemoryTestEnv,
  input: { agentId: string; managerId: string; bindingId?: string; now?: number },
): string {
  const at = input.now ?? 1_700_000_000_000;
  const bindingId = input.bindingId ?? `amb_${input.agentId}`;
  env.db
    .prepare(
      `INSERT INTO agent_managements
         (binding_id, agent_id, manager_id, status, grant_source, scopes_json,
          permission_version, initiated_by, confirmed_by, created_at, confirmed_at,
          expires_at, revoked_at, revoked_by, updated_at)
       VALUES (?, ?, ?, 'active', 'created', '[]', 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(bindingId, input.agentId, input.managerId, input.managerId, input.managerId, at, at, at);
  return bindingId;
}

export function seedRoom(
  env: MemoryTestEnv,
  input: {
    roomId: string;
    kind: 'direct' | 'group';
    ownerId: string | null;
    policy?: 'full' | 'from_join';
    policyRevision?: number;
    memberSeq?: number;
    headSeq?: number;
    dissolved?: boolean;
    archiveHeadSeq?: number | null;
    members: readonly {
      actorId: string;
      role?: 'owner' | 'member';
      joinedSeq?: number;
      joinedAt?: number;
      memberGeneration?: number;
      status?: 'active' | 'left' | 'removed';
    }[];
    now?: number;
  },
): void {
  const at = input.now ?? 1_700_000_000_000;
  env.db
    .prepare(
      `INSERT INTO rooms
         (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
          member_seq, last_message_id, created_at, updated_at, policy_revision,
          member_history_policy, dissolved_at, archive_head_seq)
       VALUES (?, ?, ?, '', NULL, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.roomId,
      input.kind,
      input.ownerId,
      input.headSeq ?? 0,
      input.memberSeq ?? input.members.length,
      at,
      at,
      input.policyRevision ?? 0,
      input.policy ?? 'full',
      input.dissolved ? at + 1 : null,
      input.archiveHeadSeq ?? null,
    );
  for (const member of input.members) {
    env.db
      .prepare(
        `INSERT INTO room_members
           (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
            member_generation, role_revision, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?)`,
      )
      .run(
        input.roomId,
        member.actorId,
        member.role ?? 'member',
        member.status ?? 'active',
        member.joinedSeq ?? 0,
        member.joinedAt ?? at,
        member.memberGeneration ?? 1,
        at,
      );
  }
}

export function updateRoomPolicy(
  env: MemoryTestEnv,
  roomId: string,
  input: { policy: 'full' | 'from_join'; revision: number },
): void {
  env.db
    .prepare(
      'UPDATE rooms SET member_history_policy = ?, policy_revision = ? WHERE room_id = ?',
    )
    .run(input.policy, input.revision, roomId);
}

export function joinRoomMember(
  env: MemoryTestEnv,
  roomId: string,
  input: {
    actorId: string;
    joinedSeq: number;
    memberGeneration: number;
    memberSeq: number;
    at?: number;
  },
): void {
  const at = input.at ?? 1_700_000_000_000;
  env.db
    .prepare(
      `INSERT INTO room_members
         (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
          member_generation, role_revision, updated_at)
       VALUES (?, ?, 'member', 'active', ?, 0, ?, ?, 1, ?)`,
    )
    .run(roomId, input.actorId, input.joinedSeq, at, input.memberGeneration, at);
  env.db.prepare('UPDATE rooms SET member_seq = ? WHERE room_id = ?').run(input.memberSeq, roomId);
}

export function leaveAndRejoin(
  env: MemoryTestEnv,
  roomId: string,
  actorId: string,
  input: { joinedSeq: number; memberGeneration: number; at?: number },
): void {
  const at = input.at ?? 1_700_000_000_000;
  env.db
    .prepare(
      `UPDATE room_members
          SET status = 'active', joined_seq = ?, last_read_seq = ?, joined_at = ?,
              member_generation = ?, updated_at = ?
        WHERE room_id = ? AND actor_id = ?`,
    )
    .run(input.joinedSeq, input.joinedSeq, at, input.memberGeneration, at, roomId, actorId);
}

export function spaceRef(row: {
  space_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
}): MemorySpaceRef {
  return {
    space_id: row.space_id,
    ownership_epoch: row.ownership_epoch,
    backend_binding_epoch: row.backend_binding_epoch,
  };
}

export function targetRoom(input: {
  roomId: string;
  memberGeneration: number;
  memberSeq: number;
  policyRevision: number;
}): MemoryTargetScope {
  return {
    audience: 'room',
    room_id: input.roomId,
    member_generation: input.memberGeneration,
    member_seq: input.memberSeq,
    policy_revision: input.policyRevision,
  };
}

export function privateTarget(): MemoryTargetScope {
  return {
    audience: 'agent_private',
    room_id: null,
    member_generation: null,
    member_seq: null,
    policy_revision: null,
  };
}

export async function rawRepresentation(input: {
  representationId?: string;
  sourceId: string;
  sourceRevision: number;
  text: string;
  kind?: 'raw_full' | 'raw_fragment' | 'preview';
  start?: number;
  end?: number;
}): Promise<MemoryExactRepresentation> {
  const bytes = new TextEncoder().encode(input.text).length;
  const kind = input.kind ?? 'raw_full';
  const start = input.start ?? 0;
  const end = input.end ?? bytes;
  return {
    representation: {
      representation_id: input.representationId ?? newId('mrp'),
      kind,
      source_id: input.sourceId,
      source_revision: input.sourceRevision,
      range: { start, end },
      depends_on: [],
      text_bytes: bytes,
      text_sha256: await sha256Hex(input.text),
      verbatim: true,
    },
    text: input.text,
  };
}

export async function summaryRepresentation(input: {
  representationId?: string;
  summaryId: string;
  revision: number;
  text: string;
  dependencies: readonly { source_id: string; source_revision: number }[];
}): Promise<MemoryExactRepresentation> {
  const bytes = new TextEncoder().encode(input.text).length;
  return {
    representation: {
      representation_id: input.representationId ?? newId('mrp'),
      kind: 'summary',
      summary_id: input.summaryId,
      revision: input.revision,
      depends_on: input.dependencies.map((dependency) => ({
        source_id: dependency.source_id,
        source_revision: dependency.source_revision,
        representation_id: null,
        range: null,
      })),
      partition_proof: null,
      text_bytes: bytes,
      text_sha256: await sha256Hex(input.text),
      verbatim: false,
    },
    text: input.text,
  };
}

export function exposureReceipt(input: {
  receiptId?: string;
  space: MemorySpaceRef;
  agentId: string;
  targetScope: MemoryTargetScope;
  originScopes: MemoryExposureReceipt['origin_scopes'];
  evidence?: 'host_reported_submitted' | 'gateway_observed_submitted';
  invocationId?: string;
  manifestHash?: string;
  payloadHash?: string;
  idempotencyKey?: string;
  proofId?: string;
  hostBindingId?: string;
}): MemoryExposureReceipt {
  const invocationId = input.invocationId ?? newId('inv');
  return {
    receipt_id: input.receiptId ?? newId('mrc'),
    kind: 'input_exposure',
    manifest_id: newId('mmf'),
    manifest_sha256: input.manifestHash ?? 'a'.repeat(64),
    payload_sha256: input.payloadHash ?? 'b'.repeat(64),
    invocation: {
      host_binding_id: input.hostBindingId ?? 'mhb_test',
      host_generation: 1,
      session_incarnation: 'sess_test',
      run_id: 'run_test',
      input_id: 'input_test',
      input_revision: 1,
      invocation_id: invocationId,
    },
    space: input.space,
    agent_actor_id: input.agentId,
    origin_scopes: input.originScopes,
    target_scope: input.targetScope,
    evidence: input.evidence ?? 'host_reported_submitted',
    proof_id: input.proofId ?? newId('mpf'),
    submitted_at: 1_700_000_000_000,
    idempotency_key: input.idempotencyKey ?? newId('idem'),
  };
}

export function experienceKey(input: {
  space: MemorySpaceRef;
  agentId: string;
  originRoomId: string;
  originMemberGeneration: number;
  sourceId: string | null;
  sourceRevision: number | null;
  representation: MemoryExactRepresentation;
}): {
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  origin_room_id: string;
  origin_member_generation: number;
  source_id: string | null;
  source_revision: number | null;
  representation_id: string;
  representation_kind: MemoryRepresentationKind;
  range: { start: number; end: number } | null;
  text_sha256: string;
} {
  const representation = input.representation.representation;
  return {
    space_id: input.space.space_id,
    ownership_epoch: input.space.ownership_epoch,
    agent_actor_id: input.agentId,
    origin_room_id: input.originRoomId,
    origin_member_generation: input.originMemberGeneration,
    source_id: input.sourceId,
    source_revision: input.sourceRevision,
    representation_id: representation.representation_id,
    representation_kind: representation.kind,
    range:
      representation.kind === 'raw_full' ||
      representation.kind === 'raw_fragment' ||
      representation.kind === 'preview'
        ? representation.range
        : null,
    text_sha256: representation.text_sha256,
  };
}

export function experienceEntry(input: {
  experienceId?: string;
  key: ReturnType<typeof experienceKey>;
  originKind?: MemoryOriginKind;
  originRoomId: string;
  producerKind?: 'agent_text' | 'server_template' | 'mixed' | null;
}): {
  experienceId: string;
  key: ReturnType<typeof experienceKey>;
  originKind: MemoryOriginKind;
  producerKind: 'agent_text' | 'server_template' | 'mixed' | null;
  originRoomId: string;
} {
  return {
    experienceId: input.experienceId ?? newId('mexp'),
    key: input.key,
    originKind: input.originKind ?? 'experienced',
    producerKind: input.producerKind ?? null,
    originRoomId: input.originRoomId,
  };
}
