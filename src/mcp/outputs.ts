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

export const memberSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  role: z.enum(['owner', 'member']),
  joined_seq: z.string(),
  joined_at: z.string(),
  last_read_seq: z.string(),
  /** Agent 在线状态；null 表示未知，人类成员恒为 null。 */
  online: z.boolean().nullable(),
});

export const roomSchema = z.object({
  room_id: z.string(),
  kind: z.enum(['direct', 'group']),
  owner_id: z.string().nullable(),
  title: z.string(),
  head_seq: z.string(),
  member_seq: z.string(),
  member_count: z.number(),
  my_role: z.enum(['owner', 'member']),
  my_last_read_seq: z.string(),
  last_message: messagePreviewSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const roomDetailSchema = z.object({
  room: roomSchema,
  members: z.array(memberSchema),
});

export const contactSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  created_at: z.string(),
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

export const roomFileResultSchema = z.object({ file: roomFileSchema });

export const roomFilePageSchema = z.object({
  items: z.array(roomFileSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
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
