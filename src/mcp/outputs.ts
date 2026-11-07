import { z } from 'zod';

export const identitySchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  agent_session_id: z.string().nullable(),
  name: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  pending_count: z.number(),
  inbox_head_seq: z.string(),
  created_at: z.string(),
  share_url: z.string().nullable(),
  resources: z.array(z.string()),
});

/** `network_issue_token` 的返回值；URL 本身即长期凭据。 */
export const issuedTokenSchema = z.object({
  token: z.string(),
  url: z.string(),
});

export const messagePreviewSchema = z.object({
  message_id: z.string(),
  sender_id: z.string(),
  created_seq: z.string(),
  preview: z.string(),
  body_bytes: z.number(),
  created_at: z.string(),
});

export const messageSchema = messagePreviewSchema.extend({
  room_id: z.string(),
  reply_to: z.string().nullable(),
  root_id: z.string().nullable(),
  hop: z.number(),
  delivery_states: z.record(z.string(), z.number()),
  /** claimed 投递的领取时间与最近更新时间；用于网页“处理中未更新”提示。 */
  delivery_claimed_at: z.string().nullable(),
  delivery_updated_at: z.string().nullable(),
});

/** 历史页额外返回权威 sender_kind；send/complete 的消息结构保持不变。 */
export const historyMessageSchema = messageSchema.extend({
  sender_kind: z.enum(['human', 'agent']).nullable(),
});

const roomMemberActionsSchema = z.object({
  can_remove: z.boolean(),
  can_set_admin: z.boolean(),
  can_revoke_admin: z.boolean(),
  can_transfer_owner: z.boolean(),
});

export const memberSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  role_revision: z.number(),
  /** 成员代次；重新加入后递增，旧游标/旧票据不能跨代次。 */
  member_generation: z.number(),
  joined_seq: z.string(),
  joined_at: z.string(),
  last_read_seq: z.string(),
  /** Agent 在线状态；null 表示未知，人类成员恒为 null。 */
  online: z.boolean().nullable(),
  /** 服务端按调用者角色与目标角色计算的成员操作；前端只据此显示入口。 */
  actions: roomMemberActionsSchema,
});

const groupPolicySchema = z.enum(['members', 'owner_admin']);
const groupHistoryPolicySchema = z.enum(['from_join', 'full']);
const groupJoinPolicySchema = z.enum(['open', 'approval']);

/** 读取请求采用的授权快照；用于跨入口核对同一份策略/代次。 */
export const authorizationSnapshotSchema = z.object({
  policy_revision: z.number(),
  history_from_seq: z.string(),
  member_generation: z.string(),
});

const roomCapabilitiesSchema = z.object({
  send_message: z.boolean(),
  create_task: z.boolean(),
  invite_members: z.boolean(),
  remove_members: z.boolean(),
  manage_admins: z.boolean(),
  manage_announcement: z.boolean(),
  manage_policy: z.boolean(),
  transfer_owner: z.boolean(),
  approve_joins: z.boolean(),
  mention_all: z.boolean(),
  view_role_history: z.boolean(),
});

