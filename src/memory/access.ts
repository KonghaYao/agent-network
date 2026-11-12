/**
 * MF02：Agent Memory 空间归属与当前权限。
 *
 * 本模块只做两件事：
 * 1. 把 actors/agent_managements/rooms/room_members 的当前状态翻译成
 *    MemorySpace + ownership/backend epoch + access versions。
 * 2. 对来源读取与目的披露做同时校验，避免“能管理 Agent”被误当成“能读
 *    第三方私聊正文”，也避免 from_join/归档上界只在列表入口生效。
 *
 * 稳定规则：
 * - space 跟 actor_id，不和 token/device/session/name 绑定；
 * - ownership_epoch 只在认领/管理转让时递增；普通 permission_version 修订
 *   不重建空间；
 * - `agent_managements.binding_id` 可能在转让时原地保留，判断归属必须看
 *   owner_actor_id + ownership_epoch；
 * - 旧 owner 的正文不会自动交给新 owner；manager 权限不绕过来源 ACL。
 */
import { BusinessError } from '../contracts/errors';
import { getActiveManagement } from '../domain/agent-access';
import {
  historyBoundary,
  visibleCreated,
  type HistoryBoundary,
} from '../domain/room-history';
import { getActor, getMember, getRoom, type D1Like } from '../storage/queries';
import type { ActorRow, AgentManagementRow, RoomMemberRow, RoomRow } from '../storage/rows';
import { newId, nowMs } from '../storage/db';
import {
  canDiscloseOrigin,
  type MemoryAccessVersions,
  type MemoryCrossRoomGrant,
  type MemoryDisclosureDecision,
  type MemoryOriginScope,
  type MemoryOwnershipKind,
  type MemoryRoomAccessVersion,
  type MemorySourceRef,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import type { MemoryRepresentationRow, MemorySourceRow, MemorySpaceRow } from './rows';

export interface MemoryOwnerResolution {
  owner_actor_id: string;
  ownership_kind: MemoryOwnershipKind;
  management_binding_id: string | null;
  management_permission_version: number | null;
}

export interface MemorySpaceContext {
  space: MemorySpaceRow;
  agent: ActorRow;
  management: AgentManagementRow | null;
  versions: MemoryAccessVersions;
}

export interface MemorySourceAccessOptions {
  space: MemorySpaceRef;
  source: MemorySourceRow;
  agentId: string;
  target_scope?: MemoryTargetScope | null;
  grant?: MemoryCrossRoomGrant | null;
  at?: number;
}

export type MemorySourceAccessReason =
  | MemoryDisclosureDecision['reason']
  | 'tombstoned'
  | 'source_not_active'
  | 'history_bound'
  | 'ownership_changed'
  | 'agent_disabled';

export interface MemorySourceAccessDecision {
  allowed: boolean;
  reason: MemorySourceAccessReason;
  source_revision: number;
}

export interface MemoryRepresentationAccessOptions {
  space: MemorySpaceRef;
  representationId: string;
  agentId: string;
  target_scope?: MemoryTargetScope | null;
  grant?: MemoryCrossRoomGrant | null;
  at?: number;
}

export interface MemoryRepresentationAccessDecision {
  allowed: boolean;
  reason:
    | 'eligible'
    | 'tombstoned'
    | 'source_missing'
    | 'source_not_active'
    | 'membership_stale'
    | 'history_bound'
    | 'policy_changed'
    | 'invalid_target'
    | 'ownership_changed'
    | 'agent_disabled';
  denied_source_ids: readonly string[];
}

/** 当前管理关系决定 owner；没有 active management 的 Agent 使用 self_owned。 */
export function resolveCurrentOwner(
  agentId: string,
  management: AgentManagementRow | null,
): MemoryOwnerResolution {
  if (management) {
    return {
      owner_actor_id: management.manager_id,
      ownership_kind: 'managed',
      management_binding_id: management.binding_id,
      management_permission_version: management.permission_version,
    };
  }
  return {
    owner_actor_id: agentId,
    ownership_kind: 'self_owned',
    management_binding_id: null,
    management_permission_version: null,
  };
}

export function spaceMatchesOwner(
  space: Pick<MemorySpaceRow, 'owner_actor_id' | 'ownership_kind'>,
  resolution: MemoryOwnerResolution,
): boolean {
  return (
    space.owner_actor_id === resolution.owner_actor_id &&
    space.ownership_kind === resolution.ownership_kind
  );
}

/**
 * 稳定 instance id。
 *
 * 已有 `memory_instances` 行时绝不静默新建第二个 namespace：配置值变化必须
 * 显式迁移空间，否则会让同一 Agent 的归属空间分裂。
 */
export async function ensureMemoryInstance(
  db: D1Like,
  options: { configuredId?: string | null; now?: number; captureDefault?: 'enabled' | 'disabled' },
): Promise<string> {
  const at = options.now ?? nowMs();
  const configured = options.configuredId?.trim() || null;
  const existing = await db
    .prepare('SELECT instance_id, capture_default FROM memory_instances LIMIT 1')
    .first<{ instance_id: string; capture_default: 'enabled' | 'disabled' }>();
  if (existing) {
    if (configured && configured !== existing.instance_id) {
      throw new BusinessError('MEMORY_UNAVAILABLE', 'Memory instance 已初始化，配置值与现有 namespace 不一致', {
        reason: 'instance_conflict',
      });
    }
    return existing.instance_id;
  }
  const instanceId = configured ?? newId('mni');
  await db
    .prepare(
      `INSERT INTO memory_instances (instance_id, capture_default, created_at, updated_at)
       SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM memory_instances)`,
    )
    .bind(instanceId, options.captureDefault ?? 'enabled', at, at)
    .run();
  const stored = await db
    .prepare('SELECT instance_id FROM memory_instances LIMIT 1')
    .first<{ instance_id: string }>();
  if (!stored) throw new BusinessError('MEMORY_UNAVAILABLE', 'Memory instance 初始化失败');
  return stored.instance_id;
}

export async function loadActiveMemorySpace(
  db: D1Like,
  agentId: string,
): Promise<MemorySpaceRow | null> {
  return db
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(agentId)
    .first<MemorySpaceRow>();
}

async function requireAgentActor(db: D1Like, agentId: string): Promise<ActorRow> {
  const actor = await getActor(db, agentId);
  if (!actor) throw new BusinessError('NOT_FOUND', 'Agent 不存在');
  if (actor.kind !== 'agent') {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'Memory 目标必须是 agent actor', {
      reason: 'not_agent',
    });
  }
  return actor;
}

