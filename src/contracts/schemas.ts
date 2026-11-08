import { z } from 'zod';

import { FILE_ID_PATTERN } from '@peri-code/mcpp/files';

import { LIMITS } from './limits';

const id = (max = 128) => z.string().min(1).max(max);
const requestId = z.string().min(1).max(128);
const cursor = z.string().min(1).max(2048).optional();
const seq = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,18}$/u)]);

export const registerSchema = z.object({
  request_id: requestId,
  kind: z.enum(['human', 'agent']),
  actor_id: id().optional(),
  agent_session_id: id(256).optional(),
  device_id: id(256).optional(),
  name: z.string().min(1).max(LIMITS.actorNameMax),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** 无鉴权、无数据库写入的长期 URL 凭据申请。 */
export const issueTokenSchema = z.object({});

export const meSchema = z.object({});

/** 显式上线没有业务写入；重复调用只刷新上线时间，不需要 request_id。 */
export const loginSchema = z.object({});

export const profileUpdateSchema = z.object({
  request_id: requestId,
  name: z.string().min(1).max(LIMITS.actorNameMax).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** 全局重命名一个 Agent actor；任何已注册身份都可调用。 */
export const agentRenameSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  name: z.string().trim().min(1).max(LIMITS.actorNameMax),
  expected_permission_version: z.number().int().positive().optional(),
});

/**
 * 修改自己的展示名称；没有 actor_id，任何 principal 只能改自己。
 *
 * 字符/字节/控制字符校验在领域层完成，以便返回可读的 INVALID_ARGUMENT；
 * schema 只做宽松上限，避免超长请求进入业务。
 */
export const meRenameSchema = z.object({
  request_id: requestId,
  name: z.string().trim().max(LIMITS.actorNameMax * 2),
});

/** 注销目标 Agent 的全部现有凭据并签发新 token；token 只返回一次。 */
export const agentReissueTokenSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  expected_permission_version: z.number().int().positive().optional(),
});

/** 软归档 Agent；只影响管理列表，不参与授权。 */
export const agentArchiveSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  expected_permission_version: z.number().int().positive().optional(),
});

/** 取消 Agent 归档；可逆且幂等。 */
export const agentUnarchiveSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  expected_permission_version: z.number().int().positive().optional(),
});

/**
 * 创建 Agent：当前 human 凭据原子创建 Agent、管理绑定与初始 credential。
 *
 * 新 Agent token 由服务端生成且只在首次响应返回；agent_session_id 可省略，
 * 由服务端生成。
 */
export const agentCreateSchema = z.object({
  request_id: requestId,
  name: z.string().min(1).max(LIMITS.actorNameMax),
  agent_session_id: id(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const agentManagementGetSchema = z.object({ actor_id: id() });

export const agentsManagedListSchema = z.object({
  cursor,
  limit: z.number().int().min(1).max(LIMITS.managedAgentsPageMax).optional(),
});

/** Agent 用自身凭据发起一次性认领；返回的 claim code 只在首次响应出现。 */
export const agentClaimStartSchema = z.object({ request_id: requestId, expires_in_ms: z.number().int().min(60_000).max(3_600_000).optional() });

/** human 用 claim code 完成双端认领。 */
export const agentClaimConfirmSchema = z.object({
  request_id: requestId,
  claim_id: id(),
  code: z.string().min(16).max(256),
});

/** Agent 取消自己尚未确认的认领。 */
export const agentClaimCancelSchema = z.object({ request_id: requestId, claim_id: id() });

/** 管理者授予有限管理委托；target 必须是已注册 human。 */
export const agentDelegateGrantSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  delegate_actor_id: id(),
  scopes: z.array(z.enum(['manage_agent'])).min(1).max(1).optional(),
  expires_in_ms: z.number().int().min(60_000).max(365 * 24 * 60 * 60_000).optional(),
});

export const agentDelegateRevokeSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  delegate_actor_id: id(),
});

export const agentDisableSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  reason: z.string().max(LIMITS.agentDisableReasonBytes * 2).optional(),
  expected_permission_version: z.number().int().positive().optional(),
});

export const agentEnableSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  expected_permission_version: z.number().int().positive().optional(),
});

/** 按已知 actor_id 批量读取 Agent 摘要；不做全局枚举。 */
export const agentsGetSchema = z.object({
  actor_ids: z.array(id()).min(1).max(LIMITS.agentLookupMax),
});

export const recoveryCreateSchema = z.object({ request_id: requestId });

export const recoveryRedeemSchema = z.object({
  request_id: requestId,
  ticket: z.string().min(16).max(512),
  device_id: id(256),
});

export const contactsListSchema = z.object({ cursor, limit: z.number().int().min(1).max(100).optional() });

export const contactAddSchema = z.object({
  request_id: requestId,
  actor_id: id().optional(),
  agent_session_id: id(256).optional(),
});

export const contactRemoveSchema = z.object({ request_id: requestId, actor_id: id() });

