/**
 * MF07 验收共享夹具：受控宿主、claim fixture 与完整暴露流程。
 *
 * 只用于本地内存 SQLite + stub 适配器，不访问真实 Hindsight、不写 .data。
 */
import { BusinessError } from '../../src/contracts/errors';
import { sha256Hex } from '../../src/storage/db';
import { StubMemoryAdapter } from '../../src/memory/adapters/stub';
import type {
  MemoryAdapterSearchHit,
  SearchResult,
} from '../../src/memory/adapters/types';
import { MemoryHostBridge, type MemoryHostPolicy } from '../../src/memory/host-bridge';
import { MEMORY_HOST_PROTOCOL_VERSION } from '../../src/memory/host-protocol';
import { createSourceSelections } from '../../src/memory/experience-source';
import { resolveRoomTargetScope } from '../../src/memory/target';
import type {
  MemoryContextTarget,
  MemoryRecallBudget,
  MemorySpaceRef,
} from '../../src/memory/contracts';
import { check, checkEqual } from './harness';
import { rawRepresentation, unique, type MemoryTestEnv } from './memory-unit';
import {
  AT,
  addSource,
  insertMessage,
  instanceId,
  setupAgentRoom,
} from './memory-mf11';

export class LookupAdapter extends StubMemoryAdapter {
  hits: MemoryAdapterSearchHit[] = [];
  override async search(): Promise<SearchResult> {
    return {
      status: 'ready',
      coverage: 'bounded',
      freshness: { as_of: AT, backend_revision: 'rev_mf06' },
      evidence_complete: true,
      hits: this.hits,
      exclusions: [],
      reason: null,
    };
  }
}

export interface Fixture {
  env: MemoryTestEnv;
  agent: string;
  manager: string;
  room: string;
  space: MemorySpaceRef;
  credentialId: string;
  messageId: string;
  deliveryId: string;
  claimId: string;
  text: string;
  sourceId: string;
  selectionId: string;
  representationId: string;
  textSha256: string;
}

export async function setupFixture(env: MemoryTestEnv, name: string, selectionNow = AT): Promise<Fixture> {
  const base = await setupAgentRoom(env, name);
  const messageId = unique(`msg_${name}`);
  const text = `MF07-${name}-SECRET-🙂-${unique('tail')}`;
  insertMessage(env, {
    messageId,
    roomId: base.room,
    senderId: base.manager,
    seq: 1,
    body: text,
  });
  const deliveryId = unique(`dlv_${name}`);
  const claimId = unique(`clm_${name}`);
  env.db
    .prepare(
      `INSERT INTO deliveries
         (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id,
          claimed_at, progress_at, result_message_id, error, created_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'claimed', 0, ?, ?, NULL, NULL, NULL, 1, ?, ?)`,
    )
    .run(deliveryId, base.agent, messageId, base.room, claimId, AT, AT, AT);
  const source = await addSource(env, {
    sourceKey: `message:${messageId}`,
    roomId: base.room,
    seq: 1,
    text,
    authorActorId: base.manager,
  });
  const exact = await rawRepresentation({
    sourceId: source.sourceId,
    sourceRevision: 1,
    text,
  });
  const targetScope = await resolveRoomTargetScope(env.d1, base.room, base.agent);
  const [selection] = await createSourceSelections(env.d1, {
    instanceId,
    agentId: base.agent,
    space: base.space,
    targetScope,
    representations: [exact],
    now: selectionNow,
  });
  return {
    env,
    agent: base.agent,
    manager: base.manager,
    room: base.room,
    space: base.space,
    credentialId: unique(`cred_${name}`),
    messageId,
    deliveryId,
    claimId,
    text,
    sourceId: source.sourceId,
    selectionId: selection!.selection_id,
    representationId: exact.representation.representation_id,
    textSha256: exact.representation.text_sha256,
  };
}

export function targetInput(
  fixture: Fixture,
  binding: { binding_id: string; generation: number; session_incarnation: string },
  suffix: string,
) {
  return {
    kind: 'message' as const,
    host_binding_id: binding.binding_id,
    host_generation: binding.generation,
    session_incarnation: binding.session_incarnation,
    run_id: `run_${suffix}`,
    input_id: `input_${suffix}`,
    input_revision: 1,
    message: {
      message_id: fixture.messageId,
      delivery_id: fixture.deliveryId,
      attempt: 0,
      claim_id: fixture.claimId,
    },
  };
}

export const BUDGET: MemoryRecallBudget = {
  candidate_limit: 10,
  output_bytes: 64 * 1024,
  deadline_at: null,
};

export function bridgeFor(
  fixture: Fixture,
  policy: MemoryHostPolicy,
  now = () => AT,
): MemoryHostBridge {
  return new MemoryHostBridge({
    db: fixture.env.d1,
    instanceId,
    agentId: fixture.agent,
    credentialId: fixture.credentialId,
    space: fixture.space,
    policy,
    now,
  });
}

