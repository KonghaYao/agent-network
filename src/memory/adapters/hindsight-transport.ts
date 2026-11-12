/**
 * Hindsight HTTP 传输：超时、可重试状态、外部取消与错误分类。
 *
 * 只把状态/分类返回给调用方，绝不把响应正文、URL 查询或凭据写进错误文本。
 */
import type { MemoryAdapterFailureReason } from './types';
import type { ResolvedHindsightConfig } from './hindsight-config';

export type HttpOutcome =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'http'; status: number; body: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'network' }
  | { kind: 'parse' }
  | { kind: 'disabled' };

export interface RequestOptions {
  body?: unknown;
  deadlineAt: number | null;
  retry: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HindsightTransport {
  readonly #config: ResolvedHindsightConfig;
  readonly #controllers = new Set<AbortController>();

  constructor(config: ResolvedHindsightConfig) {
    this.#config = config;
  }

  get config(): ResolvedHindsightConfig {
    return this.#config;
  }

  /** 进程关闭/取消时中止进行中的请求；已提交的远端作业由 jobStatus 对账。 */
  cancelAll(): void {
    for (const controller of this.#controllers) controller.abort('cancelled');
  }

  async request(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<HttpOutcome> {
    const config = this.#config;
    const deadlineAt = options.deadlineAt ?? config.now() + config.requestTimeoutMs;
    let attempt = 0;
    for (;;) {
      const remaining = deadlineAt - config.now();
      if (remaining <= 0) return { kind: 'timeout' };
      const controller = new AbortController();
      this.#controllers.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
      }, remaining);
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${config.apiKey}`,
          accept: 'application/json',
        };
        if (options.body !== undefined) headers['content-type'] = 'application/json';
        const response = await config.fetchImpl(`${config.baseUrl}${path}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        const text = await response.text();
        let body: unknown = null;
        let parsed = true;
        if (text.length > 0) {
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            parsed = false;
          }
        }
        if (response.ok) {
          return parsed ? { kind: 'ok', status: response.status, body } : { kind: 'parse' };
        }
        if (options.retry && attempt < config.maxRetries && RETRYABLE_STATUS.has(response.status)) {
          attempt += 1;
          if (!(await this.backoff(attempt, deadlineAt))) return { kind: 'timeout' };
          continue;
        }
        return { kind: 'http', status: response.status, body };
      } catch {
        if (controller.signal.aborted) {
          return timedOut ? { kind: 'timeout' } : { kind: 'cancelled' };
        }
        if (options.retry && attempt < config.maxRetries) {
          attempt += 1;
          if (!(await this.backoff(attempt, deadlineAt))) return { kind: 'timeout' };
          continue;
        }
        return { kind: 'network' };
      } finally {
        clearTimeout(timer);
        this.#controllers.delete(controller);
      }
    }
  }

  reasonFor(
    outcome: HttpOutcome,
    fallback: MemoryAdapterFailureReason,
  ): MemoryAdapterFailureReason {
    switch (outcome.kind) {
      case 'timeout':
        return 'timeout';
      case 'cancelled':
      case 'network':
      case 'disabled':
        return 'unavailable';
      case 'parse':
        return 'unknown';
      case 'ok':
        return fallback;
      case 'http':
        if (outcome.status === 400 || outcome.status === 422) return 'invalid_request';
        if (outcome.status === 409) return 'fenced';
        if (outcome.status === 401 || outcome.status === 403) return 'unavailable';
        if (outcome.status === 404) return 'unknown';
        if (outcome.status === 408 || outcome.status === 425 || outcome.status === 429) {
          return 'timeout';
        }
        if (outcome.status >= 500) return 'unavailable';
        return fallback;
    }
  }

  private async backoff(attempt: number, deadlineAt: number): Promise<boolean> {
    const delay = Math.min(this.#config.retryBaseMs * 2 ** (attempt - 1), 5_000);
    if (this.#config.now() + delay >= deadlineAt) return false;
    await this.#config.sleepImpl(delay);
    return this.#config.now() < deadlineAt;
  }
}
