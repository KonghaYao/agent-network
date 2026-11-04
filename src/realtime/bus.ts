import type { ServerEvent, ServerEventBus } from '@modelcontextprotocol/server';

import type { Env } from '../env';

export interface HintMessage {
  topic: string;
  seq: number;
  kind?: string;
}

/**
 * 一条 MCP `subscriptions/listen` 流到进程内通知 hub 的桥。
 *
 * - `subscribe()` 由 SDK 的 listen 路由调用；这里按 topic 注册订阅。
 * - hub 只广播小型提示；资源正文由客户端回读。
 * - 连接断开时调用 `onBroken`，让 Gateway 结束本次 MCP 订阅流，客户端重建。
 */
export class TopicEventBus implements ServerEventBus {
  readonly #topicUris: Map<string, Set<string>>;
  readonly #onBroken: () => void;
  readonly #listeners = new Set<(event: ServerEvent) => void>();
  readonly #unsubscribes: Array<() => void> = [];
  readonly #buffer: ServerEvent[] = [];
  #closed = false;
  #broken = false;

  constructor(env: Env, topicUris: Map<string, Set<string>>, onBroken: () => void) {
    this.#topicUris = topicUris;
    this.#onBroken = onBroken;
    for (const topic of topicUris.keys()) {
      const subscription = env.NOTIFICATION_HUB.subscribe(topic, (message) => {
        this.#onChannelMessage(topic, message);
      });
      this.#unsubscribes.push(() => subscription.unsubscribe());
    }
  }

  /** 订阅注册是同步的；保留 ready() 以兼容原有调用顺序。 */
  ready(): Promise<void> {
    return Promise.resolve();
  }

  #onChannelMessage(topic: string, data: unknown): void {
    let seq = 0;
    let kind: string | undefined;
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as Partial<HintMessage>;
        seq = typeof parsed.seq === 'number' ? parsed.seq : 0;
        kind = typeof parsed.kind === 'string' ? parsed.kind : undefined;
      } catch {
        // 非 JSON 提示按无版本处理。
      }
    }
    if (kind === 'membership') {
      // 成员变化后必须关闭流并重新鉴权，避免已被移除的身份继续收到房间提示。
      this.#break();
      return;
    }
    const uris = this.#topicUris.get(topic);
    if (!uris) return;
    for (const uri of uris) {
      const event: ServerEvent = { kind: 'resource_updated', uri };
      void seq;
      void kind;
      this.#dispatch(event);
    }
  }

  #dispatch(event: ServerEvent): void {
    if (this.#listeners.size === 0) {
      if (this.#buffer.length >= 32) this.#buffer.shift();
      this.#buffer.push(event);
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }

  #break(): void {
    if (this.#broken) return;
    this.#broken = true;
    this.close();
    this.#onBroken();
  }

  publish(): void {
    // 服务端的变更发布走 D1 outbox + hub，不经过单请求 bus。
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    if (this.#buffer.length > 0) {
      const buffered = this.#buffer.splice(0, this.#buffer.length);
      for (const event of buffered) listener(event);
    }
    return () => {
      this.#listeners.delete(listener);
      // 订阅流结束时 SDK 只会取消订阅，不会通知 bus；这里主动断开 hub 订阅，
      // 让 Agent 立即离线。
      if (this.#listeners.size === 0) this.close();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
  }
}

export async function publishHint(
  env: Env,
  topic: string,
  seq: number,
  kind?: string,
): Promise<void> {
  await env.NOTIFICATION_HUB.publish(topic, JSON.stringify({ topic, seq, kind } satisfies HintMessage));
}
