import { LIMITS } from '../../contracts/limits';
import { BusinessError, type BusinessErrorCode } from '../../contracts/errors';
import { guardMessageMatch } from '../guards';
import type { OperationRow } from '../rows';
import { getOperation } from '../queries';

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

const GUARD_CODES: Record<string, BusinessErrorCode> = {
  notMember: 'NOT_MEMBER',
  notOwner: 'NOT_OWNER',
  queueFull: 'QUEUE_FULL',
  budgetExceeded: 'CONFLICT',
  invalidTarget: 'INVALID_ARGUMENT',
  invalidMention: 'INVALID_ARGUMENT',
  claimConflict: 'CLAIM_CONFLICT',
  staleAttempt: 'STALE_ATTEMPT',
  roomFull: 'ROOM_FULL',
  roomLimit: 'CONFLICT',
  actorExists: 'ACTOR_EXISTS',
  recoveryInvalid: 'RECOVERY_INVALID',
  roomFileLimit: 'ROOM_FILE_LIMIT',
  notFileOwner: 'NOT_OWNER',
  roomTaskLimit: 'CONFLICT',
  taskConflict: 'CLAIM_CONFLICT',
  taskEditor: 'NOT_OWNER',
  eventSubscriptionLimit: 'RESOURCE_EXHAUSTED',
  eventSubscriptionGlobal: 'RESOURCE_EXHAUSTED',
  presenceStale: 'CONFLICT',
  permissionDenied: 'PERMISSION_DENIED',
  membershipStale: 'MEMBERSHIP_STALE',
  versionConflict: 'VERSION_CONFLICT',
  roleRevision: 'VERSION_CONFLICT',
  policyRevision: 'VERSION_CONFLICT',
  announcementRevision: 'VERSION_CONFLICT',
  assignmentStale: 'ASSIGNMENT_STALE',
  reviewStale: 'REVIEW_STALE',
  quotaExceeded: 'QUOTA_EXCEEDED',
  requestExpired: 'REQUEST_EXPIRED',
  inviteExhausted: 'INVITE_EXHAUSTED',
  blocked: 'BLOCKED',
  actorDisabled: 'ACTOR_DISABLED',
  pairingInvalid: 'PAIRING_INVALID',
  deviceStale: 'CONFLICT',
  taskState: 'CONFLICT',
  friendRequired: 'FRIEND_REQUIRED',
  contactRequestStale: 'CONFLICT',
  ownerTransferRequired: 'CONFLICT',
  ownerMissing: 'CONFLICT',
  rateLimited: 'RATE_LIMITED',
  invitationStale: 'CONFLICT',
  inviteTargetsMissing: 'FRIEND_REQUIRED',
  joinRequestStale: 'CONFLICT',
  roomInviteLimit: 'QUOTA_EXCEEDED',
  ownerTransferStale: 'CONFLICT',
  fileUnavailable: 'FILE_UNAVAILABLE',
  artifactConflict: 'CONFLICT',
  fileReferenced: 'CONFLICT',
  handoffConflict: 'CONFLICT',
  roomDissolved: 'CONFLICT',
};