export const contactRequestSchema = z.object({
  request_id: requestId,
  actor_id: id().optional(),
  agent_session_id: id(256).optional(),
  /** 申请附言；只进入好友申请入口，不写入任何 direct 房间。 */
  message: z.string().trim().max(LIMITS.contactRequestMessageBytes * 2).optional(),
  /** 测试与运营可缩短有效期；默认 LIMITS.contactRequestTtlMs。 */
  expires_in_ms: z.number().int().min(1_000).max(LIMITS.contactRequestTtlMs).optional(),
});

export const contactRequestsListSchema = z.object({
  direction: z.enum(['all', 'incoming', 'outgoing']).optional(),
  status: z
    .enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired'])
    .optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.contactRequestsPageMax).optional(),
});

export const contactRequestIdSchema = z.object({
  request_id: requestId,
  contact_request_id: id(),
});

export const contactRequestRespondSchema = contactRequestIdSchema.extend({
  action: z.enum(['accept', 'reject']),
});

export const contactPolicyGetSchema = z.object({ actor_id: id().optional() });

export const contactPolicySetSchema = z.object({
  request_id: requestId,
  actor_id: id().optional(),
  policy: z.enum(['self_approval', 'manager_approval', 'auto_accept']),
});

export const contactBlockSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  reason: z.string().max(LIMITS.contactBlockReasonBytes * 2).optional(),
  /** 共同群里来自被拉黑者的定向 @ 是否静默；默认 true。 */
  mute_mentions: z.boolean().optional(),
});

export const contactUnblockSchema = z.object({
  request_id: requestId,
  actor_id: id(),
});

export const contactBlocksListSchema = z.object({
  cursor,
  limit: z.number().int().min(1).max(LIMITS.contactBlocksPageMax).optional(),
});

export const contactReportSchema = z.object({
  request_id: requestId,
  target_actor_id: id(),
  category: z.enum(['harassment', 'spam', 'fraud', 'other']),
  note: z.string().max(LIMITS.contactReportNoteBytes * 2).optional(),
  room_id: id().optional(),
  message_id: id().optional(),
});

export const contactReportsListSchema = z.object({
  cursor,
  limit: z.number().int().min(1).max(LIMITS.contactReportsPageMax).optional(),
});

export const roomCreateSchema = z.object({
  request_id: requestId,
  kind: z.enum(['direct', 'group']),
  members: z.array(id()).min(1).max(LIMITS.memberChangeMax),
  title: z.string().max(160).optional(),
});

export const roomsListSchema = z.object({ cursor, limit: z.number().int().min(1).max(100).optional() });

export const roomGetSchema = z.object({ room_id: id() });

export const roomMembersUpdateSchema = z.object({
  request_id: requestId,
  room_id: id(),
  add: z.array(id()).max(LIMITS.memberChangeMax).optional(),
  remove: z.array(id()).max(LIMITS.memberChangeMax).optional(),
  transfer_owner_to: id().optional(),
  /** 单个移除目标的角色版本；可选，提供时按事务提交序裁决。 */
  expected_role_revision: z.number().int().positive().optional(),
});

const groupPolicy = z.enum(['members', 'owner_admin']);
const groupHistoryPolicy = z.enum(['from_join', 'full']);
const groupJoinPolicy = z.enum(['open', 'approval']);

/** 群主任免管理员；expected revision 是目标成员当前 `role_revision`。 */
export const roomRoleSetSchema = z.object({
  request_id: requestId,
  room_id: id(),
  actor_id: id(),
  role: z.enum(['admin', 'member']),
  expected_role_revision: z.number().int().positive(),
});

/** 发起群主转让提议；目标必须接受后才生效。 */
export const roomOwnerTransferProposeSchema = z.object({
  request_id: requestId,
  room_id: id(),
  target_actor_id: id(),
  /** 读取时的目标角色版本；提供时在提交前复核，避免角色漂移。 */
  expected_role_revision: z.number().int().positive().optional(),
});

/** 兼容旧工具名：`network_room_owner_transfer` 现在只发起待确认提议。 */
export const roomOwnerTransferSchema = roomOwnerTransferProposeSchema;

/** 目标接受或拒绝待确认转让；expected_version 是提议当前版本。 */
export const roomOwnerTransferRespondSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  action: z.enum(['accept', 'reject']),
  expected_version: z.number().int().positive(),
});

/** 发起人取消待确认转让；expected_version 是提议当前版本。 */
export const roomOwnerTransferCancelSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  expected_version: z.number().int().positive(),
});

