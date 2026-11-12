/**
 * MF09 Langfuse 来源配置：服务端注入、fail closed、错误文本不含凭据。
 *
 * Langfuse Public API 使用 Basic Auth（public key + secret key）。凭据只由
 * 服务端 env 读取，只进入请求头；错误、capabilities 与导入结果只报告变量名，
 * 不包含 key、完整 host 查询串或 trace 正文。
 *
 * trusted binding 是唯一可把外部 trace 关联到 WeBots actor/room 的入口：
 * trace 自带的 `userId`、metadata 或名称不能自行声明 agent/room/verified。
 */
import { LIMITS } from '../../contracts/limits';

export const LANGFUSE_OBSERVATION_CLASSES = [
  'original_input',
  'business_event',
  'tool_result',
  'memory_context',
  'summary',
  'authored',
  'agent_claim',
] as const;

/**
 * 观测语义类别。只有受控 binding 的 observation 名称映射能决定类别；
 * trace 内自报字段不参与授权判定。
 */
export type LangfuseObservationClass = (typeof LANGFUSE_OBSERVATION_CLASSES)[number];

export type LangfuseObservationField = 'input' | 'output';

export interface LangfuseObservationRule {
  class: LangfuseObservationClass;
  /** 读取 observation 的 input 还是 output；v2 两者都是原始字符串。 */
  field: LangfuseObservationField;
  /** summary 依赖的最终输入 manifest 在 metadata 中的键名。 */
  manifest_metadata_key?: string;
  /** memory_context 回流引用的 context id 在 metadata 中的键名。 */
  context_metadata_key?: string;
}

export interface LangfuseOriginBinding {
  /** WeBots 业务房间；来源受众以当前成员代次/策略重新校验。 */
  room_id: string;
  /** 可选；配置后成员代次不一致即拒绝导入，避免静默改变归属范围。 */
  member_generation?: number;
  /** 可选；配置后策略版本不一致即拒绝导入。 */
  policy_revision?: number;
}

/**
 * 受控 integration binding。
 *
 * 一个 Langfuse project 对应一个 WeBots 信任域；需要多个 actor 时使用独立
 * project/凭据，不能靠 trace 内自报 userId 区分。`observations` 按名称精确
 * 映射，未列出的 observation 一律跳过。
 */
export interface LangfuseSourceBinding {
  binding_id: string;
  project_id: string;
  agent_actor_id: string;
  origin: LangfuseOriginBinding;
  /** 可选；只允许这些 trace 名称，减少共享 project 内的误归属。 */
  trace_names?: readonly string[];
  /** 可选；服务端确认的作者 actor，不使用 trace.userId 冒充。 */
  author_actor_id?: string;
  observations: Readonly<Record<string, LangfuseObservationRule>>;
}

export interface LangfuseSourceConfig {
  /** Langfuse 部署根地址，例如 https://cloud.langfuse.com；可带部署前缀。 */
  host: string;
  publicKey: string;
  secretKey: string;
  bindings: readonly LangfuseSourceBinding[];
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** 首次没有水位时的起始时间（epoch ms）；缺省回看 LIMITS。 */
  initialFrom?: number | null;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ResolvedLangfuseSourceConfig {
  host: string;
  publicKey: string;
  secretKey: string;
  bindings: readonly LangfuseSourceBinding[];
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  pageSize: number;
  maxPages: number;
  initialFrom: number;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  now: () => number;
}

export type LangfuseConfigLoadResult =
  | { ok: true; config: LangfuseSourceConfig }
  | { ok: false; disabled: boolean; error: string };

export interface LangfuseSourceCapabilities {
  provider: 'langfuse';
  status: 'ready' | 'disabled';
  /** 只声明读取路径；本模块不提供 MCP ingest 旁路。 */
  api: 'observations-v2';
  pagination: 'cursor';
  auth: 'basic';
  import_classes: readonly LangfuseObservationClass[];
  /** 明确不转化为独立来源证据的类别。 */
  rejected_classes: readonly LangfuseObservationClass[];
  reason: string | null;
}

const IMPORT_CLASSES: readonly LangfuseObservationClass[] = [
  'original_input',
  'business_event',
  'tool_result',
  'memory_context',
  'summary',
];
const REJECTED_CLASSES: readonly LangfuseObservationClass[] = ['authored', 'agent_claim'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validCredential(value: string): boolean {
  // Langfuse keys 是无空白的 ASCII token；拒绝 CR/LF/空格避免头注入或误配置。
  return value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/u.test(value);
}

function parseNonNegativeInt(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value.trim() === '') return { ok: true, value: fallback };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    return { ok: false, error: `${name} must be an integer >= ${min}` };
  }
  return { ok: true, value: parsed };
}