export const roomSchema = z.object({
  room_id: z.string(),
  kind: z.enum(['direct', 'group']),
  owner_id: z.string().nullable(),
  title: z.string(),
  head_seq: z.string(),
  member_seq: z.string(),
  member_count: z.number(),
  my_role: z.enum(['owner', 'admin', 'member']),
  my_role_revision: z.number(),
  my_last_read_seq: z.string(),
  my_member_generation: z.number(),
  history_from_seq: z.string(),
  authorization: authorizationSnapshotSchema,
  policy_revision: z.number(),
  policies: z.object({
    member_message: groupPolicySchema,
    member_invite: groupPolicySchema,
    member_task: groupPolicySchema,
    member_history: groupHistoryPolicySchema,
    member_join: groupJoinPolicySchema,
    member_profile: groupPolicySchema,
    member_mention_all: groupPolicySchema,
  }),
  announcement: z.string(),
  announcement_revision: z.number(),
  announcement_updated_at: z.string().nullable(),
  announcement_updated_by: z.string().nullable(),
  capabilities: roomCapabilitiesSchema,
  last_message: messagePreviewSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** 待确认群主转让；can_* 由服务端按调用者身份计算，页面只据此显示入口。 */
export const ownerTransferSchema = z.object({
  transfer_id: z.string(),
  room_id: z.string(),
  from_owner_id: z.string(),
  from_owner_name: z.string(),
  to_actor_id: z.string(),
  to_actor_name: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired']),
  version: z.number(),
  expires_at: z.string(),
  created_at: z.string(),
  can_accept: z.boolean(),
  can_reject: z.boolean(),
  can_cancel: z.boolean(),
});

export const roomDetailSchema = z.object({
  room: roomSchema,
  members: z.array(memberSchema),
  /** 待确认邀请；只有群主/管理员可见，不计入 member_count。 */
  invited: z.array(
    z.object({
      invitation_id: z.string(),
      actor_id: z.string(),
      kind: z.enum(['human', 'agent']),
      name: z.string(),
      invited_by: z.string(),
      invited_at: z.string(),
      expires_at: z.string(),
    }),
  ),
  /** 当前有效的群主转让提议；没有 pending 时为 null。 */
  owner_transfer: ownerTransferSchema.nullable(),
});

export const roomCreateMemberResultSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  status: z.enum(['active', 'invited', 'failed']),
  code: z.string().nullable(),
  message: z.string().nullable(),
});

/** 建群返回额外的逐对象结果；room_get 仍是纯 RoomDetail。 */
export const roomCreateResultSchema = roomDetailSchema.extend({
  results: z.array(roomCreateMemberResultSchema).optional(),
});

/** 策略变更影响；只在 network_room_policy_set 返回。 */
export const roomPolicyImpactSchema = z.object({
  history_policy: groupHistoryPolicySchema,
  affected_members: z.number(),
  hidden_tasks: z.number(),
  hidden_files: z.number(),
  material_loss: z.boolean(),
  message: z.string(),
});

export const roomPolicySetResultSchema = roomDetailSchema.extend({
  policy_impact: roomPolicyImpactSchema.optional(),
});

export const roomInvitationSchema = z.object({
  invitation_id: z.string(),
  room_id: z.string(),
  room_title: z.string(),
  inviter_id: z.string(),
  inviter_name: z.string(),
  target_actor_id: z.string().nullable(),
  kind: z.enum(['direct', 'link']),
  status: z.enum(['pending', 'accepted', 'rejected', 'revoked', 'expired', 'exhausted']),
  expires_at: z.string(),
  created_at: z.string(),
  can_respond: z.boolean(),
});

export const roomInvitationPageSchema = z.object({
  items: z.array(roomInvitationSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const roomInvitationRespondSchema = z.object({
  invitation_id: z.string(),
  room_id: z.string(),
  status: z.enum(['accepted', 'rejected']),
});

export const contactSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  /** active 表示双方已建立好友关系；none 只是自己的历史收藏。 */
  relation: z.enum(['active', 'none']),
  created_at: z.string(),
});

export const contactActorSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
});

export const contactRelationSchema = z.object({
  pair_key: z.string(),
  actor_ids: z.array(z.string()),
  status: z.enum(['active', 'ended']),
  source: z.enum(['request', 'auto_manager']),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
});

export const contactRequestSchema = z.object({
  contact_request_id: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired']),
  direction: z.enum(['incoming', 'outgoing']),
  message: z.string(),
  auto_accepted: z.boolean(),
  from_actor: contactActorSchema,
  to_actor: contactActorSchema,
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
  responded_at: z.string().nullable(),
  responded_by: z.string().nullable(),
  can_respond: z.boolean(),
  can_cancel: z.boolean(),
});

export const contactRequestResultSchema = z.object({
  request: contactRequestSchema.nullable(),
  relation: contactRelationSchema.nullable(),
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired']),
  already_friends: z.boolean(),
  auto_accepted: z.boolean(),
});

