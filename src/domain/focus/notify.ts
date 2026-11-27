/**
 * `focus_updated` 提示：只写 actor scope 事件与 outbox。
 *
 * 不写 inbox、不增加 `pending_count`、不推进 `head_seq`、不产生 delivery；
 * 卡主刷新看板即可拿到新快照。event_key 由业务代次/事项决定，重放不重复。
 */

import { FOCUS_UPDATED_EVENT } from '../../contracts/events';
import { actorTopic, eventStatementIfAbsent, outboxStatementIfAbsent } from '../../storage/events';

export type FocusUpdatedChange = 'enabled' | 'resumed' | 'paused' | 'archived';

export interface FocusUpdatedSpec {
  ownerActorId: string;
  change: FocusUpdatedChange;
  /** 归档提示指向事项；绑定状态变化为 null。 */
  itemId?: string | null;
  version?: number | null;
  generation?: number | null;
  eventKey: string;
  at: number;
}

export function focusUpdatedStatements(
  db: D1Database,
  spec: FocusUpdatedSpec,
): D1PreparedStatement[] {
  const refId = spec.itemId ?? null;
  const metadata: Record<string, unknown> = {
    owner_actor_id: spec.ownerActorId,
    change: spec.change,
    ref_id: refId,
  };
  if (spec.itemId) metadata.item_id = spec.itemId;
  if (spec.version !== undefined && spec.version !== null) metadata.version = spec.version;
  if (spec.generation !== undefined && spec.generation !== null) {
    metadata.generation = spec.generation;
  }
  return [
    eventStatementIfAbsent(
      db,
      {
        eventKey: spec.eventKey,
        scopeKind: 'actor',
        scopeId: spec.ownerActorId,
        eventType: FOCUS_UPDATED_EVENT,
        refId,
        metadata,
      },
      spec.at,
    ),
    outboxStatementIfAbsent(
      db,
      { topic: actorTopic(spec.ownerActorId), eventKey: spec.eventKey },
      spec.at,
    ),
  ];
}
