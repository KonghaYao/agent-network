/**
 * Memory MF01 契约最小校验。
 *
 * 只验证类型/schema/纯策略函数，不启动服务、不连接数据库或引擎：
 * - 六操作 Adapter 与 lookup/auto 的类型边界；
 * - pending/unavailable/unsupported 与证据等级；
 * - 准确消费、authored/curated、稀疏范围、摘要与当前上下文；
 * - 客户端不能自报 space/provider bank/verified/trusted。
 *
 * 运行：bun run test:memory-contracts
 */
import { BusinessError } from '../src/contracts/errors';
import {
  MEMORY_ERROR_CODES,
  MEMORY_PAYLOAD_AUTHORITY,
  canDiscloseOrigin,
  countsAsRawCoverage,
  decideExperienceAdmission,
  hostMayReportEvidence,
  hostSupports,
  isFullRawCoverage,
  isInjectionEligible,
  isValidByteRange,
  maxReportableEvidence,
  meetsMinimumEvidence,
  memoryExposureReceiptInputSchema,
  memoryHostBindInputSchema,
  memoryInputPrepareInputSchema,
  memoryRecallInputSchema,
  type MemoryAccessVersions,
  type MemoryBoundContext,
  type MemoryContextTarget,
  type MemoryLookupContext,
  type MemoryOriginScope,
  type MemoryRecallDispatch,
  type MemoryRecallTarget,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from '../src/memory/contracts';
import type { MemoryAdapter, MemoryAdapterOperation } from '../src/memory/adapters/types';

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right
  ? 1
  : 2
  ? true
  : false;
type Expect<Value extends true> = Value;

type _AdapterOps = Expect<Equal<keyof MemoryAdapter, MemoryAdapterOperation>>;
type _AutoIntentModes = Expect<Equal<Extract<MemoryRecallDispatch, { kind: 'auto' }>['intent']['mode'], 'related' | 'task'>>;
type _LookupIsNeverAuto = Expect<Equal<Extract<MemoryRecallDispatch, { kind: 'auto'; intent: { mode: 'lookup' } }>, never>>;

let checks = 0;
let failures = 0;

function check(label: string, condition: unknown, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
}

interface Parseable {
  safeParse(value: unknown): { success: boolean; error?: unknown };
}

function accepts(label: string, schema: Parseable, value: unknown): void {
  const result = schema.safeParse(value);
  check(label, result.success, result.error);
}

function rejects(label: string, schema: Parseable, value: unknown): void {
  check(label, !schema.safeParse(value).success);
}

const hash = 'a'.repeat(64);
const space: MemorySpaceRef = {
  space_id: 'sp_contract',
  ownership_epoch: 1,
  backend_binding_epoch: 1,
};
const targetScope: MemoryTargetScope = {
  audience: 'room',
  room_id: 'rm_group',
  member_generation: 3,
  member_seq: 10,
  policy_revision: 2,
};
const versions: MemoryAccessVersions = {
  actor_disabled_at: null,
  credential_revoked_at: null,
  management_binding_id: 'mg_1',
  management_permission_version: 1,
  rooms: [
    {
      room_id: 'rm_group',
      member_generation: 3,
      member_seq: 10,
      policy_revision: 2,
      joined_seq: 0,
      joined_at: 0,
      archive_head_seq: null,
    },
  ],
};
const messageTarget: Extract<MemoryContextTarget, { kind: 'message' }> = {
  kind: 'message',
  agent_actor_id: 'actor_a',
  space,
  host_binding_id: 'hb_1',
  host_generation: 1,
  session_incarnation: 'sess_1',
  run_id: 'run_1',
  input_id: 'input_1',
  input_revision: 1,
  target_scope: targetScope,
  versions,
  message: { message_id: 'msg_1', delivery_id: 'dl_1', attempt: 1, claim_id: 'cl_1' },
};

function main(): void {
  console.log('Memory MF01 契约校验');

  for (const code of MEMORY_ERROR_CODES) {
    const error = new BusinessError(code, 'contract check');
    check(`错误码可构造且保留原码：${code}`, error.code === code);
  }
  check('MEMORY_UNAVAILABLE 可重试', new BusinessError('MEMORY_UNAVAILABLE', 'x').retryable);
  check('MEMORY_NOT_READY 可重试', new BusinessError('MEMORY_NOT_READY', 'x').retryable);
  check('MEMORY_DISABLED 不可重试', !new BusinessError('MEMORY_DISABLED', 'x').retryable);

  check('host_reported 满足 host 最低证据', meetsMinimumEvidence('host_reported_submitted', 'host_reported_submitted'));
  check('host_reported 不满足 gateway 最低证据', !meetsMinimumEvidence('host_reported_submitted', 'gateway_observed_submitted'));
  check('gateway 满足 host 最低证据', meetsMinimumEvidence('gateway_observed_submitted', 'host_reported_submitted'));
  for (const state of ['prepared', 'served', 'unknown'] as const) {
    check(`${state} 不满足任何提交最低证据`, !meetsMinimumEvidence(state, 'host_reported_submitted'));
  }

  const baseAdmission = {
    minimum_evidence: 'host_reported_submitted',
    source_state: 'active',
    ownership_current: true,
    agent_enabled: true,
  } as const;
  const submitted = decideExperienceAdmission({
    ...baseAdmission,
    origin_kind: 'experienced',
    submission_state: 'host_reported_submitted',
  });
  check('experienced + 合格提交证据 → 接纳并允许 retain', submitted.admitted && submitted.retain_allowed && submitted.evidence === 'host_reported_submitted');
  for (const state of ['prepared', 'served'] as const) {
    const decision = decideExperienceAdmission({ ...baseAdmission, origin_kind: 'experienced', submission_state: state });
    check(`experienced + ${state} → 拒绝 retain`, !decision.admitted && !decision.retain_allowed && decision.reason === 'not_submitted');
  }
  const unknown = decideExperienceAdmission({ ...baseAdmission, origin_kind: 'experienced', submission_state: 'unknown' });
  check('experienced + unknown → 提交未知不推进', !unknown.admitted && unknown.reason === 'submission_unknown');
  const below = decideExperienceAdmission({
    ...baseAdmission,
    origin_kind: 'experienced',
    submission_state: 'host_reported_submitted',
    minimum_evidence: 'gateway_observed_submitted',
  });
  check('experienced + 低于最低证据 → 拒绝', !below.admitted && below.reason === 'evidence_below_minimum');
  const authored = decideExperienceAdmission({
    ...baseAdmission,
    origin_kind: 'authored',
    submission_state: 'prepared',
    producer_kind: 'agent_text',
  });
  check('authored 不要求 input_exposure，但要求 producer_kind', authored.admitted && authored.retain_allowed && authored.evidence === null);
  const authoredMissingProducer = decideExperienceAdmission({
    ...baseAdmission,
    origin_kind: 'authored',
    submission_state: 'prepared',
  });
  check('authored 缺 producer_kind → 拒绝', !authoredMissingProducer.admitted && authoredMissingProducer.reason === 'producer_kind_required');
  const curated = decideExperienceAdmission({
    ...baseAdmission,
    origin_kind: 'curated',
    submission_state: 'prepared',
  });
  check('curated 使用独立资料策略', curated.admitted && curated.retain_allowed && curated.evidence === null);
  const retracted = decideExperienceAdmission({
    ...baseAdmission,
    source_state: 'retracted',
    origin_kind: 'experienced',
    submission_state: 'host_reported_submitted',
  });
  check('撤回来源不再接纳新经历', !retracted.admitted && retracted.reason === 'source_not_active');
  const transferred = decideExperienceAdmission({
    ...baseAdmission,
    ownership_current: false,
    origin_kind: 'experienced',
    submission_state: 'host_reported_submitted',
  });
  check('归属代次变化 → 拒绝新 owner 经历', !transferred.admitted && transferred.reason === 'ownership_changed');
  const disabled = decideExperienceAdmission({
    ...baseAdmission,
    agent_enabled: false,
    origin_kind: 'experienced',
    submission_state: 'host_reported_submitted',
  });
  check('停用 Agent → 拒绝接纳', !disabled.admitted && disabled.reason === 'agent_disabled');

  check('完整范围 [0,10) 是 raw_full', isFullRawCoverage([{ start: 0, end: 10 }], 10));
  check('相邻片段合并后可覆盖全文', isFullRawCoverage([{ start: 5, end: 10 }, { start: 0, end: 5 }], 10));
  check('重叠片段可覆盖全文', isFullRawCoverage([{ start: 0, end: 7 }, { start: 5, end: 10 }], 10));
  check('中间缺块不是 raw_full', !isFullRawCoverage([{ start: 0, end: 4 }, { start: 5, end: 10 }], 10));
  check('超出正文不是 raw_full', !isFullRawCoverage([{ start: 0, end: 10 }], 11));
  check('空正文不产生 raw_full', !isFullRawCoverage([], 0));
  check('合法半开区间', isValidByteRange({ start: 0, end: 10 }, 10));
  check('越界区间无效', !isValidByteRange({ start: 0, end: 11 }, 10));
  check('零长度区间无效', !isValidByteRange({ start: 4, end: 4 }, 10));
  check('负起点无效', !isValidByteRange({ start: -1, end: 4 }, 10));
  check('raw_fragment 计入原文覆盖', countsAsRawCoverage('raw_fragment'));
  check('preview 不计入原文覆盖', !countsAsRawCoverage('preview'));
  check('summary 不计入原文覆盖', !countsAsRawCoverage('summary'));
  check('memory_context 不计入原文覆盖', !countsAsRawCoverage('memory_context'));
  check('authored 不计入原文覆盖', !countsAsRawCoverage('authored'));

  const privateOrigin: Pick<MemoryOriginScope, 'room_id' | 'member_generation' | 'policy_revision'> = {
    room_id: 'rm_direct',
    member_generation: 1,
    policy_revision: 1,
  };
  const groupTarget: MemoryTargetScope = {
    audience: 'room',
    room_id: 'rm_group',
    member_generation: 1,
    member_seq: 1,
    policy_revision: 1,
  };
  const crossRoom = canDiscloseOrigin(privateOrigin, groupTarget);
  check('私聊来源默认不能进入群目标', !crossRoom.allowed && crossRoom.reason === 'different_room');
  const sameRoom = canDiscloseOrigin(
    { room_id: 'rm_group', member_generation: 1, policy_revision: 1 },
    groupTarget,
  );
  check('同房间同代次同策略才允许披露', sameRoom.allowed && sameRoom.reason === 'same_origin_room');
  const staleGeneration = canDiscloseOrigin(
    { room_id: 'rm_group', member_generation: 0, policy_revision: 1 },
    groupTarget,
  );
  check('成员代次变化 → 披露失效', !staleGeneration.allowed && staleGeneration.reason === 'membership_stale');
  const changedPolicy = canDiscloseOrigin(
    { room_id: 'rm_group', member_generation: 1, policy_revision: 0 },
    groupTarget,
  );
  check('策略版本变化 → 披露失效', !changedPolicy.allowed && changedPolicy.reason === 'policy_changed');
  const granted = canDiscloseOrigin(privateOrigin, groupTarget, {
    grant_id: 'grant_1',
    from_room_id: 'rm_direct',
    to_room_id: 'rm_group',
  });
  check('显式 grant 才允许跨房披露', granted.allowed && granted.reason === 'explicit_cross_room_grant');
  const privateTarget = canDiscloseOrigin(privateOrigin, {
    audience: 'agent_private',
    room_id: null,
    member_generation: null,
    member_seq: null,
    policy_revision: null,
  });
  check('Agent 私有上下文允许使用自己的私聊来源', privateTarget.allowed && privateTarget.reason === 'agent_private');
  const malformedTarget = canDiscloseOrigin(privateOrigin, {
    audience: 'room',
    room_id: null,
    member_generation: null,
    member_seq: null,
    policy_revision: null,
  });
  check('room 受众缺版本 → 无效目标', !malformedTarget.allowed && malformedTarget.reason === 'invalid_target');

  check('tool-only 没有提交证据等级', maxReportableEvidence('tool_only') === null);
  check('adapted host 最高 host_reported', maxReportableEvidence('adapted_host') === 'host_reported_submitted');
  check('controlled gateway 最高 gateway_observed', maxReportableEvidence('controlled_gateway') === 'gateway_observed_submitted');
  check('tool-only 不能报告提交证据', !hostMayReportEvidence('tool_only', 'host_reported_submitted'));
  check('adapted host 不能伪造 gateway 证据', !hostMayReportEvidence('adapted_host', 'gateway_observed_submitted'));
  check('adapted host 可报告 host 证据', hostMayReportEvidence('adapted_host', 'host_reported_submitted'));
  check('controlled gateway 可报告 gateway 证据', hostMayReportEvidence('controlled_gateway', 'gateway_observed_submitted'));
  check('tool-only 没有 run_binding 能力', !hostSupports('tool_only', 'run_binding'));
  check('adapted host 声明 submission_evidence', hostSupports('adapted_host', 'submission_evidence'));
  check('controlled gateway 声明 gateway_observation', hostSupports('controlled_gateway', 'gateway_observation'));

  const boundContext: MemoryBoundContext = {
    kind: 'bound',
    context_id: 'ctx_bound',
    space,
    agent_actor_id: 'actor_a',
    body: { version: 1, sha256: hash, bytes: 32, authority: MEMORY_PAYLOAD_AUTHORITY },
    evidence: {
      coverage: 'bounded',
      evidence_complete: true,
      minimum_evidence: 'host_reported_submitted',
      items: [],
    },
    validity: 'active',
    created_at: 1,
    expires_at: 2,
    target: messageTarget,
    target_scope: targetScope,
    injection: { eligible: true, admit_required: true, reason: 'active' },
  };
  const lookupContext: MemoryLookupContext = {
    kind: 'lookup',
    context_id: 'ctx_lookup',
    space,
    agent_actor_id: 'actor_a',
    body: { version: 1, sha256: hash, bytes: 32, authority: MEMORY_PAYLOAD_AUTHORITY },
    evidence: {
      coverage: 'bounded',
      evidence_complete: true,
      minimum_evidence: null,
      items: [],
    },
    validity: 'active',
    created_at: 1,
    expires_at: 2,
    target: null,
    target_scope: targetScope,
    injection: { eligible: false, admit_required: true, reason: 'lookup_only' },
  };
  check('lookup Context 永远不可注入', !isInjectionEligible(lookupContext));
  check('active bound Context 可进入受理', isInjectionEligible(boundContext));
  const revokedContext: MemoryBoundContext = {
    ...boundContext,
    validity: 'revoked',
    injection: { eligible: false, admit_required: true, reason: 'revoked' },
  };
  check('撤销后的 bound Context 不可注入', !isInjectionEligible(revokedContext));

  const recallTarget: Extract<MemoryRecallTarget, { kind: 'message' }> = {
    kind: 'message',
    space,
    target_scope: targetScope,
    host_binding_id: 'hb_1',
    host_generation: 1,
    session_incarnation: 'sess_1',
    message: { room_id: 'rm_group', message_id: 'msg_1', created_seq: 10 },
    delivery_id: 'dl_1',
    attempt: 1,
  };
  const autoRelated: MemoryRecallDispatch = {
    kind: 'auto',
    intent: {
      mode: 'related',
      message: { room_id: 'rm_group', message_id: 'msg_1', created_seq: 10 },
    },
    target: recallTarget,
  };
  const explicitLookup: MemoryRecallDispatch = {
    kind: 'explicit',
    intent: { mode: 'lookup', query: '合同' },
  };
  check('auto 只携带 related/task 目标', autoRelated.kind === 'auto' && autoRelated.target.kind === 'message');
  check('lookup 显式派发不携带 target', explicitLookup.kind === 'explicit');

  const validContextTarget = {
    kind: 'message',
    host_binding_id: 'hb_1',
    host_generation: 1,
    session_incarnation: 'sess_1',
    run_id: 'run_1',
    input_id: 'input_1',
    input_revision: 1,
    message: { message_id: 'msg_1', delivery_id: 'dl_1', attempt: 1, claim_id: 'cl_1' },
  };
  const validRecall = {
    request_id: 'req_1',
    mode: 'related',
    dispatch: 'auto',
    host: { host_binding_id: 'hb_1', host_generation: 1, session_incarnation: 'sess_1' },
    message: { room_id: 'rm_group', message_id: 'msg_1', created_seq: 10 },
    budget: { candidate_limit: 10, output_bytes: 4096 },
  };
  accepts('合法 auto related 召回 schema', memoryRecallInputSchema, validRecall);
  accepts('合法显式 lookup 召回 schema', memoryRecallInputSchema, {
    request_id: 'req_2',
    mode: 'lookup',
    dispatch: 'explicit',
    query: '合同',
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });
  accepts('合法 bootstrap 召回 schema', memoryRecallInputSchema, {
    request_id: 'req_bootstrap',
    mode: 'bootstrap',
    dispatch: 'explicit',
    host: { host_binding_id: 'hb_1', host_generation: 1, session_incarnation: 'sess_1' },
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });
  rejects('bootstrap 缺宿主绑定被拒绝', memoryRecallInputSchema, {
    request_id: 'req_bootstrap',
    mode: 'bootstrap',
    dispatch: 'explicit',
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });
  rejects('客户端不能自报 verified', memoryRecallInputSchema, { ...validRecall, verified: true });
  rejects('客户端不能自报 trusted', memoryRecallInputSchema, { ...validRecall, trusted: true });
  rejects('客户端不能指定 provider bank', memoryRecallInputSchema, { ...validRecall, bank_id: 'bank_other' });
  rejects('客户端不能指定 provider_id', memoryRecallInputSchema, { ...validRecall, provider_id: 'hindsight' });
  rejects('客户端不能指定 space_id', memoryRecallInputSchema, { ...validRecall, space_id: 'sp_other' });
  rejects('auto 缺宿主绑定被拒绝', memoryRecallInputSchema, { ...validRecall, host: undefined });
  rejects('lookup 不能用 auto', memoryRecallInputSchema, {
    request_id: 'req_3',
    mode: 'lookup',
    dispatch: 'auto',
    query: '合同',
    host: { host_binding_id: 'hb_1', host_generation: 1, session_incarnation: 'sess_1' },
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });
  rejects('auto related 不能携带 task 定位', memoryRecallInputSchema, {
    ...validRecall,
    task: { task_id: 'task_1', assignment_id: 'asg_1', assignment_version: 1 },
  });
  accepts('auto related 可带硬过滤最低证据', memoryRecallInputSchema, {
    ...validRecall,
    hard_filters: { minimum_evidence: 'gateway_observed_submitted', origin_kinds: ['experienced'] },
  });
  rejects('显式查询不能携带注入目标', memoryRecallInputSchema, {
    request_id: 'req_4',
    mode: 'lookup',
    dispatch: 'explicit',
    query: '合同',
    target: validContextTarget,
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });

  accepts('宿主绑定只接受声明能力', memoryHostBindInputSchema, {
    request_id: 'req_hb',
    declared_capabilities: ['explicit_lookup', 'run_binding'],
  });
  rejects('宿主绑定不能自报等级', memoryHostBindInputSchema, {
    request_id: 'req_hb',
    level: 'controlled_gateway',
  });
  rejects('宿主绑定不能自报 trusted', memoryHostBindInputSchema, {
    request_id: 'req_hb',
    declared_capabilities: ['explicit_lookup'],
    trusted: true,
  });

  accepts('输入准备只接受 selection 引用', memoryInputPrepareInputSchema, {
    request_id: 'req_prepare',
    target: validContextTarget,
    selection_ids: ['sel_1'],
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });
  rejects('输入准备不能携带正文', memoryInputPrepareInputSchema, {
    request_id: 'req_prepare',
    target: validContextTarget,
    selection_ids: ['sel_1'],
    text: '客户端自带上文',
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });
  rejects('输入准备不能携带来源 ID', memoryInputPrepareInputSchema, {
    request_id: 'req_prepare',
    target: validContextTarget,
    selection_ids: ['sel_1'],
    source_id: 'src_1',
    budget: { candidate_limit: 10, output_bytes: 4096 },
  });

  accepts('合法 input_exposure 回执', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'input_exposure',
    manifest_id: 'mf_1',
    manifest_sha256: hash,
    payload_sha256: hash,
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
  });
  accepts('合法 context_delivery 回执', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'context_delivery',
    context_id: 'ctx_1',
    context_sha256: hash,
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
  });
  rejects('input_exposure 缺 manifest 被拒绝', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'input_exposure',
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
  });
  rejects('回执不能携带裸 through_seq', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'input_exposure',
    manifest_id: 'mf_1',
    manifest_sha256: hash,
    payload_sha256: hash,
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
    through_seq: 100,
  });
  rejects('回执不能自报 evidence 等级', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'input_exposure',
    manifest_id: 'mf_1',
    manifest_sha256: hash,
    payload_sha256: hash,
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
    evidence: 'gateway_observed_submitted',
  });
  rejects('回执不能自报 verified', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'context_delivery',
    context_id: 'ctx_1',
    context_sha256: hash,
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
    verified: true,
  });
  rejects('context_delivery 不能携带 manifest 字段', memoryExposureReceiptInputSchema, {
    request_id: 'req_receipt',
    kind: 'context_delivery',
    context_id: 'ctx_1',
    context_sha256: hash,
    manifest_id: 'mf_1',
    invocation_id: 'inv_1',
    proof_id: 'proof_1',
    submitted_at: 1,
  });

  if (failures > 0) {
    console.error(`\nMemory 契约校验失败：${failures}/${checks} 项未通过`);
    process.exit(1);
  }
  console.log(`\nMemory 契约校验通过：${checks} 项`);
}

main();