/**
 * 首次启用按“当前”有效管理关系初始化；已有 Agent 的旧创建者不参与判断。
 *
 * 如果检测到活动空间仍属于旧 owner（例如旧进程未执行转让 hook），本函数
 * 会在同一 batch 中关闭旧绑定并切到新空间。正常业务路径应在转让事务内
 * 调用 statements 版本，避免出现这个兜底窗口。
 */
export async function ensureAgentMemorySpace(
  db: D1Like,
  options: {
    agentId: string;
    instanceId: string;
    now?: number;
    spaceId?: string;
    transitionId?: string;
    capture?: 'none' | 'pending' | 'excluded';
  },
): Promise<MemorySpaceRow> {
  const at = options.now ?? nowMs();
  const agent = await requireAgentActor(db, options.agentId);
  const management = await getActiveManagement(db, options.agentId);
  const owner = resolveCurrentOwner(options.agentId, management);
  const active = await loadActiveMemorySpace(db, options.agentId);
  if (active && active.instance_id === options.instanceId && spaceMatchesOwner(active, owner)) {
    return active;
  }

  const previous = active;
  const nextEpoch = previous ? previous.ownership_epoch + 1 : 1;
  const nextSpaceId = options.spaceId ?? newId('msp');
  const transitionId = options.transitionId ?? newId('mtr');
  const kind = previous ? 'management_transfer' : management ? 'initial_enable' : 'initial_enable';
  const capture = options.capture ?? (agent.disabled_at === null ? 'pending' : 'none');

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_instances (instance_id, capture_default, created_at, updated_at)
         SELECT ?, 'enabled', ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM memory_instances)`,
      )
      .bind(options.instanceId, at, at),
  ];
  if (previous) {
    statements.push(
      db
        .prepare(
          `UPDATE memory_spaces
              SET active = 0,
                  capture = CASE WHEN capture = 'excluded' THEN 'excluded' ELSE 'none' END,
                  updated_at = ?
            WHERE space_id = ? AND active = 1`,
        )
        .bind(at, previous.space_id),
      db
        .prepare(
          `UPDATE memory_host_bindings
              SET state = 'closed', closed_at = ?, updated_at = ?
            WHERE space_id = ? AND state = 'active'`,
        )
        .bind(at, at, previous.space_id),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO memory_spaces
           (space_id, instance_id, agent_actor_id, owner_actor_id, ownership_kind,
            ownership_epoch, backend_binding_epoch, management_binding_id, capture, active,
            created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_spaces WHERE agent_actor_id = ? AND active = 1
          )`,
      )
      .bind(
        nextSpaceId,
        options.instanceId,
        options.agentId,
        owner.owner_actor_id,
        owner.ownership_kind,
        nextEpoch,
        owner.management_binding_id,
        capture,
        at,
        at,
        options.agentId,
      ),
    db
      .prepare(
        `INSERT INTO memory_space_transitions
           (transition_id, space_id, previous_space_id, agent_actor_id, kind,
            previous_owner_actor_id, next_owner_actor_id, previous_ownership_epoch,
            next_ownership_epoch, closed_host_binding_ids, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_space_transitions
             WHERE agent_actor_id = ? AND next_ownership_epoch = ?
          )`,
      )
      .bind(
        transitionId,
        nextSpaceId,
        previous?.space_id ?? null,
        options.agentId,
        kind,
        previous?.owner_actor_id ?? null,
        owner.owner_actor_id,
        previous?.ownership_epoch ?? 0,
        nextEpoch,
        at,
        options.agentId,
        nextEpoch,
      ),
  );
  await db.batch(statements);
  const stored = await loadActiveMemorySpace(db, options.agentId);
  if (!stored) throw new BusinessError('MEMORY_UNAVAILABLE', 'Memory space 初始化失败');
  if (stored.instance_id !== options.instanceId) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'Memory space 属于其他 instance', {
      reason: 'instance_mismatch',
    });
  }
  return stored;
}

