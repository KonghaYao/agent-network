/**
 * MF09 Langfuse 来源验收（受控假 HTTP 服务）。
 *
 * 覆盖：
 * - 服务端 env 注入、缺失/非法 fail closed、凭据不进入错误/能力/结果；
 * - Basic Auth 形状、ISO 时间窗口、cursor 分页与死循环/页数保护；
 * - trusted binding 字段映射、raw/summary/memory_context 边界；
 * - 摘要必须关联最终输入 manifest、memory_context 必须引用现有 Context；
 * - 记忆回声抑制、重复导入幂等、同键内容变化 conflict；
 * - tombstone 后回放永久排除；
 * - 当前房间成员/策略 ACL 不被外部 trace 绕过；
 * - 超时、取消、401/500、异常响应与重启水位。
 *
 * 运行：bun run test:memory-langfuse
 */
import { authorizeSourceRead } from '../src/memory/access';
import {
  langfuseSourceCapabilities,
  loadLangfuseConfigFromEnv,
  resolveLangfuseSourceConfig,
  type LangfuseSourceBinding,
  type LangfuseSourceConfig,
} from '../src/memory/sources/langfuse-config';
import { LangfuseSourceImporter } from '../src/memory/sources/langfuse-import';
import {
  mapLangfuseObservation,
  parseLangfuseObservation,
} from '../src/memory/sources/langfuse-mapping';
import {
  ensureSpaceForAgent,
  getSource,
  runMemoryBatch,
  tombstoneStatement,
} from '../src/memory/store';
import { resolveRoomTargetScope } from '../src/memory/target';
import { newId, sha256Hex } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';
import { FakeLangfuse, type FakeLangfuseObservation } from './lib/memory-langfuse-fake';
import {
  queryText,
  seedLfContext,
  seedLfManifest,
  seedLfRawSource,
} from './lib/memory-langfuse-fixture';
import {
  createMemoryEnv,
  seedActor,
  seedManagement,
  seedRoom,
  spaceRef,
  unique,
  updateRoomPolicy,
} from './lib/memory-unit';

const AT = 1_700_000_000_000;
const NOW = AT + 60_000;
const AGENT = 'act_lf_agent';
const MANAGER = 'act_lf_manager';
const ROOM = 'room_lf_main';
const INSTANCE = 'mni_lf_test';
const PROJECT = 'proj_lf_test';
const PUBLIC_KEY = 'pk-lf-test-public';
const SECRET_KEY = 'sk-lf-test-secret';
const ORIGIN_SCOPE = {
  room_id: ROOM,
  member_generation: 1,
  policy_revision: 0,
  joined_seq: 0,
  joined_at: AT,
  archive_head_seq: null,
};

const iso = (ms: number): string => new Date(ms).toISOString();

function observation(
  input: Partial<FakeLangfuseObservation> & Pick<FakeLangfuseObservation, 'id' | 'name' | 'startTime'>,
): FakeLangfuseObservation {
  return {
    traceId: 'trace_lf_main',
    projectId: PROJECT,
    type: 'GENERATION',
    traceName: 'agent-run',
    userId: 'external-user',
    sessionId: 'external-session',
    ...input,
  };
}

function baseBinding(overrides: Partial<LangfuseSourceBinding> = {}): LangfuseSourceBinding {
  return {
    binding_id: 'lfb_main',
    project_id: PROJECT,
    agent_actor_id: AGENT,
    origin: { room_id: ROOM },
    author_actor_id: AGENT,
    observations: {
      'user input': { class: 'original_input', field: 'input' },
      'tool result': { class: 'tool_result', field: 'output' },
      'business event': { class: 'business_event', field: 'output' },
      compaction: {
        class: 'summary',
        field: 'output',
        manifest_metadata_key: 'agentnet_manifest_id',
      },
      'memory context': {
        class: 'memory_context',
        field: 'input',
        context_metadata_key: 'agentnet_context_id',
      },
      'assistant output': { class: 'agent_claim', field: 'output' },
      'authored text': { class: 'authored', field: 'output' },
    },
    ...overrides,
  };
}

