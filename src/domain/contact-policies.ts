import { BusinessError } from '../contracts/errors';
import type { ContactPolicyGetInput, ContactPolicySetInput } from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { getActor } from '../storage/queries';
import type { ActorRow, ContactReceivePolicyRow, ContactRequestRow } from '../storage/rows';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { getActiveManagement, managementAccess } from './agent-access';
import { actorId, type Principal } from './principal';

/**
 * 好友接收策略。
 *
 * 未显式设置时：human 自确认；有 active manager 的 Agent 由管理者确认；
 * 无管理者 Agent 自行确认。`auto_accept` 必须显式设置，不会因
 * `kind = agent` 自动生效。
 */

export type ContactReceivePolicy = 'self_approval' | 'manager_approval' | 'auto_accept';

export interface ContactPolicyView {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
  policy: ContactReceivePolicy;
  configured: boolean;
  approver_actor_id: string | null;
  approver_name: string | null;
}

export interface EffectiveContactPolicy {
  policy: ContactReceivePolicy;
  configured: boolean;
  approver: ActorRow | null;
}

export async function effectivePolicy(
  db: D1Database,
  target: ActorRow,
  at: number,
): Promise<EffectiveContactPolicy> {
  const configured = await db
    .prepare('SELECT * FROM contact_receive_policies WHERE actor_id = ?')
    .bind(target.actor_id)
    .first<ContactReceivePolicyRow>();
  if (configured) {
    if (configured.policy === 'auto_accept') {
      return { policy: 'auto_accept', configured: true, approver: null };
    }
    if (configured.policy === 'manager_approval' && target.kind === 'agent') {
      const management = await getActiveManagement(db, target.actor_id);
      if (management) {
        const approver = await getActor(db, management.manager_id);
        if (approver) {
          return { policy: 'manager_approval', configured: true, approver };
        }
      }
      // 管理者已撤销时回落到 Agent 自确认，避免申请永久卡死。
      return { policy: 'self_approval', configured: true, approver: target };
    }
    return { policy: 'self_approval', configured: true, approver: target };
  }

  if (target.kind === 'human') {
    return { policy: 'self_approval', configured: false, approver: target };
  }
  const management = await getActiveManagement(db, target.actor_id);
  if (management) {
    const approver = await getActor(db, management.manager_id);
    if (approver) {
      return { policy: 'manager_approval', configured: false, approver };
    }
  }
  return { policy: 'self_approval', configured: false, approver: target };
}

/** 申请目标或其管理者/受托人可以接受或拒绝；发起者永远不能自批。 */
export async function canHandleRequest(
  db: D1Database,
  viewer: string,
  request: ContactRequestRow,
  target: ActorRow,
  at: number,
): Promise<boolean> {
  if (viewer === request.from_actor_id) return false;
  const policy = await effectivePolicy(db, target, at);
  if (policy.policy === 'manager_approval') {
    const access = await managementAccess(db, viewer, target.actor_id, at);
    return access?.canManage === true;
  }
  if (policy.policy === 'auto_accept') {
    // 自动接受是目标的预先同意，不能让发起者自批；但目标或管理者仍可
    // 处理策略切换前遗留的 pending，避免申请无人可动只能等到过期。
    if (viewer === target.actor_id) return true;
    if (target.kind === 'agent') {
      const access = await managementAccess(db, viewer, target.actor_id, at);
      return access?.canManage === true;
    }
    return false;
  }
  return viewer === target.actor_id;
}

export async function canRespond(
  db: D1Database,
  viewer: string,
  request: ContactRequestRow,
  target: ActorRow,
  at: number,
): Promise<boolean> {
  if (request.status !== 'pending') return false;
  return canHandleRequest(db, viewer, request, target, at);
}

async function policyTarget(
  db: D1Database,
  viewer: string,
  actorIdInput: string | undefined,
): Promise<ActorRow> {
  const target = actorIdInput ? await getActor(db, actorIdInput) : await getActor(db, viewer);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  return target;
}

async function requirePolicyAccess(
  db: D1Database,
  viewer: string,
  target: ActorRow,
  at: number,
): Promise<void> {
  if (viewer === target.actor_id) return;
  if (target.kind === 'agent') {
    const access = await managementAccess(db, viewer, target.actor_id, at);
    if (access?.canManage) return;
  }
  throw new BusinessError('PERMISSION_DENIED', '当前身份不能读取或修改该接收策略');
}

function policyView(
  target: ActorRow,
  effective: EffectiveContactPolicy,
): ContactPolicyView {
  return {
    actor_id: target.actor_id,
    name: target.name,
    kind: target.kind,
    policy: effective.policy,
    configured: effective.configured,
    approver_actor_id: effective.approver?.actor_id ?? null,
    approver_name: effective.approver?.name ?? null,
  };
}

export async function contactPolicyGet(
  db: D1Database,
  principal: Principal,
  input: ContactPolicyGetInput,
): Promise<ContactPolicyView> {
  const viewer = actorId(principal);
  const at = nowMs();
  const target = await policyTarget(db, viewer, input.actor_id);
  await requirePolicyAccess(db, viewer, target, at);
  return policyView(target, await effectivePolicy(db, target, at));
}

export async function contactPolicySet(
  db: D1Database,
  principal: Principal,
  input: ContactPolicySetInput,
): Promise<ContactPolicyView> {
  const viewer = actorId(principal);
  const caller = principal.actor ?? (await getActor(db, viewer));
  if (!caller || caller.kind !== 'human') {
    throw new BusinessError('INVALID_ARGUMENT', '只有人类管理者可以修改接收策略');
  }
  const target = await policyTarget(db, viewer, input.actor_id);
  if (target.kind === 'human' && viewer !== target.actor_id) {
    throw new BusinessError('PERMISSION_DENIED', '不能修改其他人类的接收策略');
  }
  if (target.kind === 'human' && input.policy === 'manager_approval') {
    throw new BusinessError('INVALID_ARGUMENT', '人类没有管理者，不能使用 manager_approval');
  }
  const at = nowMs();
  await requirePolicyAccess(db, viewer, target, at);
  // 预计算写入后的完整视图并作为幂等结果保存，避免重放只返回半截对象。
  let effective: EffectiveContactPolicy;
  if (input.policy === 'auto_accept') {
    effective = { policy: 'auto_accept', configured: true, approver: null };
  } else if (input.policy === 'manager_approval') {
    const management = await getActiveManagement(db, target.actor_id);
    const approver = management ? await getActor(db, management.manager_id) : null;
    effective = approver
      ? { policy: 'manager_approval', configured: true, approver }
      : { policy: 'self_approval', configured: true, approver: target };
  } else {
    effective = { policy: 'self_approval', configured: true, approver: target };
  }
  const result = policyView(target, effective);
  const payloadHash = await sha256Hex(stableStringify(input));
  await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          `INSERT INTO contact_receive_policies (actor_id, policy, updated_by, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(actor_id) DO UPDATE SET
             policy = excluded.policy,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(target.actor_id, input.policy, viewer, at),
    ],
  });
  return policyView(target, await effectivePolicy(db, target, at));
}
