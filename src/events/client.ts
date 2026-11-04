import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

import {
  CallbackTargetError,
  resolveCallbackTarget,
  type CallbackUrlRules,
} from './security';

export type CallbackFailure =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'blocked_address'
  | 'network_error';

export class CallbackRequestError extends Error {
  readonly reason: CallbackFailure;

  constructor(reason: CallbackFailure, message: string) {
    super(message);
    this.name = 'CallbackRequestError';
    this.reason = reason;
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

function classify(error: Error): CallbackFailure {
  const code = (error as NodeJS.ErrnoException).code ?? '';
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

/**
 * SSRF-hardened HTTPS POST。
 *
 * - 每次请求重新解析并固定一个已校验地址；
 * - Host 保持原 host（含非 443 端口），TLS SNI/servername 保持原 hostname；
 * - 不跟随重定向；3xx 作为普通状态返回，由调用方分类；
 * - 响应体最多读取 maxResponseBytes。
 */
export async function postCallback(input: PostCallbackInput): Promise<PostCallbackResult> {
  let target;
  try {
    target = await resolveCallbackTarget(input.url, input.rules);
  } catch (error) {
    if (error instanceof CallbackTargetError) {
      throw new CallbackRequestError(
        error.reason === 'blocked_address' ? 'blocked_address' : 'connection_refused',
        error.message,
      );
    }
    throw error;
  }

  const authority = input.url.host;
  const headers: Record<string, string> = {
    ...input.headers,
    host: authority,
    'content-length': String(Buffer.byteLength(input.body, 'utf8')),
  };
  const rejectUnauthorized = input.rules.allowPrivateCallbacks && !input.tlsCa ? false : true;

  return await new Promise<PostCallbackResult>((resolve, reject) => {
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
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family);
        },
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
          settle(() => reject(new CallbackRequestError(classify(error), error.message)));
        });
      },
    );

    const timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('callback timeout'), { code: 'ETIMEDOUT' }));
    }, input.timeoutMs);
    timer.unref?.();

    request.on('error', (error: Error) => {
      settle(() => reject(new CallbackRequestError(classify(error), error.message)));
    });
    request.end(input.body);
  });
}
