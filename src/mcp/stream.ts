import { SERVER_INFO_META_KEY, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/server';

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { Env } from '../env';
import type { ActorRow } from '../storage/rows';
import type { HubSubscription } from '../realtime/hub';
import {
  buildSessionLoginFrame,
  STREAM_EVENT_META_KEY,
  STREAM_URI,
  STREAM_VERSION,
  type StreamFrame,
} from '../realtime/stream';

/**
 * `subscriptions/listen` 的自定义 SSE 路由。
 *
 * SDK 的 listen router 把 resource_updated 固定成 `params: { uri }`，无法
 * 携带来源信封。这里复制同一 wire 形状，但把业务来源放进
 * `params._meta["io.agent-network/event"]`。
 *
 * 该路由只负责传输：订阅注册、在线门控与连接上限在 NotificationHub；
 * 事件来源与 recipient 解析在 realtime/stream.ts。
 */

export interface StreamListenRequest {
  id?: string | number | null;
}

export interface StreamQueueEntry {
  frame: string;
  items: number;
}

const SERVER_INFO = { name: 'peri-agent-network', version: '0.1.0' } as const;

function notification(method: string, params: Record<string, unknown>): string {
  return `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  })}\n\n`;
}

function parseFrame(frame: string): StreamFrame | null {
  try {
    const value = JSON.parse(frame) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as StreamFrame;
  } catch {
    return null;
  }
}

/**
 * 有界 SSE 发送队列。
 *
 * - 队列满时优先丢弃最旧的业务帧，并累计 item 数到下一帧的 dropped；
 * - ack / keepalive 等非业务帧不会被丢弃（避免握手失败）；
 * - 若队列里没有业务帧可丢，则丢弃新业务帧并只累计 dropped。
 */
export class StreamQueue {
  readonly #entries: StreamQueueEntry[] = [];
  readonly #limit: number;
  #droppedItems = 0;

  constructor(limit: number = LIMITS.streamQueueMax) {
    this.#limit = limit;
  }

  get length(): number {
    return this.#entries.length;
  }

  get droppedItems(): number {
    return this.#droppedItems;
  }

  push(entry: StreamQueueEntry): boolean {
    if (this.#entries.length >= this.#limit) {
      const index = this.#entries.findIndex((item) => item.items > 0);
      if (index >= 0) {
        const [dropped] = this.#entries.splice(index, 1);
        if (dropped) this.#droppedItems += dropped.items;
      } else if (entry.items > 0) {
        this.#droppedItems += entry.items;
        return false;
      } else {
        return false;
      }
    }
    this.#entries.push(entry);
    return true;
  }

  shift(): StreamQueueEntry | undefined {
    return this.#entries.shift();
  }

  takeDropped(): number {
    const dropped = this.#droppedItems;
    this.#droppedItems = 0;
    return dropped;
  }
}

export function serveActorStream(
  request: Request,
  env: Env,
  actor: ActorRow,
  body: StreamListenRequest,
): Response {
  const id = body.id;
  if ((typeof id !== 'string' || id.length === 0) && typeof id !== 'number') {
    throw new BusinessError('INVALID_ARGUMENT', 'subscriptions/listen 缺少有效 id');
  }
  const subscriptionId = String(id);
  const wasOnline = actor.kind === 'agent' && env.NOTIFICATION_HUB.actorOnline(actor.actor_id);

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let lastSeq = '0';
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let subscription: HubSubscription | undefined;
  const queue = new StreamQueue(LIMITS.streamQueueMax);
  const encoder = new TextEncoder();

  const canWrite = (): boolean =>
    controller !== null && (controller.desiredSize === null || controller.desiredSize > 0);

  const flush = (): void => {
    while (!closed && queue.length > 0 && canWrite()) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        controller?.enqueue(encoder.encode(entry.frame));
      } catch {
        close(false);
        return;
      }
    }
    // 慢消费者恢复后，把累计的 dropped 作为最后一帧送达；否则它只会
    // 挂在下一条业务帧上，没有后续事件时永远不可见。
    if (closed || queue.length > 0 || queue.droppedItems === 0 || !canWrite()) return;
    const dropped = queue.takeDropped();
    const notice: StreamFrame = {
      v: STREAM_VERSION,
      actor_id: actor.actor_id,
      seq: lastSeq,
      attention: 'informational',
      items: [],
      more: true,
      dropped,
    };
    try {
      controller?.enqueue(
        encoder.encode(
          notification('notifications/resources/updated', {
            uri: STREAM_URI,
            _meta: {
              [SUBSCRIPTION_ID_META_KEY]: id,
              [STREAM_EVENT_META_KEY]: notice,
            },
          }),
        ),
      );
    } catch {
      close(false);
    }
  };

  const close = (graceful: boolean): void => {
    if (closed) return;
    if (graceful && controller) {
      const frame = `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          _meta: {
            [SUBSCRIPTION_ID_META_KEY]: id,
            [SERVER_INFO_META_KEY]: SERVER_INFO,
          },
        },
      })}\n\n`;
      try {
        controller.enqueue(encoder.encode(frame));
      } catch {
        // 连接已经关闭。
      }
    }
    closed = true;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    request.signal.removeEventListener('abort', onAbort);
    subscription?.unsubscribe();
    try {
      controller?.close();
    } catch {
      // 已经进入关闭流程。
    }
  };

  const push = (entry: StreamQueueEntry): void => {
    if (closed) return;
    if (!queue.push(entry)) return;
    flush();
  };

  const pushEvent = (raw: string): void => {
    const frame = parseFrame(raw);
    if (!frame) return;
    lastSeq = frame.seq;
    const dropped = queue.takeDropped();
    if (dropped > 0) {
      frame.more = true;
      frame.dropped += dropped;
    }
    push({
      frame: notification('notifications/resources/updated', {
        uri: STREAM_URI,
        _meta: {
          [SUBSCRIPTION_ID_META_KEY]: id,
          [STREAM_EVENT_META_KEY]: frame,
        },
      }),
      items: frame.items.length,
    });
  };

  const onAbort = (): void => close(false);

  // ack 必须先于任何事件进入队列。
  push({
    frame: notification('notifications/subscriptions/acknowledged', {
      notifications: { resourceSubscriptions: [STREAM_URI] },
      _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
    }),
    items: 0,
  });

  const subscriptionHandle = env.NOTIFICATION_HUB.subscribeActor(
    actor.actor_id,
    actor.kind,
    subscriptionId,
    pushEvent,
    () => close(true),
  );
  subscription = subscriptionHandle;

  // login 先于连接时，补发一帧当前快照。
  if (wasOnline) {
    pushEvent(JSON.stringify(buildSessionLoginFrame(actor)));
  }

  keepAlive = setInterval(() => {
    if (queue.length >= LIMITS.streamQueueMax) return;
    push({ frame: ': keepalive\n\n', items: 0 });
  }, LIMITS.keepaliveMs);

  if (request.signal.aborted) {
    close(false);
  } else {
    request.signal.addEventListener('abort', onAbort, { once: true });
  }

  const readable = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
        if (closed) {
          try {
            streamController.close();
          } catch {
            // 已经关闭。
          }
          return;
        }
        flush();
      },
      pull() {
        flush();
      },
      cancel() {
        close(false);
      },
    },
    { highWaterMark: 1 },
  );

  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