/** 群主设置普通成员发言/邀请/任务/历史/审批/@所有人策略。 */
export const roomPolicySetSchema = z
  .object({
    request_id: requestId,
    room_id: id(),
    member_message_policy: groupPolicy.optional(),
    member_invite_policy: groupPolicy.optional(),
    member_task_policy: groupPolicy.optional(),
    /** `from_join`（默认）只可见当前加入后；`full` 由群主显式开启。 */
    member_history_policy: groupHistoryPolicy.optional(),
    /** `approval` 由 G02 的邀请接受路径强制执行；G07 持久化并返回。 */
    member_join_policy: groupJoinPolicy.optional(),
    /** 群资料编辑权限；G04 消费。 */
    member_profile_policy: groupPolicy.optional(),
    /** `@所有人` 权限；默认 owner_admin。 */
    member_mention_all_policy: groupPolicy.optional(),
    expected_policy_revision: z.number().int().positive(),
  })
  .refine(
    (value) =>
      value.member_message_policy !== undefined ||
      value.member_invite_policy !== undefined ||
      value.member_task_policy !== undefined ||
      value.member_history_policy !== undefined ||
      value.member_join_policy !== undefined ||
      value.member_profile_policy !== undefined ||
      value.member_mention_all_policy !== undefined,
    { message: '至少需要修改一项群策略' },
  );

/** 群主/管理员维护公告；expected revision 防止覆盖并发修改。 */
export const roomAnnouncementSetSchema = z.object({
  request_id: requestId,
  room_id: id(),
  announcement: z.string().max(LIMITS.roomAnnouncementBytes),
  expected_announcement_revision: z.number().int().positive(),
});

export const roomRoleHistorySchema = z.object({
  room_id: id(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.roomRoleHistoryPageMax).optional(),
});

/**
 * 普通成员可见的管理事件：只含影响自己、群公告与策略变更的摘要。
 * 详细审计（角色版本、request_id、detail）仍由 owner/admin 的
 * `network_room_role_history` 读取。
 */
export const roomNoticeListSchema = z.object({
  room_id: id(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.roomRoleHistoryPageMax).optional(),
});

/**
 * 读取当前身份收到的定向邀请、某群的链接邀请或一个链接的预览。
 *
 * - 默认：G01 定向邀请列表，只返回当前身份收到的邀请。
 * - `room_id`：该群当前有效的链接邀请，需要 `invite_members`。
 * - `invite_key`：链接持有者的最小群介绍，不返回消息正文或邀请人凭据。
 */
export const roomInviteGetSchema = z.object({
  invitation_id: id().optional(),
  room_id: id().optional(),
  /** 链接 URL 中的明文 key；服务端只保存摘要，不落库原文。 */
  invite_key: z.string().min(16).max(256).optional(),
  status: z
    .enum(['pending', 'accepted', 'rejected', 'revoked', 'expired', 'exhausted'])
    .optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.roomInvitationsPageMax).optional(),
});

/** 接受/拒绝定向邀请；链接邀请另需出示明文 key。 */
export const roomInviteRespondSchema = z.object({
  request_id: requestId,
  invitation_id: id(),
  action: z.enum(['accept', 'reject']),
  /** 链接邀请必须与 invitation_id 同时出示；定向邀请忽略。 */
  invite_key: z.string().min(16).max(256).optional(),
});

/**
 * 创建群邀请。
 *
 * `target_actor_id` 为空时创建可分享链接（默认 20 次、7 天），返回明文 key
 * 与分享 URL 仅此一次；指定目标时创建单人定向邀请（1 次），目标必须是好友。
 */
export const roomInviteCreateSchema = z
  .object({
    request_id: requestId,
    room_id: id(),
    target_actor_id: id().optional(),
    max_uses: z.number().int().min(1).max(LIMITS.roomInviteLinkMaxUses).optional(),
    expires_in_ms: z
      .number()
      .int()
      .min(LIMITS.roomInviteTtlMinMs)
      .max(LIMITS.roomInviteTtlMaxMs)
      .optional(),
  })
  .refine((value) => value.target_actor_id === undefined || value.max_uses === undefined, {
    message: '定向邀请固定 1 次，不能设置 max_uses',
  });

/** 撤销群邀请；inviter 或 owner/admin 可立即撤销。 */
export const roomInviteRevokeSchema = z.object({
  request_id: requestId,
  invitation_id: id(),
  expected_revision: z.number().int().positive().optional(),
});

/** 分页读取某群的入群申请；只有 owner/admin 可读。 */
export const roomJoinRequestListSchema = z.object({
  room_id: id(),
  status: z
    .enum(['pending', 'approved', 'rejected', 'cancelled', 'expired'])
    .optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.roomJoinRequestsPageMax).optional(),
});

/** 批准或拒绝入群申请；批准时在同一事务重新检查容量、邀请与拉黑。 */
export const roomJoinRequestRespondSchema = z.object({
  request_id: requestId,
  join_request_id: id(),
  action: z.enum(['approve', 'reject']),
  expected_revision: z.number().int().positive().optional(),
});

export const roomLeaveSchema = z.object({
  request_id: requestId,
  room_id: id(),
  expected_role_revision: z.number().int().positive().optional(),
});