const GUARD_MESSAGES: Record<string, string> = {
  notMember: '当前身份不是该房间的有效成员',
  notOwner: '只有群 owner 可以执行该操作',
  queueFull: '目标 Agent 的待办队列已满',
  budgetExceeded: '协作深度或 root 累计派发预算已用尽',
  invalidTarget: '目标不是当前房间中的有效 Agent 成员',
  invalidMention: '被提及的成员不是当前房间中的有效人类成员',
  claimConflict: '该工作已被领取或状态已变化',
  staleAttempt: 'attempt 或 claim_id 已过期',
  roomFull: '群成员数量达到上限',
  roomLimit: '活跃房间数量达到上限',
  actorExists: '该 actor_id 已被其他凭据占用',
  recoveryInvalid: '恢复 ticket 无效、已过期或已被使用',
  roomFileLimit: '房间文件数量或总大小达到上限',
  notFileOwner: '只有上传者或群 owner 可以删除该文件',
  roomTaskLimit: '房间任务数量达到上限',
  taskConflict: '任务已被他人领取或状态已变化',
  taskEditor: '只有任务创建者或房间 owner 可以修改或删除任务',
  eventSubscriptionLimit: '该身份的事件订阅数量达到上限',
  eventSubscriptionGlobal: '全局事件订阅数量达到上限',
  presenceStale: '在线状态已变化',
  permissionDenied: '当前身份没有执行该管理操作的权限',
  membershipStale: '成员资格或加入边界已变化',
  versionConflict: '权限版本已变化，请刷新后重试',
  roleRevision: '群角色版本已变化，请刷新后重试',
  policyRevision: '群策略版本已变化，请刷新后重试',
  announcementRevision: '群公告版本已变化，请刷新后重试',
  assignmentStale: '当前执行资格已失效',
  reviewStale: '验收版本已变化或已被处理，请刷新后重试',
  quotaExceeded: '资源配额已用尽',
  requestExpired: '请求已过期，请重新发起',
  inviteExhausted: '邀请次数已用尽',
  blocked: '对方已拉黑，操作被拒绝',
  actorDisabled: 'Agent 已停用，不能继续执行或接收新投递',
  pairingInvalid: '设备配对挑战无效或已被使用',
  deviceStale: '设备状态已变化，请刷新设备列表后重试',
  taskState: '任务状态已变化',
  friendRequired: '需要有效的好友关系',
  contactRequestStale: '好友申请状态已变化，请刷新后重试',
  ownerTransferRequired: '群 owner 不能直接退群；请先转移 owner 或解散群聊',
  ownerMissing: '群主缺失，群已冻结，不能邀请或加入成员',
  rateLimited: '操作过于频繁，请稍后再试',
  invitationStale: '邀请状态已变化，请刷新后重试',
  inviteTargetsMissing: '成员资格在提交时已变化，群未创建',
  joinRequestStale: '入群申请状态已变化，请刷新后重试',
  roomInviteLimit: '该群同时有效的邀请链接数量达到上限',
  ownerTransferStale: '群主转让提议状态已变化，请刷新后重试',
  fileUnavailable: '文件不存在、已删除、已过期或正在被清理',
  artifactConflict: '成果版本已变化或文件已被其他成果占用',
  fileReferenced: '文件仍被有效任务或成果引用，不能删除或释放保留',
  handoffConflict: '交接包版本已变化，请刷新后重试',
  roomDissolved: '群已解散，当前为只读归档，不能继续写入',
};

/** 限额类 guard 的稳定 data，供 MCP Events 映射 -32025。 */
const GUARD_DETAILS: Record<string, Record<string, unknown>> = {
  inviteTargetsMissing: {
    reason: 'invite_targets_missing',
  },
  eventSubscriptionLimit: {
    limit: 'subscriptions',
    max: LIMITS.eventsSubscriptionsPerActor,
  },
  eventSubscriptionGlobal: {
    limit: 'global_subscriptions',
    max: LIMITS.eventsSubscriptionsGlobal,
  },
  roomDissolved: {
    reason: 'room_dissolved',
    read_only: true,
  },
  ownerMissing: {
    reason: 'owner_missing',
    owner_missing: true,
  },
  ownerTransferRequired: {
    reason: 'owner_transfer_required',
    owner_transfer_required: true,
  },
};

/** 把 D1 batch 抛出的约束错误映射成有类型的业务错误。 */
export function mapBatchError(error: unknown): BusinessError | null {
  const text = errorText(error);
  if (isOneClaimedConflict(error)) {
    return new BusinessError('CLAIM_CONFLICT', '当前已有领取中的工作，不能并行领取');
  }
  const guard = guardMessageMatch(text);
  if (guard) {
    return new BusinessError(
      GUARD_CODES[guard] ?? 'CONFLICT',
      GUARD_MESSAGES[guard] ?? '事务条件不满足',
      GUARD_DETAILS[guard],
    );
  }
  return null;
}

export function isOperationConflict(error: unknown): boolean {
  return errorText(error).includes('UNIQUE constraint failed: operations.actor_id, operations.request_id');
}

export function isMessageConflict(error: unknown): boolean {
  return errorText(error).includes(
    'UNIQUE constraint failed: messages.sender_id, messages.client_message_id',
  );
}

export function isDeliveryConflict(error: unknown): boolean {
  return errorText(error).includes('UNIQUE constraint failed: deliveries.recipient_id, deliveries.message_id');
}

/** 同一 file_id 只能绑定一次；命中后按房间/墓碑状态收敛或报错。 */
export function isRoomFileConflict(error: unknown): boolean {
  return errorText(error).includes('UNIQUE constraint failed: room_files.file_id');
}