function makeConfig(
  fake: FakeLangfuse,
  overrides: Partial<LangfuseSourceConfig> = {},
): LangfuseSourceConfig {
  return {
    host: fake.baseUrl,
    publicKey: fake.publicKey,
    secretKey: fake.secretKey,
    bindings: [baseBinding()],
    requestTimeoutMs: 250,
    maxRetries: 1,
    retryBaseMs: 1,
    pageSize: 2,
    maxPages: 20,
    initialFrom: AT,
    now: () => NOW,
    ...overrides,
  };
}

function resolved(
  fake: FakeLangfuse,
  overrides: Partial<LangfuseSourceConfig> = {},
) {
  const config = resolveLangfuseSourceConfig(makeConfig(fake, overrides));
  if (!config) throw new Error('config unexpectedly disabled');
  return config;
}

function assertNoSecret(label: string, value: unknown): void {
  const text = JSON.stringify(value);
  check(`${label} 不含 public key`, !text.includes(PUBLIC_KEY));
  check(`${label} 不含 secret key`, !text.includes(SECRET_KEY));
}

async function main(): Promise<void> {
  const env = createMemoryEnv();
  seedActor(env, { actorId: AGENT, kind: 'agent' });
  seedActor(env, { actorId: MANAGER, kind: 'human' });
  seedManagement(env, { agentId: AGENT, managerId: MANAGER });
  seedRoom(env, {
    roomId: ROOM,
    kind: 'group',
    ownerId: MANAGER,
    policyRevision: 0,
    memberSeq: 2,
    members: [
      { actorId: AGENT, joinedSeq: 0, joinedAt: AT, memberGeneration: 1 },
      { actorId: MANAGER, role: 'owner', joinedSeq: 0, joinedAt: AT, memberGeneration: 1 },
    ],
  });
  const space = await ensureSpaceForAgent(env.d1, {
    agentId: AGENT,
    instanceId: INSTANCE,
    now: AT,
  });

  const fake = new FakeLangfuse(PUBLIC_KEY, SECRET_KEY);
  try {
    // -----------------------------------------------------------------------
    // 1. env 注入与 fail closed
    const disabled = loadLangfuseConfigFromEnv({});
    check('env 未开启时 disabled', !disabled.ok && disabled.disabled);
    const missingHost = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: JSON.stringify([baseBinding()]),
    });
    check('env 缺 host fail closed', !missingHost.ok && !missingHost.disabled);
    check(
      'env 缺 host 只报变量名',
      !missingHost.ok && missingHost.error.includes('LANGFUSE_HOST') && !missingHost.error.includes(SECRET_KEY),
    );
    const missingPublic = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_HOST: fake.baseUrl,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: JSON.stringify([baseBinding()]),
    });
    check('env 缺 public key fail closed', !missingPublic.ok);
    check('env 缺 public key 不泄漏 secret', !missingPublic.ok && !missingPublic.error.includes(SECRET_KEY));
    const badHost = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_HOST: `ftp://user:${SECRET_KEY}@example.com`,
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: JSON.stringify([baseBinding()]),
    });
    check('env 非法 host fail closed', !badHost.ok);
    check('env 非法 host 不回显凭据', !badHost.ok && !badHost.error.includes(SECRET_KEY));
    const malformedBindings = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_HOST: fake.baseUrl,
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: `{not-json:${SECRET_KEY}}`,
    });
    check('env 非法 bindings fail closed', !malformedBindings.ok);
    check(
      'env 非法 bindings 不回显原文',
      !malformedBindings.ok && !malformedBindings.error.includes(SECRET_KEY),
    );
    const multiProject = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_HOST: fake.baseUrl,
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: JSON.stringify([
        baseBinding(),
        baseBinding({ binding_id: 'lfb_other', project_id: 'proj_other' }),
      ]),
    });
    check('env 多 project 拒绝', !multiProject.ok);
    const badPageSize = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_HOST: fake.baseUrl,
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: JSON.stringify([baseBinding()]),
      LANGFUSE_PAGE_SIZE: '0',
    });
    check('env 非法 page size fail closed', !badPageSize.ok);
    const validEnv = loadLangfuseConfigFromEnv({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_HOST: `${fake.baseUrl}/api/public`,
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BINDINGS_JSON: JSON.stringify([baseBinding()]),
      LANGFUSE_INITIAL_FROM: String(AT),
    });
    check('env 完整配置可加载', validEnv.ok);
    check('env 完整配置保留 binding', validEnv.ok && validEnv.config.bindings.length === 1);
    check('env 请求数仍为零', fake.requestCount === 0);

    const resolvedConfig = resolved(fake);
    checkEqual('host 去掉 /api/public', resolvedConfig.host, fake.baseUrl);
    check('capabilities ready', langfuseSourceCapabilities(resolvedConfig).status === 'ready');
    assertNoSecret('capabilities', langfuseSourceCapabilities(resolvedConfig));

    // -----------------------------------------------------------------------
    // 2. 夹具：manifest 与 context 引用的业务来源
    const manifestSource = await seedLfRawSource(env, {
      instanceId: INSTANCE,
      roomId: ROOM,
      agentId: AGENT,
      at: AT,
      text: `MANIFEST-SOURCE-${unique('lf')}`,
      sourceKey: `seed:manifest:${unique('lf')}`,
    });
    const manifestId = await seedLfManifest(env, {
      instanceId: INSTANCE,
      roomId: ROOM,
      agentId: AGENT,
      spaceId: space.space_id,
      ownershipEpoch: space.ownership_epoch,
      representationId: manifestSource.representationId,
      textSha256: manifestSource.digest,
      at: AT,
    });
    const contextSource = await seedLfRawSource(env, {
      instanceId: INSTANCE,
      roomId: ROOM,
      agentId: AGENT,
      at: AT,
      text: `CONTEXT-SOURCE-${unique('lf')}`,
      sourceKey: `seed:context:${unique('lf')}`,
    });
    const contextBody = `CONTEXT-BODY-${unique('lf')}`;
    const contextId = await seedLfContext(env, {
      instanceId: INSTANCE,
      roomId: ROOM,
      agentId: AGENT,
      spaceId: space.space_id,
      ownershipEpoch: space.ownership_epoch,
      body: contextBody,
      representationId: contextSource.representationId,
      sourceId: contextSource.sourceId,
      sourceRevision: 1,
      sourceTextBytes: contextSource.bytes,
      at: AT,
    });

    // -----------------------------------------------------------------------
    // 3. 映射与导入
    fake.addObservation(
      observation({
        id: 'obs-user-input',
        name: 'user input',
        startTime: iso(AT + 1_000),
        input: `USER-INPUT-${unique('lf')}`,
        metadata: { agent_id: 'act_spoofed', room_id: 'room_spoofed', verified: true },
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-tool-result',
        name: 'tool result',
        type: 'TOOL',
        startTime: iso(AT + 2_000),
        output: `TOOL-RESULT-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-business-event',
        name: 'business event',
        type: 'EVENT',
        startTime: iso(AT + 3_000),
        output: `BUSINESS-EVENT-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-summary',
        name: 'compaction',
        startTime: iso(AT + 4_000),
        output: `SUMMARY-${unique('lf')}`,
        metadata: { agentnet_manifest_id: manifestId },
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-context',
        name: 'memory context',
        startTime: iso(AT + 5_000),
        input: 'trace-side text must not replace context body',
        metadata: { agentnet_context_id: contextId },
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-agent-claim',
        name: 'assistant output',
        startTime: iso(AT + 6_000),
        output: `CLAIM-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-authored',
        name: 'authored text',
        startTime: iso(AT + 7_000),
        output: `AUTHORED-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-summary-no-manifest',
        name: 'compaction',
        startTime: iso(AT + 8_000),
        output: `SUMMARY-NO-MANIFEST-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-context-no-id',
        name: 'memory context',
        startTime: iso(AT + 9_000),
        input: `CONTEXT-NO-ID-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-echo-context',
        name: 'user input',
        startTime: iso(AT + 10_000),
        input: contextBody,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-echo-manifest',
        name: 'user input',
        startTime: iso(AT + 11_000),
        input: manifestSource.text,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-unmapped-name',
        name: 'unknown observation',
        startTime: iso(AT + 12_000),
        output: `UNMAPPED-${unique('lf')}`,
      }),
    );
    fake.addObservation(
      observation({
        id: 'obs-foreign-project',
        name: 'user input',
        projectId: 'proj_foreign',
        startTime: iso(AT + 13_000),
        input: `FOREIGN-${unique('lf')}`,
      }),
    );
    fake.behavior.pageSizeOverride = 2;

    const importer = new LangfuseSourceImporter({
      db: env.d1,
      instanceId: INSTANCE,
      config: resolvedConfig,
    });
    const first = await importer.importOnce({ from: AT, to: AT + 20_000 });
    checkEqual('导入状态 ready', first.status, 'ready');
    checkEqual('导入 fetched', first.fetched, 13);
    checkEqual('导入 imported', first.imported, 5);
    checkEqual('agent_claim/authored 跳过', first.skipped.non_independent, 2);
    checkEqual('无 manifest 摘要跳过', first.skipped.unverified_summary, 1);
    checkEqual('无 context id 跳过', first.skipped.unverified_context, 1);
    checkEqual('回声跳过', first.skipped.echo_suppressed, 2);
    checkEqual('未映射 observation 跳过', first.skipped.unmapped_observation, 1);
    checkEqual('未映射 project 跳过', first.skipped.unmapped_project, 1);
    check('分页至少两页', fake.requests.length >= 2);
    checkEqual('每页 limit=2', fake.requests[0]?.query.get('limit'), '2');
    check(
      '请求带时间窗口',
      fake.requests[0]?.query.get('fromStartTime') === iso(AT) &&
        fake.requests[0]?.query.get('toStartTime') === iso(AT + 20_000),
    );
    check(
      '请求带字段组',
      (fake.requests[0]?.query.get('fields') ?? '').includes('trace_context') &&
        (fake.requests[0]?.query.get('fields') ?? '').includes('io'),
    );
    check(
      '请求展开 manifest/context metadata',
      (fake.requests[0]?.query.get('expandMetadata') ?? '').includes('agentnet_manifest_id') &&
        (fake.requests[0]?.query.get('expandMetadata') ?? '').includes('agentnet_context_id'),
    );
    const auth = fake.requests[0]?.headers.authorization ?? '';
    checkEqual('Basic Auth 形状', auth, `Basic ${btoa(`${PUBLIC_KEY}:${SECRET_KEY}`)}`);
    for (const request of fake.requests) {
      const query = queryText(request.query);
      check('URL 不含 public key', !query.includes(PUBLIC_KEY));
      check('URL 不含 secret key', !query.includes(SECRET_KEY));
      check('path 固定为 observations v2', request.path === '/api/public/v2/observations');
    }
    assertNoSecret('导入结果', first);
    check('导入结果不含正文', !JSON.stringify(first).includes('USER-INPUT-'));
    check('导入结果不含 host', !JSON.stringify(first).includes(fake.baseUrl));

    const sourceRows = await env.d1
      .prepare("SELECT * FROM memory_sources WHERE source_kind = 'langfuse_observation' AND source_key LIKE 'langfuse:lfb_main:%' ORDER BY source_key")
      .all<{
        source_id: string;
        source_key: string;
        business_ref_json: string;
        origin_room_id: string;
        origin_member_generation: number;
        origin_policy_revision: number;
        origin_seq: number | null;
        origin_created_at: number;
        author_actor_id: string | null;
        revision: number;
        content_text: string | null;
        content_sha256: string | null;
        content_bytes: number | null;
      }>();
    checkEqual('来源数量', sourceRows.results.length, 5);
    for (const row of sourceRows.results) {
      checkEqual(
        `来源 ${row.source_key} digest`,
        row.content_sha256,
        await sha256Hex(row.content_text ?? ''),
      );
    }
    const userInputSource = sourceRows.results.find((row) => row.source_key.includes('obs-user-input'));
    check('用户输入来源存在', userInputSource !== undefined);
    checkEqual('来源 kind', userInputSource?.origin_room_id, ROOM);
    checkEqual('来源成员代次', userInputSource?.origin_member_generation, 1);
    checkEqual('来源策略版本', userInputSource?.origin_policy_revision, 0);
    checkEqual('来源无业务 seq', userInputSource?.origin_seq, null);
    checkEqual('来源时间', userInputSource?.origin_created_at, AT + 1_000);
    checkEqual('作者来自 binding 而非 trace userId', userInputSource?.author_actor_id, AGENT);
    checkEqual('来源 revision', userInputSource?.revision, 1);
    const userInputDigest = await sha256Hex(userInputSource?.content_text ?? '');
    checkEqual('来源 digest 与正文一致', userInputSource?.content_sha256, userInputDigest);
    const businessRef = JSON.parse(userInputSource?.business_ref_json ?? '{}') as Record<string, unknown>;
    checkEqual('业务引用 trace_id', businessRef.trace_id, 'trace_lf_main');
    checkEqual('业务引用 observation_id', businessRef.observation_id, 'obs-user-input');
    checkEqual('保留外部 userId 仅作溯源', businessRef.trace_user_id, 'external-user');
    checkEqual('类别记录 original_input', businessRef.observation_class, 'original_input');

    const representationRows = await env.d1
      .prepare(
        `SELECT r.*, s.source_key FROM memory_representations r
           LEFT JOIN memory_sources s ON s.source_id = r.source_id
          WHERE (s.source_kind = 'langfuse_observation'
                 AND s.source_key LIKE 'langfuse:lfb_main:%')
             OR r.summary_id LIKE 'lfsum_%'
             OR r.source_context_id = ?
          ORDER BY r.kind, s.source_key`,
      )
      .bind(contextId)
      .all<{
        representation_id: string;
        kind: string;
        source_id: string | null;
        source_revision: number | null;
        source_context_id: string | null;
        range_start: number | null;
        range_end: number | null;
        text: string;
        text_bytes: number;
        text_sha256: string;
        verbatim: number;
        source_key: string | null;
      }>();
    checkEqual('表示数量', representationRows.results.length, 5);
    checkEqual(
      'raw fragment 数量',
      representationRows.results.filter((row) => row.kind === 'raw_fragment').length,
      3,
    );
    checkEqual(
      'summary 数量',
      representationRows.results.filter((row) => row.kind === 'summary').length,
      1,
    );
    checkEqual(
      'memory_context 数量',
      representationRows.results.filter((row) => row.kind === 'memory_context').length,
      1,
    );
    for (const row of representationRows.results) {
      if (row.kind === 'raw_fragment') {
        checkEqual('raw verbatim', row.verbatim, 1);
        checkEqual('raw 全文范围', `${row.range_start}-${row.range_end}`, `0-${row.text_bytes}`);
        checkEqual('raw 与来源 revision 一致', row.source_revision, 1);
      } else {
        checkEqual('非 raw verbatim=false', row.verbatim, 0);
      }
    }
    const summaryRep = representationRows.results.find((row) => row.kind === 'summary');
    check('summary 不是 raw 覆盖', summaryRep?.kind === 'summary');
    const summaryDeps = await env.d1
      .prepare(
        'SELECT COUNT(*) AS n FROM memory_representation_dependencies WHERE representation_id = ?',
      )
      .bind(summaryRep?.representation_id ?? 'missing')
      .first<{ n: number }>();
    check('summary 继承 manifest 依赖', (summaryDeps?.n ?? 0) >= 1);
    const summarySource = sourceRows.results.find((row) => row.source_key.includes('obs-summary'));
    const summarySelfDep = await env.d1
      .prepare(
        `SELECT 1 AS hit FROM memory_representation_dependencies
          WHERE representation_id = ? AND source_id = ? LIMIT 1`,
      )
      .bind(summaryRep?.representation_id ?? 'missing', summarySource?.source_id ?? 'missing')
      .first<{ hit: number }>();
    check('summary 依赖自身来源以继承撤权/遗忘', summarySelfDep !== null);
    const contextSourceRow = sourceRows.results.find((row) => row.source_key.includes('obs-context'));
    checkEqual('context 来源使用服务端正文', contextSourceRow?.content_text, contextBody);
    const contextRep = representationRows.results.find((row) => row.kind === 'memory_context');
    checkEqual('context 表示引用 context id', contextRep?.source_context_id, contextId);
    const contextDeps = await env.d1
      .prepare(
        'SELECT COUNT(*) AS n FROM memory_representation_dependencies WHERE representation_id = ?',
      )
      .bind(contextRep?.representation_id ?? 'missing')
      .first<{ n: number }>();
    check('context 保留来源依赖', (contextDeps?.n ?? 0) >= 1);
    const contextSelfDep = await env.d1
      .prepare(
        `SELECT 1 AS hit FROM memory_representation_dependencies
          WHERE representation_id = ? AND source_id = ? LIMIT 1`,
      )
      .bind(contextRep?.representation_id ?? 'missing', contextSourceRow?.source_id ?? 'missing')
      .first<{ hit: number }>();
    check('context 依赖自身来源以继承撤权/遗忘', contextSelfDep !== null);

    // -----------------------------------------------------------------------
    // 4. 重复导入幂等 / 同键内容变化 conflict
    fake.resetRequests();
    const second = await importer.importOnce({ from: AT, to: AT + 20_000 });
    checkEqual('重复导入不新增', second.imported, 0);
    checkEqual('重复导入记录 duplicate', second.duplicates, 5);
    const sourceCountAfterSecond = await env.d1
      .prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE source_kind = 'langfuse_observation' AND source_key LIKE 'langfuse:lfb_main:%'")
      .first<{ n: number }>();
    checkEqual('重复导入来源数不变', sourceCountAfterSecond?.n, 5);

    const mutated = fake.observations.find((item) => item.id === 'obs-user-input');
    if (mutated) mutated.input = `REWRITTEN-${unique('lf')}`;
    const conflict = await importer.importOnce({ from: AT, to: AT + 20_000 });
    checkEqual('同键正文变化 conflict', conflict.conflicts, 1);
    const unchanged = await getSource(
      env.d1,
      userInputSource?.source_id ?? 'missing',
      userInputSource?.revision ?? 1,
    );
    checkEqual('冲突不覆盖原正文', unchanged?.content_text, userInputSource?.content_text);
    if (mutated) mutated.input = userInputSource?.content_text ?? '';

    // -----------------------------------------------------------------------
    // 5. 重启水位与增量
    const beforeRestart = fake.requestCount;
    const restarted = new LangfuseSourceImporter({
      db: env.d1,
      instanceId: INSTANCE,
      config: resolvedConfig,
    });
    const empty = await restarted.importOnce({ to: AT + 20_000 });
    checkEqual('水位到达后空窗口', empty.status, 'empty');
    checkEqual('空窗口不发请求', fake.requestCount, beforeRestart);
    fake.addObservation(
      observation({
        id: 'obs-after-restart',
        name: 'user input',
        startTime: iso(AT + 25_000),
        input: `AFTER-RESTART-${unique('lf')}`,
      }),
    );
    const resumed = await restarted.importOnce({ to: AT + 30_000 });
    checkEqual('重启后增量导入', resumed.imported, 1);
    checkEqual(
      '重启从持久水位开始',
      fake.requests.at(-1)?.query.get('fromStartTime'),
      iso(AT + 20_000),
    );

    // -----------------------------------------------------------------------
    // 6. ACL：当前房间策略变化立即拒绝读取
    const userInputRow = await getSource(
      env.d1,
      userInputSource?.source_id ?? 'missing',
      userInputSource?.revision ?? 1,
    );
    if (!userInputRow) throw new Error('missing imported source');
    const beforePolicy = await resolveRoomTargetScope(env.d1, ROOM, AGENT);
    const allowedBefore = await authorizeSourceRead(env.d1, {
      space: spaceRef(space),
      source: userInputRow,
      agentId: AGENT,
      target_scope: beforePolicy,
      at: NOW,
    });
    checkEqual('导入来源当前可读', allowedBefore.allowed, true);
    updateRoomPolicy(env, ROOM, { policy: 'full', revision: 7 });
    const afterPolicy = await resolveRoomTargetScope(env.d1, ROOM, AGENT);
    const deniedAfter = await authorizeSourceRead(env.d1, {
      space: spaceRef(space),
      source: userInputRow,
      agentId: AGENT,
      target_scope: afterPolicy,
      at: NOW,
    });
    checkEqual('策略版本变化拒绝读取', deniedAfter.allowed, false);
    checkEqual('拒绝原因为 policy_changed', deniedAfter.reason, 'policy_changed');
    await env.d1
      .prepare('UPDATE room_members SET member_generation = 2 WHERE room_id = ? AND actor_id = ?')
      .bind(ROOM, AGENT)
      .run();
    const afterGeneration = await resolveRoomTargetScope(env.d1, ROOM, AGENT);
    const deniedGeneration = await authorizeSourceRead(env.d1, {
      space: spaceRef(space),
      source: userInputRow,
      agentId: AGENT,
      target_scope: afterGeneration,
      at: NOW,
    });
    checkEqual('成员代次变化拒绝读取', deniedGeneration.allowed, false);
    checkEqual('拒绝原因为 membership_stale', deniedGeneration.reason, 'membership_stale');
    await env.d1
      .prepare('UPDATE room_members SET member_generation = 1 WHERE room_id = ? AND actor_id = ?')
      .bind(ROOM, AGENT)
      .run();

    // -----------------------------------------------------------------------
    // 7. tombstone 后回放永久排除
    const sourceKey = userInputSource?.source_key ?? 'missing';
    await runMemoryBatch(env.d1, [
      tombstoneStatement(env.d1, {
        tombstoneId: newId('mtb'),
        instanceId: INSTANCE,
        targetKind: 'source_key',
        targetId: sourceKey,
        sourceKey,
        reason: 'forget',
        now: NOW,
      }),
    ]);
    fake.resetRequests();
    const replayed = await importer.importOnce({ from: AT, to: AT + 20_000 });
    check('遗忘来源重放被排除', replayed.excluded >= 1);
    const countAfterReplay = await env.d1
      .prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE source_kind = 'langfuse_observation' AND source_key LIKE 'langfuse:lfb_main:%'")
      .first<{ n: number }>();
    checkEqual('排除后来源数不变', countAfterReplay?.n, 6);
    const tombstonedRead = await authorizeSourceRead(env.d1, {
      space: spaceRef(space),
      source: userInputRow,
      agentId: AGENT,
      target_scope: afterPolicy,
      at: NOW,
    });
    checkEqual('tombstone 来源不可读', tombstonedRead.allowed, false);
    checkEqual('tombstone 拒绝原因', tombstonedRead.reason, 'tombstoned');

    // -----------------------------------------------------------------------
    // 8. 映射边界（直接调用，验证 ambiguous/trace_names/invalid）
    const parsed = parseLangfuseObservation(
      observation({
        id: 'obs-map',
        name: 'user input',
        startTime: iso(AT),
        input: 'map',
        traceName: 'agent-run',
      }),
    );
    if (!parsed.ok) throw new Error('parse failed');
    const ambiguous = await mapLangfuseObservation(parsed.observation, [
      baseBinding(),
      baseBinding({ binding_id: 'lfb_second', agent_actor_id: 'act_other' }),
    ]);
    check('重复 binding 歧义拒绝', ambiguous.kind === 'skipped' && ambiguous.reason === 'ambiguous_binding');
    const traceMismatch = await mapLangfuseObservation(parsed.observation, [
      baseBinding({ trace_names: ['other-trace'] }),
    ]);
    check(
      'trace 名称不匹配拒绝',
      traceMismatch.kind === 'skipped' && traceMismatch.reason === 'unmapped_trace',
    );
    const invalidShape = parseLangfuseObservation({
      ...observation({ id: 'obs-bad', name: 'user input', startTime: iso(AT) }),
      input: { not: 'a string' },
    });
    check('对象 I/O 不冒充原文', !invalidShape.ok && invalidShape.reason === 'invalid_observation');

    // -----------------------------------------------------------------------
    // 9. 故障：401 / 500 重试 / 超时 / 取消 / 异常响应 / cursor 循环 / 页数
    const errorFake = new FakeLangfuse(PUBLIC_KEY, SECRET_KEY);
    try {
      const unauthorizedConfig = resolved(errorFake, {
        secretKey: 'sk-wrong',
        bindings: [baseBinding({ binding_id: 'lfb_error', project_id: 'proj_error' })],
      });
      errorFake.addObservation(
        observation({
          id: 'obs-error-401',
          name: 'user input',
          projectId: 'proj_error',
          startTime: iso(AT + 1_000),
          input: 'unauthorized',
        }),
      );
      const unauthorized = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: unauthorizedConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('401 状态 unavailable', unauthorized.status, 'unavailable');
      checkEqual('401 原因 unauthorized', unauthorized.reason, 'unauthorized');
      assertNoSecret('401 结果', unauthorized);

      errorFake.behavior.failures = 1;
      const retryConfig = resolved(errorFake, {
        publicKey: errorFake.publicKey,
        secretKey: errorFake.secretKey,
        bindings: [baseBinding({ binding_id: 'lfb_error', project_id: 'proj_error' })],
        initialFrom: AT,
      });
      const retried = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: retryConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('500 后重试成功', retried.status, 'ready');
      checkEqual('重试后导入一条', retried.imported, 1);
      check('发生重试请求', errorFake.requestCount >= 2);

      errorFake.behavior.failures = 99;
      const failing = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: retryConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('持续 500 fail closed', failing.status, 'unavailable');
      checkEqual('持续 500 原因只含状态码', failing.reason, 'http_500');
      assertNoSecret('500 结果', failing);
      checkEqual('失败不推进水位', failing.watermarks.lfb_error, AT + 10_000);
      errorFake.behavior.failures = 0;

      errorFake.behavior.hang = true;
      const timeoutConfig = resolved(errorFake, {
        bindings: [baseBinding({ binding_id: 'lfb_error', project_id: 'proj_error' })],
        requestTimeoutMs: 50,
        maxRetries: 0,
        initialFrom: AT,
      });
      const timedOut = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: timeoutConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('超时状态', timedOut.status, 'timeout');
      checkEqual('超时原因', timedOut.reason, 'timeout');
      checkEqual('超时不推进水位', timedOut.watermarks.lfb_error, AT + 10_000);

      const controller = new AbortController();
      const cancelPromise = new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: timeoutConfig,
      }).importOnce({ from: AT, to: AT + 10_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      const cancelled = await cancelPromise;
      checkEqual('取消状态', cancelled.status, 'cancelled');
      checkEqual('取消不推进水位', cancelled.watermarks.lfb_error, AT + 10_000);
      errorFake.behavior.hang = false;

      errorFake.behavior.malformed = 'json';
      const malformed = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: retryConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('非 JSON 响应 fail closed', malformed.reason, 'invalid_response');
      errorFake.behavior.malformed = 'shape';
      const badShape = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: retryConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('错误响应形状 fail closed', badShape.reason, 'invalid_response');
      errorFake.behavior.malformed = null;

      for (let index = 0; index < 3; index += 1) {
        errorFake.addObservation(
          observation({
            id: `obs-loop-${index}`,
            name: 'user input',
            projectId: 'proj_error',
            startTime: iso(AT + 2_000 + index),
            input: `LOOP-${index}`,
          }),
        );
      }
      errorFake.behavior.cursorLoop = true;
      errorFake.behavior.pageSizeOverride = 1;
      const loop = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: retryConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('cursor 循环终止', loop.reason, 'cursor_loop');
      errorFake.behavior.cursorLoop = false;

      const pageLimitConfig = resolved(errorFake, {
        bindings: [baseBinding({ binding_id: 'lfb_error', project_id: 'proj_error' })],
        pageSize: 1,
        maxPages: 1,
        initialFrom: AT,
      });
      const pageLimited = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: pageLimitConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('页数上限终止', pageLimited.reason, 'page_limit');
      checkEqual('页数上限不推进水位', pageLimited.watermarks.lfb_error, AT + 10_000);
    } finally {
      await errorFake.stop();
    }

    // -----------------------------------------------------------------------
    // 10. binding 过期与 disabled importer
    const staleFake = new FakeLangfuse(PUBLIC_KEY, SECRET_KEY);
    try {
      staleFake.addObservation(
        observation({
          id: 'obs-stale',
          name: 'user input',
          startTime: iso(AT + 1_000),
          input: 'STALE',
        }),
      );
      const staleConfig = resolved(staleFake, {
        bindings: [
          baseBinding({
            origin: { room_id: ROOM, member_generation: 99, policy_revision: 99 },
          }),
        ],
      });
      const stale = await new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: staleConfig,
      }).importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('binding 过期跳过', stale.skipped.mapping_stale, 1);
      checkEqual('binding 过期不导入', stale.imported, 0);

      const disabledImporter = new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: null,
      });
      checkEqual('无配置能力 disabled', disabledImporter.capabilities().status, 'disabled');
      assertNoSecret('disabled capabilities', disabledImporter.capabilities());
      const disabledResult = await disabledImporter.importOnce();
      checkEqual('无配置 import disabled', disabledResult.status, 'disabled');
      check('无配置不发请求', staleFake.requestCount === 1);

      const captureOff = new LangfuseSourceImporter({
        db: env.d1,
        instanceId: INSTANCE,
        config: resolved(staleFake),
        capture: false,
      });
      const captureOffResult = await captureOff.importOnce({ from: AT, to: AT + 10_000 });
      checkEqual('停止采集状态', captureOffResult.status, 'disabled');
      checkEqual('停止采集原因', captureOffResult.reason, 'capture_disabled');
      check('停止采集不发请求', staleFake.requestCount === 1);
    } finally {
      await staleFake.stop();
    }
  } finally {
    await fake.stop();
  }

  console.log(`memory langfuse checks passed (${checksPassed()} assertions)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
