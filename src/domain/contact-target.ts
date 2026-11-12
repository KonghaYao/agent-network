/**
 * 好友相关入口的目标 actor 解析。
 *
 * `actor_id` 与 `agent_session_id` 必须且只能提供一个；错误码、文案与判定顺序
 * 与拆分前的两份实现完全一致。`contact-relations` 仍保留同名导出作为 facade，
 * 避免调用方改动。
 */

import { BusinessError } from '../contracts/errors';
import { getActor, getActorBySession, type D1Like } from '../storage/queries';
import type { ActorRow } from '../storage/rows';

export interface ContactTargetInput {
  actor_id?: string;
  agent_session_id?: string;
}

export async function resolveContactTarget(
  db: D1Like,
  input: ContactTargetInput,
): Promise<ActorRow> {
  const hasId = typeof input.actor_id === 'string';
  const hasSession = typeof input.agent_session_id === 'string';
  if (hasId === hasSession) {
    throw new BusinessError('INVALID_ARGUMENT', 'actor_id 与 agent_session_id 必须且只能提供一个');
  }
  const actor = hasId
    ? await getActor(db, input.actor_id as string)
    : await getActorBySession(db, input.agent_session_id as string);
  if (!actor) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  return actor;
}