/** 同一 file_id/任务版本只能有一个成果；命中后按幂等请求或 CONFLICT 收敛。 */
export function isArtifactConflict(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes('UNIQUE constraint failed: artifacts.file_id') ||
    text.includes('UNIQUE constraint failed: artifacts.room_id, artifacts.task_id, artifacts.version') ||
    text.includes('idx_artifacts_file') ||
    text.includes('idx_artifacts_task_version')
  );
}

export function isEventKeyConflict(error: unknown): boolean {
  return errorText(error).includes('UNIQUE constraint failed: events.event_key');
}

export function isOneClaimedConflict(error: unknown): boolean {
  const text = errorText(error);
  if (text.includes('idx_deliveries_one_claimed')) return true;
  // SQLite 只报告冲突列；单列 recipient_id 冲突只可能来自“每 Agent 至多一条 claimed”的部分唯一索引。
  return (
    text.includes('UNIQUE constraint failed: deliveries.recipient_id') &&
    !text.includes('deliveries.message_id')
  );
}

export function resolveOperation(row: OperationRow, payloadHash: string): unknown {
  if (row.payload_hash !== payloadHash) {
    throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 request_id 携带了不同的参数', {
      request_id: row.request_id,
    });
  }
  try {
    return JSON.parse(row.result_json) as unknown;
  } catch {
    throw new BusinessError('CONFLICT', '已保存的幂等结果不可读', { request_id: row.request_id });
  }
}

export interface ReplayOutcome {
  found: boolean;
  result?: unknown;
}

/**
 * 在目标授权前解析既有幂等结果。
 *
 * `runIdempotent` 本身在目标不存在/非 Agent 时不需要先鉴权，但管理类操作
 * 还要先读取目标确认 kind；同一 `request_id` 改参数必须在权限检查之前
 * 收敛为 `IDEMPOTENCY_CONFLICT`，避免未授权的第二个目标把重放误报成
 * `PERMISSION_DENIED`。命中后调用方直接返回结果，不再执行本次 batch。
 */
export async function resolveReplay(
  db: D1Database,
  actorId: string,
  requestId: string,
  payloadHash: string,
): Promise<ReplayOutcome> {
  const existing = await getOperation(db, actorId, requestId);
  if (!existing) return { found: false };
  return { found: true, result: resolveOperation(existing, payloadHash) };
}

export interface IdempotentOptions {
  actorId: string;
  requestId: string;
  payloadHash: string;
  result: unknown;
  /** 返回完整 batch；第一条必须是 operations 插入。 */
  build: (resultJson: string) => D1PreparedStatement[];
  /** 非 operations 的唯一键冲突（例如长期消息唯一键）的恢复入口。 */
  onUniqueConflict?: (error: unknown) => Promise<unknown | undefined>;
}

/**
 * 统一幂等写入：
 * 1. 先读 operations 快速返回；
 * 2. batch 内以 operations 唯一键作为本次操作所有权；
 * 3. 约束冲突时读取已提交结果或明确冲突。
 */
export async function runIdempotent(
  db: D1Database,
  options: IdempotentOptions,
): Promise<unknown> {
  const existing = await getOperation(db, options.actorId, options.requestId);
  if (existing) return resolveOperation(existing, options.payloadHash);

  const resultJson = JSON.stringify(options.result);
  const statements = options.build(resultJson);
  try {
    await db.batch(statements);
    return options.result;
  } catch (error) {
    const business = mapBatchError(error);
    if (isOperationConflict(error)) {
      const committed = await getOperation(db, options.actorId, options.requestId);
      if (committed) return resolveOperation(committed, options.payloadHash);
      // 并发的同 request_id 操作失败并回滚：本请求重试一次。
      await db.batch(statements);
      return options.result;
    }
    if (options.onUniqueConflict) {
      const recovered = await options.onUniqueConflict(error);
      if (recovered !== undefined) return recovered;
    }
    if (business) throw business;
    throw error;
  }
}

export function operationsStatement(
  db: D1Database,
  actorId: string,
  requestId: string,
  payloadHash: string,
  resultJson: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operations (actor_id, request_id, payload_hash, write_nonce, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(actorId, requestId, payloadHash, crypto.randomUUID(), resultJson, at);
}
