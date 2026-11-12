/**
 * MF09 Langfuse 只读 HTTP 传输。
 *
 * 只请求 Observations API v2（cursor 分页）。Basic Auth 头在构造时生成，
 * 不进入 URL、查询串、错误或结果；失败只返回分类/状态码，不回传响应正文。
 */
import type { ResolvedLangfuseSourceConfig } from './langfuse-config';

export type LangfuseHttpOutcome =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'http'; status: number }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'network' }
  | { kind: 'parse' };

export interface LangfuseObservationQuery {
  /** epoch ms；转换为官方要求的 ISO 8601。 */
  from: number;
  to: number;
  cursor: string | null;
  deadlineAt?: number | null;
  signal?: AbortSignal | null;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const OBSERVATION_FIELDS = 'core,basic,time,io,metadata,trace_context';
const DEFAULT_METADATA_KEYS = ['agentnet_manifest_id', 'agentnet_context_id'];

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class LangfuseTransport {
  readonly #config: ResolvedLangfuseSourceConfig;
  readonly #authorization: string;
  readonly #expandMetadata: string;
  readonly #controllers = new Set<AbortController>();

  constructor(config: ResolvedLangfuseSourceConfig) {
    this.#config = config;
    // 只在私有字段保存认证头；凭据不参与任何日志或结果。
    this.#authorization = `Basic ${btoa(`${config.publicKey}:${config.secretKey}`)}`;
    const metadataKeys = new Set(DEFAULT_METADATA_KEYS);
    for (const binding of config.bindings) {
      for (const rule of Object.values(binding.observations)) {
        if (rule.manifest_metadata_key) metadataKeys.add(rule.manifest_metadata_key);
        if (rule.context_metadata_key) metadataKeys.add(rule.context_metadata_key);
      }
    }
    this.#expandMetadata = [...metadataKeys].join(',');
  }

  /** 进程关闭/取消时中止进行中的请求。 */
  cancelAll(): void {
    for (const controller of this.#controllers) controller.abort('cancelled');
  }

  async listObservations(query: LangfuseObservationQuery): Promise<LangfuseHttpOutcome> {
    const config = this.#config;
    const deadlineAt = query.deadlineAt ?? config.now() + config.requestTimeoutMs;
    let attempt = 0;
    for (;;) {
      if (query.signal?.aborted) return { kind: 'cancelled' };
      const remaining = deadlineAt - config.now();
      if (remaining <= 0) return { kind: 'timeout' };
      const controller = new AbortController();
      this.#controllers.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
      }, remaining);
      const onExternalAbort = () => controller.abort('cancelled');
      query.signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        const url = new URL(`${config.host}/api/public/v2/observations`);
        url.searchParams.set('fromStartTime', new Date(query.from).toISOString());
        url.searchParams.set('toStartTime', new Date(query.to).toISOString());
        url.searchParams.set('limit', String(config.pageSize));
        url.searchParams.set('fields', OBSERVATION_FIELDS);
        url.searchParams.set('expandMetadata', this.#expandMetadata);
        if (query.cursor) url.searchParams.set('cursor', query.cursor);
        const response = await config.fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: this.#authorization,
            accept: 'application/json',
          },
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          // 响应正文可能包含 trace 内容或认证提示；只保留状态码。
          if (
            attempt < config.maxRetries &&
            RETRYABLE_STATUS.has(response.status)
          ) {
            attempt += 1;
            if (!(await this.#backoff(attempt, deadlineAt, query.signal))) {
              return query.signal?.aborted ? { kind: 'cancelled' } : { kind: 'timeout' };
            }
            continue;
          }
          return { kind: 'http', status: response.status };
        }
        if (text.length === 0) return { kind: 'parse' };
        try {
          return { kind: 'ok', status: response.status, body: JSON.parse(text) as unknown };
        } catch {
          return { kind: 'parse' };
        }
      } catch (error) {
        if (controller.signal.aborted) {
          if (query.signal?.aborted) return { kind: 'cancelled' };
          return timedOut ? { kind: 'timeout' } : { kind: 'cancelled' };
        }
        if (isAbortError(error) && query.signal?.aborted) return { kind: 'cancelled' };
        if (attempt < config.maxRetries) {
          attempt += 1;
          if (!(await this.#backoff(attempt, deadlineAt, query.signal))) {
            return query.signal?.aborted ? { kind: 'cancelled' } : { kind: 'timeout' };
          }
          continue;
        }
        return { kind: 'network' };
      } finally {
        clearTimeout(timer);
        query.signal?.removeEventListener('abort', onExternalAbort);
        this.#controllers.delete(controller);
      }
    }
  }

  async #backoff(
    attempt: number,
    deadlineAt: number,
    signal?: AbortSignal | null,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const config = this.#config;
    const delay = Math.min(
      config.retryBaseMs * 2 ** Math.max(0, attempt - 1),
      Math.max(1, deadlineAt - config.now()),
    );
    await config.sleepImpl(delay);
    return !signal?.aborted && config.now() < deadlineAt;
  }
}
