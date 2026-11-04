import type { ActorRow, CredentialRow } from '../storage/rows';

export interface Principal {
  /** 当前请求凭据的 SHA-256 hash；不保存原文。 */
  credentialHash: string;
  /** 已注册凭据对应的 actor；未注册凭据为 undefined。 */
  actor: ActorRow | null;
  credential: CredentialRow | null;
}

export function actorId(principal: Principal): string {
  if (!principal.actor) {
    throw new Error('principal has no registered actor');
  }
  return principal.actor.actor_id;
}

export function actorResources(_actorIdValue: string): string[] {
  // cutover 后每个 actor 只有统一 stream；旧 URI 已删除且不再返回。
  return ['agentnet://stream'];
}
