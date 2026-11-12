/**
 * MF11 验收（一）：manifest 绑定、分群经历、稀疏片段与音频隔离。
 * 补读分页与计划生命周期见 verify-memory-catchup.ts。
 */
import { BusinessError } from '../src/contracts/errors';
import { sha256Hex } from '../src/storage/db';
import { requireCurrentMemorySpace } from '../src/memory/access';
import {
  buildSubmittedInputManifest,
  type MemoryManifestBuildInput,
} from '../src/memory/input-manifest';
import {
  appendGatewayObservationProof,
  recordHostInputExposure,
  submitHostManifestReport,
} from '../src/memory/host-exposure';
import {
  createSourceSelections,
  experienceCoverage,
  getExperience,
  listExperiences,
  recordAuthoredExperience,
  saveCuratedMemory,
  listCuratedMemories,
  sourceRawCoverage,
} from '../src/memory/experience';
import { bindMemoryHost, coverageForSource } from '../src/memory/store-objects';
import type { MemoryHostFinalManifestReport } from '../src/memory/contracts';
import { check, checkEqual, checksPassed } from './lib/harness';
import {
  createMemoryEnv,
  leaveAndRejoin,
  privateTarget,
  rawRepresentation,
  seedRoom,
  summaryRepresentation,
  targetRoom,
  unique,
} from './lib/memory-unit';
import {
  AT,
  addSource,
  authoredRepresentation,
  bindHost,
  expectCode,
  insertMessage,
  instanceId,
  invocation,
  messageTarget,
  setupAgentRoom,
} from './lib/memory-mf11';

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. manifest 绑定、不可更新、同 invocation 唯一、prepared 不接纳经历
  // -------------------------------------------------------------------------
  const env = createMemoryEnv();
  const first = await setupAgentRoom(env, 'manifest');
  const source = await addSource(env, {
    sourceKey: `msg_${first.room}_1`,
    roomId: first.room,
    seq: 10,
    text: 'MF11-SECRET-甲🙂乙',
  });
  const exact = await rawRepresentation({
    sourceId: source.sourceId,
    sourceRevision: 1,
    text: source.text,
  });
  const [selection] = await createSourceSelections(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    targetScope: privateTarget(),
    representations: [exact],
    now: AT,
  });
  check('selection 是 not_consumed', selection?.consumption === 'not_consumed');
  checkEqual(
    '仅创建 selection 不产生经历',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    0,
  );

  const binding = await bindHost(env, { agentId: first.agent, space: first.space });
  const inv = invocation(binding.binding_id, binding.generation, 'manifest_1');
  const target = await messageTarget(env, {
    agentId: first.agent,
    space: first.space,
    bindingId: binding.binding_id,
    generation: binding.generation,
    inv,
    targetScope: privateTarget(),
    roomId: first.room,
  });
  const payload = `SYSTEM\n${source.text}\nTAIL`;
  const buildInput: MemoryManifestBuildInput = {
    instanceId,
    agentId: first.agent,
    space: first.space,
    hostBindingId: binding.binding_id,
    hostGeneration: binding.generation,
    invocation: inv,
    target,
    payload,
    items: [
      {
        selection_id: selection!.selection_id,
        representation_id: exact.representation.representation_id,
        text_sha256: exact.representation.text_sha256,
      },
    ],
    now: AT,
  };
  await expectCode(
    'private selection 不能提交到房间受众',
    buildSubmittedInputManifest(env.d1, {
      ...buildInput,
      target: {
        ...target,
        target_scope: targetRoom({
          roomId: first.room,
          memberGeneration: 1,
          memberSeq: 2,
          policyRevision: 0,
        }),
      },
    }),
    'MEMORY_TARGET_INVALID',
  );
  const built = await buildSubmittedInputManifest(env.d1, buildInput);
  check('manifest 首次创建', built.created);
  checkEqual('manifest hash 长度', built.manifest.manifest_sha256.length, 64);
  checkEqual(
    'payload hash 由服务端计算',
    built.manifest.payload_sha256,
    await sha256Hex(payload),
  );
  checkEqual('manifest item 数量', built.manifest.items.length, 1);
  checkEqual(
    '同 invocation 同内容幂等',
    (await buildSubmittedInputManifest(env.d1, buildInput)).manifest.manifest_id,
    built.manifest.manifest_id,
  );
  await expectCode(
    '同 invocation 换 payload/hash 冲突',
    buildSubmittedInputManifest(env.d1, { ...buildInput, payload: `${payload}\nMORE` }),
    'IDEMPOTENCY_CONFLICT',
  );
  let updateError = '';
  try {
    env.db
      .prepare('UPDATE memory_manifest_items SET text_sha256 = ? WHERE manifest_id = ?')
      .run('f'.repeat(64), built.manifest.manifest_id);
  } catch (error) {
    updateError = String(error);
  }
  check(
    'manifest items 不可更新',
    updateError.includes('memory_manifest_item_immutable'),
    updateError,
  );
  let trustError: unknown = null;
  try {
    await submitHostManifestReport(env.d1, {
      instanceId,
      agentId: first.agent,
      space: first.space,
      report: {
        protocol_version: '2026-11-11.1',
        host_binding_id: binding.binding_id,
        host_generation: binding.generation,
        invocation: inv,
        target,
        payload,
        payload_sha256: built.manifest.payload_sha256,
        items: [],
        trusted: true,
        verified: true,
      } as unknown as MemoryHostFinalManifestReport,
    });
  } catch (error) {
    trustError = error;
  }
  checkEqual(
    '客户端自报 trusted/verified 被拒绝',
    trustError instanceof BusinessError ? trustError.code : 'UNKNOWN',
    'INVALID_ARGUMENT',
  );
  await expectCode(
    'tool_only 宿主不能报告最终清单',
    (async () => {
      const weak = await bindHost(env, {
        agentId: first.agent,
        space: first.space,
        trustLevel: 'api_tool_only',
        session: unique('weak'),
      });
      await buildSubmittedInputManifest(env.d1, {
        ...buildInput,
        hostBindingId: weak.binding_id,
        hostGeneration: weak.generation,
        invocation: { ...inv, host_binding_id: weak.binding_id, host_generation: weak.generation },
        target: {
          ...target,
          host_binding_id: weak.binding_id,
          host_generation: weak.generation,
        },
      });
    })(),
    'PERMISSION_DENIED',
  );

  checkEqual(
    '最终清单已写入但未提交不产生经历',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    0,
  );
  env.db
    .prepare('UPDATE room_members SET last_read_seq = 999999 WHERE room_id = ? AND actor_id = ?')
    .run(first.room, first.agent);
  checkEqual(
    'UI 已读游标不替代提交证据',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    0,
  );

  const ack = await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    hostBindingId: binding.binding_id,
    hostGeneration: binding.generation,
    manifestId: built.manifest.manifest_id,
    requestId: 'req_manifest_1',
    now: AT,
  });
  checkEqual('合格 host report 接纳经历', ack.disposition, 'applied');
  checkEqual('host report 证据等级', ack.evidence, 'host_reported_submitted');
  checkEqual(
    '经历数 = manifest 项数',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    1,
  );
  const duplicateAck = await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    hostBindingId: binding.binding_id,
    hostGeneration: binding.generation,
    manifestId: built.manifest.manifest_id,
    requestId: 'req_manifest_1',
    now: AT + 1,
  });
  checkEqual('重复提交只对账', duplicateAck.disposition, 'applied');
  checkEqual(
    '重复提交不重复经历',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    1,
  );
  const otherRequest = await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    hostBindingId: binding.binding_id,
    hostGeneration: binding.generation,
    manifestId: built.manifest.manifest_id,
    requestId: 'req_manifest_2',
    now: AT + 1,
  });
  checkEqual('同 invocation 不同 requestId 只对账一次', otherRequest.disposition, 'applied');
  checkEqual(
    '同 invocation 不同 requestId 不重复经历',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    1,
  );

  const gateway = await appendGatewayObservationProof(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    hostBindingId: binding.binding_id,
    hostGeneration: binding.generation,
    manifestId: built.manifest.manifest_id,
    observedPayloadSha256: built.manifest.payload_sha256,
    observedAt: AT + 2,
    now: AT + 2,
  });
  check('网关观测追加 proof', gateway.appended);
  const strict = await listExperiences(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    targetScope: privateTarget(),
    minimumEvidence: 'gateway_observed_submitted',
    now: AT + 3,
  });
  checkEqual('严格证据查询仍返回同一事实', strict.items.length, 1);
  checkEqual('证据升级后等级', strict.items[0]?.evidence, 'gateway_observed_submitted');
  checkEqual(
    '证据升级不重复经历',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
    1,
  );
  const rawCoverage = await sourceRawCoverage(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    sourceId: source.sourceId,
    sourceRevision: 1,
    originRoomId: first.room,
    memberGeneration: 1,
    now: AT + 3,
  });
  check('manifest 原文覆盖完整', rawCoverage.full);
  checkEqual('原文覆盖 range 数', rawCoverage.ranges.length, 1);

  leaveAndRejoin(env, first.room, first.agent, {
    joinedSeq: 0,
    memberGeneration: 2,
    at: AT + 5,
  });
  const gen2Coverage = await coverageForSource(env.d1, {
    spaceId: first.space.space_id,
    ownershipEpoch: first.space.ownership_epoch,
    agentId: first.agent,
    sourceId: source.sourceId,
    sourceRevision: 1,
    originRoomId: first.room,
    originMemberGeneration: 2,
  });
  checkEqual('退群重加不复制旧消费游标', gen2Coverage.ranges.length, 0);
  const oldGenFrontier = await experienceCoverage(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    roomId: first.room,
    memberGeneration: 1,
    now: AT + 5,
  });
  checkEqual('旧成员代次不能继续读取 frontier', oldGenFrontier.frontier_seq, null);
  const oldGenList = await listExperiences(env.d1, {
    instanceId,
    agentId: first.agent,
    space: first.space,
    targetScope: privateTarget(),
    roomId: first.room,
    memberGeneration: 1,
    now: AT + 5,
  });
  checkEqual('旧成员代次不返回经历正文', oldGenList.items.length, 0);

  // 2. 摘要不冒充原文；多源摘要不推进 raw coverage
  const second = await setupAgentRoom(env, 'summary');
  const sourceA = await addSource(env, {
    sourceKey: `msg_${second.room}_a`,
    roomId: second.room,
    seq: 20,
    text: 'ALPHA-摘要来源',
  });
  const sourceB = await addSource(env, {
    sourceKey: `msg_${second.room}_b`,
    roomId: second.room,
    seq: 21,
    text: 'BETA-摘要来源',
  });
  const summary = await summaryRepresentation({
    summaryId: 'summary_mf11',
    revision: 1,
    text: 'SUMMARY: ALPHA + BETA',
    dependencies: [
      { source_id: sourceA.sourceId, source_revision: 1 },
      { source_id: sourceB.sourceId, source_revision: 1 },
    ],
  });
  const secondBinding = await bindHost(env, { agentId: second.agent, space: second.space });
  const secondInv = invocation(secondBinding.binding_id, secondBinding.generation, 'summary_1');
  const secondTarget = await messageTarget(env, {
    agentId: second.agent,
    space: second.space,
    bindingId: secondBinding.binding_id,
    generation: secondBinding.generation,
    inv: secondInv,
    targetScope: privateTarget(),
    roomId: second.room,
  });
  const [summarySelection] = await createSourceSelections(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    targetScope: privateTarget(),
    representations: [summary],
    now: AT,
  });
  const summaryPayload = `SUMMARY-ONLY\n${summary.text}`;
  const summaryManifest = await buildSubmittedInputManifest(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    hostBindingId: secondBinding.binding_id,
    hostGeneration: secondBinding.generation,
    invocation: secondInv,
    target: secondTarget,
    payload: summaryPayload,
    items: [
      {
        selection_id: summarySelection!.selection_id,
        representation_id: summary.representation.representation_id,
        text_sha256: summary.representation.text_sha256,
      },
    ],
    now: AT,
  });
  const summaryAck = await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    hostBindingId: secondBinding.binding_id,
    hostGeneration: secondBinding.generation,
    manifestId: summaryManifest.manifest.manifest_id,
    requestId: 'req_summary_1',
    now: AT,
  });
  checkEqual('摘要输入被接纳', summaryAck.disposition, 'applied');
  const summaryCoverageA = await sourceRawCoverage(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    sourceId: sourceA.sourceId,
    sourceRevision: 1,
    originRoomId: second.room,
    memberGeneration: 1,
    now: AT,
  });
  const summaryCoverageB = await sourceRawCoverage(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    sourceId: sourceB.sourceId,
    sourceRevision: 1,
    originRoomId: second.room,
    memberGeneration: 1,
    now: AT,
  });
  checkEqual('摘要不推进来源 A raw coverage', summaryCoverageA.ranges.length, 0);
  checkEqual('摘要不推进来源 B raw coverage', summaryCoverageB.ranges.length, 0);
  const secondList = await listExperiences(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    targetScope: privateTarget(),
    now: AT + 1,
  });
  checkEqual('摘要单独形成一条经历', secondList.items.length, 1);
  checkEqual('摘要经历类型', secondList.items[0]?.representation_kind, 'summary');
  const summaryDetail = await getExperience(env.d1, {
    instanceId,
    agentId: second.agent,
    space: second.space,
    targetScope: privateTarget(),
    experienceId: secondList.items[0]!.experience_id,
    now: AT + 1,
  });
  check('摘要正文可读', summaryDetail.available);
  if (summaryDetail.available) {
    checkEqual('摘要正文', summaryDetail.detail.text, summary.text);
  }
  checkEqual(
    '摘要没有产生 raw 范围',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_coverage_ranges').get() as { n: number }).n,
    1,
  );

  // 3. 稀疏 UTF-8 片段与非法码点边界
  const third = await setupAgentRoom(env, 'utf8');
  const chinese = '甲🙂乙丙';
  const chineseMessageId = `msg_${third.room}_utf8`;
  const chineseSource = await addSource(env, {
    sourceKey: `message:${chineseMessageId}`,
    roomId: third.room,
    seq: 30,
    text: chinese,
  });
  insertMessage(env, {
    messageId: chineseMessageId,
    roomId: third.room,
    senderId: third.agent,
    seq: 30,
    body: chinese,
  });
  const invalid = await rawRepresentation({
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    text: '🙂',
    kind: 'raw_fragment',
    start: 1,
    end: 5,
  });
  await expectCode(
    '片段起点落在 UTF-8 码点中间被拒绝',
    createSourceSelections(env.d1, {
      instanceId,
      agentId: third.agent,
      space: third.space,
      targetScope: privateTarget(),
      representations: [invalid],
      now: AT,
    }),
    'MEMORY_EVIDENCE_INSUFFICIENT',
  );
  const head = await rawRepresentation({
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    text: '甲',
    kind: 'raw_fragment',
    start: 0,
    end: 3,
  });
  const tail = await rawRepresentation({
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    text: '丙',
    kind: 'raw_fragment',
    start: 10,
    end: 13,
  });
  const preview = await rawRepresentation({
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    text: 'X',
    kind: 'preview',
    start: 0,
    end: 3,
  });
  if (preview.representation.kind === 'preview') {
    (preview.representation as { verbatim: boolean }).verbatim = false;
  }
  const thirdSelections = await createSourceSelections(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    representations: [head, tail, preview],
    now: AT,
  });
  checkEqual('三个准备选择', thirdSelections.length, 3);
  const thirdBinding = await bindHost(env, { agentId: third.agent, space: third.space });
  const thirdInv = invocation(thirdBinding.binding_id, thirdBinding.generation, 'sparse_1');
  const thirdTarget = await messageTarget(env, {
    agentId: third.agent,
    space: third.space,
    bindingId: thirdBinding.binding_id,
    generation: thirdBinding.generation,
    inv: thirdInv,
    targetScope: privateTarget(),
    roomId: third.room,
  });
  const sparsePayload = `HEAD:${head.text}|TAIL:${tail.text}|PREVIEW:${preview.text}`;
  const sparseManifest = await buildSubmittedInputManifest(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    invocation: thirdInv,
    target: thirdTarget,
    payload: sparsePayload,
    items: thirdSelections.map((item) => ({
      selection_id: item.selection_id,
      representation_id: item.representation.representation_id,
      text_sha256: item.representation.text_sha256,
    })),
    now: AT,
  });
  await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    manifestId: sparseManifest.manifest.manifest_id,
    requestId: 'req_sparse_1',
    now: AT,
  });
  const sparseCoverage = await sourceRawCoverage(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    originRoomId: third.room,
    memberGeneration: 1,
    now: AT,
  });
  check('稀疏范围不完整', !sparseCoverage.full);
  checkEqual('头片 + 末片两个范围', sparseCoverage.ranges.length, 2);
  const frontier = await experienceCoverage(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    roomId: third.room,
    memberGeneration: 1,
    now: AT,
  });
  checkEqual('缺中间片段时 frontier 为 null', frontier.frontier_seq, null);
  checkEqual('first_gap 指向实际消息', frontier.first_gap?.message_id, chineseMessageId);
  const middleA = await rawRepresentation({
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    text: '🙂',
    kind: 'raw_fragment',
    start: 3,
    end: 7,
  });
  const middleB = await rawRepresentation({
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    text: '乙',
    kind: 'raw_fragment',
    start: 7,
    end: 10,
  });
  const middleSelections = await createSourceSelections(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    representations: [middleA, middleB],
    now: AT + 1,
  });
  const secondInvocation = invocation(thirdBinding.binding_id, thirdBinding.generation, 'sparse_2');
  const secondTargetSparse = await messageTarget(env, {
    agentId: third.agent,
    space: third.space,
    bindingId: thirdBinding.binding_id,
    generation: thirdBinding.generation,
    inv: secondInvocation,
    targetScope: privateTarget(),
    roomId: third.room,
  });
  const completeManifest = await buildSubmittedInputManifest(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    invocation: secondInvocation,
    target: secondTargetSparse,
    payload: `${middleA.text}${middleB.text}`,
    items: middleSelections.map((item) => ({
      selection_id: item.selection_id,
      representation_id: item.representation.representation_id,
      text_sha256: item.representation.text_sha256,
    })),
    now: AT + 1,
  });
  await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    manifestId: completeManifest.manifest.manifest_id,
    requestId: 'req_sparse_2',
    now: AT + 1,
  });
  const completeCoverage = await sourceRawCoverage(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    sourceId: chineseSource.sourceId,
    sourceRevision: 1,
    originRoomId: third.room,
    memberGeneration: 1,
    now: AT + 2,
  });
  check('跨 run 累计覆盖完整', completeCoverage.full);
  const completeFrontier = await experienceCoverage(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    roomId: third.room,
    memberGeneration: 1,
    now: AT + 2,
  });
  checkEqual('真实消息完整后 frontier 前进', completeFrontier.frontier_seq, 30);

  // 4. authored / curated 独立类别
  const authoredSource = await addSource(env, {
    sourceKey: `msg_${third.room}_authored`,
    roomId: third.room,
    seq: 40,
    text: 'AGENT-AUTHORED-201',
    authorActorId: third.agent,
  });
  const authored = await authoredRepresentation({
    sourceId: authoredSource.sourceId,
    sourceRevision: 1,
    text: authoredSource.text,
    producerKind: 'server_template',
  });
  const authoredId = await recordAuthoredExperience(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    exact: authored,
    sourceId: authoredSource.sourceId,
    sourceRevision: 1,
    originRoomId: third.room,
    originMemberGeneration: 1,
    now: AT + 3,
  });
  check('authored 经历已写入', authoredId.length > 0);
  const authoredList = await listExperiences(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    originKinds: ['authored'],
    now: AT + 3,
  });
  checkEqual('authored 单独过滤', authoredList.items.length, 1);
  checkEqual('authored producer_kind', authoredList.items[0]?.producer_kind, 'server_template');
  checkEqual(
    'authored 不推进原文覆盖',
    (await sourceRawCoverage(env.d1, {
      instanceId,
      agentId: third.agent,
      space: third.space,
      sourceId: authoredSource.sourceId,
      sourceRevision: 1,
      originRoomId: third.room,
      memberGeneration: 1,
      now: AT + 3,
    })).ranges.length,
    0,
  );
  const curated = await saveCuratedMemory(env.d1, {
    instanceId,
    agentId: third.agent,
    ownerActorId: third.manager,
    space: third.space,
    title: '人工资料',
    content: 'CURATED-MF11',
    now: AT + 4,
  });
  checkEqual('curated 修订', curated.revision, 1);
  const curatedList = await listCuratedMemories(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    now: AT + 4,
  });
  checkEqual('curated 列表独立', curatedList.length, 1);
  checkEqual(
    'curated 不产生经历',
    (env.db
      .prepare('SELECT COUNT(*) AS n FROM memory_experiences WHERE origin_kind = ?')
      .get('curated') as { n: number }).n,
    0,
  );
  console.log(`\nMF11 manifest/experience checks passed: ${checksPassed()} 项`);
}

await main();