export function assertAgentExecutionAllowed(agent: Pick<ActorRow, 'actor_id' | 'disabled_at'>): void {
  if (agent.disabled_at !== null) {
    throw new BusinessError('ACTOR_DISABLED', 'Agent 已停用，不能执行 Memory 查询或绑定', {
      actor_id: agent.actor_id,
    });
  }
}

/**
 * 每次查询都重验当前管理关系；不能只靠后台 worker 稍后失效。
 */
export async function requireCurrentMemorySpace(
  db: D1Like,
  options: {
    agentId: string;
    instanceId: string;
    expected?: MemorySpaceRef | null;
    roomIds?: readonly string[];
    at?: number;
  },
): Promise<MemorySpaceContext> {
  const agent = await requireAgentActor(db, options.agentId);
  assertAgentExecutionAllowed(agent);
  const management = await getActiveManagement(db, options.agentId);
  const owner = resolveCurrentOwner(options.agentId, management);
  const space = await ensureAgentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    now: options.at,
  });
  if (!spaceMatchesOwner(space, owner)) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'Memory 归属已变化，请重新获取空间', {
      reason: 'ownership_changed',
      space_id: space.space_id,
    });
  }
  if (options.expected) {
    if (
      options.expected.space_id !== space.space_id ||
      options.expected.ownership_epoch !== space.ownership_epoch ||
      options.expected.backend_binding_epoch !== space.backend_binding_epoch
    ) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'Memory 空间或代次已过期', {
        reason: 'space_epoch_stale',
        space_id: space.space_id,
        ownership_epoch: String(space.ownership_epoch),
        backend_binding_epoch: String(space.backend_binding_epoch),
      });
    }
  }
  const versions = await loadMemoryAccessVersions(db, {
    agentId: options.agentId,
    management,
    credentialRevokedAt: null,
    roomIds: options.roomIds ?? [],
  });
  return { space, agent, management, versions };
}

export async function roomAccessVersion(
  db: D1Like,
  roomId: string,
  agentId: string,
): Promise<MemoryRoomAccessVersion | null> {
  const room = await getRoom(db, roomId);
  if (!room) return null;
  const member = await getMember(db, roomId, agentId);
  if (!member || member.status !== 'active') return null;
  return {
    room_id: roomId,
    member_generation: member.member_generation,
    member_seq: room.member_seq,
    policy_revision: room.policy_revision,
    joined_seq: member.joined_seq,
    joined_at: member.joined_at,
    archive_head_seq: room.archive_head_seq,
  };
}

export async function loadMemoryAccessVersions(
  db: D1Like,
  options: {
    agentId: string;
    management: AgentManagementRow | null;
    credentialRevokedAt: number | null;
    roomIds: readonly string[];
  },
): Promise<MemoryAccessVersions> {
  const rooms: MemoryRoomAccessVersion[] = [];
  for (const roomId of [...new Set(options.roomIds)]) {
    const version = await roomAccessVersion(db, roomId, options.agentId);
    if (version) rooms.push(version);
  }
  return {
    actor_disabled_at: null,
    credential_revoked_at: options.credentialRevokedAt,
    management_binding_id: options.management?.binding_id ?? '',
    management_permission_version: options.management?.permission_version ?? 0,
    rooms,
  };
}

