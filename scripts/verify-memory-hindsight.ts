/**
 * MF04 Hindsight 适配器验收（受控假 HTTP 服务）。
 *
 * 覆盖：
 * - 六操作与 capabilities 声明（分页/来源完整性/分区隔离/硬过滤/清除证据/reflect）；
 * - retain 只发送已接纳准确表示，拒绝 hash/字节/资格不匹配，同 key 冲突 fenced；
 * - search recall 与 list 分页、硬过滤、预算截断、unsupported 时间过滤；
 * - remove 删除后重新列出确认，DELETE 2xx 但文档仍在时保持 purge_pending；
 * - jobStatus pending/running/completed/failed/cancelled/unknown/unsupported；
 * - 超时、取消、重试、错误分类与凭据不泄漏。
 *
 * 运行：bun run test:memory-hindsight
 */
import {
  loadHindsightConfigFromEnv,
} from '../src/memory/adapters/hindsight';
import { HindsightMemoryAdapter } from '../src/memory/adapters/hindsight';
import { normalizeBaseUrl, resolveHindsightConfig } from '../src/memory/adapters/hindsight-config';
import { HindsightTransport } from '../src/memory/adapters/hindsight-transport';
import type {
  MemoryAdapterRetainItem,
  MemoryAdapterSearchPlan,
  RetainRequest,
} from '../src/memory/adapters/types';
import type {
  MemoryRawRepresentation,
  MemorySpaceRef,
  MemorySummaryRepresentation,
} from '../src/memory/contracts';
import { sha256Hex, utf8Bytes } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';
import { FakeHindsight } from './lib/memory-hindsight-fake';
import {
  realHindsightEnabled,
  runRealHindsightContract,
} from './lib/memory-hindsight-real';

const AT = 1_700_000_000_000;
const HASH = 'a'.repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function space(backendEpoch = 1, ownershipEpoch = 1): MemorySpaceRef {
  return {
    space_id: 'sp_mf04_hindsight',
    ownership_epoch: ownershipEpoch,
    backend_binding_epoch: backendEpoch,
  };
}

function experiencedEligibility(): MemoryAdapterRetainItem['eligibility'] {
  return {
    kind: 'experienced',
    evidence: 'host_reported_submitted',
    receipt_id: 'rcpt_mf04',
    proof_id: 'proof_mf04',
  };
}

function authoredEligibility(): MemoryAdapterRetainItem['eligibility'] {
  return {
    kind: 'authored',
    producer_kind: 'agent_text',
    experience_id: 'exp_mf04',
  };
}

async function rawRepresentation(
  sourceId: string,
  revision: number,
  text: string,
  representationId: string,
): Promise<MemoryRawRepresentation> {
  const bytes = utf8Bytes(text);
  return {
    representation_id: representationId,
    kind: 'raw_full',
    text_bytes: bytes,
    text_sha256: await sha256Hex(text),
    verbatim: true,
    source_id: sourceId,
    source_revision: revision,
    range: { start: 0, end: bytes },
    depends_on: [],
  };
}

function item(
  representation: MemoryRawRepresentation | MemorySummaryRepresentation,
  text: string,
  source: { source_id: string; source_revision: number } | null,
  originKind: 'experienced' | 'authored' | 'curated',
  eligibility: MemoryAdapterRetainItem['eligibility'],
): MemoryAdapterRetainItem {
  return {
    origin_kind: originKind,
    representation: { representation, text },
    source,
    eligibility,
  };
}

function retainRequest(
  targetSpace: MemorySpaceRef,
  items: MemoryAdapterRetainItem[],
  operationKey: string,
  payloadHash = HASH,
): RetainRequest {
  return {
    space: targetSpace,
    operation_key: operationKey,
    payload_sha256: payloadHash,
    items,
    policy_version: 1,
    deadline_at: null,
  };
}

