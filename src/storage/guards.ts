/**
 * 事务条件闸门。
 *
 * 每个 guard 表只接受 x=0；`INSERT ... SELECT 1 WHERE <违反条件>` 命中时
 * 触发 CHECK 失败，使整个 D1 batch 回滚。表名、业务错误码、文案与 details
 * 统一维护在这里，`runner.ts` 只做映射。
 *
 * 新增闸门时必须同时更新迁移与本表；不要在 runner 里再维护第二份映射。
 */

import type { BusinessErrorCode } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';

export interface GuardDefinition {
  table: string;
  code: BusinessErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export const GUARDS = {
  notMember: {
    table: 'guard_not_member',
    code: 'NOT_MEMBER',
    message: '当前身份不是该房间的有效成员',
  },
  notOwner: {
    table: 'guard_not_owner',
    code: 'NOT_OWNER',
    message: '只有群 owner 可以执行该操作',
  },
  queueFull: {
    table: 'guard_queue_full',
    code: 'QUEUE_FULL',
    message: '目标 Agent 的待办队列已满',
  },
  budgetExceeded: {
    table: 'guard_budget_exceeded',
    code: 'CONFLICT',
    message: '协作深度或 root 累计派发预算已用尽',
  },
  invalidTarget: {
    table: 'guard_invalid_target',
    code: 'INVALID_ARGUMENT',
    message: '目标不是当前房间中的有效 Agent 成员',
  },
  invalidMention: {
    table: 'guard_invalid_mention',
    code: 'INVALID_ARGUMENT',
    message: '被提及的成员不是当前房间中的有效人类成员',
  },
  claimConflict: {
    table: 'guard_claim_conflict',
    code: 'CLAIM_CONFLICT',
    message: '该工作已被领取或状态已变化',
  },
  staleAttempt: {
    table: 'guard_stale_attempt',
    code: 'STALE_ATTEMPT',
    message: 'attempt 或 claim_id 已过期',
  },
  roomFull: {
    table: 'guard_room_full',
    code: 'ROOM_FULL',
    message: '群成员数量达到上限',
  },
  roomLimit: {
    table: 'guard_room_limit',
    code: 'CONFLICT',
    message: '活跃房间数量达到上限',
  },
  actorExists: {
    table: 'guard_actor_exists',
    code: 'ACTOR_EXISTS',
    message: '该 actor_id 已被其他凭据占用',
  },
  recoveryInvalid: {
    table: 'guard_recovery_invalid',
    code: 'RECOVERY_INVALID',
    message: '恢复 ticket 无效、已过期或已被使用',
  },
  roomFileLimit: {
    table: 'guard_room_file_limit',
    code: 'ROOM_FILE_LIMIT',
    message: '房间文件数量或总大小达到上限',
  },
  notFileOwner: {
    table: 'guard_not_file_owner',
    code: 'NOT_OWNER',
    message: '只有上传者或群 owner 可以删除该文件',
  },
  eventSubscriptionLimit: {
    table: 'guard_event_subscription_limit',
    code: 'RESOURCE_EXHAUSTED',
    message: '该身份的事件订阅数量达到上限',
    details: {
      limit: 'subscriptions',
      max: LIMITS.eventsSubscriptionsPerActor,
    },
  },
  eventSubscriptionGlobal: {
    table: 'guard_event_subscription_global',
    code: 'RESOURCE_EXHAUSTED',
    message: '全局事件订阅数量达到上限',
    details: {
      limit: 'global_subscriptions',
      max: LIMITS.eventsSubscriptionsGlobal,
    },
  },
  presenceStale: {
    table: 'guard_presence_stale',
    code: 'CONFLICT',
    message: '在线状态已变化',
  },
  permissionDenied: {
    table: 'guard_permission_denied',
    code: 'PERMISSION_DENIED',
    message: '当前身份没有执行该管理操作的权限',
  },
  membershipStale: {
    table: 'guard_membership_stale',
    code: 'MEMBERSHIP_STALE',
    message: '成员资格或加入边界已变化',
  },
  versionConflict: {
    table: 'guard_version_conflict',
    code: 'VERSION_CONFLICT',
    message: '权限版本已变化，请刷新后重试',
  },
  roleRevision: {
    table: 'guard_role_revision',
    code: 'VERSION_CONFLICT',
    message: '群角色版本已变化，请刷新后重试',
  },
  policyRevision: {
    table: 'guard_policy_revision',
    code: 'VERSION_CONFLICT',
    message: '群策略版本已变化，请刷新后重试',
  },
  announcementRevision: {
    table: 'guard_announcement_revision',
    code: 'VERSION_CONFLICT',
    message: '群公告版本已变化，请刷新后重试',
  },
  quotaExceeded: {
    table: 'guard_quota_exceeded',
    code: 'QUOTA_EXCEEDED',
    message: '资源配额已用尽',
  },
  requestExpired: {
    table: 'guard_request_expired',
    code: 'REQUEST_EXPIRED',
    message: '请求已过期，请重新发起',
  },
  inviteExhausted: {
    table: 'guard_invite_exhausted',
    code: 'INVITE_EXHAUSTED',
    message: '邀请次数已用尽',
  },
  blocked: {
    table: 'guard_blocked',
    code: 'BLOCKED',
    message: '对方已拉黑，操作被拒绝',
  },
  actorDisabled: {
    table: 'guard_actor_disabled',
    code: 'ACTOR_DISABLED',
    message: 'Agent 已停用，不能继续执行或接收新投递',
  },
  pairingInvalid: {
    table: 'guard_pairing_invalid',
    code: 'PAIRING_INVALID',
    message: '设备配对挑战无效或已被使用',
  },
  deviceStale: {
    table: 'guard_device_stale',
    code: 'CONFLICT',
    message: '设备状态已变化，请刷新设备列表后重试',
  },
  friendRequired: {
    table: 'guard_friend_required',
    code: 'FRIEND_REQUIRED',
    message: '需要有效的好友关系',
  },
  contactRequestStale: {
    table: 'guard_contact_request_stale',
    code: 'CONFLICT',
    message: '好友申请状态已变化，请刷新后重试',
  },
  ownerTransferRequired: {
    table: 'guard_owner_transfer_required',
    code: 'CONFLICT',
    message: '群 owner 不能直接退群；请先转移 owner 或解散群聊',
    details: {
      reason: 'owner_transfer_required',
      owner_transfer_required: true,
    },
  },
  ownerMissing: {
    table: 'guard_owner_missing',
    code: 'CONFLICT',
    message: '群主缺失，群已冻结，不能邀请或加入成员',
    details: {
      reason: 'owner_missing',
      owner_missing: true,
    },
  },
  rateLimited: {
    table: 'guard_rate_limited',
    code: 'RATE_LIMITED',
    message: '操作过于频繁，请稍后再试',
  },
  invitationStale: {
    table: 'guard_invitation_stale',
    code: 'CONFLICT',
    message: '邀请状态已变化，请刷新后重试',
  },
  inviteTargetsMissing: {
    table: 'guard_invite_targets_missing',
    code: 'FRIEND_REQUIRED',
    message: '成员资格在提交时已变化，群未创建',
    details: {
      reason: 'invite_targets_missing',
    },
  },
  joinRequestStale: {
    table: 'guard_join_request_stale',
    code: 'CONFLICT',
    message: '入群申请状态已变化，请刷新后重试',
  },
  roomInviteLimit: {
    table: 'guard_room_invite_limit',
    code: 'QUOTA_EXCEEDED',
    message: '该群同时有效的邀请链接数量达到上限',
  },
  ownerTransferStale: {
    table: 'guard_owner_transfer_stale',
    code: 'CONFLICT',
    message: '群主转让提议状态已变化，请刷新后重试',
  },
  fileUnavailable: {
    table: 'guard_file_unavailable',
    code: 'FILE_UNAVAILABLE',
    message: '文件不存在、已删除、已过期或正在被清理',
  },
  artifactConflict: {
    table: 'guard_artifact_conflict',
    code: 'CONFLICT',
    message: '成果版本已变化或文件已被其他成果占用',
  },
  fileReferenced: {
    table: 'guard_file_referenced',
    code: 'CONFLICT',
    message: '文件仍被有效任务或成果引用，不能删除或释放保留',
  },
  roomDissolved: {
    table: 'guard_room_dissolved',
    code: 'CONFLICT',
    message: '群已解散，当前为只读归档，不能继续写入',
    details: {
      reason: 'room_dissolved',
      read_only: true,
    },
  },
  contactLinkInvalid: {
    table: 'guard_contact_link_invalid',
    code: 'CONTACT_LINK_INVALID',
    message: '好友链接无效、已过期、已被使用或已被撤销',
  },
  contactLinkLimit: {
    table: 'guard_contact_link_limit',
    code: 'QUOTA_EXCEEDED',
    message: '待使用的好友链接数量达到上限',
    details: {
      reason: 'contact_link_pending_limit',
      max: LIMITS.contactLinkPendingMax,
    },
  },
  taskMarkUnavailable: {
    table: 'guard_task_mark_unavailable',
    code: 'NOT_FOUND',
    message: '消息不存在、当前不可见或已撤回',
  },
  taskMarkConflict: {
    table: 'guard_task_mark_conflict',
    code: 'CONFLICT',
    message: '消息已属于另一个 Task；请另选起点或先取消原标记',
  },
} as const satisfies Record<string, GuardDefinition>;

export type GuardName = keyof typeof GUARDS;

export function guardSql(name: GuardName, violation: string): string {
  return `INSERT INTO ${GUARDS[name].table} (x) SELECT 1 WHERE (${violation})`;
}

export function guardMessageMatch(table: string): GuardName | null {
  for (const [name, guard] of Object.entries(GUARDS)) {
    if (table.includes(guard.table)) return name as GuardName;
  }
  return null;
}