export async function loadRoomHistoryBoundary(
  db: D1Like,
  roomId: string,
  agentId: string,
): Promise<HistoryBoundary | null> {
  const room = await getRoom(db, roomId);
  if (!room) return null;
  const member = await getMember(db, roomId, agentId);
  if (!member || member.status !== 'active') return null;
  return historyBoundary(room, member);
}

export function sourceOriginScope(source: MemorySourceRow): MemoryOriginScope | null {
  if (!source.origin_room_id) return null;
  return {
    room_id: source.origin_room_id,
    member_generation: source.origin_member_generation,
    policy_revision: source.origin_policy_revision,
    joined_seq: source.origin_joined_seq,
    joined_at: source.origin_joined_at,
    archive_head_seq: source.origin_archive_head_seq,
  };
}

export async function isTombstoned(
  db: D1Like,
  target: { kind: string; id: string } | { sourceKey: string },
): Promise<boolean> {
  if ('sourceKey' in target) {
    const row = await db
      .prepare(
        "SELECT 1 AS hit FROM memory_tombstones WHERE source_key = ? AND target_kind IN ('source_key','source') LIMIT 1",
      )
      .bind(target.sourceKey)
      .first<{ hit: number }>();
    return row !== null;
  }
  const row = await db
    .prepare('SELECT 1 AS hit FROM memory_tombstones WHERE target_kind = ? AND target_id = ? LIMIT 1')
    .bind(target.kind, target.id)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * 来源读取 = “Agent 能读” × “可向目的受众披露”。
 *
 * 调用方传入的 caller 不能扩大范围：manager 只影响管理设置，不改变本函数
 * 内的成员资格、历史边界与来源状态判断。
 */
export async function authorizeSourceRead(
  db: D1Like,
  options: MemorySourceAccessOptions,
): Promise<MemorySourceAccessDecision> {
  const source = options.source;
  const deny = (reason: MemorySourceAccessDecision['reason']): MemorySourceAccessDecision => ({
    allowed: false,
    reason,
    source_revision: source.revision,
  });

  const actor = await getActor(db, options.agentId);
  if (!actor || actor.kind !== 'agent' || actor.disabled_at !== null) {
    return deny('agent_disabled');
  }
  const management = await getActiveManagement(db, options.agentId);
  const currentOwner = management?.manager_id ?? options.agentId;
  const activeSpace = await loadActiveMemorySpace(db, options.agentId);
  if (
    !activeSpace ||
    activeSpace.space_id !== options.space.space_id ||
    activeSpace.ownership_epoch !== options.space.ownership_epoch ||
    activeSpace.owner_actor_id !== currentOwner
  ) {
    return deny('ownership_changed');
  }
  if (source.state !== 'active') return deny('source_not_active');
  if (await isTombstoned(db, { kind: 'source', id: source.source_id })) return deny('tombstoned');
  if (source.source_key && (await isTombstoned(db, { sourceKey: source.source_key }))) {
    return deny('tombstoned');
  }

  if (!source.origin_room_id) {
    // manual/imported 来源只属于当前空间；其他来源没有房间定位时不能读取。
    const allowed = source.source_kind === 'manual';
    return allowed
      ? { allowed: true, reason: 'agent_private', source_revision: source.revision }
      : deny('invalid_target');
  }

  const room = await getRoom(db, source.origin_room_id);
  const member = room ? await getMember(db, source.origin_room_id, options.agentId) : null;
  if (!room || !member || member.status !== 'active') return deny('membership_stale');
  if (member.member_generation !== source.origin_member_generation) {
    return deny('membership_stale');
  }
  const boundary = historyBoundary(room, member);
  if (
    !visibleCreated(
      { created_seq: source.origin_seq, created_at: source.origin_created_at },
      boundary,
    )
  ) {
    return deny('history_bound');
  }
  if (boundary.policyRevision !== source.origin_policy_revision) {
    return deny('policy_changed');
  }

  const origin: MemoryOriginScope = {
    room_id: source.origin_room_id,
    member_generation: source.origin_member_generation,
    policy_revision: source.origin_policy_revision,
    joined_seq: source.origin_joined_seq,
    joined_at: source.origin_joined_at,
    archive_head_seq: source.origin_archive_head_seq,
  };
  if (options.target_scope) {
    const disclosure = canDiscloseOrigin(origin, options.target_scope, options.grant ?? null);
    if (!disclosure.allowed) {
      return {
        allowed: false,
        reason: disclosure.reason,
        source_revision: source.revision,
      };
    }
    if (options.target_scope.audience === 'room' && options.target_scope.room_id) {
      const targetRoom = await getRoom(db, options.target_scope.room_id);
      const targetMember = targetRoom
        ? await getMember(db, options.target_scope.room_id, options.agentId)
        : null;
      if (
        !targetRoom ||
        !targetMember ||
        targetMember.status !== 'active' ||
        targetMember.member_generation !== options.target_scope.member_generation ||
        targetRoom.policy_revision !== options.target_scope.policy_revision
      ) {
        return deny('membership_stale');
      }
      if (
        options.target_scope.member_seq !== null &&
        targetRoom.member_seq !== options.target_scope.member_seq
      ) {
        return deny('invalid_target');
      }
    }
  }
  return { allowed: true, reason: 'same_origin_room', source_revision: source.revision };
}

async function requireSourceRevision(
  db: D1Like,
  source: MemorySourceRef,
): Promise<MemorySourceRow | null> {
  return db
    .prepare('SELECT * FROM memory_sources WHERE source_id = ? AND revision = ?')
    .bind(source.source_id, source.source_revision)
    .first<MemorySourceRow>();
}

async function collectDependencies(
  db: D1Like,
  representationId: string,
): Promise<{ sourceIds: Set<string>; representationIds: Set<string>; unavailable: boolean }> {
  const sourceIds = new Set<string>();
  const representationIds = new Set<string>();
  const queue = [representationId];
  const seen = new Set<string>();
  let unavailable = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 64) {
      unavailable = true;
      break;
    }
    const representation = await db
      .prepare('SELECT source_id FROM memory_representations WHERE representation_id = ?')
      .bind(current)
      .first<Pick<MemoryRepresentationRow, 'source_id'>>();
    if (!representation) {
      unavailable = true;
      continue;
    }
    if (representation.source_id) sourceIds.add(representation.source_id);
    const dependencies = await db
      .prepare(
        'SELECT source_id, depends_on_representation_id FROM memory_representation_dependencies WHERE representation_id = ?',
      )
      .bind(current)
      .all<{ source_id: string; depends_on_representation_id: string | null }>();
    for (const dependency of dependencies.results) {
      sourceIds.add(dependency.source_id);
      if (dependency.depends_on_representation_id) {
        representationIds.add(dependency.depends_on_representation_id);
        queue.push(dependency.depends_on_representation_id);
      }
    }
  }
  return { sourceIds, representationIds, unavailable };
}

