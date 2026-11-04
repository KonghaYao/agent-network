import { isIP, type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';

import { LIMITS } from '../contracts/limits';
import { sanitizeDiagnosticText } from './log';
import {
  CallbackTargetError,
  resolveCallbackTargets,
  type CallbackTarget,
  type CallbackUrlRules,
} from './security';

export type CallbackFailure =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'blocked_address'
  | 'network_error';

/** 单个已校验地址的一次尝试；只保留诊断需要的字段。 */
export interface CallbackAttempt {
  attempt: number;
  family: 4 | 6;
  address: string;
  durationMs: number;
  code: string | null;
  reason: CallbackFailure;
  /** 已去除 URL 并截断的底层错误文本，禁止写入 secret/signature/body。 */
  message: string;
}

export class CallbackRequestError extends Error {
  readonly reason: CallbackFailure;
  /** 底层 errno（ECONNREFUSED、ETIMEDOUT 等），已限制为安全字符集。 */
  readonly code: string | null;
  readonly attempts: readonly CallbackAttempt[];

  constructor(
    reason: CallbackFailure,
    code: string | null,
    message: string,
    attempts: readonly CallbackAttempt[] = [],
  ) {
    super(message);
    this.name = 'CallbackRequestError';
    this.reason = reason;
    this.code = code;
    this.attempts = attempts;
  }

  get attemptCount(): number {
    return this.attempts.length;
  }

  get lastFamily(): 4 | 6 | null {
    return this.attempts.at(-1)?.family ?? null;
  }
}

export interface PostCallbackInput {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxResponseBytes: number;
  rules: CallbackUrlRules;
  tlsCa?: string;
}

export interface PostCallbackResult {
  status: number;
  body: string;
  truncated: boolean;
}

function errorCode(error: Error): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : null;
}

function classify(error: Error): CallbackFailure {
  const code = errorCode(error) ?? '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
    return 'connection_refused';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return 'connection_refused';
  }
  if (code.startsWith('ERR_TLS_') || code.includes('CERT') || code.includes('SSL')) {
    return 'tls_error';
  }
  return 'network_error';
}

function requestHeaders(input: PostCallbackInput): Record<string, string> {
  return {
    ...input.headers,
    host: input.url.host,
    'content-length': String(Buffer.byteLength(input.body, 'utf8')),
  };
}

/** 固定地址发起一次 HTTPS POST；Host/SNI 保持原 host，不跟随重定向。 */
function postPinnedAddress(
  input: PostCallbackInput,
  target: CallbackTarget,
  timeoutMs: number,
): Promise<PostCallbackResult> {
  const headers = requestHeaders(input);
  const rejectUnauthorized = input.rules.allowPrivateCallbacks && !input.tlsCa ? false : true;

  return new Promise<PostCallbackResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: target.hostname,
        port: input.url.port === '' ? 443 : Number(input.url.port),
        path: `${input.url.pathname}${input.url.search}`,
        method: 'POST',
        headers,
        lookup: ((_hostname, options, callback) => {
          // Node 的 Happy Eyeballs 路径会以 all:true 调用 lookup；此时必须返回数组。
          if ('all' in options && options.all) {
            (
              callback as unknown as (
                error: null,
                addresses: { address: string; family: number }[],
              ) => void
            )(null, [{ address: target.address, family: target.family }]);
            return;
          }
          (callback as unknown as (error: null, address: string, family: number) => void)(
            null,
            target.address,
            target.family,
          );
        }) as LookupFunction,
        ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
        minVersion: 'TLSv1.2',
        rejectUnauthorized,
        ...(input.tlsCa ? { ca: input.tlsCa } : {}),
        agent: false,
      },
      (response) => {
        let text = '';
        let truncated = false;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (settled) return;
          const remaining = input.maxResponseBytes - text.length;
          if (chunk.length > remaining) {
            text += chunk.slice(0, Math.max(0, remaining));
            truncated = true;
            settle(() =>
              resolve({ status: response.statusCode ?? 0, body: text, truncated }),
            );
            response.destroy();
            return;
          }
          text += chunk;
        });
        response.on('end', () => {
          settle(() =>
            resolve({ status: response.statusCode ?? 0, body: text, truncated }),
          );
        });
        response.on('error', (error: Error) => {
          settle(() => reject(toRequestError(error)));
        });
      },
    );

    const timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('callback timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timer.unref?.();

    request.on('error', (error: Error) => {
      settle(() => reject(toRequestError(error)));
    });
    request.end(input.body);
  });
}

function toRequestError(error: Error): CallbackRequestError {
  return new CallbackRequestError(
    classify(error),
    errorCode(error),
    sanitizeDiagnosticText(error.message),
  );
}

/**
 * 在已解析、已校验的地址列表上依次尝试。
 *
 * - 单地址超时 5s，总预算为 input.timeoutMs；
 * - 某个地址网络失败后立即回退到下一个，只有全部失败才抛错；
 * - TLS/Host/SNI 与 HTTP 状态处理与单地址请求完全一致。
 */
export async function postCallbackToTargets(
  input: PostCallbackInput,
  targets: readonly CallbackTarget[],
): Promise<PostCallbackResult> {
  if (targets.length === 0) {
    throw new CallbackRequestError('blocked_address', null, 'callback address is not public');
  }

  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  const perAttemptTimeoutMs = Math.max(
    1,
    Math.min(input.timeoutMs, LIMITS.eventsCallbackAttemptTimeoutMs),
  );
  const attempts: CallbackAttempt[] = [];

  for (const target of targets) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const attemptStartedAt = Date.now();
    try {
      return await postPinnedAddress(
        input,
        target,
        Math.min(perAttemptTimeoutMs, remaining),
      );
    } catch (error) {
      const requestError =
        error instanceof CallbackRequestError ? error : toRequestError(error as Error);
      attempts.push({
        attempt: attempts.length + 1,
        family: target.family,
        address: target.address,
        durationMs: Math.max(0, Date.now() - attemptStartedAt),
        code: requestError.code,
        reason: requestError.reason,
        message: requestError.message,
      });
    }
  }

  const last = attempts.at(-1);
  const reason: CallbackFailure = last?.reason ?? 'timeout';
  const code = last?.code ?? (reason === 'timeout' ? 'ETIMEDOUT' : null);
  const message =
    last?.message ??
    (reason === 'timeout' ? 'callback timeout' : 'callback request failed');
  throw new CallbackRequestError(reason, code, message, attempts);
}

/**
 * SSRF-hardened HTTPS POST。
 *
 * - 每次请求重新解析全部 A/AAAA 地址并逐个校验；
 * - 按 IPv4 优先顺序尝试，网络失败时回退到下一个地址；
 * - 每次尝试固定已验证 IP，Host 保持原 host（含非 443 端口），TLS SNI 保持原 hostname；
 * - 不跟随重定向；3xx 作为普通状态返回，由调用方分类；
 * - 响应体最多读取 maxResponseBytes。
 */
export async function postCallback(input: PostCallbackInput): Promise<PostCallbackResult> {
  let targets: CallbackTarget[];
  try {
    targets = await resolveCallbackTargets(input.url, input.rules);
  } catch (error) {
    if (error instanceof CallbackTargetError) {
      throw new CallbackRequestError(
        error.reason === 'blocked_address' ? 'blocked_address' : 'connection_refused',
        null,
        error.message,
      );
    }
    throw error;
  }
  return postCallbackToTargets(input, targets);
}
