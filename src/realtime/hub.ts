import type { Database } from 'bun:sqlite';

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { actorTopic } from '../storage/events';

/**
 * 进程内通知通道，替代 Cloudflare Durable Object（PartyServer）。
 *
 * cutover 后只维护统一 actor stream（`actor:{actor_id}`）：
 * - 人类连接不需要 login，建立后即可接收；
 * - Agent 的 login 门控整个投递流，未上线时不接收任何帧；
 * - 同一 actor 允许多条物理连接，最后一条连接断开即离线；
 * - 成员移除不再断流，客户端按 `room.membership` 停止该房间的读写。
 *
 * 单进程内状态不持久化：进程重启后需要重新 login，这与 MCP 订阅流的
 * 生命周期一致。多实例部署不在当前实现范围内。
 */

export interface HubSubscription {
  unsubscribe(): void;
}

export type ActorStreamKind = 'human' | 'agent';

interface ActorStreamState {
  kind: ActorStreamKind;
  subscribers: Map<string, (message: string) => void>;
  subscriptionIds: Set<string>;
  /** 连接 -> subscription id；设备撤销按连接清理时需要同时释放订阅 id。 */
  subscriptionIdByConnection: Map<string, string>;
  /** 连接 -> credential_id；用于单设备撤销只关闭该设备的活跃流。 */
  credentialIds: Map<string, string | null>;
  /** 服务端收口时由传输层注册的 graceful close。 */
  shutdown: Map<string, () => void>;
  online: boolean;
  since: number;
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

export interface HubPresenceHooks {
  /** Agent 已显式 login，且建立了至少一条连接。 */
  onAgentStreamOpened?: (actorId: string) => void;
  /** Agent 的最后一条连接断开；调用时 hub 已置为离线。 */
  onAgentLastConnectionClosed?: (actorId: string) => void;
}

export class NotificationHub {
  readonly #actorStreams = new Map<string, ActorStreamState>();
  readonly #hooks: HubPresenceHooks;
  /** 已撤销凭据；阻止撤销与建立连接并发时旧凭据重新注册流。 */
  readonly #revokedCredentials = new Set<string>();
  #counter = 0;

  constructor(_db: Database, hooks: HubPresenceHooks = {}) {
    // 保留构造参数以维持 main.ts 的装配方式；hub 不读取业务表。
    this.#hooks = hooks;
  }

  /**
   * 建立统一 actor stream 连接。
   *
   * 人类连接不需要 login，建立后即可接收；Agent 连接注册后保持离线，
   * 直到 `loginActor`。同一 actor 最多 `streamConnectionsPerActor` 条，
   * 同一 subscription id 在活跃期间不能复用。
   */
  subscribeActor(
    actorId: string,
    kind: ActorStreamKind,
    subscriptionId: string,
    send: (message: string) => void,
    onShutdown?: () => void,
    credentialId?: string | null,
  ): HubSubscription {
    if (credentialId && this.#revokedCredentials.has(credentialId)) {
      throw new BusinessError('CREDENTIAL_INVALID', '凭据已撤销，不能建立实时连接', {
        credential_id: credentialId,
      });
    }
    const state = this.#actorStream(actorId, kind);
    if (state.subscriptionIds.has(subscriptionId)) {
      throw new BusinessError('INVALID_ARGUMENT', 'subscription id 已被当前 actor 的其他连接使用', {
        subscription_id: subscriptionId,
      });
    }
    if (state.subscribers.size >= LIMITS.streamConnectionsPerActor) {
      throw new BusinessError('RATE_LIMITED', '当前 actor 的 stream 连接数已达上限', {
        limit: LIMITS.streamConnectionsPerActor,
      });
    }
    const connectionId = `conn_${++this.#counter}`;
    state.subscribers.set(connectionId, send);
    state.subscriptionIds.add(subscriptionId);
    state.subscriptionIdByConnection.set(connectionId, subscriptionId);
    state.credentialIds.set(connectionId, credentialId ?? null);
    if (onShutdown) state.shutdown.set(connectionId, onShutdown);
    if (kind === 'agent' && state.online && state.subscribers.size === 1) {
      this.#hooks.onAgentStreamOpened?.(actorId);
    }
    return {
      unsubscribe: () => {
        const current = this.#actorStreams.get(actorTopic(actorId));
        if (!current) return;
        current.subscribers.delete(connectionId);
        current.subscriptionIds.delete(subscriptionId);
        current.subscriptionIdByConnection.delete(connectionId);
        current.credentialIds.delete(connectionId);
        current.shutdown.delete(connectionId);
        if (current.subscribers.size === 0) {
          const wasOnline = current.online;
          current.online = false;
          if (wasOnline && kind === 'agent') {
            this.#hooks.onAgentLastConnectionClosed?.(actorId);
          }
        }
      },
    };
  }

  #actorStream(actorId: string, kind: ActorStreamKind): ActorStreamState {
    const topic = actorTopic(actorId);
    let state = this.#actorStreams.get(topic);
    if (!state) {
      state = {
        kind,
        subscribers: new Map(),
        subscriptionIds: new Set(),
        subscriptionIdByConnection: new Map(),
        credentialIds: new Map(),
        shutdown: new Map(),
        online: false,
        since: 0,
      };
      this.#actorStreams.set(topic, state);
    }
    return state;
  }