export async function expectError(label: string, run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
    check(label, false, 'expected error');
  } catch (error) {
    checkEqual(label, error instanceof BusinessError ? error.code : 'UNKNOWN', code);
  }
}

export async function fullExposureFlow(
  fixture: Fixture,
  policy: MemoryHostPolicy,
  options: { observeGateway?: boolean } = {},
): Promise<{
  bridge: MemoryHostBridge;
  binding: Awaited<ReturnType<MemoryHostBridge['bind']>>;
  manifestId: string;
  manifestSha256: string;
  payloadSha256: string;
  payload: string;
  target: MemoryContextTarget;
  ack: Awaited<ReturnType<MemoryHostBridge['submitExposure']>>;
}> {
  const bridge = bridgeFor(fixture, policy);
  const binding = await bridge.bind({
    request_id: unique('bind'),
    session_incarnation: `sess_${fixture.agent}`,
    declared_capabilities: [
      'explicit_lookup',
      'run_binding',
      'async_supplement',
      'final_manifest_report',
      'submission_evidence',
      'gateway_observation',
      'history_isolation',
    ],
  });
  const target = targetInput(fixture, binding, fixture.agent);
  const prepared = await bridge.prepareInput({
    request_id: unique('prepare'),
    target,
    selection_ids: [fixture.selectionId],
    budget: BUDGET,
  });
  checkEqual(`${fixture.agent} prepare 状态`, prepared.status, 'prepared');
  if (prepared.status !== 'prepared') throw new Error('prepare failed');
  checkEqual('prepare 不产生 retain 资格', prepared.retain_eligible, false);
  checkEqual('prepare 返回准确正文', prepared.items[0]?.text, fixture.text);
  const payload = `SYSTEM\n${fixture.text}\nTAIL`;
  const manifest = await bridge.submitManifest({
    protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
    host_binding_id: binding.binding_id,
    host_generation: binding.generation,
    invocation: {
      host_binding_id: binding.binding_id,
      host_generation: binding.generation,
      session_incarnation: binding.session_incarnation,
      run_id: target.run_id,
      input_id: target.input_id,
      input_revision: target.input_revision,
      invocation_id: `inv_${fixture.agent}_${binding.generation}`,
    },
    target: prepared.target,
    payload,
    payload_sha256: await sha256Hex(payload),
    items: [
      {
        selection_id: fixture.selectionId,
        representation_id: fixture.representationId,
        text_sha256: fixture.textSha256,
      },
    ],
  });
  checkEqual('manifest 仍是 prepared，不是已提交', manifest.status, 'prepared');
  checkEqual('manifest 没有 retain 资格', manifest.retain_eligible, false);
  const queued = await bridge.markHostQueued(manifest.manifest.manifest_id);
  checkEqual('宿主排队状态不是提交证据', queued.status, 'host_queued');
  checkEqual('宿主排队没有证据', queued.submitted_evidence, null);
  const beforeReceipt = fixture.env.db
    .prepare('SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?')
    .get(fixture.agent) as { n: number };
  checkEqual('排队不产生经历', beforeReceipt.n, 0);
  const ack = await bridge.submitExposure({
    protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
    host_binding_id: binding.binding_id,
    host_generation: binding.generation,
    manifest_id: manifest.manifest.manifest_id,
    manifest_sha256: manifest.manifest.manifest_sha256,
    payload_sha256: manifest.manifest.payload_sha256,
    request_id: unique('receipt'),
    submitted_at: AT,
  });
  checkEqual('合格 receipt 被采纳', ack.disposition, 'applied');
  check('receipt 派生 host_reported 证据', ack.evidence === 'host_reported_submitted');
  check('receipt 原子产生经历', ack.experience_ids.length > 0);
  check('receipt 原子产生 retain 资格', ack.retain_ids.length > 0);
  if (options.observeGateway) {
    const observed = await bridge.recordGatewayObservation({
      protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
      host_binding_id: binding.binding_id,
      host_generation: binding.generation,
      invocation_id: `inv_${fixture.agent}_${binding.generation}`,
      manifest_id: manifest.manifest.manifest_id,
      manifest_sha256: manifest.manifest.manifest_sha256,
      observed_payload_sha256: manifest.manifest.payload_sha256,
      observed_at: AT,
    });
    check('受控网关可追加独立 proof', observed.appended);
  }
  return {
    bridge,
    binding,
    manifestId: manifest.manifest.manifest_id,
    manifestSha256: manifest.manifest.manifest_sha256,
    payloadSha256: manifest.manifest.payload_sha256,
    payload,
    target: prepared.target,
    ack,
  };
}