export const messageSendSchema = z.object({
  request_id: requestId,
  client_message_id: id(128),
  room_id: id(),
  body: z.string().min(1).max(LIMITS.messageBodyBytes),
  /** Agent 执行目标；显式传入（含 []）后不再按正文解析派活。 */
  invoke: z.array(id()).max(LIMITS.invokeMax).optional(),
  /** 显式提及的人类成员；数量上限在领域层校验，超过时返回 INVALID_ARGUMENT。 */
  mentions: z.array(id()).optional(),
  reply_to: id().optional(),
  claim: z
    .object({ delivery_id: id(), attempt: z.number().int().nonnegative(), claim_id: id() })
    .optional(),
});

/**
 * 发送回执对账：只按发送者自己的 client_message_id 查询是否已提交。
 *
 * 不读取正文或 preview，也不要求当前仍是房间成员；用于响应丢失后判断
 * 是否还需要重发，避免生成第二条消息。
 */
export const messageSendStatusSchema = z.object({
  client_message_ids: z
    .array(id(128))
    .min(1)
    .max(LIMITS.messageSendStatusMax),
});

export const historyListSchema = z.object({
  room_id: id(),
  direction: z.enum(['before', 'after']).optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.historyPageMax).optional(),
  /** 默认 messages 保持 Agent 与旧客户端契约；timeline 仅人类可用。 */
  view: z.enum(['messages', 'timeline']).optional(),
});

export const messageReadSchema = z.object({
  message_id: id(),
  chunk_cursor: z.string().max(64).optional(),
});

export const roomMarkReadSchema = z.object({ room_id: id(), through_seq: seq });

export const syncSchema = z.object({
  scope: z.string().min(1).max(256),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.syncPageMax).optional(),
});

export const inboxListSchema = z.object({
  state: z.enum(['pending', 'claimed', 'completed', 'failed', 'cancelled', 'all']).optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.inboxPageMax).optional(),
});

export const deliveryClaimSchema = z.object({ request_id: requestId, delivery_id: id() });

export const deliveryReportSchema = z.object({
  request_id: requestId,
  delivery_id: id(),
  attempt: z.number().int().nonnegative(),
  claim_id: id(),
  status: z.string().min(1).max(280),
});

export const deliveryCompleteSchema = z.object({
  request_id: requestId,
  delivery_id: id(),
  attempt: z.number().int().nonnegative(),
  claim_id: id(),
  final_body: z.string().min(1).max(LIMITS.messageBodyBytes).optional(),
  client_message_id: id(128).optional(),
});

export const deliveryFailSchema = z.object({
  request_id: requestId,
  delivery_id: id(),
  attempt: z.number().int().nonnegative(),
  claim_id: id(),
  error: z.string().min(1).max(1024),
});

export const deliveryCancelSchema = z.object({
  request_id: requestId,
  delivery_id: id(),
  reason: z.string().min(1).max(512),
});

export const deliveryRetrySchema = z.object({
  request_id: requestId,
  delivery_id: id(),
  expected_attempt: z.number().int().nonnegative(),
});

/** file_id 来自 MCPP Files v1 上传响应；只接受该扩展的格式。 */
const fileId = z.string().regex(new RegExp(FILE_ID_PATTERN));

export const roomFileBindSchema = z.object({
  request_id: requestId,
  room_id: id(),
  file_id: fileId,
});

export const roomFileListSchema = z.object({
  room_id: id(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.roomFilePageMax).optional(),
});

export const roomFileGetSchema = z.object({ room_id: id(), file_id: fileId });

export const roomFileDeleteSchema = z.object({
  request_id: requestId,
  room_id: id(),
  file_id: fileId,
});

/**
 * 公开发布是独立、需有权限的动作，默认关闭。
 *
 * - 已绑定文件：上传者或群 owner 可切换；单聊只有上传者。
 * - 未绑定草稿：只有上传身份可以切换，`room_id` 省略。
 */
export const filePublishSchema = z.object({
  request_id: requestId,
  file_id: fileId,
  public: z.boolean(),
  room_id: id().optional(),
});

/** 成果提交：把当前身份自己的文件绑定为房间成果版本并进入保留。 */
export const artifactSubmitSchema = z.object({
  request_id: requestId,
  room_id: id(),
  file_id: fileId,
  task_id: id().optional(),
  version: z.number().int().min(1).max(LIMITS.artifactVersionMax).optional(),
  summary: z.string().trim().max(LIMITS.artifactSummaryBytes).optional(),
});

export const artifactListSchema = z.object({
  room_id: id(),
  task_id: id().optional(),
  cursor,
  limit: z.number().int().min(1).max(LIMITS.artifactPageMax).optional(),
});

export const artifactReleaseSchema = z.object({
  request_id: requestId,
  artifact_id: id(),
});

/** 当前 human 在此会话私有的网页监控地址；null 表示清除。 */
export const roomMonitorGetSchema = z.object({ room_id: id() });

export const roomMonitorSetSchema = z.object({
  request_id: requestId,
  room_id: id(),
  url: z.string().trim().max(LIMITS.roomMonitorUrlMax).nullable(),
});

/**
 * 任务工作流：短标题与受控长正文分离。
 *
 * Zod 的 max 按 UTF-16 码元/字符计，标题最多放宽到 2 倍字符上限；最终按
 * Unicode 码点、UTF-8 字节与控制字符在领域层校验。
 */
