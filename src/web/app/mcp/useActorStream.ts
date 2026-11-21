import { useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { ACTOR_STREAM_URI, readActorStream, type ActorStreamEvent } from '../../lib/actor-stream';

export type { ActorStreamEvent, StreamAttention } from '../../lib/actor-stream';

/**
 * 首页的实时刷新通道：复用现有 `agentnet://stream` 订阅，不轮询。
 *
 * 只负责“收到提示就刷新列表”，不解析具体业务事件；消息正文、回执与
 * 房间状态仍以 `network_rooms_list` 的读取结果为准。断线按指数退避重连，
 * 凭据失效/连接数上限等不可恢复错误停止重试并在侧栏显示状态。
 */

const PROTOCOL_VERSION = '2026-07-28';
const FATAL_CODES = new Set([
  'CREDENTIAL_INVALID',
  'INVALID_ARGUMENT',
  'NOT_MEMBER',
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'UNAUTHORIZED',
  'ACTOR_NOT_FOUND',
  'RATE_LIMITED',
]);

interface StreamOptions {
  token: string | null;
  /** 事件来源；ack 补拉传 `{ type: 'ack', reconnect }`。页面只据此刷新相关查询。 */
  onEvent: (event: ActorStreamEvent) => void;
}

interface StreamState {
  error: string | null;
}

function streamRequest(token: string): { headers: Record<string, string>; body: string } {
  return {
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'subscriptions/listen',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'subscriptions/listen',
      params: {
        notifications: { resourceSubscriptions: [ACTOR_STREAM_URI] },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-web',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  };
}

function backoff(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    LIMITS.reconnectMaxMs,
    LIMITS.reconnectBaseMs * 2 ** exponent,
  );
  const jitter =
    1 + (Math.random() * 2 - 1) * LIMITS.reconnectJitterRatio;
  return Math.max(0, Math.round(base * jitter));
}

interface StreamFailure {
  message: string;
  fatal: boolean;
}

async function responseFailure(response: Response): Promise<StreamFailure> {
  let message = '';
  let code = '';
  try {
    const text = await response.text();
    if (text) {
      const payload = JSON.parse(text) as {
        error?: { message?: unknown; data?: { code?: unknown } };
      };
      if (typeof payload.error?.message === 'string') message = payload.error.message;
      if (typeof payload.error?.data?.code === 'string') code = payload.error.data.code;
    }
  } catch {
    // 非 JSON 响应按传输错误处理。
  }
  if (response.status === 401 || response.status === 403 || FATAL_CODES.has(code)) {
    return { message: message || '实时连接已停止：凭据无效或没有权限', fatal: true };
  }
  return { message: message || `HTTP ${response.status}`, fatal: false };
}

export function useActorStream({ token, onEvent }: StreamOptions): StreamState {
  const [error, setError] = useState<string | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!token) {
      setError(null);
      return undefined;
    }
    setError(null);
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    /**
     * 首次 ack 本身不直接补拉；调用方用 `at` 与首屏 history 请求发起
     * 时刻比较，只补握手窗口。重连 ack 仍由调用方整体刷新。
     */
    let connected = false;

    const retry = () => {
      if (disposed) return;
      setError('实时连接已断开，正在重试…');
      attempt += 1;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, backoff(attempt));
    };

    const connect = async (): Promise<void> => {
      if (disposed) return;
      controller = new AbortController();
      const request = streamRequest(token);
      let response: Response;
      try {
        response = await fetch('/mcp', {
          method: 'POST',
          headers: request.headers,
          signal: controller.signal,
          body: request.body,
        });
      } catch {
        if (disposed || controller.signal.aborted) return;
        retry();
        return;
      }
      if (disposed) return;
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
        const failure = await responseFailure(response);
        if (disposed) return;
        if (failure.fatal) {
          setError(`实时连接已停止：${failure.message}`);
          return;
        }
        retry();
        return;
      }

      try {
        for await (const frame of readActorStream(response.body)) {
          if (disposed) break;
          if (frame.type === 'ack') {
            // 仅收到有效 ack 后结束连续失败退避。
            attempt = 0;
            setError(null);
            const reconnect = connected;
            connected = true;
            handlerRef.current({ type: 'ack', reconnect, at: Date.now() });
          } else {
            handlerRef.current(frame);
          }
        }
      } catch {
        if (disposed) return;
      }
      if (disposed) return;
      retry();
    };

    void connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [token]);

  return { error };
}
