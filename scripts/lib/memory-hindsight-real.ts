/**
 * Hindsight 真实 HTTP 契约验收（默认跳过）。
 *
 * 只在 `HINDSIGHT_REAL_TEST=1` 时运行，使用唯一测试 bank：
 * PUT bank -> retain 1 条 -> jobStatus 完成 -> recall 命中 -> list/documents
 * -> remove 清理文档 -> DELETE bank 兜底清理。
 *
 * 输出只包含状态与数量；不打印正文、bank 路由或凭据。
 */
import { HindsightMemoryAdapter } from '../../src/memory/adapters/hindsight';
import { normalizeBaseUrl } from '../../src/memory/adapters/hindsight-config';
import { bankIdFor } from '../../src/memory/adapters/hindsight-tags';
import type {
  MemoryAdapterJobRef,
  MemoryAdapterRetainItem,
  MemoryAdapterSearchPlan,
  SearchResult,
} from '../../src/memory/adapters/types';
import type {
  MemoryRawRepresentation,
  MemorySpaceRef,
} from '../../src/memory/contracts';
import { sha256Hex, utf8Bytes } from '../../src/storage/db';
import { check, checkEqual } from './harness';

export interface RealHindsightSummary {
  ran: boolean;
  retainStatus: string | null;
  jobState: string | null;
  recallHits: number | null;
  listHits: number | null;
  documentCount: number | null;
  removeStatus: string | null;
  bankDeleted: boolean | null;
}

interface RawResponse {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function realHindsightEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.HINDSIGHT_REAL_TEST === '1';
}

async function rawRequest(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
): Promise<RawResponse> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
    });
  } catch {
    // 错误文本不包含 URL、凭据或响应正文。
    throw new Error('real Hindsight request failed');
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function listPath(bankId: string, suffix: string): string {
  return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
}

function documentCount(body: unknown): number | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  return body.items.length;
}

function documentTotal(body: unknown): number | null {
  if (!isRecord(body)) return null;
  return typeof body.total === 'number' && Number.isSafeInteger(body.total)
    ? body.total
    : null;
}

async function waitForJob(
  adapter: HindsightMemoryAdapter,
  space: MemorySpaceRef,
  jobRef: MemoryAdapterJobRef,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = 'unknown';
  while (Date.now() < deadline) {
    const status = await adapter.jobStatus({ space, job_ref: jobRef });
    state = status.state;
    if (state === 'completed' || state === 'failed' || state === 'cancelled') return state;
    await Bun.sleep(1_000);
  }
  return state;
}

async function waitForSearch(
  search: () => Promise<SearchResult>,
  accept: (result: SearchResult) => boolean,
  timeoutMs: number,
): Promise<SearchResult> {
  const deadline = Date.now() + timeoutMs;
  let result = await search();
  while (!accept(result) && Date.now() < deadline) {
    await Bun.sleep(1_000);
    result = await search();
  }
  return result;
}

async function waitForDocuments(
  baseUrl: string,
  apiKey: string,
  bankId: string,
  minimum: number,
  timeoutMs: number,
): Promise<RawResponse> {
  const deadline = Date.now() + timeoutMs;
  let response = await rawRequest(
    baseUrl,
    apiKey,
    'GET',
    listPath(bankId, '/documents?limit=10&offset=0'),
  );
  while ((documentCount(response.body) ?? 0) < minimum && Date.now() < deadline) {
    await Bun.sleep(500);
    response = await rawRequest(
      baseUrl,
      apiKey,
      'GET',
      listPath(bankId, '/documents?limit=10&offset=0'),
    );
  }
  return response;
}

function searchPlan(query: string | null): MemoryAdapterSearchPlan {
  return {
    query,
    hard_filters: {},
    ranking_hints: {},
    candidate_limit: 50,
    output_bytes: 1024 * 1024,
    deadline_at: Date.now() + 30_000,
    policy_version: 1,
  };
}