/**
 * 规范化为不带查询/凭据的根地址；允许自托管部署前缀，但去掉重复的
 * `/api/public`，避免请求拼成 `/api/public/api/public/...`。
 */
export function normalizeLangfuseHost(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('LANGFUSE_HOST is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('LANGFUSE_HOST must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('LANGFUSE_HOST must not contain credentials, query or fragment');
  }
  let path = parsed.pathname.replace(/\/+$/u, '');
  if (path.endsWith('/api/public')) path = path.slice(0, -'/api/public'.length);
  path = path.replace(/\/+$/u, '');
  return `${parsed.origin}${path}`;
}

function parseBinding(
  value: unknown,
  index: number,
): { ok: true; binding: LangfuseSourceBinding } | { ok: false; error: string } {
  const prefix = `LANGFUSE_BINDINGS_JSON[${index}]`;
  if (!isRecord(value)) return { ok: false, error: `${prefix} must be an object` };
  const bindingId = value.binding_id;
  if (!nonEmptyString(bindingId, 200)) {
    return { ok: false, error: `${prefix}.binding_id is invalid` };
  }
  const projectId = value.project_id;
  if (!nonEmptyString(projectId, 200)) {
    return { ok: false, error: `${prefix}.project_id is invalid` };
  }
  const agentActorId = value.agent_actor_id;
  if (!nonEmptyString(agentActorId, 200)) {
    return { ok: false, error: `${prefix}.agent_actor_id is invalid` };
  }
  const origin = value.origin;
  if (!isRecord(origin) || !nonEmptyString(origin.room_id, 200)) {
    return { ok: false, error: `${prefix}.origin.room_id is invalid` };
  }
  const roomId = origin.room_id;
  const memberGeneration = origin.member_generation;
  if (
    memberGeneration !== undefined &&
    (!Number.isSafeInteger(memberGeneration) || (memberGeneration as number) < 0)
  ) {
    return { ok: false, error: `${prefix}.origin.member_generation is invalid` };
  }
  const policyRevision = origin.policy_revision;
  if (
    policyRevision !== undefined &&
    (!Number.isSafeInteger(policyRevision) || (policyRevision as number) < 0)
  ) {
    return { ok: false, error: `${prefix}.origin.policy_revision is invalid` };
  }
  const traceNames = value.trace_names;
  if (
    traceNames !== undefined &&
    (!Array.isArray(traceNames) ||
      traceNames.length === 0 ||
      !traceNames.every((name) => nonEmptyString(name, 200)))
  ) {
    return { ok: false, error: `${prefix}.trace_names is invalid` };
  }
  if (value.author_actor_id !== undefined && !nonEmptyString(value.author_actor_id, 200)) {
    return { ok: false, error: `${prefix}.author_actor_id is invalid` };
  }
  const authorActorId = value.author_actor_id;
  const observationsValue = value.observations;
  if (!isRecord(observationsValue) || Object.keys(observationsValue).length === 0) {
    return { ok: false, error: `${prefix}.observations is invalid` };
  }
  const observations: Record<string, LangfuseObservationRule> = {};
  for (const [name, rule] of Object.entries(observationsValue)) {
    if (!nonEmptyString(name, 200)) {
      return { ok: false, error: `${prefix}.observations contains an invalid name` };
    }
    if (!isRecord(rule)) {
      return { ok: false, error: `${prefix}.observations[${JSON.stringify(name)}] is invalid` };
    }
    const observationClass = rule.class;
    if (
      typeof observationClass !== 'string' ||
      !(LANGFUSE_OBSERVATION_CLASSES as readonly string[]).includes(observationClass)
    ) {
      return {
        ok: false,
        error: `${prefix}.observations[${JSON.stringify(name)}].class is invalid`,
      };
    }
    if (rule.field !== 'input' && rule.field !== 'output') {
      return {
        ok: false,
        error: `${prefix}.observations[${JSON.stringify(name)}].field is invalid`,
      };
    }
    for (const key of ['manifest_metadata_key', 'context_metadata_key'] as const) {
      if (rule[key] !== undefined && !nonEmptyString(rule[key], 200)) {
        return {
          ok: false,
          error: `${prefix}.observations[${JSON.stringify(name)}].${key} is invalid`,
        };
      }
    }
    observations[name] = {
      class: observationClass as LangfuseObservationClass,
      field: rule.field,
      ...(rule.manifest_metadata_key === undefined
        ? {}
        : { manifest_metadata_key: rule.manifest_metadata_key as string }),
      ...(rule.context_metadata_key === undefined
        ? {}
        : { context_metadata_key: rule.context_metadata_key as string }),
    };
  }
  return {
    ok: true,
    binding: {
      binding_id: bindingId,
      project_id: projectId,
      agent_actor_id: agentActorId,
      origin: {
        room_id: roomId,
        ...(memberGeneration === undefined
          ? {}
          : { member_generation: memberGeneration as number }),
        ...(policyRevision === undefined
          ? {}
          : { policy_revision: policyRevision as number }),
      },
      ...(traceNames === undefined ? {} : { trace_names: traceNames as string[] }),
      ...(authorActorId === undefined ? {} : { author_actor_id: authorActorId }),
      observations,
    },
  };
}