/**
 * 派生物读取沿依赖逐项重验当前来源 ACL。
 *
 * from_join 与归档上界对 summary/context/observation 同样生效；不能因为
 * 摘要已经生成、模型已经引用过就绕过当前成员代次和策略版本。
 */
export async function authorizeRepresentationRead(
  db: D1Like,
  options: MemoryRepresentationAccessOptions,
): Promise<MemoryRepresentationAccessDecision> {
  const representation = await db
    .prepare('SELECT * FROM memory_representations WHERE representation_id = ?')
    .bind(options.representationId)
    .first<MemoryRepresentationRow>();
  if (!representation) {
    return { allowed: false, reason: 'source_missing', denied_source_ids: [] };
  }
  if (await isTombstoned(db, { kind: 'representation', id: options.representationId })) {
    return { allowed: false, reason: 'tombstoned', denied_source_ids: [] };
  }
  const dependencies = await collectDependencies(db, options.representationId);
  if (dependencies.unavailable) {
    return { allowed: false, reason: 'invalid_target', denied_source_ids: [] };
  }
  if (representation.source_id) dependencies.sourceIds.add(representation.source_id);
  const denied: string[] = [];
  let deniedReason: MemoryRepresentationAccessDecision['reason'] | null = null;
  for (const sourceId of dependencies.sourceIds) {
    if (await isTombstoned(db, { kind: 'source', id: sourceId })) {
      denied.push(sourceId);
      deniedReason ??= 'tombstoned';
      continue;
    }
    const source = await db
      .prepare('SELECT * FROM memory_sources WHERE source_id = ? ORDER BY revision DESC LIMIT 1')
      .bind(sourceId)
      .first<MemorySourceRow>();
    if (!source) {
      denied.push(sourceId);
      deniedReason ??= 'source_missing';
      continue;
    }
    const decision = await authorizeSourceRead(db, {
      space: options.space,
      source,
      agentId: options.agentId,
      target_scope: options.target_scope,
      grant: options.grant,
      at: options.at,
    });
    if (!decision.allowed) {
      denied.push(sourceId);
      deniedReason ??=
        decision.reason === 'tombstoned'
          ? 'tombstoned'
          : decision.reason === 'policy_changed'
            ? 'policy_changed'
            : decision.reason === 'membership_stale'
              ? 'membership_stale'
              : decision.reason === 'history_bound'
                ? 'history_bound'
                : decision.reason === 'different_room' ||
                    decision.reason === 'invalid_target'
                  ? 'invalid_target'
                  : decision.reason === 'ownership_changed'
                    ? 'ownership_changed'
                    : decision.reason === 'agent_disabled'
                      ? 'agent_disabled'
                      : 'source_not_active';
    }
  }
  if (denied.length > 0) {
    return {
      allowed: false,
      reason: deniedReason ?? 'history_bound',
      denied_source_ids: denied,
    };
  }
  return { allowed: true, reason: 'eligible', denied_source_ids: [] };
}