export async function runRealHindsightContract(
  env: Record<string, string | undefined> = process.env,
): Promise<RealHindsightSummary> {
  if (!realHindsightEnabled(env)) {
    return {
      ran: false,
      retainStatus: null,
      jobState: null,
      recallHits: null,
      listHits: null,
      documentCount: null,
      removeStatus: null,
      bankDeleted: null,
    };
  }

  const rawBase = (env.HINDSIGHT_URL ?? env.HINDSIGHT_BASE_URL ?? '').trim();
  const apiKey = env.HINDSIGHT_API_KEY ?? '';
  if (!rawBase || !apiKey) {
    throw new Error('HINDSIGHT_REAL_TEST=1 requires HINDSIGHT_URL and HINDSIGHT_API_KEY');
  }
  // 故意保留/补上尾随 `/`，验证适配器不会拼出 `//v1/...`。
  const baseWithSlash = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const baseUrl = normalizeBaseUrl(rawBase);
  const requestTimeoutMs = positiveInt(env.HINDSIGHT_TIMEOUT_MS, 30_000);
  const jobTimeoutMs = positiveInt(env.HINDSIGHT_REAL_JOB_TIMEOUT_MS, 120_000);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const bankPrefix = `webots-test-${suffix}`;
  const space: MemorySpaceRef = {
    space_id: `sp_mf04_real_${suffix}`,
    ownership_epoch: 1,
    backend_binding_epoch: 1,
  };
  const expectedBankId = await bankIdFor(bankPrefix, space);
  const adapter = new HindsightMemoryAdapter({
    baseUrl: baseWithSlash,
    apiKey,
    bankPrefix,
    requestTimeoutMs,
    maxRetries: 2,
    retryBaseMs: 250,
    listPageSize: 10,
  });

  const summary: RealHindsightSummary = {
    ran: true,
    retainStatus: null,
    jobState: null,
    recallHits: null,
    listHits: null,
    documentCount: null,
    removeStatus: null,
    bankDeleted: null,
  };

  let primaryFailure: unknown = null;
  try {
    check(
      'real capabilities 不含凭据',
      !JSON.stringify(adapter.capabilities()).includes(apiKey),
    );

    const unauthorized = new HindsightMemoryAdapter({
      baseUrl: baseWithSlash,
      apiKey: 'invalid-test-key',
      bankPrefix,
      requestTimeoutMs,
      maxRetries: 0,
    });
    const unauthorizedEnsure = await unauthorized.ensureSpace({
      space: { ...space, space_id: `sp_mf04_real_unauth_${suffix}` },
      operation_key: `ensure-unauth-${suffix}`,
      payload_sha256: await sha256Hex(`ensure-unauth:${suffix}`),
      deadline_at: Date.now() + requestTimeoutMs,
    });
    checkEqual('real 401 status', unauthorizedEnsure.status, 'unavailable');
    check(
      'real 401 结果不含凭据',
      !JSON.stringify(unauthorizedEnsure).includes('invalid-test-key'),
    );

    const ensured = await adapter.ensureSpace({
      space,
      operation_key: `ensure-${suffix}`,
      payload_sha256: await sha256Hex(`ensure:${suffix}`),
      deadline_at: Date.now() + requestTimeoutMs,
    });
    checkEqual('real ensureSpace status', ensured.status, 'ready');
    check('real ensureSpace 结果不含凭据', !JSON.stringify(ensured).includes(apiKey));
    checkEqual('real bank 路由稳定', ensured.backend_ref?.provider_id, expectedBankId);
    check('real bank 使用唯一前缀', expectedBankId.startsWith(`${bankPrefix}-`));
    check('real bank 不含 space_id', !expectedBankId.includes(space.space_id));

    const sourceId = `src_real_${suffix}`;
    const text = `Contract check ${suffix}: the release moved to Friday.`;
    const bytes = utf8Bytes(text);
    const representation: MemoryRawRepresentation = {
      representation_id: `rep_real_${suffix}`,
      kind: 'raw_full',
      text_bytes: bytes,
      text_sha256: await sha256Hex(text),
      verbatim: true,
      source_id: sourceId,
      source_revision: 1,
      range: { start: 0, end: bytes },
      depends_on: [],
    };
    const item: MemoryAdapterRetainItem = {
      origin_kind: 'experienced',
      representation: { representation, text },
      source: { source_id: sourceId, source_revision: 1 },
      eligibility: {
        kind: 'experienced',
        evidence: 'host_reported_submitted',
        receipt_id: `rcpt_real_${suffix}`,
        proof_id: `proof_real_${suffix}`,
      },
    };
    const retained = await adapter.retain({
      space,
      operation_key: `retain-${suffix}`,
      payload_sha256: await sha256Hex(`retain:${suffix}`),
      items: [item],
      policy_version: 1,
      deadline_at: Date.now() + requestTimeoutMs,
    });
    summary.retainStatus = retained.status;
    checkEqual('real retain status', retained.status, 'accepted');
    check('real retain job_ref', retained.job_ref !== null);
    check('real retain 结果不含凭据', !JSON.stringify(retained).includes(apiKey));
    if (!retained.job_ref) throw new Error('real retain returned no job_ref');

    summary.jobState = await waitForJob(
      adapter,
      space,
      retained.job_ref,
      jobTimeoutMs,
    );
    checkEqual('real retain job completed', summary.jobState, 'completed');

    const documents = await waitForDocuments(
      baseUrl,
      apiKey,
      expectedBankId,
      1,
      jobTimeoutMs,
    );
    checkEqual('real documents status', documents.status, 200);
    summary.documentCount = documentCount(documents.body);
    check('real documents 至少 1 个', (summary.documentCount ?? 0) >= 1, summary.documentCount);
    check('real documents total 至少 1', (documentTotal(documents.body) ?? 0) >= 1);

    const recall = await waitForSearch(
      () =>
        adapter.search({
          space,
          plan: searchPlan('release Friday'),
        }),
      (result) => result.status === 'ready' && result.hits.length > 0,
      30_000,
    );
    summary.recallHits = recall.hits.length;
    checkEqual('real recall status', recall.status, 'ready');
    check('real recall 至少 1 条', recall.hits.length >= 1, recall.hits.length);
    check('real recall 结果不含凭据', !JSON.stringify(recall).includes(apiKey));

    const listed = await waitForSearch(
      () =>
        adapter.search({
          space,
          plan: searchPlan(null),
        }),
      (result) => result.status === 'ready' && result.hits.length > 0,
      30_000,
    );
    summary.listHits = listed.hits.length;
    checkEqual('real list status', listed.status, 'ready');
    check('real list 至少 1 条', listed.hits.length >= 1, listed.hits.length);
    checkEqual('real list 分页完整', listed.coverage, 'exhaustive');

    const removed = await adapter.remove({
      space,
      operation_key: `remove-${suffix}`,
      payload_sha256: await sha256Hex(`remove:${suffix}`),
      targets: [
        {
          kind: 'representation',
          source: { source_id: sourceId, source_revision: 1 },
          representation_id: representation.representation_id,
          range: representation.range,
        },
      ],
      policy_version: 1,
      deadline_at: Date.now() + jobTimeoutMs,
    });
    summary.removeStatus = removed.status;
    checkEqual('real remove status', removed.status, 'accepted');
    checkEqual('real remove purge', removed.purge, 'purged');
    check('real remove 结果不含凭据', !JSON.stringify(removed).includes(apiKey));

    const emptyRecall = await waitForSearch(
      () =>
        adapter.search({
          space,
          plan: searchPlan('release Friday'),
        }),
      (result) => result.status === 'empty',
      20_000,
    );
    checkEqual('real remove 后 recall 为空', emptyRecall.status, 'empty');
    const emptyList = await waitForSearch(
      () =>
        adapter.search({
          space,
          plan: searchPlan(null),
        }),
      (result) => result.status === 'empty',
      20_000,
    );
    checkEqual('real remove 后 list 为空', emptyList.status, 'empty');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      const deleted = await rawRequest(
        baseUrl,
        apiKey,
        'DELETE',
        listPath(expectedBankId, ''),
      );
      const gone = await rawRequest(
        baseUrl,
        apiKey,
        'GET',
        listPath(expectedBankId, '/memories/list?limit=1&offset=0'),
      );
      summary.bankDeleted = deleted.status === 200 || deleted.status === 404;
      check(
        'real 测试 bank 已删除',
        summary.bankDeleted && gone.status === 404,
      );
      check('real 清理结果不含凭据', !JSON.stringify(deleted.body).includes(apiKey));
    } catch (cleanupError) {
      if (primaryFailure === null) throw cleanupError;
      // 主断言失败时保留原始错误；清理失败只报告，不输出响应正文。
      console.error('real Hindsight cleanup failed after test failure');
    }
  }

  return summary;
}
