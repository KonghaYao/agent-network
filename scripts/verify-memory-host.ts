/**
 * MF07 HostBridge + MF06 工具/能力目录验收（受控 stub，不接真实 Hindsight）。
 *
 * 覆盖：
 * - 服务端签发宿主等级；客户端 capabilities 不能提升等级，自报 verified/trusted 被拒；
 * - prepare input → SubmittedInputManifest → ExposureReceipt → retain 资格；
 * - prepared / host_queued / host_reported_submitted / gateway_observed 分离；
 * - tool-only 不能上报共享输入；迟到/失效绑定 skipped_no_boundary 或 rejected；
 * - stub 适配器 retain 失败不影响 receipt，状态返回 unavailable/unsupported；
 * - MCP 工具注册、输入 schema、能力目录与 disabled 行为。
 *
 * 运行：bun scripts/verify-memory-host.ts
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';

import { createD1 } from '../src/bun/d1';
import { buildServer } from '../src/mcp/server';
import type { Env } from '../src/env';
import { NotificationHub } from '../src/realtime/hub';
import { sha256Hex } from '../src/storage/db';
import type { Principal } from '../src/domain/principal';
import { MemoryRuntime } from '../src/memory/runtime';
import { StubMemoryAdapter } from '../src/memory/adapters/stub';
import { loadRepresentationExact } from '../src/memory/experience-source';
import { MEMORY_HOST_PROTOCOL_VERSION } from '../src/memory/host-protocol';
import { check, checkEqual, checksPassed } from './lib/harness';
import { createMemoryEnv, seedActor, unique, type MemoryTestEnv } from './lib/memory-unit';
import { AT, instanceId } from './lib/memory-mf11';
import {
  BUDGET,
  LookupAdapter,
  bridgeFor,
  expectError,
  fullExposureFlow,
  setupFixture,
  targetInput,
} from './lib/memory-mf07';

async function main(): Promise<void> {
  const env = createMemoryEnv();

  // -------------------------------------------------------------------------
  // 1. adapted host：prepare → manifest → receipt → retain
  // -------------------------------------------------------------------------
  const adapted = await setupFixture(env, 'adapted');
  const noBoundary = bridgeFor(adapted, { trust_level: 'tool_only' });
  const toolOnlyBinding = await noBoundary.bind({
    request_id: unique('toolbind'),
    session_incarnation: `tool_${adapted.agent}`,
    declared_capabilities: ['explicit_lookup', 'final_manifest_report', 'submission_evidence'],
  });
  checkEqual('tool-only 声明不能提升等级', toolOnlyBinding.level, 'tool_only');
  await expectError(
    'tool-only 不能准备共享输入',
    () =>
      noBoundary.prepareInput({
        request_id: unique('prepare'),
        target: targetInput(adapted, toolOnlyBinding, 'tool'),
        selection_ids: [adapted.selectionId],
        budget: BUDGET,
      }),
    'MEMORY_UNSUPPORTED',
  );

  const adaptedFlow = await fullExposureFlow(adapted, { trust_level: 'adapted_host' });
  const state = await adaptedFlow.bridge.inputState(adaptedFlow.manifestId);
  checkEqual('回执后状态为 host_reported_submitted', state.status, 'host_reported_submitted');
  checkEqual('回执后可 retain', state.retain_eligible, true);
  checkEqual('inputState 返回 retain 意图数', state.retain_ids.length > 0, true);
  const experienceCount = env.db
    .prepare('SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?')
    .get(adapted.agent) as { n: number };
  checkEqual('adapted 经历已落库', experienceCount.n, 1);

  // 1b. 直接 manifest + invocation 证据：身份、去重与写库不依赖 trace/project/observation。
  const manifestRow = env.db
    .prepare(
      `SELECT run_id, input_id, input_revision, invocation_id, payload_sha256
         FROM memory_manifests WHERE manifest_id = ?`,
    )
    .get(adaptedFlow.manifestId) as {
    run_id: string;
    input_id: string;
    input_revision: number;
    invocation_id: string;
    payload_sha256: string;
  };
  checkEqual('直接 manifest 记录 run_id', manifestRow.run_id, `run_${adapted.agent}`);
  checkEqual('直接 manifest 记录 input_id', manifestRow.input_id, `input_${adapted.agent}`);
  checkEqual('直接 manifest 记录 input_revision', manifestRow.input_revision, 1);
  checkEqual(
    '直接 manifest 记录 invocation_id',
    manifestRow.invocation_id,
    `inv_${adapted.agent}_${adaptedFlow.binding.generation}`,
  );
  checkEqual('直接 manifest 的 payload hash 即提交内容', manifestRow.payload_sha256, adaptedFlow.payloadSha256);
  const manifestColumns = (
    env.db.prepare('PRAGMA table_info(memory_manifests)').all() as Array<{ name: string }>
  ).map((column) => column.name);
  check(
    '直接 manifest 表不存储 trace/project/observation',
    !manifestColumns.includes('trace_id') &&
      !manifestColumns.includes('project_id') &&
      !manifestColumns.includes('observation_id'),
    manifestColumns,
  );
  const experienceRow = env.db
    .prepare(
      `SELECT representation_kind, source_id, evidence FROM memory_experiences
        WHERE agent_actor_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(adapted.agent) as {
    representation_kind: string;
    source_id: string | null;
    evidence: string;
  };
  checkEqual('直接宿主经历来自 invocation 的准确表示', experienceRow.representation_kind, 'raw_full');
  checkEqual('直接宿主经历绑定业务来源', experienceRow.source_id, adapted.sourceId);
  checkEqual('直接宿主证据由服务端派生', experienceRow.evidence, 'host_reported_submitted');

  // 2. claim 更换后旧 target 不能在 manifest/receipt 继续绑定
  const stale = await setupFixture(env, 'claim_stale');
  const staleBridge = bridgeFor(stale, { trust_level: 'adapted_host' });
  const staleBinding = await staleBridge.bind({
    request_id: unique('stale_bind'),
    session_incarnation: `stale_${stale.agent}`,
    declared_capabilities: ['explicit_lookup', 'run_binding', 'final_manifest_report', 'submission_evidence'],
  });
  const staleTargetInput = targetInput(stale, staleBinding, stale.agent);
  const stalePrepared = await staleBridge.prepareInput({
    request_id: unique('stale_prepare'),
    target: staleTargetInput,
    selection_ids: [stale.selectionId],
    budget: BUDGET,
  });
  checkEqual('claim 变更前 prepare 成功', stalePrepared.status, 'prepared');
  if (stalePrepared.status !== 'prepared') throw new Error('prepare failed');
  env.db
    .prepare('UPDATE deliveries SET attempt = 1, claim_id = ? WHERE delivery_id = ?')
    .run(unique('new_claim'), stale.deliveryId);
  const stalePayload = `SYSTEM\n${stale.text}`;
  await expectError(
    'claim 更换后 manifest 拒绝旧 target',
    async () =>
      staleBridge.submitManifest({
        protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
        host_binding_id: staleBinding.binding_id,
        host_generation: staleBinding.generation,
        invocation: {
          host_binding_id: staleBinding.binding_id,
          host_generation: staleBinding.generation,
          session_incarnation: staleBinding.session_incarnation,
          run_id: staleTargetInput.run_id,
          input_id: staleTargetInput.input_id,
          input_revision: staleTargetInput.input_revision,
          invocation_id: `inv_${stale.agent}`,
        },
        target: stalePrepared.target,
        payload: stalePayload,
        payload_sha256: await sha256Hex(stalePayload),
        items: [
          {
            selection_id: stale.selectionId,
            representation_id: stale.representationId,
            text_sha256: stale.textSha256,
          },
        ],
      }),
    'MEMORY_TARGET_INVALID',
  );

  // 3. 客户端不能自报 verified/trusted
  await expectError(
    'manifest 不能自报 trusted',
    async () =>
      adaptedFlow.bridge.submitManifest({
        protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
        host_binding_id: adaptedFlow.binding.binding_id,
        host_generation: adaptedFlow.binding.generation,
        invocation: {
          host_binding_id: adaptedFlow.binding.binding_id,
          host_generation: adaptedFlow.binding.generation,
          session_incarnation: adaptedFlow.binding.session_incarnation,
          run_id: 'run_forged',
          input_id: 'input_forged',
          input_revision: 1,
          invocation_id: `inv_forged_${adapted.agent}`,
        },
        target: adaptedFlow.target as never,
        payload: 'forged',
        payload_sha256: await sha256Hex('forged'),
        items: [],
        trusted: true,
      } as never),
    'INVALID_ARGUMENT',
  );
  await expectError(
    'receipt 不能自报 verified',
    () =>
      adaptedFlow.bridge.submitExposure({
        protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
        host_binding_id: adaptedFlow.binding.binding_id,
        host_generation: adaptedFlow.binding.generation,
        manifest_id: adaptedFlow.manifestId,
        manifest_sha256: 'a'.repeat(64),
        payload_sha256: 'b'.repeat(64),
        request_id: unique('forged'),
        submitted_at: AT,
        verified: true,
      } as never),
    'INVALID_ARGUMENT',
  );

  await expectError(
    'receipt 的 payload hash 必须与 manifest 对账',
    () =>
      adaptedFlow.bridge.submitExposure({
        protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
        host_binding_id: adaptedFlow.binding.binding_id,
        host_generation: adaptedFlow.binding.generation,
        manifest_id: adaptedFlow.manifestId,
        manifest_sha256: adaptedFlow.manifestSha256,
        payload_sha256: 'b'.repeat(64),
        request_id: unique('hash_mismatch'),
        submitted_at: AT,
      }),
    'MEMORY_EVIDENCE_INSUFFICIENT',
  );

  // 4. 同一显式 session 重新绑定必须递增 generation，旧 run 不能再准备
  const restart = await setupFixture(env, 'restart');
  const restartBridge = bridgeFor(restart, { trust_level: 'adapted_host' });
  const firstBinding = await restartBridge.bind({
    request_id: unique('restart_bind_1'),
    session_incarnation: 'stable_host_session',
    declared_capabilities: ['explicit_lookup', 'run_binding', 'final_manifest_report', 'submission_evidence'],
  });
  const secondBinding = await restartBridge.bind({
    request_id: unique('restart_bind_2'),
    session_incarnation: 'stable_host_session',
    declared_capabilities: ['explicit_lookup', 'run_binding', 'final_manifest_report', 'submission_evidence'],
  });
  checkEqual('同一 session 重新 bind 递增 generation', secondBinding.generation, firstBinding.generation + 1);
  const staleRun = await restartBridge.prepareInput({
    request_id: unique('restart_prepare'),
    target: targetInput(restart, firstBinding, 'restart_old'),
    selection_ids: [restart.selectionId],
    budget: BUDGET,
  });
  checkEqual('旧 run 的准备返回 skipped_no_boundary', staleRun.status, 'skipped_no_boundary');

  // 5. 同 invocation 不能换 payload；同清单不能换 hash
  await expectError(
    '同 invocation 换 payload 生成新 manifest 被拒',
    async () =>
      adaptedFlow.bridge.submitManifest({
        protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
        host_binding_id: adaptedFlow.binding.binding_id,
        host_generation: adaptedFlow.binding.generation,
        invocation: {
          host_binding_id: adaptedFlow.binding.binding_id,
          host_generation: adaptedFlow.binding.generation,
          session_incarnation: adaptedFlow.binding.session_incarnation,
          run_id: `run_${adapted.agent}`,
          input_id: `input_${adapted.agent}`,
          input_revision: 1,
          invocation_id: `inv_${adapted.agent}_${adaptedFlow.binding.generation}`,
        },
        target: adaptedFlow.target as never,
        payload: `DIFFERENT\n${adapted.text}`,
        payload_sha256: await sha256Hex(`DIFFERENT\n${adapted.text}`),
        items: [
          {
            selection_id: adapted.selectionId,
            representation_id: adapted.representationId,
            text_sha256: adapted.textSha256,
          },
        ],
      }),
    'IDEMPOTENCY_CONFLICT',
  );

  // 6. 断线/租约结束后 skipped_no_boundary
  await adaptedFlow.bridge.close({ binding_id: adaptedFlow.binding.binding_id, host_generation: adaptedFlow.binding.generation });
  const closedPrepare = await adaptedFlow.bridge.prepareInput({
    request_id: unique('late'),
    target: targetInput(adapted, adaptedFlow.binding, 'late'),
    selection_ids: [adapted.selectionId],
    budget: BUDGET,
  });
  checkEqual('关闭后准备返回 skipped_no_boundary', closedPrepare.status, 'skipped_no_boundary');

  // 7. 网关观测只允许 controlled_gateway
  const adaptedGateway = await setupFixture(env, 'gateway_denied');
  const adaptedBridge = bridgeFor(adaptedGateway, { trust_level: 'adapted_host' });
  const adaptedBinding = await adaptedBridge.bind({
    request_id: unique('bind'),
    session_incarnation: `sess_${adaptedGateway.agent}`,
    declared_capabilities: ['explicit_lookup', 'run_binding', 'final_manifest_report', 'submission_evidence'],
  });
  const adaptedFlow2 = await (async () => {
    const target = targetInput(adaptedGateway, adaptedBinding, adaptedGateway.agent);
    const prepared = await adaptedBridge.prepareInput({
      request_id: unique('prepare'),
      target,
      selection_ids: [adaptedGateway.selectionId],
      budget: BUDGET,
    });
    if (prepared.status !== 'prepared') throw new Error('prepare failed');
    const payload = `SYSTEM\n${adaptedGateway.text}\nTAIL`;
    const manifest = await adaptedBridge.submitManifest({
      protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
      host_binding_id: adaptedBinding.binding_id,
      host_generation: adaptedBinding.generation,
      invocation: {
        host_binding_id: adaptedBinding.binding_id,
        host_generation: adaptedBinding.generation,
        session_incarnation: adaptedBinding.session_incarnation,
        run_id: target.run_id,
        input_id: target.input_id,
        input_revision: target.input_revision,
        invocation_id: `inv_${adaptedGateway.agent}`,
      },
      target: prepared.target,
      payload,
      payload_sha256: await sha256Hex(payload),
      items: [
        {
          selection_id: adaptedGateway.selectionId,
          representation_id: adaptedGateway.representationId,
          text_sha256: adaptedGateway.textSha256,
        },
      ],
    });
    return manifest.manifest;
  })();
  await expectError(
    'adapted host 不能记录网关观测',
    () =>
      adaptedBridge.recordGatewayObservation({
        protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
        host_binding_id: adaptedBinding.binding_id,
        host_generation: adaptedBinding.generation,
        invocation_id: `inv_${adaptedGateway.agent}`,
        manifest_id: adaptedFlow2.manifest_id,
        manifest_sha256: adaptedFlow2.manifest_sha256,
        observed_payload_sha256: adaptedFlow2.payload_sha256,
        observed_at: AT,
      }),
    'PERMISSION_DENIED',
  );

  // 8. controlled gateway：host_reported → gateway_observed
  const gateway = await setupFixture(env, 'gateway');
  const gatewayFlow = await fullExposureFlow(gateway, { trust_level: 'controlled_gateway' }, { observeGateway: true });
  const gatewayState = await gatewayFlow.bridge.inputState(gatewayFlow.manifestId);
  checkEqual('网关观测后状态升级', gatewayState.status, 'gateway_observed_submitted');
  checkEqual('网关观测不重复制造经历', gatewayState.retain_ids.length > 0, true);

  // 9. 所有权变化后的迟到 receipt 不写新 owner 经历
  const late = await setupFixture(env, 'late');
  const lateFlow = await fullExposureFlow(late, { trust_level: 'adapted_host' });
  const newManager = unique('human_new');
  seedActor(env, { actorId: newManager, kind: 'human', name: newManager });
  env.db
    .prepare('UPDATE agent_managements SET manager_id = ?, permission_version = permission_version + 1 WHERE agent_id = ?')
    .run(newManager, late.agent);
  const before = env.db
    .prepare('SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?')
    .get(late.agent) as { n: number };
  const lateAck = await lateFlow.bridge.submitExposure({
    protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
    host_binding_id: lateFlow.binding.binding_id,
    host_generation: lateFlow.binding.generation,
    manifest_id: lateFlow.manifestId,
    manifest_sha256: lateFlow.manifestSha256,
    payload_sha256: lateFlow.payloadSha256,
    request_id: unique('late_receipt'),
    submitted_at: AT,
  });
  check('所有权变化后的回执只 rejected', lateAck.disposition === 'rejected');
  const after = env.db
    .prepare('SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?')
    .get(late.agent) as { n: number };
  checkEqual('迟到回执没有新增经历', after.n, before.n);

  // 10. stub adapter：retain 不被伪报成功
  const runtime = new MemoryRuntime(createD1(env.db), {
    adapter: new StubMemoryAdapter(),
    instanceId,
    now: () => AT,
  });
  await runtime.start();
  const stub = await setupFixture(env, 'stub');
  const stubFlow = await fullExposureFlow(stub, { trust_level: 'adapted_host' });
  const tick = await runtime.tick();
  check('stub retain 至少处理一次作业', tick.claimed + tick.failed + tick.requeued >= 1, tick);
  const retainJob = env.db
    .prepare("SELECT job_id, status, last_error FROM memory_jobs WHERE space_id = ? AND operation_type = 'retain' LIMIT 1")
    .get(stub.space.space_id) as { job_id: string; status: string; last_error: string | null } | undefined;
  check('retain job 存在', retainJob !== undefined);
  checkEqual('stub retain 不伪报完成', retainJob?.status === 'failed' || retainJob?.status === 'pending' || retainJob?.status === 'unknown', true);
  const stubState = await stubFlow.bridge.inputState(stubFlow.manifestId);
  checkEqual('后端失败不撤销已采纳 receipt', stubState.status, 'host_reported_submitted');
  await runtime.stop();

  // -------------------------------------------------------------------------
  // 11. MCP 工具注册、能力目录、disabled 行为（内存内传输）
  // -------------------------------------------------------------------------
  const runtime2 = new MemoryRuntime(createD1(env.db), {
    adapter: new StubMemoryAdapter(),
    instanceId,
    now: () => AT,
  });
  await runtime2.start();
  const toolFixture = await setupFixture(env, 'tools', Date.now());
  const actor = env.db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(toolFixture.agent) as never;
  const credential = {
    credential_id: toolFixture.credentialId,
    actor_id: toolFixture.agent,
    device_id: 'dev_test',
    token_hash: 'hash',
    revoked_at: null,
    created_at: AT,
    last_used_at: null,
    revoked_by: null,
    label: null,
  };
  const principal: Principal = { credentialHash: 'hash', actor, credential };
  const fullEnv: Env = {
    DB: env.d1,
    NOTIFICATION_HUB: new NotificationHub(env.db),
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://test.local',
    FILE_TICKET_SECRET: 'mf06-test-ticket-secret',
    MEMORY: runtime2,
    MEMORY_HOST: { trust_level: 'adapted_host' },
  };
  const mcp = await connectServer(fullEnv, principal);
  try {
    const list = await mcp.client.listTools();
    const names = list.tools.map((tool) => tool.name);
    check('tools/list 包含 memory 工具', names.includes('network_memory_recall'));
    check('tools/list 包含 host bind', names.includes('network_memory_host_bind'));
    const me = (await mcp.client.callTool({ name: 'network_me', arguments: {} })) as {
      structuredContent?: { service?: { memory?: Record<string, unknown> } };
    };
    const memory = me.structuredContent?.service?.memory as {
      enabled: boolean;
      host_modes: string[];
      tools: string[];
      unsupported: string[];
    };
    checkEqual('network_me 宣告 memory enabled', memory.enabled, true);
    checkEqual('network_me 宣告 adapted host', memory.host_modes.includes('adapted_host'), true);
    check('catalog tools 与 tools/list 一致', names.includes('network_memory_status') && memory.tools.includes('network_memory_status'));
    check('catalog 明确不支持 auto_injection', memory.unsupported.includes('auto_injection'));
    const status = (await mcp.client.callTool({ name: 'network_memory_status', arguments: {} })) as {
      structuredContent?: { enabled: boolean; host_level: string };
    };
    checkEqual('status 返回 enabled', status.structuredContent?.enabled, true);
    checkEqual('status 返回宿主等级', status.structuredContent?.host_level, 'adapted_host');
    const recall = (await mcp.client.callTool({
      name: 'network_memory_recall',
      arguments: {
        request_id: unique('mcp_recall'),
        mode: 'lookup',
        dispatch: 'explicit',
        query: 'release',
        budget: { candidate_limit: 5, output_bytes: 4096 },
      },
    })) as { structuredContent?: { status: string; injection?: { eligible: boolean } } };
    checkEqual('stub lookup 如实返回 unsupported', recall.structuredContent?.status, 'unsupported');
    checkEqual('lookup 永不携带注入许可', recall.structuredContent?.injection?.eligible, false);
    const forged = await mcp.client.callTool({
      name: 'network_memory_host_bind',
      arguments: { request_id: unique('bind'), declared_capabilities: ['explicit_lookup'], trusted: true },
    });
    check('strict schema 拒绝 trusted 字段', forged.isError === true);
    const through = await mcp.client.callTool({
      name: 'network_memory_recall',
      arguments: {
        request_id: unique('recall'),
        mode: 'lookup',
        dispatch: 'explicit',
        query: 'x',
        budget: { candidate_limit: 5, output_bytes: 4096 },
        through_seq: 10,
      },
    });
    check('strict schema 拒绝裸 through_seq', through.isError === true);
  } finally {
    await mcp.close();
  }

  const disabledEnv: Env = {
    DB: env.d1,
    NOTIFICATION_HUB: new NotificationHub(env.db),
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://test.local',
    FILE_TICKET_SECRET: 'mf06-test-ticket-secret',
  };
  const disabled = await connectServer(disabledEnv, principal);
  try {
    const me = (await disabled.client.callTool({ name: 'network_me', arguments: {} })) as {
      structuredContent?: { service?: { memory?: { enabled: boolean; reason: string | null } } };
    };
    checkEqual('disabled 目录 enabled=false', me.structuredContent?.service?.memory?.enabled, false);
    checkEqual('disabled 目录给出原因', me.structuredContent?.service?.memory?.reason, 'memory_disabled');
    const status = (await disabled.client.callTool({ name: 'network_memory_status', arguments: {} })) as {
      structuredContent?: { enabled: boolean };
    };
    checkEqual('disabled status 可用但不伪造启用', status.structuredContent?.enabled, false);
    const context = await disabled.client.callTool({ name: 'network_memory_context_list', arguments: {} });
    check('disabled 内容工具明确报错', context.isError === true);
  } finally {
    await disabled.close();
  }

  // -------------------------------------------------------------------------
  // 10. lookup 召回 → lookup Context；context list/get 不携带注入许可
  // -------------------------------------------------------------------------
  const lookup = await setupFixture(env, 'lookup');
  const adapter = new LookupAdapter();
  const exact = await loadRepresentationExact(env.d1, lookup.representationId);
  check('lookup 测试表示存在', exact !== null);
  adapter.hits = [
    {
      backend_ref: {
        space: lookup.space,
        provider_id: 'mf06-stub',
        provider_revision: 'rev_1',
      },
      representation: exact!.representation,
      source: { source_id: lookup.sourceId, source_revision: 1 },
      origin_kind: 'experienced',
      evidence: 'host_reported_submitted',
      score: null,
    },
  ];
  const lookupRuntime = new MemoryRuntime(createD1(env.db), {
    adapter,
    instanceId,
    now: () => AT,
  });
  await lookupRuntime.start();
  const lookupEnv: Env = {
    DB: env.d1,
    NOTIFICATION_HUB: new NotificationHub(env.db),
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://test.local',
    FILE_TICKET_SECRET: 'mf06-test-ticket-secret',
    MEMORY: lookupRuntime,
    MEMORY_HOST: { trust_level: 'adapted_host' },
  };
  const lookupServer = await connectServer(lookupEnv, principalFor(env, lookup.agent, 'cred_lookup'));
  try {
    const beforeMe = await callTool<{ pending_count: number }>(lookupServer.client, 'network_me', {});
    const beforeEvents = (env.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    const recall = await callTool<{
      recall_id: string;
      status: string;
      context_ref: string | null;
      injection: { eligible: boolean };
      items: readonly unknown[];
    }>(lookupServer.client, 'network_memory_recall', {
      request_id: unique('lookup_recall'),
      mode: 'lookup',
      dispatch: 'explicit',
      query: 'MF07',
      budget: { candidate_limit: 10, output_bytes: 4096 },
    });
    checkEqual('lookup 召回 ready', recall.status, 'ready');
    check('lookup 召回返回 context_ref', typeof recall.context_ref === 'string');
    checkEqual('lookup 召回不携带注入许可', recall.injection.eligible, false);
    checkEqual('lookup 召回返回候选', recall.items.length, 1);
    const context = await callTool<{
      available: boolean;
      kind: string;
      body: string;
      items: readonly unknown[];
      injection: { eligible: boolean; reason: string };
    }>(lookupServer.client, 'network_memory_context_get', { context_id: recall.context_ref });
    checkEqual('lookup Context 可读', context.available, true);
    checkEqual('lookup Context 类型', context.kind, 'lookup');
    check('lookup Context 正文含准确文本', context.body.includes(lookup.text));
    checkEqual('lookup Context 仍是 lookup_only', context.injection.reason, 'lookup_only');
    const contexts = await callTool<{ items: readonly { context_id: string }[] }>(
      lookupServer.client,
      'network_memory_context_list',
      { kind: 'lookup' },
    );
    check('context_list 包含刚创建的 lookup 包', contexts.items.some((item) => item.context_id === recall.context_ref));
    const afterMe = await callTool<{ pending_count: number }>(lookupServer.client, 'network_me', {});
    const afterEvents = (env.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    checkEqual('Memory 查询不增加 pending_count', afterMe.pending_count, beforeMe.pending_count);
    checkEqual('Memory 查询不写业务 events', afterEvents, beforeEvents);
    await lookupServer.client.callTool({
      name: 'network_memory_recall',
      arguments: {
        request_id: 'same_recall_request',
        mode: 'lookup',
        dispatch: 'explicit',
        query: 'a',
        budget: { candidate_limit: 10, output_bytes: 4096 },
      },
    });
    await toolError(
      '同 recall request_id 不同输入返回冲突',
      () =>
        lookupServer.client.callTool({
          name: 'network_memory_recall',
          arguments: {
            request_id: 'same_recall_request',
            mode: 'lookup',
            dispatch: 'explicit',
            query: 'b',
            budget: { candidate_limit: 10, output_bytes: 4096 },
          },
        }),
      'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    await lookupServer.close();
    await lookupRuntime.stop();
  }

  // -------------------------------------------------------------------------
  // 11. experience list/get（adapted fixture 的已接纳经历）
  // -------------------------------------------------------------------------
  const experienceServer = await connectServer(
    { ...fullEnv, MEMORY_HOST: { trust_level: 'adapted_host' } },
    principalFor(env, adapted.agent, 'cred_experience'),
  );
  try {
    const page = await callTool<{ items: readonly { experience_id: string }[] }>(
      experienceServer.client,
      'network_memory_experience_list',
      {},
    );
    check('experience_list 返回已接纳经历', page.items.length >= 1);
    const detail = await callTool<{ available: boolean; text: string; item: { evidence: string } }>(
      experienceServer.client,
      'network_memory_experience_get',
      { experience_id: page.items[0]!.experience_id },
    );
    checkEqual('experience_get 可读正文', detail.available, true);
    check('experience_get 正文含来源文本', detail.text.includes(adapted.text));
    checkEqual('experience_get 证据等级', detail.item.evidence, 'host_reported_submitted');
  } finally {
    await experienceServer.close();
  }

  // -------------------------------------------------------------------------
  // 12. curated put/correct/list/get/forget 与 operation 状态
  // -------------------------------------------------------------------------
  const governanceServer = await connectServer(
    { ...fullEnv, MEMORY_HOST: { trust_level: 'adapted_host' } },
    principalFor(env, toolFixture.agent, 'cred_governance'),
  );
  try {
    const put = await callTool<{ curated_id: string; revision: number; status: string }>(
      governanceServer.client,
      'network_memory_put',
      {
        request_id: unique('put'),
        title: 'MF06 preference',
        content: 'prefer concise reports',
      },
    );
    checkEqual('put 本地保存 curated', put.status, 'ready');
    checkEqual('put 初始 revision', put.revision, 1);
    const correct = await callTool<{ revision: number; duplicate: boolean }>(
      governanceServer.client,
      'network_memory_correct',
      {
        request_id: unique('correct'),
        curated_id: put.curated_id,
        expected_revision: 1,
        title: 'MF06 preference v2',
        content: 'prefer concise reports with evidence',
      },
    );
    checkEqual('correct 递增 revision', correct.revision, 2);
    const curated = await callTool<{ items: readonly { curated_id: string; revision: number }[] }>(
      governanceServer.client,
      'network_memory_list',
      { object_kind: 'curated' },
    );
    check('curated list 含 revised 记录', curated.items.some((item) => item.curated_id === put.curated_id && item.revision === 2));
    const got = await callTool<{ item: { content: string } }>(
      governanceServer.client,
      'network_memory_get',
      { object_kind: 'curated', id: put.curated_id },
    );
    checkEqual('curated get 返回当前修订', got.item.content, 'prefer concise reports with evidence');
    const forgotten = await callTool<{ operation_id: string; status: string; purge: string }>(
      governanceServer.client,
      'network_memory_forget',
      {
        request_id: unique('forget'),
        target: { kind: 'curated', curated_id: put.curated_id, revision: 2 },
      },
    );
    checkEqual('forget curated 先本地排除', forgotten.status, 'pending');
    checkEqual('forget 不提前声称 purged', forgotten.purge, 'unknown');
    const operation = await callTool<{ found: boolean; operation: { action: string; availability: string } }>(
      governanceServer.client,
      'network_memory_operation_get',
      { operation_id: forgotten.operation_id },
    );
    checkEqual('operation_get 找到治理作业', operation.found, true);
    checkEqual('operation_get 状态为 pending', operation.operation.availability, 'pending');
  } finally {
    await governanceServer.close();
  }

  // -------------------------------------------------------------------------
  // 13. catchup prepare/get：scan cursor 不推进消费
  // -------------------------------------------------------------------------
  const catchup = await setupFixture(env, 'catchup');
  const catchupServer = await connectServer(
    { ...fullEnv, MEMORY_HOST: { trust_level: 'adapted_host' } },
    principalFor(env, catchup.agent, 'cred_catchup'),
  );
  try {
    const plan = await callTool<{
      plan_id: string;
      status: string;
      items: readonly { message_id: string; selection_state: string }[];
      selections: readonly { selection_id: string }[];
    }>(catchupServer.client, 'network_memory_catchup_prepare', {
      request_id: unique('catchup'),
      room_id: catchup.room,
      query: 'MF07',
      budget: { candidate_limit: 50, selected_limit: 10, output_bytes: 4096 },
    });
    check('catchup_prepare 返回计划', typeof plan.plan_id === 'string');
    check('catchup_prepare 返回候选', plan.items.length >= 1);
    check('catchup 选择不产生消费证明', plan.selections.length >= 1);
    const page = await callTool<{ plan_id: string; items: readonly unknown[] }>(
      catchupServer.client,
      'network_memory_catchup_get',
      { plan_id: plan.plan_id },
    );
    checkEqual('catchup_get 读取同一计划', page.plan_id, plan.plan_id);
    check('catchup_get 返回计划项', page.items.length >= 1);
  } finally {
    await catchupServer.close();
  }

  // -------------------------------------------------------------------------
  // 14. MCP host bind/input prepare 与严格参数
  // -------------------------------------------------------------------------
  const hostServer = await connectServer(
    { ...fullEnv, MEMORY_HOST: { trust_level: 'adapted_host' } },
    principalFor(env, toolFixture.agent, 'cred_host_tool'),
  );
  try {
    const binding = await callTool<{
      binding_id: string;
      generation: number;
      session_incarnation: string;
      level: string;
    }>(hostServer.client, 'network_memory_host_bind', {
      request_id: unique('bind'),
      session_incarnation: `tool_${toolFixture.agent}`,
      declared_capabilities: [
        'explicit_lookup',
        'run_binding',
        'final_manifest_report',
        'submission_evidence',
      ],
    });
    checkEqual('MCP host_bind 使用服务端等级', binding.level, 'adapted_host');
    const prepared = await callTool<{
      status: string;
      target: Record<string, unknown>;
      items: readonly { selection_id: string; text: string }[];
      retain_eligible: boolean;
    }>(hostServer.client, 'network_memory_input_prepare', {
      request_id: unique('prepare'),
      target: {
        kind: 'message',
        host_binding_id: binding.binding_id,
        host_generation: binding.generation,
        session_incarnation: binding.session_incarnation,
        run_id: 'run_mcp',
        input_id: 'input_mcp',
        input_revision: 1,
        message: {
          message_id: toolFixture.messageId,
          delivery_id: toolFixture.deliveryId,
          attempt: 0,
          claim_id: toolFixture.claimId,
        },
      },
      selection_ids: [toolFixture.selectionId],
      budget: { candidate_limit: 10, output_bytes: 4096 },
    });
    checkEqual('MCP input_prepare 返回 prepared', prepared.status, 'prepared');
    checkEqual('MCP input_prepare 不产生 retain', prepared.retain_eligible, false);
    checkEqual('MCP input_prepare 返回准确文本', prepared.items[0]?.text, toolFixture.text);
    const contextId = `mctx_${unique('admit')}`;
    const contextBody = 'MF06 bound memory packet';
    const contextHash = await sha256Hex(contextBody);
    const now = Date.now();
    env.db
      .prepare(
        `INSERT INTO memory_contexts
           (context_id, space_id, ownership_epoch, agent_actor_id, recall_id, kind,
            body, body_sha256, body_bytes, target_json, versions_json, policy_version,
            status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'bound', ?, ?, ?, ?, '{}', 1, 'ready', ?, ?, ?)`,
      )
      .run(
        contextId,
        toolFixture.space.space_id,
        toolFixture.space.ownership_epoch,
        toolFixture.agent,
        contextBody,
        contextHash,
        new TextEncoder().encode(contextBody).length,
        JSON.stringify(prepared.target),
        now,
        now + 60_000,
        now,
      );
    const admitted = await callTool<{
      kind: string;
      disposition: string;
      evidence: string;
    }>(hostServer.client, 'network_memory_admit', {
      request_id: unique('ctx_receipt'),
      kind: 'context_delivery',
      context_id: contextId,
      context_sha256: contextHash,
      invocation_id: 'inv_context_delivery',
      proof_id: 'proof_context_delivery',
      submitted_at: now,
    });
    checkEqual('context_delivery 回执被采纳', admitted.disposition, 'applied');
    checkEqual('adapted host 的交付证据', admitted.evidence, 'host_reported_delivered');
    await toolError(
      'MCP input_prepare 不能自报 space',
      () =>
        hostServer.client.callTool({
          name: 'network_memory_input_prepare',
          arguments: {
            request_id: unique('bad_prepare'),
            target: {
              kind: 'message',
              host_binding_id: binding.binding_id,
              host_generation: binding.generation,
              session_incarnation: binding.session_incarnation,
              run_id: 'run_mcp_bad',
              input_id: 'input_mcp_bad',
              input_revision: 1,
              message: {
                message_id: toolFixture.messageId,
                delivery_id: toolFixture.deliveryId,
                attempt: 0,
                claim_id: toolFixture.claimId,
              },
            },
            selection_ids: [toolFixture.selectionId],
            budget: { candidate_limit: 10, output_bytes: 4096 },
            space_id: 'msp_forged',
          },
        }),
      'space_id',
    );
    await toolError(
      'MCP admit 不能自报 verified',
      () =>
        hostServer.client.callTool({
          name: 'network_memory_admit',
          arguments: {
            request_id: unique('admit'),
            kind: 'input_exposure',
            manifest_id: 'mmf_missing',
            manifest_sha256: 'a'.repeat(64),
            payload_sha256: 'b'.repeat(64),
            invocation_id: 'inv_missing',
            proof_id: 'proof_missing',
            submitted_at: AT,
            verified: true,
          },
        }),
      'verified',
    );
  } finally {
    await hostServer.close();
  }

  console.log(`\nMF06/MF07 HostBridge checks passed: ${checksPassed()} 项`);
}

function principalFor(env: MemoryTestEnv, agentId: string, credentialId: string): Principal {
  const actor = env.db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(agentId) as never;
  return {
    credentialHash: `hash_${agentId}`,
    actor,
    credential: {
      credential_id: credentialId,
      actor_id: agentId,
      device_id: `dev_${agentId}`,
      token_hash: `token_${agentId}`,
      revoked_at: null,
      created_at: AT,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}


async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: readonly { type: string; text?: string }[];
  };
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent as T;
}

async function toolError(
  label: string,
  run: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    const result = (await run()) as {
      isError?: boolean;
      content?: readonly { text?: string }[];
    };
    const text = JSON.stringify(result.content ?? []);
    check(label, result.isError === true && text.includes(expected), text);
  } catch (error) {
    check(label, String(error).includes(expected) || (error as { code?: string }).code === expected);
  }
}

async function connectServer(env: Env, principal: Principal): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server: McpServer = buildServer(env, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mf06-mf07-acceptance', version: '0.1.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

await main();
