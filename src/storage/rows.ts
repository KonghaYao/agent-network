export interface ActorRow {
  actor_id: string;
  kind: 'human' | 'agent';
  agent_session_id: string | null;
  name: string;
  metadata: string;
  inbox_head_seq: number;
  inbox_min_seq: number;
  pending_count: number;
  /** 管理列表软归档时间；NULL 表示未归档，不参与任何授权判断。 */
  archived_at: number | null;
  archived_by: string | null;
  /** 非 NULL 表示停用：拒绝新写入、新投递、claim/report/complete/fail。 */
  disabled_at: number | null;
  disabled_by: string | null;
  disabled_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentManagementRow {
  binding_id: string;
  agent_id: string;
  manager_id: string;
  status: 'active' | 'revoked' | 'expired';
  grant_source: 'created' | 'claim' | 'transfer' | 'legacy';
  scopes_json: string;
  permission_version: number;
  initiated_by: string;
  confirmed_by: string | null;
  created_at: number;
  confirmed_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  updated_at: number;
}

export interface AgentClaimRow {
  claim_id: string;
  agent_id: string;
  claim_code_hash: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'cancelled' | 'expired';
  attempts: number;
  max_attempts: number;
  created_at: number;
  expires_at: number;
  confirmed_by: string | null;
  confirmed_at: number | null;
  updated_at: number;
}

export interface AgentDelegationRow {
  delegation_id: string;
  agent_id: string;
  delegate_actor_id: string;
  status: 'active' | 'revoked' | 'expired';
  scopes_json: string;
  permission_version: number;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  updated_at: number;
}

export interface AgentManagementTransferRow {
  transfer_id: string;
  agent_id: string;
  from_manager_id: string;
  to_manager_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  from_permission_version: number;
  context_json: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  responded_at: number | null;
  responded_by: string | null;
  updated_at: number;
}

export interface CredentialRow {
  credential_id: string;
  actor_id: string;
  device_id: string;
  token_hash: string;
  revoked_at: number | null;
  created_at: number;
  last_used_at: number | null;
  revoked_by: string | null;
  label: string | null;
}

export type DeviceStatus = 'active' | 'revoked';
export type DevicePairingStatus = 'pending' | 'approved' | 'redeemed' | 'expired' | 'cancelled';

export interface DeviceRow {
  actor_id: string;
  device_id: string;
  label: string;
  platform: string;
  status: DeviceStatus;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface DevicePairingRow {
  pairing_id: string;
  challenge_hash: string;
  status: DevicePairingStatus;
  actor_id: string | null;
  created_at: number;
  expires_at: number;
  approved_by_actor_id: string | null;
  approved_by_credential_id: string | null;
  approved_at: number | null;
  redeemed_credential_id: string | null;
  redeemed_at: number | null;
  attempts: number;
  max_attempts: number;
  updated_at: number;
  created_by_credential_id: string | null;
  device_id: string | null;
  device_label: string;
  platform: string;
  device_token_hash: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string;
}

export interface ContactRow {
  owner_actor_id: string;
  target_actor_id: string;
  created_at: number;
}

/** 双向好友关系；`contacts` 仍是单侧个人收藏，不代表同意。 */
export interface ContactRelationRow {
  pair_key: string;
  actor_a: string;
  actor_b: string;
  status: 'active' | 'ended';
  source: 'request' | 'auto_manager' | 'invite_link';
  request_id: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  ended_by: string | null;
}

/** 好友邀请链接；只保存 token 摘要，明文不落库、不在重放中出现。 */
export interface ContactInviteLinkRow {
  link_id: string;
  owner_actor_id: string;
  token_hash: string;
  status: 'pending' | 'used' | 'revoked' | 'expired';
  expires_at: number;
  used_by: string | null;
  used_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface ContactRequestRow {
  contact_request_id: string;
  pair_key: string;
  from_actor_id: string;
  to_actor_id: string;
  message: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  auto_accepted: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  responded_at: number | null;
  responded_by: string | null;
}

export interface ContactReceivePolicyRow {
  actor_id: string;
  policy: 'self_approval' | 'manager_approval' | 'auto_accept';
  updated_by: string;
  updated_at: number;
}

/** 拉黑与好友关系分开存储；`released_at` 为 NULL 表示仍生效。 */
export interface ContactBlockRow {
  block_id: string;
  blocker_actor_id: string;
  blocked_actor_id: string;
  reason: string;
  mute_mentions: number;
  created_at: number;
  released_at: number | null;
  released_by: string | null;
}

/** 举报只保存最小定位证据，不复制消息正文，也不对外发送。 */
export interface ContactReportRow {
  report_id: string;
  reporter_actor_id: string;
  target_actor_id: string;
  category: 'harassment' | 'spam' | 'fraud' | 'other';
  note: string;
  room_id: string | null;
  message_id: string | null;
  evidence_json: string;
  status: 'received';
  created_at: number;
  updated_at: number;
}

export type RoomRole = 'owner' | 'admin' | 'member';
export type GroupMemberPolicy = 'members' | 'owner_admin';
/** 新成员默认只看当前这次加入后的历史；`full` 由群主显式开启。 */
export type GroupHistoryPolicy = 'from_join' | 'full';
/** `open` 保持直接邀请；`approval` 由 G02 在邀请接受路径强制执行。 */
export type GroupJoinPolicy = 'open' | 'approval';

export interface RoomRow {
  room_id: string;
  kind: 'direct' | 'group';
  owner_id: string | null;
  title: string;
  direct_pair_key: string | null;
  head_seq: number;
  events_min_seq: number;
  member_seq: number;
  last_message_id: string | null;
  policy_revision: number;
  member_message_policy: GroupMemberPolicy;
  member_invite_policy: GroupMemberPolicy;
  member_history_policy: GroupHistoryPolicy;
  member_join_policy: GroupJoinPolicy;
  member_profile_policy: GroupMemberPolicy;
  member_mention_all_policy: GroupMemberPolicy;
  announcement: string;
  announcement_revision: number;
  announcement_updated_at: number | null;
  announcement_updated_by: string | null;
  /** 群解散时间；NULL 表示仍可写。解散后成员保留只读归档资格。 */
  dissolved_at: number | null;
  dissolved_by: string | null;
  dissolve_reason: string | null;
  /** 解散时 room scope 的事件高水位；所有归档读取的序号上界。 */
  archive_head_seq: number | null;
  /** 解散时的成员版本快照；用于审计与未来媒体层成员代次核对。 */
  archive_member_seq: number | null;
  created_at: number;
  updated_at: number;
}

export interface RoomMemberRow {
  room_id: string;
  actor_id: string;
  role: RoomRole;
  status: 'active' | 'left' | 'removed';
  joined_seq: number;
  last_read_seq: number;
  joined_at: number;
  /** 每次重新加入递增；旧游标/旧缓存索引不能跨代次继续读取。 */
  member_generation: number;
  role_revision: number;
  updated_at: number;
}

/** 群邀请独立于成员关系；pending 不计入 active 成员数。 */
export interface RoomInvitationRow {
  invitation_id: string;
  room_id: string;
  inviter_id: string;
  target_actor_id: string | null;
  token_hash: string | null;
  kind: 'direct' | 'link';
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired' | 'exhausted';
  max_uses: number;
  used_count: number;
  expires_at: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

export type RoomManagementAction =
  | 'member_added'
  | 'member_removed'
  | 'member_left'
  | 'admin_appointed'
  | 'admin_revoked'
  | 'owner_transferred'
  | 'owner_transfer_proposed'
  | 'owner_transfer_accepted'
  | 'owner_transfer_rejected'
  | 'owner_transfer_cancelled'
  | 'owner_transfer_expired'
  | 'policy_updated'
  | 'announcement_updated'
  | 'invite_created'
  | 'invite_revoked'
  | 'join_requested'
  | 'join_approved'
  | 'join_rejected'
  | 'room_dissolved';

/** 入群申请：pending 不是成员，批准时才在同一事务写入 active 成员。 */
export interface RoomJoinRequestRow {
  join_request_id: string;
  invitation_id: string;
  room_id: string;
  applicant_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  message: string;
  revision: number;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

/** 群主转让提议；pending 不改变 `rooms.owner_id` 与任何成员角色。 */
export interface RoomOwnerTransferRow {
  transfer_id: string;
  room_id: string;
  from_owner_id: string;
  to_actor_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  version: number;
  target_role_revision: number;
  invalid_reason: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  responded_at: number | null;
  responded_by: string | null;
}

export interface RoomManagementAuditRow {
  audit_id: string;
  room_id: string;
  action: RoomManagementAction;
  target_actor_id: string | null;
  previous_role: RoomRole | null;
  new_role: RoomRole | null;
  previous_status: 'active' | 'left' | 'removed' | null;
  new_status: 'active' | 'left' | 'removed' | null;
  expected_revision: number | null;
  resulting_revision: number;
  changed_by: string;
  request_id: string;
  detail_json: string;
  created_at: number;
}

export interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string;
  client_message_id: string;
  created_seq: number;
  body: string;
  body_bytes: number;
  preview: string;
  reply_to: string | null;
  root_id: string | null;
  hop: number;
  root_invocations_used: number;
  /** 消息式 Task 归属；起点自指 message_id，普通消息为 NULL。 */
  task_root_id: string | null;
  /** 起点标记审计；处理消息与普通消息为 NULL。 */
  task_marked_by: string | null;
  task_marked_at: number | null;
  created_at: number;
}

export interface DeliveryRow {
  delivery_id: string;
  recipient_id: string;
  message_id: string;
  room_id: string;
  state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  claim_id: string | null;
  claimed_at: number | null;
  progress_at: number | null;
  /** 上一次 3 分钟无进度提醒的时间；claim/report/retry 时重置。 */
  last_reminded_at: number | null;
  result_message_id: string | null;
  error: string | null;
  created_seq: number;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  event_seq: number;
  scope_kind: 'room' | 'inbox' | 'actor';
  scope_id: string;
  event_type: string;
  ref_id: string | null;
  metadata: string;
  event_key: string;
  created_at: number;
}

export interface OutboxRow {
  outbox_id: string;
  topic: string;
  event_seq: number;
  status: 'pending' | 'processing' | 'completed';
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface OperationRow {
  actor_id: string;
  request_id: string;
  payload_hash: string;
  write_nonce: string;
  result_json: string;
  created_at: number;
}

export interface RecoveryTicketRow {
  ticket_hash: string;
  actor_id: string;
  expires_at: number;
  consumed_at: number | null;
  redeemed_credential_id: string | null;
  redeem_request_id: string | null;
  created_at: number;
}

/** 已绑定到房间的 MCPP Files 记录；public_url 由 PUBLIC_ORIGIN 派生，不落库。 */
export interface RoomFileRow {
  room_file_id: string;
  room_id: string;
  file_id: string;
  uploader_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: number;
  /** 绑定事件序号；旧行 NULL 时回退 created_at。 */
  created_seq: number | null;
  expires_at: number;
  /** 被有效任务/成果引用时置 1，不随 `expires_at` 清理。 */
  retained: number;
  deleted_at: number | null;
  deleted_by: string | null;
}

/** 应用层上传登记；字节仍在 MCPP Files/FlyDrive。 */
export interface DriveFileRow {
  file_id: string;
  owner_scope: string;
  uploader_id: string | null;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  state: 'draft' | 'bound' | 'deleted';
  visibility: 'private' | 'public';
  room_id: string | null;
  created_at: number;
  /** NULL 表示保留中，不参与 TTL 清理。 */
  expires_at: number | null;
  retained: number;
  deleted_at: number | null;
  deleted_by: string | null;
  purged_at: number | null;
}

/** 成果版本；每个 file_id 至多一条。 */
export interface ArtifactRow {
  artifact_id: string;
  room_id: string;
  version: number;
  file_id: string;
  created_by: string;
  summary: string;
  status: 'delivered' | 'released';
  created_at: number;
  created_seq: number | null;
  released_at: number | null;
  released_by: string | null;
}

/** 成果/转发/收藏对文件的保留引用。 */
export interface FileReferenceRow {
  reference_id: string;
  file_id: string;
  kind: 'artifact' | 'forward' | 'favorite';
  ref_id: string;
  room_id: string | null;
  actor_id: string;
  state: 'active' | 'released';
  created_at: number;
  released_at: number | null;
  released_by: string | null;
}

/** 每个 human 在每个房间私有的网页监控地址；无行表示未配置。 */
export interface ActorRoomMonitorRow {
  actor_id: string;
  room_id: string;
  url: string;
  created_at: number;
  updated_at: number;
}

/** MCP Events webhook 订阅；secret 以 AES-GCM 密文落库。 */
export interface EventSubscriptionRow {
  subscription_id: string;
  actor_id: string;
  event_name: string;
  arguments_json: string;
  callback_url: string;
  callback_url_key: string;
  credential_id: string;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  previous_secret_expires_at: number | null;
  refresh_before: number;
  scanned_seq: number;
  last_scan_at: number;
  last_delivery_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  active: number;
  verified_at: number;
  created_at: number;
  updated_at: number;
}

export type EventDeliveryStatus = 'pending' | 'processing' | 'delivered' | 'abandoned';

/** MCP Events 单事件投递；payload_json 是发送时的精确字节。 */
export interface EventDeliveryRow {
  delivery_id: string;
  subscription_id: string;
  event_seq: number;
  event_id: string;
  payload_json: string;
  status: EventDeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
  last_http_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
}

export interface WebhookVerificationRow {
  actor_id: string;
  callback_url_key: string;
  verified_at: number;
  expires_at: number;
}