  #safeSend(send: (message: string) => void, message: string): void {
    try {
      send(message);
    } catch {
      // 连接已进入关闭流程；离线状态由 unsubscribe 收敛。
    }
  }

  /** 统一 stream 上线：给当前所有连接广播 login 帧。无连接时保留在线状态。 */
  loginActor(actorId: string, kind: ActorStreamKind, frame: string): HubLoginResult {
    const state = this.#actorStream(actorId, kind);
    const since = Date.now();
    state.online = true;
    state.since = since;
    for (const send of state.subscribers.values()) this.#safeSend(send, frame);
    return { online: true, since, connections: state.subscribers.size };
  }

  /** 统一 stream 发布：人类总是接收；Agent 必须在线。 */
  publishActor(actorId: string, frame: string): void {
    const state = this.#actorStreams.get(actorTopic(actorId));
    if (!state) return;
    if (state.kind === 'agent' && !state.online) return;
    for (const send of state.subscribers.values()) this.#safeSend(send, frame);
  }

  /** 统一 stream 的在线快照；有连接且已上线才算在线。 */
  actorPresence(actorId: string): HubPresence {
    const state = this.#actorStreams.get(actorTopic(actorId));
    if (!state) return { online: false, since: null };
    const online =
      state.kind === 'agent'
        ? state.online && state.subscribers.size > 0
        : state.subscribers.size > 0;
    return { online, since: online ? state.since : null };
  }

  /** 是否处于“已登录”状态；连接建立时可据此补发 login 帧。 */
  actorOnline(actorId: string): boolean {
    return this.#actorStreams.get(actorTopic(actorId))?.online === true;
  }

  actorConnectionCount(actorId: string): number {
    return this.#actorStreams.get(actorTopic(actorId))?.subscribers.size ?? 0;
  }

  /**
   * 关闭指定 credential 的全部活动 stream 连接。
   *
   * 设备撤销必须只影响该设备：同一 actor 的其他 credential 连接继续接收。
   * 返回触发的连接数。
   */
  closeByCredential(credentialId: string): number {
    let closed = 0;
    for (const state of this.#actorStreams.values()) {
      for (const [connectionId, currentCredentialId] of [...state.credentialIds]) {
        if (currentCredentialId !== credentialId) continue;
        const close = state.shutdown.get(connectionId);
        state.subscribers.delete(connectionId);
        const subscriptionId = state.subscriptionIdByConnection.get(connectionId);
        if (subscriptionId) state.subscriptionIds.delete(subscriptionId);
        state.subscriptionIdByConnection.delete(connectionId);
        state.credentialIds.delete(connectionId);
        state.shutdown.delete(connectionId);
        try {
          close?.();
          closed += 1;
        } catch {
          // 单条连接关闭失败不能阻塞其他连接收口。
        }
      }
      if (state.subscribers.size === 0) state.online = false;
    }
    return closed;
  }

  /**
   * 标记 credential 已撤销并关闭其活动连接。
   *
   * 标记必须发生在数据库撤销之后、下一次订阅尝试之前；这样撤销与建立
   * 连接并发时，迟到的旧凭据订阅也会被拒绝。
   */
  revokeCredential(credentialId: string): number {
    this.#revokedCredentials.add(credentialId);
    return this.closeByCredential(credentialId);
  }

  /**
   * 服务端关闭：对全部活动 stream 连接触发 graceful close。
   *
   * 返回触发的连接数。传输层负责发送 `resultType: "complete"` 帧；
   * hub 只保存注册的收口回调。
   */
  closeAllStreams(): number {
    let closed = 0;
    for (const state of this.#actorStreams.values()) {
      for (const close of [...state.shutdown.values()]) {
        try {
          close();
          closed += 1;
        } catch {
          // 单条连接关闭失败不能阻塞其他连接收口。
        }
      }
    }
    return closed;
  }

  /**
   * 关闭指定 actor 的全部活动 stream 连接。
   *
   * 用于凭据轮换与 Agent 停用：旧连接可能持有已撤销/已停用的凭据，
   * 不能继续接收新帧。传输层收到 graceful close 后发送 complete 帧；
   * 返回触发的连接数。
   */
  closeActorStreams(actorId: string): number {
    const state = this.#actorStreams.get(actorTopic(actorId));
    if (!state) return 0;
    let closed = 0;
    for (const close of [...state.shutdown.values()]) {
      try {
        close();
        closed += 1;
      } catch {
        // 单条连接关闭失败不能阻塞其他连接收口。
      }
    }
    return closed;
  }

  /** 统一 stream 连接统计，供健康检查与测试；actors 只统计仍有连接的 actor。 */
  streamStats(): { actors: number; connections: number; online: number } {
    let actors = 0;
    let connections = 0;
    let online = 0;
    for (const state of this.#actorStreams.values()) {
      if (state.subscribers.size === 0) continue;
      actors += 1;
      connections += state.subscribers.size;
      if (state.kind === 'agent' && state.online) online += 1;
    }
    return { actors, connections, online };
  }

  /** 测试与运维用：清空全部进程内状态。 */
  reset(): void {
    this.#actorStreams.clear();
    this.#revokedCredentials.clear();
  }
}
