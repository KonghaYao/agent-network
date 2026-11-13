import { useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';

/**
 * 首页的实时刷新通道：复用现有 `agentnet://stream` 订阅，不轮询。
 *
 * 只负责“收到提示就刷新列表”，不解析具体业务事件；消息正文、回执与
 * 房间状态仍以 `network_rooms_list` 的读取结果为准。断线按指数退避重连，
 * 凭据失效/连接数上限等不可恢复错误停止重试并在侧栏显示状态。
 */

const STREAM_URI = 'agentnet://stream';
const PROTOCOL_VERSION = '2026-07-28';
const EVENT_META_KEY = 'io.agent-network/event';
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

export type ActorStreamEvent =
  | { type: 'ack'; reconnect: boolean }
  | { type: 'event'; source: string; kind: string; roomId: string | null };

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
        notifications: { resourceSubscriptions: [STREAM_URI] },
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

function parseSseData(block: string): string {
  const lines = block.split('\n');
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.join('\n');
}

function isAck(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const value = message as {
    method?: unknown;
    params?: {
      notifications?: { resourceSubscriptions?: unknown };
    };
  };
  if (value.method !== 'notifications/subscriptions/acknowledged') return false;
  const subscriptions = value.params?.notifications?.resourceSubscriptions;
  return Array.isArray(subscriptions) && subscriptions.includes(STREAM_URI);
}

function notificationUri(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as {
    method?: unknown;
    params?: { uri?: unknown; _meta?: Record<string, unknown> };
  };
  if (value.method !== 'notifications/resources/updated') return null;
  if (value.params?.uri !== STREAM_URI) return null;
  const meta = value.params._meta;
  if (!meta || typeof meta[EVENT_META_KEY] !== 'object') return null;
  return STREAM_URI;
}

/** 信封里的 item 只取定位字段；不解析正文，只用于决定刷新哪些查询。 */
function notificationEvents(message: unknown): ActorStreamEvent[] {
  if (!message || typeof message !== 'object') return [];
  const value = message as {
    params?: { _meta?: Record<string, unknown> };
  };
  const envelope = value.params?._meta?.[EVENT_META_KEY];
  if (!envelope || typeof envelope !== 'object') return [];
  const items = (envelope as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const events: ActorStreamEvent[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { source?: unknown; kind?: unknown; room_id?: unknown };
    events.push({
      type: 'event',
      source: typeof item.source === 'string' ? item.source : '',
      kind: typeof item.kind === 'string' ? item.kind : '',
      roomId: typeof item.room_id === 'string' ? item.room_id : null,
    });
  }
  return events;
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
    /** 首次 ack 由首屏查询覆盖；只有重连后的 ack 才需要补拉。 */
    let connected = false;

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, delay);
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
        attempt += 1;
        setError('实时连接已断开，正在重试…');
        schedule(backoff(attempt));
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
        attempt += 1;
        setError('实时连接已断开，正在重试…');
        schedule(backoff(attempt));
        return;
      }

      attempt = 0;
      setError(null);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let acknowledged = false;
      try {
        for (;;) {
          const step = await reader.read();
          if (step.done || disposed) break;
          buffer += decoder.decode(step.value, { stream: true }).replaceAll('\r\n', '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = parseSseData(block);
            if (data) {
              let message: unknown = null;
              try {
                message = JSON.parse(data);
              } catch {
                message = null;
              }
              if (isAck(message)) {
                acknowledged = true;
                // 首次连接由首屏查询覆盖；重连才补拉，避免首屏重复读取。
                const reconnect = connected;
                connected = true;
                handlerRef.current({ type: 'ack', reconnect });
              } else if (notificationUri(message)) {
                const events = notificationEvents(message);
                if (events.length === 0) {
                  // 信封合法但没有可定位 item：保守刷新，仍不解析正文。
                  handlerRef.current({
                    type: 'event',
                    source: '',
                    kind: '',
                    roomId: null,
                  });
                } else {
                  for (const event of events) handlerRef.current(event);
                }
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch {
        if (disposed) return;
      } finally {
        try {
          await reader.cancel();
        } catch {
          // reader 可能已经被浏览器关闭。
        }
      }
      if (disposed) return;
      attempt += 1;
      if (!acknowledged) setError('实时连接已断开，正在重试…');
      schedule(backoff(attempt));
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