const taskTitle = z.string().trim().min(1).max(LIMITS.taskTitleMax * 2);
const taskBodyText = z.string().max(LIMITS.taskDescriptionBytes);

export const taskCreateSchema = z.object({
  request_id: requestId,
  room_id: id(),
  title: taskTitle,
  description: taskBodyText.optional(),
  acceptance_criteria: taskBodyText.optional(),
  source_message_id: id().optional(),
  assignee_actor_id: id().optional(),
  reviewer_actor_id: id().optional(),
  /** 追加工作时关联已 accepted/cancelled 的同房间父任务。 */
  parent_task_id: id().optional(),
  /** 可选同房间关联任务，只表达关系。 */
  related_task_id: id().optional(),
  due_at: z.iso.datetime({ offset: true }).optional(),
  attachment_file_ids: z.array(id()).max(LIMITS.taskAttachmentsMax).optional(),
});

export const taskGetSchema = z.object({ task_id: id() });

export const taskListSchema = z.object({
  room_id: id().optional(),
  scope: z.enum(['room', 'mine']).optional(),
  status: z
    .enum([
      'unassigned',
      'offered',
      'in_progress',
      'blocked',
      'submitted',
      'accepted',
      'failed',
      'cancelled',
      'legacy_completed',
    ])
    .optional(),
  limit: z.number().int().min(1).max(LIMITS.taskListMax).optional(),
});

export const taskSummarySchema = z.object({
  room_ids: z.array(id()).min(1).max(LIMITS.taskLookupMax).optional(),
});

