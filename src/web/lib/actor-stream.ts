import { sseMessageStream } from '../../contracts/sse';

export const ACTOR_STREAM_URI = 'agentnet://stream';
const EVENT_META_KEY = 'io.agent-network/event';

export type StreamAttention = 'action_required' | 'informational';

export type ActorStreamEvent =
  | { type: 'ack'; reconnect: boolean; at: number }
  | {
      type: 'event';
      source: string;
      kind: string;
      roomId: string | null;
      /** 事件定位到的消息；撤回与回执可据此重读可见窗口。 */
      messageId: string | null;
      /** 服务端提供的 change（如 recalled/marked/completed）。 */
      change: string | null;
      /**
       * 服务端标注的处理优先级。`action_required` 表示当前身份需要重新
       * 确认能力或访问边界，不一定意味着会话内容已不可读；被撤销管理员
       * 仍是群成员，只有被移出才会失去读权限。普通成员/资料变化是
       * informational。
       */
      attention: StreamAttention | null;
    };

type ActorNotification = Extract<ActorStreamEvent, { type: 'event' }>;
type ActorStreamFrame = { type: 'ack' } | ActorNotification;

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
  return Array.isArray(subscriptions) && subscriptions.includes(ACTOR_STREAM_URI);
}

function notificationItems(message: unknown): unknown[] | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as {
    method?: unknown;
    params?: { uri?: unknown; _meta?: Record<string, unknown> };
  };
  if (value.method !== 'notifications/resources/updated' || value.params?.uri !== ACTOR_STREAM_URI) {
    return null;
  }
  const envelope = value.params._meta?.[EVENT_META_KEY];
  if (typeof envelope !== 'object') return null;
  const items = (envelope as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

/** 只取定位和刷新所需字段，消息正文由查询重读。 */
function notificationEvents(items: unknown[]): ActorNotification[] {
  const events: ActorNotification[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as {
      source?: unknown;
      kind?: unknown;
      room_id?: unknown;
      message_id?: unknown;
      change?: unknown;
      attention?: unknown;
    };
    events.push({
      type: 'event',
      source: typeof item.source === 'string' ? item.source : '',
      kind: typeof item.kind === 'string' ? item.kind : '',
      roomId: typeof item.room_id === 'string' ? item.room_id : null,
      messageId: typeof item.message_id === 'string' ? item.message_id : null,
      change: typeof item.change === 'string' ? item.change : null,
      attention:
        item.attention === 'action_required' || item.attention === 'informational'
          ? item.attention
          : null,
    });
  }
  return events;
}

/** 每条物理连接只确认一次；缺少定位字段的更新仍触发保守刷新。 */
export async function* readActorStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ActorStreamFrame> {
  let acknowledged = false;
  for await (const frame of sseMessageStream(body)) {
    let message: unknown;
    try {
      message = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (isAck(message)) {
      if (acknowledged) continue;
      acknowledged = true;
      yield { type: 'ack' };
      continue;
    }
    const items = notificationItems(message);
    if (items === null) continue;
    const events = notificationEvents(items);
    if (events.length > 0) {
      yield* events;
    } else {
      yield {
        type: 'event',
        source: '',
        kind: '',
        roomId: null,
        messageId: null,
        change: null,
        attention: null,
      };
    }
  }
}
