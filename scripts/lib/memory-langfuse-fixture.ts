/**
 * MF09 Langfuse 验收夹具：在临时 SQLite 中写入 manifest/context 所需的业务来源。
 *
 * 这些来源模拟 WeBots 已有业务事实，不代表 Langfuse 可以直接创建它们。
 */
import { memoryRepresentationInsertStatements } from '../../src/memory/representation-statements';
import { runMemoryBatch, sourceMutationStatements } from '../../src/memory/store';
import { sha256Hex, utf8Bytes } from '../../src/storage/db';
import { unique, type MemoryTestEnv } from './memory-unit';

export async function seedLfRawSource(
  env: MemoryTestEnv,
  input: {
    instanceId: string;
    roomId: string;
    agentId: string;
    text: string;
    sourceKey?: string;
    createdAt?: number;
    at: number;
  },
): Promise<{
  sourceId: string;
  representationId: string;
  text: string;
  digest: string;
  bytes: number;
}> {
  const sourceId = unique('msrc_lf_seed');
  const representationId = unique('mrep_lf_seed');
  const text = input.text;
  const digest = await sha256Hex(text);
  const bytes = utf8Bytes(text);
  const createdAt = input.createdAt ?? input.at;
  await runMemoryBatch(env.d1, [
    ...sourceMutationStatements(env.d1, {
      sourceId,
      instanceId: input.instanceId,
      sourceKey: input.sourceKey ?? `seed:${sourceId}`,
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: JSON.stringify({ message_id: sourceId, created_seq: 1 }),
      originRoomId: input.roomId,
      originMemberGeneration: 1,
      originPolicyRevision: 0,
      originJoinedSeq: 0,
      originJoinedAt: input.at,
      originArchiveHeadSeq: null,
      originSeq: 1,
      originCreatedAt: createdAt,
      authorActorId: null,
      revision: 1,
      contentText: text,
      contentSha256: digest,
      contentBytes: bytes,
      now: input.at,
    }),
    ...memoryRepresentationInsertStatements(env.d1, {
      instanceId: input.instanceId,
      exact: {
        representation: {
          representation_id: representationId,
          kind: 'raw_full',
          source_id: sourceId,
          source_revision: 1,
          range: { start: 0, end: bytes },
          depends_on: [],
          text_bytes: bytes,
          text_sha256: digest,
          verbatim: true,
        },
        text,
      },
      dependencies: [],
      now: input.at,
    }),
  ]);
  return { sourceId, representationId, text, digest, bytes };
}

export async function seedLfManifest(
  env: MemoryTestEnv,
  input: {
    instanceId: string;
    roomId: string;
    agentId: string;
    spaceId: string;
    ownershipEpoch: number;
    representationId: string;
    textSha256: string;
    at: number;
  },
): Promise<string> {
  const manifestId = unique('mmf_lf');
  const originScope = JSON.stringify({
    room_id: input.roomId,
    member_generation: 1,
    policy_revision: 0,
    joined_seq: 0,
    joined_at: input.at,
    archive_head_seq: null,
  });
  await env.d1.batch([
    env.d1
      .prepare(
        `INSERT INTO memory_manifests
           (manifest_id, space_id, ownership_epoch, agent_actor_id, host_binding_id,
            host_generation, session_incarnation, run_id, input_id, input_revision,
            invocation_id, manifest_sha256, payload_sha256, target_json, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, '{}', ?)`,
      )
      .bind(
        manifestId,
        input.spaceId,
        input.ownershipEpoch,
        input.agentId,
        'a'.repeat(64),
        'b'.repeat(64),
        input.at,
      ),
    env.d1
      .prepare(
        `INSERT INTO memory_manifest_items
           (manifest_id, item_index, selection_id, representation_id, origin_scope_json, text_sha256)
         VALUES (?, 0, NULL, ?, ?, ?)`,
      )
      .bind(manifestId, input.representationId, originScope, input.textSha256),
  ]);
  return manifestId;
}

export async function seedLfContext(
  env: MemoryTestEnv,
  input: {
    instanceId: string;
    roomId: string;
    agentId: string;
    spaceId: string;
    ownershipEpoch: number;
    body: string;
    representationId: string;
    sourceId: string;
    sourceRevision: number;
    sourceTextBytes: number;
    at: number;
  },
): Promise<string> {
  const contextId = unique('mctx_lf');
  const body = input.body;
  const bodySha = await sha256Hex(body);
  const bodyBytes = utf8Bytes(body);
  const originScope = JSON.stringify({
    room_id: input.roomId,
    member_generation: 1,
    policy_revision: 0,
    joined_seq: 0,
    joined_at: input.at,
    archive_head_seq: null,
  });
  await env.d1.batch([
    env.d1
      .prepare(
        `INSERT INTO memory_contexts
           (context_id, space_id, ownership_epoch, agent_actor_id, recall_id, kind,
            body, body_sha256, body_bytes, target_json, versions_json, policy_version,
            status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'lookup', ?, ?, ?, '{}', '{}', 1, 'ready', ?, ?, ?)`,
      )
      .bind(
        contextId,
        input.spaceId,
        input.ownershipEpoch,
        input.agentId,
        body,
        bodySha,
        bodyBytes,
        input.at,
        input.at + 3_600_000,
        input.at,
      ),
    env.d1
      .prepare(
        `INSERT INTO memory_context_items
           (context_id, item_index, experience_id, representation_id,
            source_dependencies_json, evidence, origin_scope_json)
         VALUES (?, 0, NULL, ?, ?, NULL, ?)`,
      )
      .bind(
        contextId,
        input.representationId,
        JSON.stringify([
          {
            source_id: input.sourceId,
            source_revision: input.sourceRevision,
            representation_id: input.representationId,
            range: { start: 0, end: input.sourceTextBytes },
          },
        ]),
        originScope,
      ),
  ]);
  return contextId;
}

export function assertNoSecret(label: string, value: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (!text.includes(secret)) continue;
    throw new Error(`${label} leaked a credential`);
  }
}

export function queryText(query: URLSearchParams): string {
  return [...query.entries()].map(([key, value]) => `${key}=${value}`).join('&');
}