export const contactRequestPageSchema = z.object({
  items: z.array(contactRequestSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const contactPolicySchema = z.object({
  actor_id: z.string(),
  name: z.string(),
  kind: z.enum(['human', 'agent']),
  policy: z.enum(['self_approval', 'manager_approval', 'auto_accept']),
  configured: z.boolean(),
  approver_actor_id: z.string().nullable(),
  approver_name: z.string().nullable(),
});

export const contactBlockSchema = z.object({
  block_id: z.string(),
  blocker_actor_id: z.string(),
  blocked_actor: contactActorSchema,
  reason: z.string(),
  mute_mentions: z.boolean(),
  created_at: z.string(),
  active: z.boolean(),
  released_at: z.string().nullable(),
  released_by: z.string().nullable(),
});

export const contactBlockResultSchema = z.object({
  block: contactBlockSchema,
  already_blocked: z.boolean(),
});

export const contactUnblockResultSchema = z.object({
  block: contactBlockSchema.nullable(),
  released: z.boolean(),
});

export const contactBlockPageSchema = z.object({
  items: z.array(contactBlockSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const contactReportSchema = z.object({
  report_id: z.string(),
  reporter_actor_id: z.string(),
  target_actor: contactActorSchema,
  category: z.enum(['harassment', 'spam', 'fraud', 'other']),
  note: z.string(),
  room_id: z.string().nullable(),
  message_id: z.string().nullable(),
  status: z.enum(['received']),
  created_at: z.string(),
  updated_at: z.string(),
});

export const contactReportResultSchema = z.object({ report: contactReportSchema });

export const contactReportPageSchema = z.object({
  items: z.array(contactReportSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const deliverySchema = z.object({
  delivery_id: z.string(),
  recipient_id: z.string(),
  message_id: z.string(),
  room_id: z.string(),
  state: z.enum(['pending', 'claimed', 'completed', 'failed', 'cancelled']),
  attempt: z.number(),
  claim_id: z.string().nullable(),
  claimed_at: z.string().nullable(),
  progress_at: z.string().nullable(),
  result_message_id: z.string().nullable(),
  error: z.string().nullable(),
  created_seq: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  message: messagePreviewSchema.nullable(),
});

export const eventRefSchema = z.object({
  seq: z.string(),
  scope: z.string(),
  type: z.string(),
  ref_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const contactPageSchema = z.object({
  items: z.array(contactSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const roomPageSchema = z.object({
  items: z.array(roomSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const timelinePresenceSchema = z.object({
  kind: z.literal('presence'),
  presence_event_id: z.string(),
  room_id: z.string(),
  agent_id: z.string(),
  transition: z.enum(['online', 'offline']),
  occurred_at: z.string(),
  recorded_at: z.string(),
  timeline_seq: z.string(),
  time_basis: z.enum(['observed', 'inferred']),
});

export const timelineMessageSchema = historyMessageSchema.extend({
  kind: z.literal('message'),
});

export const timelineItemSchema = z.union([timelineMessageSchema, timelinePresenceSchema]);

export const historyPageSchema = z.object({
  items: z.array(historyMessageSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  snapshot: z.string(),
  head_seq: z.string(),
  authorization: authorizationSnapshotSchema.optional(),
  /** timeline 模式下存在；messages 默认不返回。 */
  view: z.enum(['messages', 'timeline']).optional(),
  timeline_items: z.array(timelineItemSchema).optional(),
  timeline_next_cursor: z.string().nullable().optional(),
  timeline_has_more: z.boolean().optional(),
  timeline_snapshot: z.string().optional(),
  timeline_resume_cursor: z.string().optional(),
});

export const inboxPageSchema = z.object({
  items: z.array(deliverySchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  pending_count: z.number(),
  claimed_delivery_id: z.string().nullable(),
});

export const syncPageSchema = z.object({
  scope: z.string(),
  items: z.array(eventRefSchema),
  next_cursor: z.string(),
  has_more: z.boolean(),
  head_seq: z.string(),
  min_seq: z.string(),
  reset_required: z.boolean(),
});

export const readChunkSchema = z.object({
  message_id: z.string(),
  room_id: z.string(),
  chunk: z.string(),
  chunk_cursor: z.string(),
  next_cursor: z.string().nullable(),
  eof: z.boolean(),
  body_bytes: z.number(),
  created_seq: z.string(),
});

export const sendResultSchema = z.object({
  message: messageSchema,
  delivery_ids: z.array(z.string()),
});

/** 发送对账只返回定位信息，不返回正文、preview 或成员资格。 */
export const messageSendStatusItemSchema = z.object({
  client_message_id: z.string(),
  found: z.boolean(),
  message_id: z.string().nullable(),
  room_id: z.string().nullable(),
  created_seq: z.string().nullable(),
  delivery_ids: z.array(z.string()),
  body_bytes: z.number().nullable(),
  created_at: z.string().nullable(),
});

export const messageSendStatusPageSchema = z.object({
  items: z.array(messageSendStatusItemSchema),
});

export const completeResultSchema = z.object({
  delivery: deliverySchema,
  message: messageSchema.nullable(),
});

export const recoveryTicketSchema = z.object({
  ticket: z.string(),
  expires_at: z.string(),
});

export const recoveredIdentitySchema = identitySchema.extend({ recovered: z.literal(true) });

export const profileResultSchema = identitySchema;

/** 重发结果只在首次响应返回 raw token；重放不返回 token。 */
export const agentReissueTokenResultSchema = z.object({
  actor_id: z.string(),
  token: z.string(),
  mcp_url: z.string(),
  revoked_count: z.number(),
  issued_at: z.string(),
});

export const agentRenameResultSchema = z.object({
  actor_id: z.string(),
  name: z.string(),
  updated_at: z.string(),
});

/** 自助改名结果：actor_id 恒为调用者自己，不返回其他 actor 信息。 */
export const meRenameResultSchema = agentRenameResultSchema;

/** 软归档结果；archived_at 保留首次归档时间，重复归档不刷新。 */
export const agentArchiveResultSchema = z.object({
  actor_id: z.string(),
  archived: z.literal(true),
  archived_at: z.string(),
  archived_by: z.string(),
});

export const agentUnarchiveResultSchema = z.object({
  actor_id: z.string(),
  archived: z.literal(false),
  archived_at: z.null(),
  archived_by: z.null(),
});

/** Agent 管理摘要；不返回 metadata、凭据或 token。 */
export const agentSummarySchema = z.object({
  actor_id: z.string(),
  kind: z.literal('agent'),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  share_url: z.string().nullable(),
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  archived_by: z.string().nullable(),
  disabled: z.boolean(),
  disabled_at: z.string().nullable(),
  disabled_by: z.string().nullable(),
  disabled_reason: z.string().nullable(),
});

export const agentsGetResultSchema = z.object({
  items: z.array(agentSummarySchema),
  missing_actor_ids: z.array(z.string()),
});

export const managementBindingSchema = z.object({
  binding_id: z.string(),
  manager_id: z.string(),
  manager_name: z.string(),
  status: z.literal('active'),
  grant_source: z.enum(['created', 'claim', 'transfer', 'legacy']),
  permission_version: z.number(),
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
});

export const delegationViewSchema = z.object({
  delegation_id: z.string(),
  delegate_actor_id: z.string(),
  scopes: z.array(z.string()),
  permission_version: z.number(),
  expires_at: z.string().nullable(),
});

export const openTaskSchema = z.object({
  task_id: z.string(),
  room_id: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'claimed']),
  updated_at: z.string(),
});

export const pendingWorkSchema = z.object({
  pending_deliveries: z.number(),
  claimed_deliveries: z.number(),
  cancelled_deliveries: z.number(),
  open_tasks: z.array(openTaskSchema),
  open_task_count: z.number(),
});

export const agentManagementGetResultSchema = z.object({
  actor_id: z.string(),
  kind: z.literal('agent'),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  share_url: z.string().nullable(),
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  archived_by: z.string().nullable(),
  disabled: z.boolean(),
  disabled_at: z.string().nullable(),
  disabled_by: z.string().nullable(),
  disabled_reason: z.string().nullable(),
  my_role: z.enum(['manager', 'delegate', 'agent']),
  management: managementBindingSchema.nullable(),
  delegation: delegationViewSchema.nullable(),
  can_manage: z.boolean(),
  can_delegate: z.boolean(),
  pending_work: pendingWorkSchema,
});

export const agentManagedItemSchema = z.object({
  actor_id: z.string(),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  share_url: z.string().nullable(),
  archived: z.boolean(),
  disabled: z.boolean(),
  role: z.enum(['manager', 'delegate']),
  permission_version: z.number(),
  since: z.string(),
});

export const agentsManagedListResultSchema = z.object({
  items: z.array(agentManagedItemSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const agentCreateResultSchema = z.object({
  actor_id: z.string(),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  share_url: z.string(),
  token: z.string(),
  mcp_url: z.string(),
  issued_at: z.string(),
  management: z.object({
    binding_id: z.string(),
    permission_version: z.number(),
    created_at: z.string(),
  }),
});

export const agentClaimStartResultSchema = z.object({
  claim_id: z.string(),
  agent_id: z.string(),
  code: z.string(),
  expires_at: z.string(),
  max_attempts: z.number(),
});

export const agentClaimConfirmResultSchema = z.object({
  claim_id: z.string(),
  agent_id: z.string(),
  manager_id: z.string(),
  binding_id: z.string(),
  permission_version: z.number(),
  confirmed_at: z.string(),
});

export const agentClaimCancelResultSchema = z.object({
  claim_id: z.string(),
  status: z.literal('cancelled'),
});

export const agentDelegateGrantResultSchema = z.object({
  delegation_id: z.string(),
  actor_id: z.string(),
  delegate_actor_id: z.string(),
  scopes: z.array(z.string()),
  permission_version: z.number(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
});

export const agentDelegateRevokeResultSchema = z.object({
  delegation_id: z.string(),
  actor_id: z.string(),
  delegate_actor_id: z.string(),
  status: z.literal('revoked'),
  revoked_at: z.string(),
});

export const agentDisableResultSchema = z.object({
  actor_id: z.string(),
  disabled: z.literal(true),
  disabled_at: z.string(),
  disabled_by: z.string(),
  disabled_reason: z.string().nullable(),
  stopped: pendingWorkSchema,
});

export const agentEnableResultSchema = z.object({
  actor_id: z.string(),
  disabled: z.literal(false),
  enabled_at: z.string(),
});

export const taskCountsSchema = z.object({
  pending: z.number(),
  claimed: z.number(),
  done: z.number(),
  failed: z.number(),
  total: z.number(),
});

export const loginResultSchema = z.object({
  actor_id: z.string(),
  online: z.literal(true),
  logged_in_at: z.string(),
  pending_count: z.number(),
  inbox_head_seq: z.string(),
  task_summary: taskCountsSchema,
});

export const removedResultSchema = z.object({
  actor_id: z.string(),
  removed: z.literal(true),
});

export const leaveResultSchema = z.object({ room_id: z.string(), left: z.literal(true) });

export const roomRoleAuditSchema = z.object({
  audit_id: z.string(),
  room_id: z.string(),
  action: z.enum([
    'member_added',
    'member_removed',
    'member_left',
    'admin_appointed',
    'admin_revoked',
    'owner_transferred',
    'owner_transfer_proposed',
    'owner_transfer_accepted',
    'owner_transfer_rejected',
    'owner_transfer_cancelled',
    'owner_transfer_expired',
    'policy_updated',
    'announcement_updated',
  ]),
  target_actor_id: z.string().nullable(),
  target_name: z.string().nullable(),
  previous_role: z.enum(['owner', 'admin', 'member']).nullable(),
  new_role: z.enum(['owner', 'admin', 'member']).nullable(),
  previous_status: z.enum(['active', 'left', 'removed']).nullable(),
  new_status: z.enum(['active', 'left', 'removed']).nullable(),
  expected_revision: z.number().nullable(),
  resulting_revision: z.number(),
  changed_by: z.string(),
  changed_by_name: z.string().nullable(),
  request_id: z.string(),
  detail: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const roomRoleHistorySchema = z.object({
  items: z.array(roomRoleAuditSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/** 普通成员可见的管理事件摘要；不含 request_id、detail 或版本字段。 */
export const roomNoticeSchema = z.object({
  audit_id: z.string(),
  action: z.enum([
    'member_added',
    'member_removed',
    'member_left',
    'admin_appointed',
    'admin_revoked',
    'owner_transferred',
    'owner_transfer_proposed',
    'owner_transfer_accepted',
    'owner_transfer_rejected',
    'owner_transfer_cancelled',
    'owner_transfer_expired',
    'policy_updated',
    'announcement_updated',
  ]),
  target_actor_id: z.string().nullable(),
  changed_by: z.string(),
  changed_by_name: z.string().nullable(),
  summary: z.string(),
  created_at: z.string(),
});

export const roomNoticePageSchema = z.object({
  items: z.array(roomNoticeSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const markReadResultSchema = z.object({ room_id: z.string(), last_read_seq: z.string() });

export const progressResultSchema = z.object({
  delivery_id: z.string(),
  attempt: z.number(),
  progress_at: z.string(),
});

/** 房间文件的公开视图；public/preview/download URL 都由 PUBLIC_ORIGIN 派生。 */
export const roomFileSchema = z.object({
  room_file_id: z.string(),
  room_id: z.string(),
  file_id: z.string(),
  name: z.string(),
  mime_type: z.string(),
  size: z.number(),
  sha256: z.string(),
  public_url: z.string(),
  preview_url: z.string(),
  download_url: z.string(),
  preview_kind: z.enum(['image', 'pdf', 'text', 'audio', 'video', 'download']),
  uploader_id: z.string(),
  uploader_name: z.string(),
  can_delete: z.boolean(),
  created_at: z.string(),
  expires_at: z.string(),
});

export const roomFileResultSchema = z.object({
  file: roomFileSchema,
  authorization: authorizationSnapshotSchema,
});

export const roomFilePageSchema = z.object({
  items: z.array(roomFileSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  authorization: authorizationSnapshotSchema,
});

export const roomFileDeletedSchema = z.object({
  file_id: z.string(),
  deleted: z.literal(true),
});

/** 当前 human 在此会话私有的网页监控地址；null 表示未配置。 */
export const roomMonitorSchema = z.object({
  room_id: z.string(),
  url: z.string(),
  updated_at: z.string(),
});

export const roomMonitorResultSchema = z.object({
  monitor: roomMonitorSchema.nullable(),
});

/** 房间任务短视图；不包含房间成员列表或任何凭据。 */
export const roomTaskSchema = z.object({
  task_id: z.string(),
  room_id: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'claimed', 'done', 'failed']),
  assignee_actor_id: z.string().nullable(),
  assignee_name: z.string().nullable(),
  result: z.string().nullable(),
  created_by: z.string(),
  created_by_name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  can_edit: z.boolean(),
  can_claim: z.boolean(),
  can_complete: z.boolean(),
});

export const roomTaskResultSchema = z.object({ task: roomTaskSchema });

export const roomTaskListSchema = z.object({
  tasks: z.array(roomTaskSchema),
  total: z.number(),
  done: z.number(),
  authorization: authorizationSnapshotSchema,
});

export const roomTaskDeletedSchema = z.object({
  task_id: z.string(),
  deleted: z.literal(true),
});

/** 侧栏任务进度；一次返回多个 active 房间，避免 N 次 list。 */
export const roomTaskSummarySchema = z.object({
  items: z.array(
    taskCountsSchema.extend({
      room_id: z.string(),
    }),
  ),
});

/** 反馈提交结果：不回显 environment/harness/problem。 */
export const feedbackCreateResultSchema = z.object({
  feedback_id: z.string(),
  created_at: z.string(),
});
