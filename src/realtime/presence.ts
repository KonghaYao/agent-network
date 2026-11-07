import { BusinessError } from '../contracts/errors';
import type { Principal } from '../domain/principal';
import { taskCounts, type TaskCounts } from '../domain/tasks';
import type { Env } from '../env';
import { buildSessionLoginFrame } from './stream';

export interface LoginView {
  actor_id: string;
  online: true;
  logged_in_at: string;
  pending_count: number;
  inbox_head_seq: string;
  /** 只读任务概览；不改变 pending_count、房间 head 或未读。 */
  task_summary: TaskCounts;
}

export interface ActorPresence {
  online: boolean;
  since: number | null;
}

/**
 * Agent 显式上线。
 *
 * 上线状态只保存在统一 stream 的进程内 hub 中：最后一条连接断开时自动
 * 置为离线，因此这里只负责表达“开始接收投递”的意图。上线前排队在
 * SQLite 的 delivery 不会被删除；hub 会用当前快照补发一条 `session.login`，
 * 由 Agent 随后调用 `network_inbox_list` 读取。
 */
export async function login(env: Env, principal: Principal): Promise<LoginView> {
  const actor = principal.actor;
  if (!actor) {
    throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册；先调用 network_register');
  }
  if (actor.kind !== 'agent') {
    throw new BusinessError('INVALID_ARGUMENT', '只有 Agent 需要上线；人类身份通过网页或订阅直接读取', {
      kind: actor.kind,
    });
  }

  const taskSummary = await taskCounts(env.DB, principal);
  const presence = env.NOTIFICATION_HUB.loginActor(
    actor.actor_id,
    actor.kind,
    JSON.stringify(buildSessionLoginFrame(actor)),
  );

  // login 先于连接时，等连接建立后由 hub 的 onAgentStreamOpened 补记；
  // 已有连接时在这里等待持久化时间线写入。写入失败不影响 login 结果。
  if (presence.connections > 0) {
    await env.PRESENCE?.recordLogin(actor.actor_id);
  }

  return {
    actor_id: actor.actor_id,
    online: true,
    logged_in_at: String(presence.since),
    pending_count: actor.pending_count,
    inbox_head_seq: String(actor.inbox_head_seq),
    task_summary: taskSummary,
  };
}

/**
 * 读取 Agent 的在线快照。
 *
 * “在线”是可用性：SSE 连接/已登录的 hub 状态，或最近 TTL 内有任意已认证
 * MCP 请求（持久化在 agent_presence_state 的 online/pending_offline）。
 * pending 仍算在线，确认下线前不制造闪烁。人类成员不查询在线状态；
 * hub/数据库查询失败返回 `null`，表示“未知”。调用方必须把 `null` 与
 * `false`（明确离线）区分开，不能把未知误报成离线。
 */
export async function presenceOf(env: Env, actorId: string): Promise<ActorPresence | null> {
  try {
    const hub = env.NOTIFICATION_HUB.actorPresence(actorId);
    if (hub.online || env.NOTIFICATION_HUB.actorConnectionCount(actorId) > 0) {
      return { online: true, since: hub.since };
    }
    if (!env.PRESENCE) return hub;
    const phase = await env.PRESENCE.phaseOf(actorId);
    const online = phase === 'online' || phase === 'pending_offline';
    return { online, since: null };
  } catch {
    return null;
  }
}