function parseBindingsJSON(
  raw: string,
): { ok: true; bindings: LangfuseSourceBinding[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // 不把 JSON 原文放进错误：配置可能被误粘贴到包含凭据的字段。
    return { ok: false, error: 'LANGFUSE_BINDINGS_JSON is invalid' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: 'LANGFUSE_BINDINGS_JSON must be a non-empty array' };
  }
  const bindings: LangfuseSourceBinding[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const result = parseBinding(parsed[index], index);
    if (!result.ok) return result;
    if (ids.has(result.binding.binding_id)) {
      return { ok: false, error: 'LANGFUSE_BINDINGS_JSON contains duplicate binding_id' };
    }
    ids.add(result.binding.binding_id);
    bindings.push(result.binding);
  }
  const projects = new Set(bindings.map((binding) => binding.project_id));
  if (projects.size !== 1) {
    // Public API key 是 project-scoped；一个 importer 只能读取一个 project。
    return { ok: false, error: 'LANGFUSE_BINDINGS_JSON must use a single project_id' };
  }
  return { ok: true, bindings };
}

function parseInitialFrom(
  value: string | undefined,
  now: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value.trim() === '') {
    return { ok: true, value: now - LIMITS.memoryLangfuseInitialLookbackMs };
  }
  const trimmed = value.trim();
  const numeric = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  const parsed = Number.isSafeInteger(numeric) ? numeric : Date.parse(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, error: 'LANGFUSE_INITIAL_FROM is invalid' };
  }
  return { ok: true, value: parsed };
}

/**
 * 从服务端 env 加载。`LANGFUSE_ENABLED` 未开启时返回 disabled；开启后缺失
 * 或非法字段 fail closed，错误只包含变量名，不包含 key 或配置原文。
 */
