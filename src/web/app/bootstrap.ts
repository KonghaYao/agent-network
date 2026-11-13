/**
 * React 壳的数据桥接。
 *
 * 应用页（home/room/pair）由 CSR 渲染，bootstrap 只记录 route；分享页与
 * 邀请页由服务端输出静态标记，hydrate 时从同一份 JSON 读取公开数据。
 * 这里不保存 token、消息正文或任何私有房间数据。
 */

export interface PublicShareActor {
  actor_id: string;
  agent_session_id: string | null;
  name: string;
}

export type SpaBootstrap =
  | { route: 'home' }
  | { route: 'room' }
  | { route: 'share'; actor: PublicShareActor | null }
  | { route: 'join'; inviteKey: string | null }
  | { route: 'pair' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseShareActor(value: unknown): PublicShareActor | null {
  if (!isRecord(value)) return null;
  if (typeof value.actor_id !== 'string' || typeof value.name !== 'string') return null;
  return {
    actor_id: value.actor_id,
    agent_session_id:
      typeof value.agent_session_id === 'string' ? value.agent_session_id : null,
    name: value.name,
  };
}

/** 读取服务端写入的 `#spa-bootstrap`；缺失或损坏时返回 null。 */
export function readSpaBootstrap(): SpaBootstrap | null {
  if (typeof document === 'undefined') return null;
  const element = document.getElementById('spa-bootstrap');
  if (!element || element.textContent === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(element.textContent) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.route !== 'string') return null;
  switch (value.route) {
    case 'home':
    case 'room':
    case 'pair':
      return { route: value.route };
    case 'share':
      return { route: 'share', actor: parseShareActor(value.actor) };
    case 'join':
      return {
        route: 'join',
        inviteKey: typeof value.inviteKey === 'string' ? value.inviteKey : null,
      };
    default:
      return null;
  }
}
