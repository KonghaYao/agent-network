import type { Database } from 'bun:sqlite';

/**
 * 进程内通知通道，替代 Cloudflare Durable Object（PartyServer）。
 *
 * 语义与 realtime/channel.ts 保持一致：
 * - 每个 topic 维护订阅连接与上线代次；
 * - Agent 的 inbox 只有显式 login 后才接收广播；
 * - login 先于订阅时，首个连接被收养并补发 login 提示；
 * - 订阅连接全部断开后 Agent 自动离线；
 * - 成员变化提示由订阅方关闭流并重新鉴权。
 *
 * 单进程内状态不持久化：进程重启后需要重新 login，这与 MCP 订阅流的
 * 生命周期一致。多实例部署不在当前实现范围内。
 */

export interface HubSubscription {
  unsubscribe(): void;
}

interface PresenceState {
  online: boolean;
  since: number;
  seq: number;
  connections: Set<string>;
}

interface TopicState {
  subscribers: Map<string, (message: string) => void>;
  presence: PresenceState | null;
}

export interface HubLoginResult {
  online: true;
  since: number;
  connections: number;
}

export interface HubPresence {
  online: boolean;
  since: number | null;
}

const INBOX_PREFIX = 'inbox:';

function loginHint(topic: string, seq: number): string {
  return JSON.stringify({ topic, seq, kind: 'login' });
}

export class NotificationHub {
  readonly #db: Database;
  readonly #topics = new Map<string, TopicState>();
  readonly #actorKinds = new Map<string, 'human' | 'agent' | null>();
  #counter = 0;

  constructor(db: Database) {
    this.#db = db;
  }

  #topic(name: string): TopicState {
    let state = this.#topics.get(name);
    if (!state) {
      state = { subscribers: new Map(), presence: null };
      this.#topics.set(name, state);
    }
    return state;
  }

  /**
   * 建立一条订阅连接。
   *
   * 返回的 unsubscribe 等价于 DO 的 onClose：连接从代次中移除，最后一个
   * Agent 连接断开时置为离线。
   */
  subscribe(topic: string, send: (message: string) => void): HubSubscription {
    const state = this.#topic(topic);
    const connectionId = `conn_${++this.#counter}`;
    state.subscribers.set(connectionId, send);

    const presence = state.presence;
    if (presence?.online && presence.connections.size === 0) {
      presence.connections.add(connectionId);
      send(loginHint(topic, presence.seq));
    }

    return {
      unsubscribe: () => {
        this.#unsubscribe(topic, connectionId);
      },
    };
  }

  #unsubscribe(topic: string, connectionId: string): void {
    const state = this.#topics.get(topic);
    if (!state) return;
    state.subscribers.delete(connectionId);
    const presence = state.presence;
    if (presence?.online && presence.connections.delete(connectionId) && presence.connections.size === 0) {
      presence.online = false;
    }
  }

  /** 发布一条不超过 1 KiB 的变更提示。 */
  async publish(topic: string, message: string): Promise<void> {
    const state = this.#topics.get(topic);
    if (!state) return;
    if (await this.#gated(topic)) {
      const presence = state.presence;
      if (!presence?.online) return;
      for (const [connectionId, send] of state.subscribers) {
        if (!presence.connections.has(connectionId)) continue;
        this.#safeSend(send, message);
      }
      return;
    }
    for (const send of state.subscribers.values()) this.#safeSend(send, message);
  }

  #safeSend(send: (message: string) => void, message: string): void {
    try {
      send(message);
    } catch {
      // 连接已进入关闭流程；离线状态由 unsubscribe 收敛。
    }
  }

  /** Agent 显式上线；重复调用幂等。 */
  async login(topic: string, seq: number): Promise<HubLoginResult> {
    const state = this.#topic(topic);
    const since = Date.now();
    const connections = [...state.subscribers.keys()];
    const previousSeq = state.presence?.seq ?? 0;
    state.presence = {
      online: true,
      since,
      seq: Math.max(seq, previousSeq),
      connections: new Set(connections),
    };
    const hint = loginHint(topic, state.presence.seq);
    for (const connectionId of connections) {
      const send = state.subscribers.get(connectionId);
      if (send) this.#safeSend(send, hint);
    }
    return { online: true, since, connections: connections.length };
  }

  /** 只读在线快照；从未 login 的 Agent 返回离线。 */
  presence(topic: string): HubPresence {
    const state = this.#topics.get(topic);
    const presence = state?.presence;
    if (!state || presence?.online !== true) return { online: false, since: null };
    const active = new Set(state.subscribers.keys());
    const online =
      presence.connections.size === 0 ||
      [...presence.connections].some((connectionId) => active.has(connectionId));
    return { online, since: online ? presence.since : null };
  }

  /** 只有 Agent 的 inbox 需要先上线；房间与人类 inbox 不受影响。 */
  async #gated(topic: string): Promise<boolean> {
    if (!topic.startsWith(INBOX_PREFIX)) return false;
    return (await this.#resolveActorKind(topic.slice(INBOX_PREFIX.length))) === 'agent';
  }

  async #resolveActorKind(actorId: string): Promise<'human' | 'agent' | null> {
    if (this.#actorKinds.has(actorId)) return this.#actorKinds.get(actorId) ?? null;
    const row = await this.#db
      .prepare('SELECT kind FROM actors WHERE actor_id = ?')
      .get(actorId) as { kind: 'human' | 'agent' } | null;
    const kind = row?.kind ?? null;
    this.#actorKinds.set(actorId, kind);
    return kind;
  }

  /** 测试与运维用：清空全部进程内状态。 */
  reset(): void {
    this.#topics.clear();
    this.#actorKinds.clear();
  }
}
