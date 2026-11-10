/**
 * 事务条件闸门。
 *
 * 每个 guard 表只接受 x=0；`INSERT ... SELECT 1 WHERE <违反条件>` 命中时
 * 触发 CHECK 失败，使整个 D1 batch 回滚。表名同时作为内部错误分类。
 */
export const GUARD_TABLES = {
  notMember: 'guard_not_member',
  notOwner: 'guard_not_owner',
  queueFull: 'guard_queue_full',
  budgetExceeded: 'guard_budget_exceeded',
  invalidTarget: 'guard_invalid_target',
  invalidMention: 'guard_invalid_mention',
  claimConflict: 'guard_claim_conflict',
  staleAttempt: 'guard_stale_attempt',
  roomFull: 'guard_room_full',
  roomLimit: 'guard_room_limit',
  actorExists: 'guard_actor_exists',
  recoveryInvalid: 'guard_recovery_invalid',
  roomFileLimit: 'guard_room_file_limit',
  notFileOwner: 'guard_not_file_owner',
  eventSubscriptionLimit: 'guard_event_subscription_limit',
  eventSubscriptionGlobal: 'guard_event_subscription_global',
  presenceStale: 'guard_presence_stale',
  permissionDenied: 'guard_permission_denied',
  membershipStale: 'guard_membership_stale',
  versionConflict: 'guard_version_conflict',
  roleRevision: 'guard_role_revision',
  policyRevision: 'guard_policy_revision',
  announcementRevision: 'guard_announcement_revision',
  quotaExceeded: 'guard_quota_exceeded',
  requestExpired: 'guard_request_expired',
  inviteExhausted: 'guard_invite_exhausted',
  blocked: 'guard_blocked',
  actorDisabled: 'guard_actor_disabled',
  pairingInvalid: 'guard_pairing_invalid',
  deviceStale: 'guard_device_stale',
  friendRequired: 'guard_friend_required',
  contactRequestStale: 'guard_contact_request_stale',
  ownerTransferRequired: 'guard_owner_transfer_required',
  ownerMissing: 'guard_owner_missing',
  rateLimited: 'guard_rate_limited',
  invitationStale: 'guard_invitation_stale',
  inviteTargetsMissing: 'guard_invite_targets_missing',
  joinRequestStale: 'guard_join_request_stale',
  roomInviteLimit: 'guard_room_invite_limit',
  ownerTransferStale: 'guard_owner_transfer_stale',
  fileUnavailable: 'guard_file_unavailable',
  artifactConflict: 'guard_artifact_conflict',
  fileReferenced: 'guard_file_referenced',
  roomDissolved: 'guard_room_dissolved',
  contactLinkInvalid: 'guard_contact_link_invalid',
  contactLinkLimit: 'guard_contact_link_limit',
  taskMarkUnavailable: 'guard_task_mark_unavailable',
  taskMarkConflict: 'guard_task_mark_conflict',
} as const;

export type GuardName = keyof typeof GUARD_TABLES;

export function guardSql(name: GuardName, violation: string): string {
  return `INSERT INTO ${GUARD_TABLES[name]} (x) SELECT 1 WHERE (${violation})`;
}

export function guardMessageMatch(table: string): GuardName | null {
  for (const [name, guardTable] of Object.entries(GUARD_TABLES)) {
    if (table.includes(guardTable)) return name as GuardName;
  }
  return null;
}