export function loadLangfuseConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): LangfuseConfigLoadResult {
  if (env.LANGFUSE_ENABLED !== '1') {
    return { ok: false, disabled: true, error: 'LANGFUSE_ENABLED is not 1' };
  }
  const host = env.LANGFUSE_HOST?.trim() ?? '';
  const publicKey = env.LANGFUSE_PUBLIC_KEY ?? '';
  const secretKey = env.LANGFUSE_SECRET_KEY ?? '';
  if (!host) return { ok: false, disabled: false, error: 'LANGFUSE_HOST is required' };
  if (!publicKey) {
    return { ok: false, disabled: false, error: 'LANGFUSE_PUBLIC_KEY is required' };
  }
  if (!secretKey) {
    return { ok: false, disabled: false, error: 'LANGFUSE_SECRET_KEY is required' };
  }
  if (!validCredential(publicKey) || publicKey.includes(':')) {
    return { ok: false, disabled: false, error: 'LANGFUSE_PUBLIC_KEY is invalid' };
  }
  if (!validCredential(secretKey)) {
    return { ok: false, disabled: false, error: 'LANGFUSE_SECRET_KEY is invalid' };
  }
  try {
    normalizeLangfuseHost(host);
  } catch (error) {
    return {
      ok: false,
      disabled: false,
      error: error instanceof Error ? error.message : 'LANGFUSE_HOST is invalid',
    };
  }
  const rawBindings = env.LANGFUSE_BINDINGS_JSON ?? '';
  if (!rawBindings.trim()) {
    return { ok: false, disabled: false, error: 'LANGFUSE_BINDINGS_JSON is required' };
  }
  const bindings = parseBindingsJSON(rawBindings);
  if (!bindings.ok) return { ok: false, disabled: false, error: bindings.error };
  const timeout = parseNonNegativeInt(
    env.LANGFUSE_TIMEOUT_MS,
    'LANGFUSE_TIMEOUT_MS',
    LIMITS.memoryAdapterTimeoutMs,
    1,
  );
  if (!timeout.ok) return { ok: false, disabled: false, error: timeout.error };
  const retries = parseNonNegativeInt(
    env.LANGFUSE_MAX_RETRIES,
    'LANGFUSE_MAX_RETRIES',
    LIMITS.memoryAdapterMaxRetries,
    0,
  );
  if (!retries.ok) return { ok: false, disabled: false, error: retries.error };
  const retryBase = parseNonNegativeInt(
    env.LANGFUSE_RETRY_BASE_MS,
    'LANGFUSE_RETRY_BASE_MS',
    LIMITS.memoryAdapterRetryBaseMs,
    1,
  );
  if (!retryBase.ok) return { ok: false, disabled: false, error: retryBase.error };
  const pageSize = parseNonNegativeInt(
    env.LANGFUSE_PAGE_SIZE,
    'LANGFUSE_PAGE_SIZE',
    LIMITS.memoryLangfusePageSize,
    1,
  );
  if (!pageSize.ok) return { ok: false, disabled: false, error: pageSize.error };
  const maxPages = parseNonNegativeInt(
    env.LANGFUSE_MAX_PAGES,
    'LANGFUSE_MAX_PAGES',
    LIMITS.memoryLangfuseMaxPages,
    1,
  );
  if (!maxPages.ok) return { ok: false, disabled: false, error: maxPages.error };
  const initialFrom = parseInitialFrom(env.LANGFUSE_INITIAL_FROM, now);
  if (!initialFrom.ok) return { ok: false, disabled: false, error: initialFrom.error };
  return {
    ok: true,
    config: {
      host,
      publicKey,
      secretKey,
      bindings: bindings.bindings,
      requestTimeoutMs: timeout.value,
      maxRetries: retries.value,
      retryBaseMs: retryBase.value,
      pageSize: Math.min(pageSize.value, 1_000),
      maxPages: maxPages.value,
      initialFrom: initialFrom.value,
    },
  };
}

