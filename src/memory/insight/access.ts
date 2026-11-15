/**
 * 只读 Agent 记忆的授权与目标解析。
 *
 * 策略是显式的跨 actor 读取：
 * - Agent 只能看自己；
 * - human 必须是目标 Agent 的好友，或与它共享至少一个未解散房间。
 *
 * 管理关系与 `manage_agent` 委托都不参与授权；“能管理 Agent”不等于“能读
 * 正文”。权限每次调用都重新查 SQLite，不依赖客户端缓存或 UI 隐藏。
 */
import { BusinessError } from '../../contracts/errors';
import { sortedPairKey } from '../../storage/db';
import {
  getActiveContactRelation,
  getActor,
  getActiveMemorySpace,
  sharesActiveRoom,
  type D1Like,
} from '../../storage/queries';
import type { ActorRow } from '../../storage/rows';
import type { MemorySpaceRow } from '../rows';
import type { InsightView, InsightViewer } from './contracts';

export type InsightRelation = 'self' | 'friend' | 'shared_room';

export interface InsightTarget {
  actor: ActorRow;
  relation: InsightRelation;
}

/** 目标必须存在且是 agent；人类或未知 actor 不进入 Hindsight 映射。 */
export async function resolveInsightTarget(
  db: D1Like,
  targetActorId: string,
): Promise<ActorRow> {
  const actor = await getActor(db, targetActorId);
  if (!actor) throw new BusinessError('NOT_FOUND', 'Agent 不存在');
  if (actor.kind !== 'agent') {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'Memory insight 目标必须是 agent actor', {
      reason: 'not_agent',
    });
  }
  return actor;
}

export async function authorizeInsightViewer(
  db: D1Like,
  viewer: InsightViewer,
  target: ActorRow,
): Promise<InsightRelation> {
  if (viewer.kind === 'agent') {
    if (viewer.actor_id === target.actor_id) return 'self';
    throw new BusinessError('PERMISSION_DENIED', 'Agent 只能查看自己的记忆', {
      reason: 'forbidden',
      insight_code: 'FORBIDDEN',
    });
  }
  const relation = await getActiveContactRelation(
    db,
    sortedPairKey(viewer.actor_id, target.actor_id),
  );
  if (relation) return 'friend';
  if (await sharesActiveRoom(db, viewer.actor_id, target.actor_id)) return 'shared_room';
  throw new BusinessError('PERMISSION_DENIED', '无权查看该 Agent 的记忆', {
    reason: 'forbidden',
    insight_code: 'FORBIDDEN',
  });
}

export async function loadInsightSpace(
  db: D1Like,
  targetActorId: string,
): Promise<MemorySpaceRow | null> {
  return getActiveMemorySpace(db, targetActorId);
}

/**
 * 跨 Agent 查看的结构化审计日志。
 *
 * 只记录谁看了谁、看哪个视图、结果；不记录正文、bank、URL 或凭据。
 */
export function auditInsightAccess(input: {
  viewer: InsightViewer;
  targetActorId: string;
  view: InsightView;
  result: 'ok' | 'denied' | 'unavailable' | 'error';
}): void {
  if (input.viewer.actor_id === input.targetActorId) return;
  console.info(
    JSON.stringify({
      event: 'agent_network.memory_insight.access',
      viewer_actor_id: input.viewer.actor_id,
      target_actor_id: input.targetActorId,
      view: input.view,
      result: input.result,
    }),
  );
}
