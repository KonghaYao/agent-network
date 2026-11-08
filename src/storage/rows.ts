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
  source: 'request' | 'auto_manager';
  request_id: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  ended_by: string | null;
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
  member_task_policy: GroupMemberPolicy;
  member_history_policy: GroupHistoryPolicy;
  member_join_policy: GroupJoinPolicy;
  member_profile_policy: GroupMemberPolicy;
  member_mention_all_policy: GroupMemberPolicy;
  announcement: string;
  announcement_revision: number;
  announcement_updated_at: number | null;
  announcement_updated_by: string | null;
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
  | 'join_rejected';

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
  task_id: string | null;
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

/** 任务/成果/转发/收藏对文件的保留引用。 */
export interface FileReferenceRow {
  reference_id: string;
  file_id: string;
  kind: 'task' | 'artifact' | 'forward' | 'favorite';
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

/** 房间任务；状态机 pending -> claimed -> done|failed。 */
export interface RoomTaskRow {
  task_id: string;
  room_id: string;
  list_id: string;
  description: string;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  assignee_actor_id: string | null;
  result: string | null;
  created_by: string;
  created_at: number;
  /** 创建事件序号；旧行 NULL 时回退 created_at。 */
  created_seq: number | null;
  updated_at: number;
  completed_at: number | null;
  sort_order: number;
}

/** D01 任务；旧 `room_tasks` 迁移后只读保留。 */
export interface TaskRow {
  task_id: string;
  room_id: string;
  created_by: string;
  source_message_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  status:
    | 'unassigned'
    | 'offered'
    | 'in_progress'
    | 'blocked'
    | 'submitted'
    | 'accepted'
    | 'failed'
    | 'cancelled'
    | 'legacy_completed';
  revision: number;
  owner_actor_id: string | null;
  current_assignment_id: string | null;
  /** 创建参数里的负责人；公开任务为 NULL，后续 claim/offer 不修改。 */
  initial_assignee_actor_id: string | null;
  /** 1 表示 `initial_assignee_actor_id` 是权威答案；0 表示旧行未知。 */
  initial_assignee_known: 0 | 1;
  reviewer_actor_id: string;
  due_at: number | null;
  blocked_reason: string | null;
  blocked_at: number | null;
  last_progress_at: number | null;
  business_authority: 'native' | 'external';
  external_binding_id: string | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
  cancelled_at: number | null;
}

export interface TaskAssignmentRow {
  assignment_id: string;
  task_id: string;
  assignment_version: number;
  owner_actor_id: string;
  status: 'offered' | 'active' | 'submitted' | 'declined' | 'revoked' | 'expired';
  offered_by: string;
  offer_expires_at: number | null;
  accepted_at: number | null;
  ended_at: number | null;
  last_progress_at: number | null;
  delivery_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskCardRow {
  task_id: string;
  message_id: string;
  room_id: string;
  created_at: number;
}

export interface TaskAttachmentRow {
  task_id: string;
  file_id: string;
  label: string;
  created_at: number;
}

/**
 * 任务进度/阻塞/恢复审计；`tasks.status` 仍是唯一当前状态。
 *
 * `task_revision` 与 `tasks.revision` 同一事务递增，唯一索引保证一个版本
 * 只有一条记录。普通进度不产生消息、delivery 或 inbox 待办。
 */
export interface TaskProgressRow {
  progress_id: string;
  task_id: string;
  task_revision: number;
  assignment_id: string | null;
  assignment_version: number | null;
  actor_id: string;
  prior_status: TaskRow['status'];
  status: TaskRow['status'];
  percent: number | null;
  note: string;
  blocked_reason: string | null;
  created_at: number;
}

export interface TaskDeliveryRow {
  delivery_id: string;
  task_id: string;
  assignment_id: string;
  assignment_version: number;
  task_revision: number;
  kind: 'task_offer' | 'task_reminder';
  created_at: number;
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