/**
 * 校验并冻结直接注入的配置。null 表示未配置，由调用方声明 disabled；
 * 非法字段抛错，错误文本不包含凭据。
 */
export function resolveLangfuseSourceConfig(
  config: LangfuseSourceConfig | null,
): ResolvedLangfuseSourceConfig | null {
  if (!config) return null;
  if (!config.publicKey) throw new Error('LANGFUSE_PUBLIC_KEY is required');
  if (!config.secretKey) throw new Error('LANGFUSE_SECRET_KEY is required');
  if (!validCredential(config.publicKey) || config.publicKey.includes(':')) {
    throw new Error('LANGFUSE_PUBLIC_KEY is invalid');
  }
  if (!validCredential(config.secretKey)) {
    throw new Error('LANGFUSE_SECRET_KEY is invalid');
  }
  if (config.bindings.length === 0) {
    throw new Error('LANGFUSE_BINDINGS_JSON is required');
  }
  const bindings: LangfuseSourceBinding[] = [];
  const bindingIds = new Set<string>();
  for (let index = 0; index < config.bindings.length; index += 1) {
    const parsed = parseBinding(config.bindings[index], index);
    if (!parsed.ok) throw new Error(parsed.error);
    if (bindingIds.has(parsed.binding.binding_id)) {
      throw new Error('LANGFUSE_BINDINGS_JSON contains duplicate binding_id');
    }
    bindingIds.add(parsed.binding.binding_id);
    bindings.push(parsed.binding);
  }
  const projects = new Set(bindings.map((binding) => binding.project_id));
  if (projects.size !== 1) {
    throw new Error('LANGFUSE_BINDINGS_JSON must use a single project_id');
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? LIMITS.memoryAdapterTimeoutMs;
  const maxRetries = config.maxRetries ?? LIMITS.memoryAdapterMaxRetries;
  const retryBaseMs = config.retryBaseMs ?? LIMITS.memoryAdapterRetryBaseMs;
  const pageSize = Math.min(config.pageSize ?? LIMITS.memoryLangfusePageSize, 1_000);
  const maxPages = config.maxPages ?? LIMITS.memoryLangfuseMaxPages;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error('LANGFUSE_TIMEOUT_MS must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('LANGFUSE_MAX_RETRIES must be a non-negative integer');
  }
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1) {
    throw new Error('LANGFUSE_RETRY_BASE_MS must be a positive integer');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('LANGFUSE_PAGE_SIZE must be a positive integer');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('LANGFUSE_MAX_PAGES must be a positive integer');
  }
  const now = config.now ?? Date.now;
  const initialFrom = config.initialFrom ?? now() - LIMITS.memoryLangfuseInitialLookbackMs;
  if (!Number.isSafeInteger(initialFrom) || initialFrom < 0) {
    throw new Error('LANGFUSE_INITIAL_FROM is invalid');
  }
  return {
    host: normalizeLangfuseHost(config.host),
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    bindings,
    requestTimeoutMs,
    maxRetries,
    retryBaseMs,
    pageSize,
    maxPages,
    initialFrom,
    fetchImpl: config.fetchImpl ?? fetch,
    sleepImpl: config.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now,
  };
}

/** 来源能力只说明服务端 importer 是否可用；不含 host、project、key 或路由。 */
export function langfuseSourceCapabilities(
  config: ResolvedLangfuseSourceConfig | null,
): LangfuseSourceCapabilities {
  return {
    provider: 'langfuse',
    status: config ? 'ready' : 'disabled',
    api: 'observations-v2',
    pagination: 'cursor',
    auth: 'basic',
    import_classes: IMPORT_CLASSES,
    rejected_classes: REJECTED_CLASSES,
    reason: config ? null : 'langfuse_not_configured',
  };
}