export const taskOfferSchema = z.object({
  request_id: requestId,
  task_id: id(),
  assignee_actor_id: id(),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * 接手指定 offer：`assignment_id` 缺失时使用任务当前 assignment；
 * `expected_revision` 用于迟到接受不覆盖新指派，服务端在事务内再校验一次。
 */
export const taskAcceptSchema = z.object({
  request_id: requestId,
  task_id: id(),
  assignment_id: id().optional(),
  expected_revision: z.number().int().min(1).optional(),
});

export const taskDeclineSchema = z.object({
  request_id: requestId,
  task_id: id(),
  assignment_id: id().optional(),
  expected_revision: z.number().int().min(1).optional(),
  reason: z.string().trim().max(LIMITS.taskCancelReasonBytes).optional(),
});

export const taskClaimSchema = z.object({
  request_id: requestId,
  task_id: id(),
  expected_revision: z.number().int().min(1).optional(),
});

export const taskCancelSchema = z.object({
  request_id: requestId,
  task_id: id(),
  reason: z.string().trim().min(1).max(LIMITS.taskCancelReasonBytes),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * 普通进度上报：note 与 percent 至少一项，领域层还会按 UTF-8 字节复核。
 * assignment_id/version 可选；传入时服务端必须与当前 active assignment 一致。
 */
export const taskProgressSchema = z.object({
  request_id: requestId,
  task_id: id(),
  note: z.string().max(LIMITS.taskProgressNoteBytes).optional(),
  percent: z.number().int().min(0).max(100).optional(),
  assignment_id: id().optional(),
  assignment_version: z.number().int().min(1).optional(),
  expected_revision: z.number().int().min(1).optional(),
});

export const taskBlockSchema = z.object({
  request_id: requestId,
  task_id: id(),
  reason: z.string().trim().min(1).max(LIMITS.taskBlockReasonBytes),
  assignment_id: id().optional(),
  assignment_version: z.number().int().min(1).optional(),
  expected_revision: z.number().int().min(1).optional(),
});

export const taskResumeSchema = z.object({
  request_id: requestId,
  task_id: id(),
  note: z.string().max(LIMITS.taskProgressNoteBytes).optional(),
  assignment_id: id().optional(),
  assignment_version: z.number().int().min(1).optional(),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * 发起任务交接：当前负责人、任务创建者或群 owner/管理员可用。
 *
 * 交接只形成待确认提议；目标接受前原负责人责任不变。
 */
export const taskTransferProposeSchema = z.object({
  request_id: requestId,
  task_id: id(),
  to_actor_id: id(),
  note: z.string().max(LIMITS.taskProgressNoteBytes).optional(),
  assignment_id: id().optional(),
  assignment_version: z.number().int().min(1).optional(),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * 接受交接：只有提议目标可调用。
 *
 * 旧 assignment 的版本也参与 CAS，避免基于旧执行资格的迟到接受。
 */
export const taskTransferAcceptSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  expected_revision: z.number().int().min(1).optional(),
  from_assignment_version: z.number().int().min(1).optional(),
});

export const taskTransferRejectSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  reason: z.string().trim().max(LIMITS.taskCancelReasonBytes).optional(),
});

export const taskTransferCancelSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  reason: z.string().trim().max(LIMITS.taskCancelReasonBytes).optional(),
});

export const taskTransferGetSchema = z.object({
  transfer_id: id(),
});

/** 交接列表：按任务或按“与我相关”读取，默认只返回仍待处理的提议。 */
export const taskTransferListSchema = z.object({
  task_id: id().optional(),
  scope: z.enum(['task', 'mine']).optional(),
  status: z
    .enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired'])
    .optional(),
  limit: z.number().int().min(1).max(LIMITS.taskTransferListMax).optional(),
});

/**
 * 提交成果：只接受当前 active assignment 的负责人，任务必须处于 in_progress。
 *
 * materials 引用已绑定到同一房间的文件；服务端在事务内重新读取字节身份并冻结
 * sha256/size/mime，不信任客户端传入的校验值。links 只记录目标版本/摘要与
 * 提交者声明的可用性，服务端不抓取外链；可访问不等于验收通过。
 */
const taskSubmissionLink = z.object({
  url: z.string().trim().min(1).max(LIMITS.taskSubmissionLinkUrlBytes),
  title: z.string().trim().max(LIMITS.taskSubmissionLinkTitleBytes).optional(),
  version: z.string().trim().max(LIMITS.taskSubmissionLinkVersionBytes).optional(),
  digest: z.string().trim().max(LIMITS.taskSubmissionLinkDigestBytes).optional(),
  availability: z.enum(['unverified', 'declared_reachable']).optional(),
});

const taskSubmissionMaterial = z.object({
  file_id: id(),
  label: z.string().trim().max(LIMITS.taskSubmissionMaterialLabelBytes).optional(),
});

export const taskSubmitSchema = z.object({
  request_id: requestId,
  task_id: id(),
  summary: z.string().max(LIMITS.taskSubmissionSummaryBytes * 2),
  materials: z.array(taskSubmissionMaterial).max(LIMITS.taskSubmissionMaterialsMax).optional(),
  links: z.array(taskSubmissionLink).max(LIMITS.taskSubmissionLinksMax).optional(),
  commit_sha: z.string().trim().max(LIMITS.taskSubmissionCommitShaMax).optional(),
  evidence: z
    .array(z.string().max(LIMITS.taskSubmissionEvidenceBytes * 2))
    .max(LIMITS.taskSubmissionEvidenceMax)
    .optional(),
  known_limits: z.string().max(LIMITS.taskSubmissionKnownLimitsBytes * 2).optional(),
  assignment_id: id().optional(),
  assignment_version: z.number().int().min(1).optional(),
  expected_revision: z.number().int().min(1).optional(),
});

/** 读取指定任务的提交版本；省略 version 时返回最新版本。 */
export const taskSubmissionGetSchema = z.object({
  task_id: id(),
  version: z.number().int().min(1).optional(),
});

/** 提交历史按版本倒序；只返回当前可见任务的历史。 */
export const taskSubmissionListSchema = z.object({
  task_id: id(),
  limit: z.number().int().min(1).max(LIMITS.taskSubmissionListMax).optional(),
});

/**
 * D06 最小退回入口：指定验收人对当前 pending 版本退回。
 *
 * D07 会在此语义上补齐完整验收授权与 accept；本工具不实现通过，避免留下
 * 两个互相冲突的退回入口。
 */
export const taskSubmissionReturnSchema = z.object({
  request_id: requestId,
  task_id: id(),
  submission_id: id(),
  /** D07 后可选绑定版本；新工具 `network_task_review_return` 要求必填。 */
  version: z.number().int().min(1).optional(),
  reason: z.string().trim().min(1).max(LIMITS.taskSubmissionReturnReasonBytes * 2),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * D07 验收通过：必须绑定具体 submission_id 与 version，并逐项核对
 * acceptance_criteria。`passed=false` 的记录可以保存核对结果，但事务会拒绝
 * 把任务转为 accepted；退回应使用 `network_task_review_return`。
 */
export const taskReviewChecklistItemSchema = z.object({
  item: z.string().trim().min(1).max(LIMITS.taskReviewChecklistItemBytes * 2),
  passed: z.boolean(),
  note: z.string().trim().max(LIMITS.taskReviewChecklistNoteBytes * 2).optional(),
});

export const taskReviewAcceptSchema = z.object({
  request_id: requestId,
  task_id: id(),
  submission_id: id(),
  version: z.number().int().min(1),
  checklist: z
    .array(taskReviewChecklistItemSchema)
    .min(1)
    .max(LIMITS.taskReviewChecklistMax),
  expected_revision: z.number().int().min(1).optional(),
});

/** D07 退回：绑定 submission_id 与 version，reason 必填且需可行动。 */
export const taskReviewReturnSchema = z.object({
  request_id: requestId,
  task_id: id(),
  submission_id: id(),
  version: z.number().int().min(1),
  reason: z.string().trim().min(1).max(LIMITS.taskSubmissionReturnReasonBytes * 2),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * 指定/替换任务验收人：创建者、群 owner 或管理员可调用。不能把当前负责人
 * 设为验收人，也不能把验收人设为 pending 成果的提交人。
 */
export const taskReviewerSetSchema = z.object({
  request_id: requestId,
  task_id: id(),
  reviewer_actor_id: id(),
  expected_revision: z.number().int().min(1).optional(),
});

/**
 * 认证反馈：只接受已注册 actor 主动提交的三段诊断文本。
 *
 * request_id 限制为 ASCII 标识符，避免把凭据或 URL 误当操作 ID；
 * 文本字段的最终上限按原始 UTF-8 字节在领域层校验，这里不用
 * Zod 的字符数 max 冒充字节限额。
 */
export const feedbackCreateSchema = z.strictObject({
  request_id: z
    .string()
    .min(1)
    .max(LIMITS.feedbackRequestIdBytes)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
    .describe(
      'Unique operation ID for idempotent replay; 1-128 ASCII characters, suggested pattern [A-Za-z0-9][A-Za-z0-9._:-]*. Must not contain credentials.',
    ),
  environment: z
    .string()
    .min(1)
    .describe(
      `Machine environment summary. Raw UTF-8 must be at most ${LIMITS.feedbackEnvironmentBytes} bytes and must not be blank after trimming. Remove credentials, private messages, personal paths and unrelated environment variables before submitting; automatic redaction is best-effort.`,
    ),
  harness: z
    .string()
    .min(1)
    .describe(
      `Harness identifier such as codex, claude-code, peri, chatgpt-web or unknown. Raw UTF-8 must be at most ${LIMITS.feedbackHarnessBytes} bytes, must not be blank after trimming, and must not contain control characters.`,
    ),
  problem: z
    .string()
    .min(1)
    .describe(
      `Problem description and minimal reproduction. Raw UTF-8 must be at most ${LIMITS.feedbackProblemBytes} bytes and must not be blank after trimming; internal newlines are preserved. Do not include credentials, private messages, user content or terminal logs; automatic redaction is best-effort.`,
    ),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
export type AgentRenameInput = z.infer<typeof agentRenameSchema>;
export type MeRenameInput = z.infer<typeof meRenameSchema>;
export type AgentReissueTokenInput = z.infer<typeof agentReissueTokenSchema>;
export type AgentArchiveInput = z.infer<typeof agentArchiveSchema>;
export type AgentUnarchiveInput = z.infer<typeof agentUnarchiveSchema>;
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;
export type AgentManagementGetInput = z.infer<typeof agentManagementGetSchema>;
export type AgentsManagedListInput = z.infer<typeof agentsManagedListSchema>;
export type AgentClaimStartInput = z.infer<typeof agentClaimStartSchema>;
export type AgentClaimConfirmInput = z.infer<typeof agentClaimConfirmSchema>;
export type AgentClaimCancelInput = z.infer<typeof agentClaimCancelSchema>;
export type AgentDelegateGrantInput = z.infer<typeof agentDelegateGrantSchema>;
export type AgentDelegateRevokeInput = z.infer<typeof agentDelegateRevokeSchema>;
export type AgentDisableInput = z.infer<typeof agentDisableSchema>;
export type AgentEnableInput = z.infer<typeof agentEnableSchema>;
export type AgentsGetInput = z.infer<typeof agentsGetSchema>;
export type RecoveryRedeemInput = z.infer<typeof recoveryRedeemSchema>;
export type ContactsListInput = z.infer<typeof contactsListSchema>;
export type ContactAddInput = z.infer<typeof contactAddSchema>;
export type ContactRemoveInput = z.infer<typeof contactRemoveSchema>;
export type ContactRequestInput = z.infer<typeof contactRequestSchema>;
export type ContactRequestsListInput = z.infer<typeof contactRequestsListSchema>;
export type ContactRequestRespondInput = z.infer<typeof contactRequestRespondSchema>;
export type ContactRequestCancelInput = z.infer<typeof contactRequestIdSchema>;
export type ContactPolicyGetInput = z.infer<typeof contactPolicyGetSchema>;
export type ContactPolicySetInput = z.infer<typeof contactPolicySetSchema>;
export type ContactBlockInput = z.infer<typeof contactBlockSchema>;
export type ContactUnblockInput = z.infer<typeof contactUnblockSchema>;
export type ContactBlocksListInput = z.infer<typeof contactBlocksListSchema>;
export type ContactReportInput = z.infer<typeof contactReportSchema>;
export type ContactReportsListInput = z.infer<typeof contactReportsListSchema>;
export type RoomCreateInput = z.infer<typeof roomCreateSchema>;
export type RoomsListInput = z.infer<typeof roomsListSchema>;
export type RoomMembersUpdateInput = z.infer<typeof roomMembersUpdateSchema>;
export type RoomRoleSetInput = z.infer<typeof roomRoleSetSchema>;
export type RoomOwnerTransferInput = z.infer<typeof roomOwnerTransferSchema>;
export type RoomOwnerTransferProposeInput = z.infer<typeof roomOwnerTransferProposeSchema>;
export type RoomOwnerTransferRespondInput = z.infer<typeof roomOwnerTransferRespondSchema>;
export type RoomOwnerTransferCancelInput = z.infer<typeof roomOwnerTransferCancelSchema>;
export type RoomPolicySetInput = z.infer<typeof roomPolicySetSchema>;
export type RoomAnnouncementSetInput = z.infer<typeof roomAnnouncementSetSchema>;
export type RoomRoleHistoryInput = z.infer<typeof roomRoleHistorySchema>;
export type RoomNoticeListInput = z.infer<typeof roomNoticeListSchema>;
export type RoomInviteGetInput = z.infer<typeof roomInviteGetSchema>;
export type RoomInviteRespondInput = z.infer<typeof roomInviteRespondSchema>;
export type RoomInviteCreateInput = z.infer<typeof roomInviteCreateSchema>;
export type RoomInviteRevokeInput = z.infer<typeof roomInviteRevokeSchema>;
export type RoomJoinRequestListInput = z.infer<typeof roomJoinRequestListSchema>;
export type RoomJoinRequestRespondInput = z.infer<typeof roomJoinRequestRespondSchema>;
export type RoomLeaveInput = z.infer<typeof roomLeaveSchema>;
export type MessageSendInput = z.infer<typeof messageSendSchema>;
export type MessageSendStatusInput = z.infer<typeof messageSendStatusSchema>;
export type HistoryListInput = z.infer<typeof historyListSchema>;
export type MessageReadInput = z.infer<typeof messageReadSchema>;
export type RoomMarkReadInput = z.infer<typeof roomMarkReadSchema>;
export type SyncInput = z.infer<typeof syncSchema>;
export type InboxListInput = z.infer<typeof inboxListSchema>;
export type DeliveryClaimInput = z.infer<typeof deliveryClaimSchema>;
export type DeliveryReportInput = z.infer<typeof deliveryReportSchema>;
export type DeliveryCompleteInput = z.infer<typeof deliveryCompleteSchema>;
export type DeliveryFailInput = z.infer<typeof deliveryFailSchema>;
export type DeliveryCancelInput = z.infer<typeof deliveryCancelSchema>;
export type DeliveryRetryInput = z.infer<typeof deliveryRetrySchema>;
export type RoomFileBindInput = z.infer<typeof roomFileBindSchema>;
export type RoomFileListInput = z.infer<typeof roomFileListSchema>;
export type RoomFileGetInput = z.infer<typeof roomFileGetSchema>;
export type RoomFileDeleteInput = z.infer<typeof roomFileDeleteSchema>;
export type FilePublishInput = z.infer<typeof filePublishSchema>;
export type ArtifactSubmitInput = z.infer<typeof artifactSubmitSchema>;
export type ArtifactListInput = z.infer<typeof artifactListSchema>;
export type ArtifactReleaseInput = z.infer<typeof artifactReleaseSchema>;
export type RoomMonitorGetInput = z.infer<typeof roomMonitorGetSchema>;
export type RoomMonitorSetInput = z.infer<typeof roomMonitorSetSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskGetInput = z.infer<typeof taskGetSchema>;
export type TaskListInput = z.infer<typeof taskListSchema>;
export type TaskSummaryInput = z.infer<typeof taskSummarySchema>;
export type TaskOfferInput = z.infer<typeof taskOfferSchema>;
export type TaskAcceptInput = z.infer<typeof taskAcceptSchema>;
export type TaskDeclineInput = z.infer<typeof taskDeclineSchema>;
export type TaskClaimInput = z.infer<typeof taskClaimSchema>;
export type TaskCancelInput = z.infer<typeof taskCancelSchema>;
export type TaskProgressInput = z.infer<typeof taskProgressSchema>;
export type TaskBlockInput = z.infer<typeof taskBlockSchema>;
export type TaskResumeInput = z.infer<typeof taskResumeSchema>;
export type TaskTransferProposeInput = z.infer<typeof taskTransferProposeSchema>;
export type TaskTransferAcceptInput = z.infer<typeof taskTransferAcceptSchema>;
export type TaskTransferRejectInput = z.infer<typeof taskTransferRejectSchema>;
export type TaskTransferCancelInput = z.infer<typeof taskTransferCancelSchema>;
export type TaskTransferGetInput = z.infer<typeof taskTransferGetSchema>;
export type TaskTransferListInput = z.infer<typeof taskTransferListSchema>;
export type TaskSubmitInput = z.infer<typeof taskSubmitSchema>;
export type TaskSubmissionGetInput = z.infer<typeof taskSubmissionGetSchema>;
export type TaskSubmissionListInput = z.infer<typeof taskSubmissionListSchema>;
export type TaskSubmissionReturnInput = z.infer<typeof taskSubmissionReturnSchema>;
export type TaskReviewAcceptInput = z.infer<typeof taskReviewAcceptSchema>;
export type TaskReviewReturnInput = z.infer<typeof taskReviewReturnSchema>;
export type TaskReviewerSetInput = z.infer<typeof taskReviewerSetSchema>;
export type FeedbackCreateInput = z.infer<typeof feedbackCreateSchema>;
