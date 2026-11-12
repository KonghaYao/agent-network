/**
 * MF06/MF07：由服务端解析准确输入目标。
 *
 * 客户端只给业务定位；Agent、空间、受众版本、成员代次与 claim 资格全部由
 * 服务端按当前授权补齐。任何一项不匹配都拒绝，不能让客户端自报 space 或
 * 受众扩大读取范围。
 */
import { BusinessError } from '../contracts/errors';
import { nowMs } from '../storage/db';
import { getMember, getMessage, getRoom } from '../storage/queries';
import type { D1Like } from '../storage/queries';
import type { DeliveryRow, RoomRow } from '../storage/rows';
import { historyBoundary, visibleMessage } from '../domain/room-history';
import {
  type MemoryContextTarget,
  type MemoryMessageDeliveryRef,
  type MemoryMessageRef,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import { requireCurrentMemorySpace, roomAccessVersion } from './access';

export interface MemoryTargetScopeInput {
  audience: 'agent_private' | 'room';
  room_id: string | null;
  member_generation: number | null;
  member_seq: number | null;
  policy_revision: number | null;
}

export function targetScopeForRoom(
  room: Pick<RoomRow, 'room_id' | 'kind'>,
  version: {
    member_generation: number;
    member_seq: number;
    policy_revision: number;
  } | null,
): MemoryTargetScope {
  if (room.kind === 'direct') {
    return {
      audience: 'agent_private',
      room_id: null,
      member_generation: null,
      member_seq: null,
      policy_revision: null,
    };
  }
  if (!version) {
    throw new BusinessError('MEMBERSHIP_STALE', '当前成员版本不可用', {
      room_id: room.room_id,
    });
  }
  return {
    audience: 'room',
    room_id: room.room_id,
    member_generation: version.member_generation,
    member_seq: version.member_seq,
    policy_revision: version.policy_revision,
  };
}

/** 当前 Agent 在房间中的目的受众；非成员/代次缺失直接失败。 */
export async function resolveRoomTargetScope(
  db: D1Like,
  roomId: string,
  agentId: string,
): Promise<MemoryTargetScope> {
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在', { room_id: roomId });
  const version = await roomAccessVersion(db, roomId, agentId);
  if (!version) {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员', { room_id: roomId });
  }
  return targetScopeForRoom(room, version);
}

function assertClaim(
  delivery: DeliveryRow | null,
  input: MemoryMessageDeliveryRef,
  agentId: string,
): DeliveryRow {
  if (!delivery || delivery.message_id !== input.message_id || delivery.delivery_id !== input.delivery_id) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '投递定位不存在', {
      reason: 'delivery_missing',
    });
  }
  if (delivery.recipient_id !== agentId) {
    throw new BusinessError('PERMISSION_DENIED', '投递不属于当前 Agent', {
      reason: 'delivery_recipient_mismatch',
    });
  }
  if (
    delivery.state !== 'claimed' ||
    delivery.attempt !== input.attempt ||
    delivery.claim_id !== input.claim_id
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '投递 claim 已失效或代次不匹配', {
      reason: 'delivery_claim_stale',
      delivery_id: delivery.delivery_id,
      state: delivery.state,
    });
  }
  return delivery;
}

export interface ResolveMessageTargetInput {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  hostBindingId: string;
  hostGeneration: number;
  sessionIncarnation: string;
  runId: string;
  inputId: string;
  inputRevision: number;
  message: MemoryMessageDeliveryRef;
  now?: number;
}

/**
 * claim 后绑定准确消息目标。
 *
 * 只接受当前 Agent、当前 attempt/claim_id 的 claimed delivery；消息必须仍在
 * 当前成员代次与历史边界内。返回的 target 带服务端当前版本集合。
 */
export async function resolveMessageContextTarget(
  db: D1Like,
  input: ResolveMessageTargetInput,
): Promise<MemoryContextTarget> {
  const at = input.now ?? nowMs();
  const delivery = await db
    .prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
    .bind(input.message.delivery_id)
    .first<DeliveryRow>();
  const claimed = assertClaim(delivery, input.message, input.agentId);
  const message = await getMessage(db, claimed.message_id);
  if (!message || message.room_id !== claimed.room_id) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '消息定位不存在或不匹配', {
      reason: 'message_missing',
    });
  }
  const room = await getRoom(db, message.room_id);
  const member = await getMember(db, message.room_id, input.agentId);
  if (!room || !member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员', {
      room_id: message.room_id,
    });
  }
  if (!visibleMessage(message, historyBoundary(room, member))) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '消息不在当前可读历史范围', {
      reason: 'message_not_visible',
    });
  }
  const context = await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    roomIds: [message.room_id],
    at,
  });
  const version = context.versions.rooms.find((item) => item.room_id === message.room_id);
  return {
    kind: 'message',
    agent_actor_id: input.agentId,
    space: context.space,
    host_binding_id: input.hostBindingId,
    host_generation: input.hostGeneration,
    session_incarnation: input.sessionIncarnation,
    run_id: input.runId,
    input_id: input.inputId,
    input_revision: input.inputRevision,
    target_scope: targetScopeForRoom(room, version ?? null),
    versions: context.versions,
    message: input.message,
  };
}

/**
 * 显式 related 召回的目标校验：只证明当前可读，不证明 claim 或已消费。
 */
export async function assertRecallMessageVisible(
  db: D1Like,
  agentId: string,
  messageRef: MemoryMessageRef,
): Promise<void> {
  const message = await getMessage(db, messageRef.message_id);
  if (!message || message.room_id !== messageRef.room_id || message.created_seq !== messageRef.created_seq) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '召回消息定位不匹配', {
      reason: 'message_missing',
    });
  }
  const room = await getRoom(db, message.room_id);
  const member = await getMember(db, message.room_id, agentId);
  if (!room || !member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员', {
      room_id: message.room_id,
    });
  }
  if (!visibleMessage(message, historyBoundary(room, member))) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '消息不在当前可读历史范围', {
      reason: 'message_not_visible',
    });
  }
}

/** 任务实体已在迁移 0042 删除；消息式任务通过 message 目标接入。 */
export function taskTargetUnsupported(): never {
  throw new BusinessError('MEMORY_UNSUPPORTED', '当前部署没有任务实体，请使用 message 目标', {
    reason: 'task_target_not_supported',
    remediation: 'use_message_target',
  });
}

/**
 * 输入提交/回执时复核 claim 代次。
 *
 * 不要求仍处于 claimed（模型可能已经提交并完成 delivery），但 attempt 或
 * claim_id 变化表示已重试/重新领取，旧 target 不能再绑定新输入。
 */
export async function assertDeliveryAttemptUnchanged(
  db: D1Like,
  agentId: string,
  ref: MemoryMessageDeliveryRef,
): Promise<void> {
  const delivery = await db
    .prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
    .bind(ref.delivery_id)
    .first<DeliveryRow>();
  if (
    !delivery ||
    delivery.message_id !== ref.message_id ||
    delivery.recipient_id !== agentId ||
    delivery.attempt !== ref.attempt ||
    delivery.claim_id !== ref.claim_id
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '投递 attempt/claim 已变化，旧输入失效', {
      reason: 'delivery_claim_stale',
      delivery_id: ref.delivery_id,
    });
  }
}