/** 供读取路径复用的来源修订加载；调用方仍需再做 authorizeSourceRead。 */
export async function loadMemorySourceRevision(
  db: D1Like,
  source: MemorySourceRef,
): Promise<MemorySourceRow | null> {
  return requireSourceRevision(db, source);
}

/**
 * 内容读取只能由 Agent 自身身份发起。
 *
 * 管理者可以看管理设置，但不能借用 `manage_agent` 读取 Agent 与第三方的
 * 私聊/群正文；该拒绝在服务层显式发生，而不是只靠 UI 隐藏按钮。
 */
export async function assertContentReaderActor(
  db: D1Like,
  callerActorId: string,
  agentId: string,
): Promise<void> {
  if (callerActorId === agentId) return;
  const management = await getActiveManagement(db, agentId);
  if (management?.manager_id === callerActorId) {
    throw new BusinessError('PERMISSION_DENIED', '管理者只能查看管理元数据，不能读取 Agent 正文', {
      reason: 'manage_agent_is_not_content_access',
      agent_id: agentId,
    });
  }
  throw new BusinessError('PERMISSION_DENIED', '只有 Agent 自身身份可以读取其记忆正文', {
    agent_id: agentId,
  });
}

/**
 * 管理权限只允许看管理元数据，不能读取 Agent 与第三方的正文。
 *
 * 该函数故意不接受 source/context 目标；调用方不能把它误当成内容授权。
 */
export async function managerMayInspectMetadata(
  db: D1Like,
  callerActorId: string,
  agentId: string,
  at = nowMs(),
): Promise<boolean> {
  const management = await getActiveManagement(db, agentId);
  return management?.manager_id === callerActorId;
}

/** 测试/诊断用的当前空间摘要；不返回正文或来源内容。 */
export async function describeMemorySpace(
  db: D1Like,
  agentId: string,
): Promise<{
  space_id: string | null;
  ownership_epoch: number | null;
  owner_actor_id: string | null;
  ownership_kind: MemoryOwnershipKind | null;
  active_host_bindings: number;
} | null> {
  const space = await loadActiveMemorySpace(db, agentId);
  if (!space) return null;
  const bindings = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM memory_host_bindings WHERE space_id = ? AND state = 'active'",
    )
    .bind(space.space_id)
    .first<{ n: number }>();
  return {
    space_id: space.space_id,
    ownership_epoch: space.ownership_epoch,
    owner_actor_id: space.owner_actor_id,
    ownership_kind: space.ownership_kind,
    active_host_bindings: bindings?.n ?? 0,
  };
}

/** 成员代次隔离：退群重加后旧代次经历不能算作新消费。 */
export function sameMemberGeneration(
  room: Pick<RoomMemberRow, 'member_generation'>,
  source: Pick<MemorySourceRow, 'origin_member_generation'>,
): boolean {
  return room.member_generation === source.origin_member_generation;
}

/** 房间归档上界；供派生重建判断当前是否仍可读。 */
export function roomArchived(
  room: Pick<RoomRow, 'dissolved_at' | 'archive_head_seq'>,
): boolean {
  return room.dissolved_at !== null && room.archive_head_seq !== null;
}