function searchPlan(overrides: Partial<MemoryAdapterSearchPlan> = {}): MemoryAdapterSearchPlan {
  return {
    query: 'release',
    hard_filters: {},
    ranking_hints: {},
    candidate_limit: 10,
    output_bytes: 64 * 1024,
    deadline_at: null,
    policy_version: 1,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const token = `test_hindsight_${crypto.randomUUID().replaceAll('-', '')}`;
  const fake = new FakeHindsight(token);
  const adapter = new HindsightMemoryAdapter({
    baseUrl: fake.baseUrl,
    apiKey: token,
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    retryBaseMs: 1,
    listPageSize: 2,
    sleepImpl: async () => undefined,
  });

  try {
    // ---------------------------------------------------------------------
    // capabilities
    // ---------------------------------------------------------------------
    const caps = adapter.capabilities();
    checkEqual('capabilities.provider', caps.provider, 'hindsight');
    checkEqual('capabilities.pagination', caps.pagination, true);
    checkEqual(
      'capabilities.hard_filters',
      caps.hard_filters.join(','),
      'origin_kind,source_id',
    );
    checkEqual('capabilities.time_window', caps.time_window, 'ranking_hint_only');
    checkEqual('capabilities.source_completeness', caps.source_completeness, 'partial');
    checkEqual('capabilities.partition_isolation', caps.partition_isolation, 'provider_partition');
    checkEqual('capabilities.reflect', caps.reflect, true);
    checkEqual('capabilities.native_export', caps.native_export, false);
    checkEqual('capabilities.immutable_revisions', caps.immutable_revisions, true);
    checkEqual(
      'capabilities.remove_granularity',
      caps.remove_granularity,
      'exact_representation',
    );
    checkEqual('capabilities.write_fence', caps.write_fence, 'partition_generation');
    check('capabilities 不含凭据', !JSON.stringify(caps).includes(token));

    // ---------------------------------------------------------------------
    // ensureSpace
    // ---------------------------------------------------------------------
    const primarySpace = space();
    const ensured = await adapter.ensureSpace({
      space: primarySpace,
      operation_key: 'ensure-mf04',
      payload_sha256: HASH,
      deadline_at: null,
    });
    checkEqual('ensureSpace.ready', ensured.status, 'ready');
    check('ensureSpace.backend_ref 存在', ensured.backend_ref !== null);
    check(
      'ensureSpace bank 不使用原始 space_id',
      !ensured.backend_ref!.provider_id.includes(primarySpace.space_id),
    );
    checkEqual(
      'ensureSpace.backend_revision 绑定 epoch',
      ensured.backend_ref!.provider_revision,
      '1',
    );
    check('ensureSpace 结果不含凭据', !JSON.stringify(ensured).includes(token));
    const putRequest = fake.requests.find(
      (request) => request.method === 'PUT' && request.path.includes('/v1/default/banks/'),
    );
    check('请求使用 Bearer 凭据', putRequest?.headers.authorization === `Bearer ${token}`);

    // ---------------------------------------------------------------------
    // retain：准确表示、幂等、冲突、拒绝未接纳表示
    // ---------------------------------------------------------------------
    const sourceOne = { source_id: 'src_mf04_msg_1', source_revision: 1 };
    const textOne = 'Alice said the release moved to Friday.';
    const rawOne = await rawRepresentation(sourceOne.source_id, 1, textOne, 'rep_mf04_1');
    const itemOne = item(rawOne, textOne, sourceOne, 'experienced', experiencedEligibility());
    const retained = await adapter.retain(
      retainRequest(primarySpace, [itemOne], 'op-mf04-retain-1'),
    );
    checkEqual('retain.accepted', retained.status, 'accepted');
    check('retain.job_ref 存在', retained.job_ref !== null);
    checkEqual('retain.job_ref epoch', retained.job_ref!.backend_binding_epoch, 1);
    check('retain provider_job_id 是 UUID', UUID.test(retained.job_ref!.provider_job_id));
    check('retain 结果不含凭据', !JSON.stringify(retained).includes(token));

    const retainPosts = fake.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/memories'),
    );
    const firstBody = retainPosts[0]!.body as {
      operation_id: string;
      items: Array<Record<string, unknown>>;
    };
    const firstItem = firstBody.items[0]!;
    checkEqual('retain 发送准确文本', firstItem.content, textOne);
    checkEqual(
      'retain metadata 保存准确 hash',
      (firstItem.metadata as Record<string, string>).agentnet_text_sha256,
      rawOne.text_sha256,
    );
    check(
      'retain observation scope 限制在来源修订',
      JSON.stringify(firstItem.observation_scopes).includes('agentnet:s:') &&
        JSON.stringify(firstItem.observation_scopes).includes('agentnet:v:'),
    );
    check(
      'retain 未发送未消费原文扩展',
      !JSON.stringify(firstBody).includes('unconsumed full source text'),
    );

    const retried = await adapter.retain(
      retainRequest(primarySpace, [itemOne], 'op-mf04-retain-1'),
    );
    checkEqual('retain 重试仍 accepted', retried.status, 'accepted');
    checkEqual(
      'retain 重试复用 operation_id',
      retried.job_ref!.provider_job_id,
      retained.job_ref!.provider_job_id,
    );
    checkEqual('retain 重试不重复创建文档', fake.documents.length, 1);

    const textConflict = 'Alice said the release moved to Monday.';
    const rawConflict = await rawRepresentation(
      sourceOne.source_id,
      1,
      textConflict,
      'rep_mf04_conflict',
    );
    const conflict = await adapter.retain(
      retainRequest(
        primarySpace,
        [item(rawConflict, textConflict, sourceOne, 'experienced', experiencedEligibility())],
        'op-mf04-retain-1',
        'b'.repeat(64),
      ),
    );
    checkEqual('同 key 不同正文 status', conflict.status, 'unsupported');
    checkEqual('同 key 不同正文 reason', conflict.reason, 'fenced');

    const postCountBeforeInvalid = fake.requestCount('POST', '/memories');
    const brokenHash = await rawRepresentation(
      sourceOne.source_id,
      1,
      'hash mismatch text',
      'rep_mf04_bad_hash',
    );
    brokenHash.text_sha256 = '0'.repeat(64);
    const invalidHash = await adapter.retain(
      retainRequest(
        primarySpace,
        [item(brokenHash, 'hash mismatch text', sourceOne, 'experienced', experiencedEligibility())],
        'op-mf04-bad-hash',
      ),
    );
    checkEqual('representation hash 不匹配 status', invalidHash.status, 'unsupported');
    checkEqual('representation hash 不匹配 reason', invalidHash.reason, 'invalid_request');
    checkEqual(
      'representation hash 不匹配不发请求',
      fake.requestCount('POST', '/memories'),
      postCountBeforeInvalid,
    );

    const invalidEvidence = await adapter.retain(
      retainRequest(
        primarySpace,
        [
          item(rawOne, textOne, sourceOne, 'experienced', {
            kind: 'experienced',
            evidence: 'prepared',
            receipt_id: 'r',
            proof_id: 'p',
          } as unknown as MemoryAdapterRetainItem['eligibility']),
        ],
        'op-mf04-invalid-evidence',
      ),
    );
    checkEqual('未接纳 evidence status', invalidEvidence.status, 'unsupported');
    checkEqual('未接纳 evidence reason', invalidEvidence.reason, 'invalid_request');

    const wrongOrigin = await adapter.retain(
      retainRequest(
        primarySpace,
        [item(rawOne, textOne, sourceOne, 'curated', experiencedEligibility())],
        'op-mf04-wrong-origin',
      ),
    );
    checkEqual('origin 与资格不匹配 status', wrongOrigin.status, 'unsupported');
    checkEqual('origin 与资格不匹配 reason', wrongOrigin.reason, 'invalid_request');

    // ---------------------------------------------------------------------
    // retain 重试：503 两次后成功
    // ---------------------------------------------------------------------
    fake.behavior.retainFailures = 2;
    const sourceRetry = { source_id: 'src_mf04_retry', source_revision: 1 };
    const textRetry = 'Retry eventually succeeds.';
    const rawRetry = await rawRepresentation(
      sourceRetry.source_id,
      1,
      textRetry,
      'rep_mf04_retry',
    );
    const retryResult = await adapter.retain(
      retainRequest(
        primarySpace,
        [item(rawRetry, textRetry, sourceRetry, 'experienced', experiencedEligibility())],
        'op-mf04-retry',
      ),
    );
    checkEqual('retain 重试后 accepted', retryResult.status, 'accepted');
    checkEqual('retain 重试次数', fake.requestCount('POST', '/memories'), 6);

    // ---------------------------------------------------------------------
    // retain 超时
    // ---------------------------------------------------------------------
    fake.behavior.retainDelayMs = 120;
    const timeoutAdapter = new HindsightMemoryAdapter({
      baseUrl: fake.baseUrl,
      apiKey: token,
      requestTimeoutMs: 20,
      maxRetries: 0,
      retryBaseMs: 1,
      sleepImpl: async () => undefined,
    });
    const timeoutRetain = await timeoutAdapter.retain(
      retainRequest(
        primarySpace,
        [item(rawRetry, textRetry, sourceRetry, 'experienced', experiencedEligibility())],
        'op-mf04-timeout',
      ),
    );
    checkEqual('retain 超时 status', timeoutRetain.status, 'unavailable');
    checkEqual('retain 超时 reason', timeoutRetain.reason, 'timeout');
    fake.behavior.retainDelayMs = 0;
    timeoutAdapter.cancelAll();

    // ---------------------------------------------------------------------
    // search：recall 映射、硬过滤、预算、unsupported、list 分页
    // ---------------------------------------------------------------------
    const searchOne = await adapter.search({
      space: primarySpace,
      plan: searchPlan(),
    });
    checkEqual('search recall status', searchOne.status, 'ready');
    checkEqual('search recall coverage', searchOne.coverage, 'bounded');
    checkEqual('search recall hit 数', searchOne.hits.length, 2);
    checkEqual('search 映射 source id', searchOne.hits[0]!.source?.source_id, sourceOne.source_id);
    checkEqual(
      'search 映射 source revision',
      searchOne.hits[0]!.source?.source_revision,
      1,
    );
    checkEqual(
      'search 映射 raw 表示',
      searchOne.hits[0]!.representation.kind,
      'raw_full',
    );
    checkEqual('search 映射 verbatim', searchOne.hits[0]!.representation.verbatim, true);
    checkEqual('search evidence_complete', searchOne.evidence_complete, true);
    check('search 结果不含凭据', !JSON.stringify(searchOne).includes(token));

    const sourceTwo = { source_id: 'src_mf04_msg_2', source_revision: 1 };
    const textTwo = 'Bob authored a note about the release checklist.';
    const rawTwo = await rawRepresentation(sourceTwo.source_id, 1, textTwo, 'rep_mf04_2');
    const authored = await adapter.retain(
      retainRequest(
        primarySpace,
        [item(rawTwo, textTwo, sourceTwo, 'authored', authoredEligibility())],
        'op-mf04-retain-2',
      ),
    );
    checkEqual('authored retain', authored.status, 'accepted');

    const byOrigin = await adapter.search({
      space: primarySpace,
      plan: searchPlan({ hard_filters: { origin_kinds: ['authored'] } }),
    });
    checkEqual('origin 硬过滤 status', byOrigin.status, 'ready');
    check('origin 硬过滤只返回 authored', byOrigin.hits.every((hit) => hit.origin_kind === 'authored'));
    const recallRequest = fake.requests
      .filter((request) => request.method === 'POST' && request.path.endsWith('/memories/recall'))
      .at(-1);
    check(
      'origin 硬过滤使用 tag_groups',
      JSON.stringify(recallRequest?.body).includes('tag_groups') &&
        JSON.stringify(recallRequest?.body).includes('agentnet:o:authored'),
    );

    const bySource = await adapter.search({
      space: primarySpace,
      plan: searchPlan({ hard_filters: { source_ids: [sourceOne.source_id] } }),
    });
    check(
      'source 硬过滤只返回目标来源',
      bySource.hits.every((hit) => hit.source?.source_id === sourceOne.source_id),
    );

    const recallCountBefore = fake.requestCount('POST', '/memories/recall');
    const unsupportedTime = await adapter.search({
      space: primarySpace,
      plan: searchPlan({
        hard_filters: { time_field: 'created_at', time_from: AT },
      }),
    });
    checkEqual('时间过滤 status', unsupportedTime.status, 'unsupported');
    checkEqual('时间过滤 reason', unsupportedTime.reason, 'unsupported');
    checkEqual(
      '时间过滤 reason 标记',
      unsupportedTime.exclusions[0]?.reason,
      'unsupported_filter',
    );
    checkEqual(
      '时间过滤不发请求',
      fake.requestCount('POST', '/memories/recall'),
      recallCountBefore,
    );

    for (let index = 3; index <= 5; index += 1) {
      const source = { source_id: `src_mf04_bulk_${index}`, source_revision: 1 };
      const text = `Bulk release note ${index}.`;
      const representation = await rawRepresentation(
        source.source_id,
        1,
        text,
        `rep_mf04_bulk_${index}`,
      );
      await adapter.retain(
        retainRequest(
          primarySpace,
          [item(representation, text, source, 'experienced', experiencedEligibility())],
          `op-mf04-bulk-${index}`,
        ),
      );
    }

    const bounded = await adapter.search({
      space: primarySpace,
      plan: searchPlan({ candidate_limit: 2 }),
    });
    checkEqual('candidate_limit 截断 hit 数', bounded.hits.length, 2);
    checkEqual('candidate_limit coverage', bounded.coverage, 'bounded');
    checkEqual(
      'candidate_limit budget 排除',
      bounded.exclusions.find((exclusion) => exclusion.reason === 'budget')?.count,
      4,
    );

    const listSearch = await adapter.search({
      space: primarySpace,
      plan: searchPlan({ query: null, candidate_limit: 20, output_bytes: 1024 * 1024 }),
    });
    checkEqual('list search status', listSearch.status, 'ready');
    checkEqual('list search 全部命中', listSearch.hits.length, 6);
    checkEqual('list search 分页完整', listSearch.coverage, 'exhaustive');
    const listRequests = fake.requests.filter(
      (request) =>
        request.method === 'GET' && request.path.includes('/memories/list'),
    );
    checkEqual('list search 使用三页', listRequests.length, 3);
    checkEqual('list search 第一页 offset', listRequests[0]!.query.get('offset'), '0');
    checkEqual('list search 第二页 offset', listRequests[1]!.query.get('offset'), '2');
    checkEqual('list search 第三页 offset', listRequests[2]!.query.get('offset'), '4');

    const listFiltered = await adapter.search({
      space: primarySpace,
      plan: searchPlan({
        query: null,
        candidate_limit: 20,
        hard_filters: { origin_kinds: ['authored'] },
      }),
    });
    checkEqual('list 本地硬过滤 hit 数', listFiltered.hits.length, 1);
    check(
      'list 本地硬过滤全部 authored',
      listFiltered.hits.every((hit) => hit.origin_kind === 'authored'),
    );
    checkEqual(
      'list 本地硬过滤 exclusion',
      listFiltered.exclusions.find((exclusion) => exclusion.reason === 'hard_filter')?.count,
      5,
    );

    const missingBankSpace = { ...space(9), space_id: 'sp_mf04_missing_bank' };
    const missingBank = await adapter.search({
      space: missingBankSpace,
      plan: searchPlan(),
    });
    checkEqual('search 404 status', missingBank.status, 'unavailable');
    checkEqual('search 404 reason', missingBank.reason, 'unavailable');

    fake.behavior.recallDelayMs = 120;
    const timeoutSearch = await timeoutAdapter.search({
      space: primarySpace,
      plan: searchPlan(),
    });
    checkEqual('search 超时 status', timeoutSearch.status, 'unavailable');
    checkEqual('search 超时 reason', timeoutSearch.reason, 'timeout');
    fake.behavior.recallDelayMs = 0;
    timeoutAdapter.cancelAll();

    // ---------------------------------------------------------------------
    // jobStatus
    // ---------------------------------------------------------------------
    const jobRef = retained.job_ref!;
    const pending = await adapter.jobStatus({ space: primarySpace, job_ref: jobRef });
    checkEqual('jobStatus pending', pending.state, 'pending');
    checkEqual('jobStatus pending retryable', pending.retryable, true);

    fake.setOperationStatus(jobRef.provider_job_id, 'processing');
    const running = await adapter.jobStatus({ space: primarySpace, job_ref: jobRef });
    checkEqual('jobStatus processing->running', running.state, 'running');

    fake.setOperationStatus(jobRef.provider_job_id, 'completed');
    const completed = await adapter.jobStatus({ space: primarySpace, job_ref: jobRef });
    checkEqual('jobStatus completed', completed.state, 'completed');
    checkEqual('jobStatus completed stage', completed.stage, 'source_readable');
    checkEqual('jobStatus completed retryable', completed.retryable, false);

    fake.setOperationStatus(jobRef.provider_job_id, 'failed');
    const failed = await adapter.jobStatus({ space: primarySpace, job_ref: jobRef });
    checkEqual('jobStatus failed', failed.state, 'failed');
    checkEqual('jobStatus failed retryable', failed.retryable, true);

    fake.setOperationStatus(jobRef.provider_job_id, 'cancelled');
    const cancelled = await adapter.jobStatus({ space: primarySpace, job_ref: jobRef });
    checkEqual('jobStatus cancelled', cancelled.state, 'cancelled');

    const missingJob = await adapter.jobStatus({
      space: primarySpace,
      job_ref: { backend_binding_epoch: 1, provider_job_id: 'op-does-not-exist' },
    });
    checkEqual('jobStatus 404 unknown', missingJob.state, 'unknown');
    checkEqual('jobStatus 404 reason', missingJob.reason, 'unknown');

    const operationGetBefore = fake.requestCount('GET', '/operations/');
    const crossEpoch = await adapter.jobStatus({
      space: space(2),
      job_ref: jobRef,
    });
    checkEqual('jobStatus 跨代次 unknown', crossEpoch.state, 'unknown');
    checkEqual('jobStatus 跨代次 unsupported', crossEpoch.reason, 'unsupported');
    checkEqual(
      'jobStatus 跨代次不查新库',
      fake.requestCount('GET', '/operations/'),
      operationGetBefore,
    );

    const emptyJob = await adapter.jobStatus({
      space: primarySpace,
      job_ref: { backend_binding_epoch: 1, provider_job_id: '' },
    });
    checkEqual('jobStatus 空 JobRef unsupported', emptyJob.reason, 'unsupported');

    // ---------------------------------------------------------------------
    // remove：representation / source_revision / 清除证据
    // ---------------------------------------------------------------------
    const removedOne = await adapter.remove({
      space: primarySpace,
      operation_key: 'remove-mf04-rep',
      payload_sha256: HASH,
      targets: [
        {
          kind: 'representation',
          source: sourceOne,
          representation_id: rawOne.representation_id,
          range: rawOne.range,
        },
      ],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual('remove representation status', removedOne.status, 'accepted');
    checkEqual('remove representation purge', removedOne.purge, 'purged');
    checkEqual('remove representation 删除一次', fake.requestCount('DELETE', '/documents/'), 1);
    check('remove 结果不含凭据', !JSON.stringify(removedOne).includes(token));

    const removedAgain = await adapter.remove({
      space: primarySpace,
      operation_key: 'remove-mf04-rep-again',
      payload_sha256: HASH,
      targets: [
        {
          kind: 'representation',
          source: sourceOne,
          representation_id: rawOne.representation_id,
          range: rawOne.range,
        },
      ],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual('remove 幂等 purge', removedAgain.purge, 'purged');

    const sourceRevision = { source_id: 'src_mf04_multi', source_revision: 2 };
    for (let index = 0; index < 2; index += 1) {
      const text = `Revision two fragment ${index}.`;
      const representation = await rawRepresentation(
        sourceRevision.source_id,
        sourceRevision.source_revision,
        text,
        `rep_mf04_multi_${index}`,
      );
      await adapter.retain(
        retainRequest(
          primarySpace,
          [item(representation, text, sourceRevision, 'experienced', experiencedEligibility())],
          `op-mf04-multi-${index}`,
        ),
      );
    }
    const removeRevision = await adapter.remove({
      space: primarySpace,
      operation_key: 'remove-mf04-source-revision',
      payload_sha256: HASH,
      targets: [{ kind: 'source_revision', source: sourceRevision }],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual('remove source_revision status', removeRevision.status, 'accepted');
    checkEqual('remove source_revision purge', removeRevision.purge, 'purged');
    checkEqual(
      'remove source_revision 删除两份',
      fake.requestCount('DELETE', '/documents/'),
      3,
    );

    const keepText = 'Delete response lies about purge.';
    const keepSource = { source_id: 'src_mf04_keep', source_revision: 1 };
    const keepRaw = await rawRepresentation(
      keepSource.source_id,
      1,
      keepText,
      'rep_mf04_keep',
    );
    await adapter.retain(
      retainRequest(
        primarySpace,
        [item(keepRaw, keepText, keepSource, 'experienced', experiencedEligibility())],
        'op-mf04-keep',
      ),
    );
    fake.behavior.deleteKeepsDocument = true;
    const pendingPurge = await adapter.remove({
      space: primarySpace,
      operation_key: 'remove-mf04-keep',
      payload_sha256: HASH,
      targets: [
        {
          kind: 'representation',
          source: keepSource,
          representation_id: keepRaw.representation_id,
          range: keepRaw.range,
        },
      ],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual('删除未确认 status', pendingPurge.status, 'unavailable');
    checkEqual('删除未确认 purge_pending', pendingPurge.purge, 'purge_pending');
    fake.behavior.deleteKeepsDocument = false;

    const unsupportedPartition = await adapter.remove({
      space: primarySpace,
      operation_key: 'remove-mf04-partition',
      payload_sha256: HASH,
      targets: [{ kind: 'partition', partition_id: 'unknown', generation: 1 }],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual(
      'remove partition status',
      unsupportedPartition.status,
      'unsupported_granularity',
    );
    checkEqual(
      'remove partition purge',
      unsupportedPartition.purge,
      'unsupported_granularity',
    );

    fake.behavior.deleteDelayMs = 120;
    const timeoutRemove = await timeoutAdapter.remove({
      space: primarySpace,
      operation_key: 'remove-mf04-timeout',
      payload_sha256: HASH,
      targets: [
        {
          kind: 'representation',
          source: keepSource,
          representation_id: keepRaw.representation_id,
          range: keepRaw.range,
        },
      ],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual('remove 超时 status', timeoutRemove.status, 'unavailable');
    checkEqual('remove 超时 purge_pending', timeoutRemove.purge, 'purge_pending');
    checkEqual('remove 超时 reason', timeoutRemove.reason, 'timeout');
    fake.behavior.deleteDelayMs = 0;
    timeoutAdapter.cancelAll();

    // ---------------------------------------------------------------------
    // 重试、取消、配置 fail closed、凭据不泄漏
    // ---------------------------------------------------------------------
    fake.behavior.bankFailures = 2;
    const retriedEnsure = await adapter.ensureSpace({
      space: { ...space(3), space_id: 'sp_mf04_retry_ensure' },
      operation_key: 'ensure-retry',
      payload_sha256: HASH,
      deadline_at: null,
    });
    checkEqual('ensureSpace 503 重试成功', retriedEnsure.status, 'ready');
    checkEqual('ensureSpace 重试次数', fake.requestCount('PUT', '/v1/default/banks/'), 4);

    fake.behavior.bankDelayMs = 200;
    const cancelSpace = { ...space(4), space_id: 'sp_mf04_cancel' };
    const beforeCancel = fake.requestCount('PUT', '/v1/default/banks/');
    const pendingEnsure = adapter.ensureSpace({
      space: cancelSpace,
      operation_key: 'ensure-cancel',
      payload_sha256: HASH,
      deadline_at: null,
    });
    await fake.waitForRequest('PUT', '/v1/default/banks/', beforeCancel + 1);
    adapter.cancelAll();
    const cancelledEnsure = await pendingEnsure;
    checkEqual('取消 ensureSpace status', cancelledEnsure.status, 'unavailable');
    checkEqual('取消 ensureSpace reason', cancelledEnsure.reason, 'unavailable');
    fake.behavior.bankDelayMs = 0;

    const disabled = new HindsightMemoryAdapter(null);
    checkEqual('disabled.configured', disabled.configured, false);
    checkEqual('disabled.ensureSpace', (await disabled.ensureSpace({
      space: primarySpace,
      operation_key: 'disabled',
      payload_sha256: HASH,
      deadline_at: null,
    })).status, 'unavailable');
    checkEqual('disabled.retain', (await disabled.retain(
      retainRequest(primarySpace, [itemOne], 'disabled-retain'),
    )).status, 'unavailable');
    checkEqual('disabled.search', (await disabled.search({
      space: primarySpace,
      plan: searchPlan(),
    })).status, 'unavailable');
    const disabledRemove = await disabled.remove({
      space: primarySpace,
      operation_key: 'disabled-remove',
      payload_sha256: HASH,
      targets: [{ kind: 'source_revision', source: sourceOne }],
      policy_version: 1,
      deadline_at: null,
    });
    checkEqual('disabled.remove', disabledRemove.status, 'unavailable');
    checkEqual('disabled.remove purge', disabledRemove.purge, 'unknown');
    checkEqual('disabled.jobStatus', (await disabled.jobStatus({
      space: primarySpace,
      job_ref: { backend_binding_epoch: 1, provider_job_id: 'op' },
    })).reason, 'unavailable');
    check('disabled 不含凭据', !JSON.stringify(disabled.capabilities()).includes(token));

    const missingUrl = loadHindsightConfigFromEnv({ HINDSIGHT_API_KEY: token });
    check('env 缺 URL fail closed', !missingUrl.ok);
    check(
      'env 缺 URL 错误不含凭据',
      !missingUrl.ok && !missingUrl.error.includes(token),
    );
    const missingKey = loadHindsightConfigFromEnv({ HINDSIGHT_URL: fake.baseUrl });
    check('env 缺 key fail closed', !missingKey.ok);
    const badRetry = loadHindsightConfigFromEnv({
      HINDSIGHT_URL: fake.baseUrl,
      HINDSIGHT_API_KEY: token,
      HINDSIGHT_MAX_RETRIES: '-1',
    });
    check('env 非法重试数 fail closed', !badRetry.ok);
    check('env 非法重试错误不含凭据', !badRetry.ok && !badRetry.error.includes(token));
    const loaded = loadHindsightConfigFromEnv({
      HINDSIGHT_URL: fake.baseUrl,
      HINDSIGHT_API_KEY: token,
    });
    check('env 完整配置可加载', loaded.ok);
    check('env 配置 bank 前缀默认值', loaded.ok && loaded.config.bankPrefix === 'agentnet');

    let invalidUrlMessage = '';
    try {
      new HindsightMemoryAdapter({
        baseUrl: 'not-a-url',
        apiKey: token,
        fetchImpl: fake.baseUrl as unknown as typeof fetch,
      });
    } catch (error) {
      invalidUrlMessage = error instanceof Error ? error.message : String(error);
    }
    check('非法 URL 抛错', invalidUrlMessage.length > 0);
    check('非法 URL 错误不含凭据', !invalidUrlMessage.includes(token));

    // ---------------------------------------------------------------------
    // base URL 归一化与传输层错误/重试映射
    // ---------------------------------------------------------------------
    checkEqual(
      'base URL 归一化去掉尾随斜杠',
      normalizeBaseUrl(`${fake.baseUrl}/`),
      fake.baseUrl,
    );
    const trailingConfig = loadHindsightConfigFromEnv({
      HINDSIGHT_URL: `${fake.baseUrl}/`,
      HINDSIGHT_API_KEY: token,
    });
    check(
      'env 配置归一化 base URL',
      trailingConfig.ok && trailingConfig.config.baseUrl === fake.baseUrl,
    );
    const trailingAdapter = new HindsightMemoryAdapter({
      baseUrl: `${fake.baseUrl}/`,
      apiKey: token,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      retryBaseMs: 1,
      sleepImpl: async () => undefined,
    });
    const trailingEnsured = await trailingAdapter.ensureSpace({
      space: { ...space(7), space_id: 'sp_mf04_trailing_slash' },
      operation_key: 'ensure-trailing-slash',
      payload_sha256: HASH,
      deadline_at: null,
    });
    checkEqual('尾随斜杠不产生 //path', trailingEnsured.status, 'ready');

    let transportCalls = 0;
    const transport = new HindsightTransport(
      resolveHindsightConfig({
        baseUrl: 'https://hindsight.example/',
        apiKey: token,
        maxRetries: 1,
        retryBaseMs: 1,
        sleepImpl: async () => undefined,
        fetchImpl: (async (input, init) => {
          transportCalls += 1;
          const url = String(input);
          check('传输 URL 不含凭据', !url.includes(token));
          check(
            '传输凭据只在 Authorization 头',
            new Headers(init?.headers).get('authorization') === `Bearer ${token}`,
          );
          if (transportCalls === 1) {
            return new Response(JSON.stringify({ error: 'rate limited' }), {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '0' },
            });
          }
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      })!,
    );
    const retriedOutcome = await transport.request('GET', '/v1/default/banks', {
      deadlineAt: Date.now() + 5_000,
      retry: true,
    });
    checkEqual('429 按 Retry-After 重试', retriedOutcome.kind, 'ok');
    checkEqual('429 重试次数', transportCalls, 2);
    check(
      '传输结果不含凭据',
      !JSON.stringify(retriedOutcome).includes(token),
    );
    checkEqual(
      '429 分类',
      transport.reasonFor({ kind: 'http', status: 429, body: null }, 'unknown'),
      'unavailable',
    );
    checkEqual(
      '425 分类',
      transport.reasonFor({ kind: 'http', status: 425, body: null }, 'unknown'),
      'unavailable',
    );
    checkEqual(
      '408 分类',
      transport.reasonFor({ kind: 'http', status: 408, body: null }, 'unknown'),
      'timeout',
    );
    checkEqual(
      '401 分类',
      transport.reasonFor({ kind: 'http', status: 401, body: null }, 'unknown'),
      'unavailable',
    );
    checkEqual(
      '409 分类',
      transport.reasonFor({ kind: 'http', status: 409, body: null }, 'unknown'),
      'fenced',
    );
    checkEqual(
      '422 分类',
      transport.reasonFor({ kind: 'http', status: 422, body: null }, 'unknown'),
      'invalid_request',
    );
    checkEqual(
      '404 分类',
      transport.reasonFor({ kind: 'http', status: 404, body: null }, 'unknown'),
      'unknown',
    );
  } finally {
    await fake.stop();
  }

  if (realHindsightEnabled()) {
    console.log('--- Hindsight 真实契约（HINDSIGHT_REAL_TEST=1）---');
    const real = await runRealHindsightContract();
    console.log(
      `real hindsight contract: retain=${real.retainStatus} job=${real.jobState} ` +
        `recall_hits=${real.recallHits} list_hits=${real.listHits} ` +
        `documents=${real.documentCount} remove=${real.removeStatus} ` +
        `bank_deleted=${real.bankDeleted}`,
    );
  } else {
    console.log('real hindsight contract skipped (HINDSIGHT_REAL_TEST!=1)');
  }

  console.log(`memory hindsight checks passed (${checksPassed()} assertions)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
