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

/**
 * 当前管理者发起管理权交接。
 *
 * `to_manager_id` 必须是已注册、未停用/归档的 human；同一 Agent 只允许
 * 一条 pending 提议。接受前管理权、委托与 Agent 凭据都不改变。
 */
export const agentTransferProposeSchema = z.object({
  request_id: requestId,
  actor_id: id(),
  to_manager_id: id(),
  note: z.string().trim().max(LIMITS.agentTransferNoteBytes).optional(),
  expires_in_ms: z
    .number()
    .int()
    .min(LIMITS.agentTransferTtlMinMs)
    .max(LIMITS.agentTransferTtlMs)
    .optional(),
});

/** 接任者接受/拒绝；只有 to_manager 本人可调用。 */
export const agentTransferRespondSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  decision: z.enum(['accept', 'reject']),
  note: z.string().trim().max(LIMITS.agentTransferNoteBytes).optional(),
});

/** 发起人取消尚未接受的提议；不改变管理权或凭据。 */
export const agentTransferCancelSchema = z.object({
  request_id: requestId,
  transfer_id: id(),
  note: z.string().trim().max(LIMITS.agentTransferNoteBytes).optional(),
});

export const agentTransferGetSchema = z.object({ transfer_id: id() });

/**
 * 列出与调用者相关的交接提议。
 *
 * `actor_id` 只用于收窄到某个 Agent；调用者必须本来就与这些提议相关，
 * 不能借此枚举他人的交接。`role=agent` 只匹配 Agent 自己的视角。
 */
export const agentTransferListSchema = z.object({
  actor_id: id().optional(),
  status: z
    .enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired'])
    .optional(),
  role: z.enum(['from', 'to', 'agent']).optional(),
  limit: z.number().int().min(1).max(LIMITS.agentTransferListMax).optional(),
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

/**
 * 已登录设备创建一次性配对挑战。
 *
 * 挑战明文只在首次响应出现；`expires_in_ms` 仅供测试缩短，服务端上限仍是
 * `LIMITS.devicePairingTtlMs`（5 分钟）。
 */
export const devicePairingCreateSchema = z.object({
  request_id: requestId,
  device_label: z.string().trim().max(LIMITS.devicePairingLabelBytes * 2).optional(),
  platform: z.string().trim().max(LIMITS.devicePairingPlatformBytes * 2).optional(),
  expires_in_ms: z
    .number()
    .int()
    .min(LIMITS.devicePairingTtlMinMs)
    .max(LIMITS.devicePairingTtlMs)
    .optional(),
});

/** 新设备用本地 token 证明并绑定到某个挑战；不要求 token 已注册。 */
export const devicePairingJoinSchema = z.object({
  request_id: requestId,
  challenge: z.string().min(8).max(64),
  device_id: id(256),
  device_label: z.string().trim().max(LIMITS.devicePairingLabelBytes * 2).optional(),
  platform: z.string().trim().max(LIMITS.devicePairingPlatformBytes * 2).optional(),
});

/** 已登录设备读取本 actor 待确认/已批准/最近完成的配对。 */
export const devicePairingListSchema = z.object({
  limit: z.number().int().min(1).max(LIMITS.devicePairingListMax).optional(),
});

export const devicePairingApproveSchema = z.object({
  request_id: requestId,
  pairing_id: id(),
});

/** 拒绝/撤销挑战；`reason` 只做审计，不加入通知正文。 */
export const devicePairingCancelSchema = z.object({
  request_id: requestId,
  pairing_id: id(),
  reason: z.string().trim().max(512).optional(),
});

/** 新设备在已登录设备批准后兑换出同 actor 的独立 credential。 */
export const devicePairingRedeemSchema = z.object({
  request_id: requestId,
  challenge: z.string().min(8).max(64),
  device_id: id(256),
});

export const deviceListSchema = z.object({});

export const deviceRevokeSchema = z.object({
  request_id: requestId,
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

/** 好友邀请链接 token：URL-safe random，服务端只保存摘要。 */
const contactLinkToken = z.string().min(8).max(128);

/** 生成一次性好友链接；expires_in_ms 只能缩短默认 24 小时有效期。 */
export const contactLinkCreateSchema = z.object({
  request_id: requestId,
  expires_in_ms: z
    .number()
    .int()
    .min(LIMITS.contactLinkTtlMinMs)
    .max(LIMITS.contactLinkTtlMs)
    .optional(),
});

/** 无鉴权预览：只判断 token 当前是否可用与邀请人，不创建身份。 */
export const contactLinkPreviewSchema = z.object({ token: contactLinkToken });

export const contactLinkRedeemSchema = z.object({
  request_id: requestId,
  token: contactLinkToken,
});

export const contactLinkRevokeSchema = z.object({
  request_id: requestId,
  link_id: id(),
});

export const contactLinkListSchema = z.object({
  limit: z.number().int().min(1).max(LIMITS.contactLinkListMax).optional(),
});

export const roomCreateSchema = z.object({
  request_id: requestId,
  kind: z.enum(['direct', 'group']),
  members: z.array(id()).min(1).max(LIMITS.memberChangeMax),
  title: z.string().max(LIMITS.roomTitleMax).optional(),
});

export const roomsListSchema = z.object({ cursor, limit: z.number().int().min(1).max(100).optional() });

export const roomRenameSchema = z.object({
  request_id: requestId,
  room_id: id(),
  title: z.string().trim().min(1).max(LIMITS.roomTitleMax),
  expected_title: z.string().max(LIMITS.roomTitleMax),
});
export type RoomRenameInput = z.infer<typeof roomRenameSchema>;

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

/** 群主设置普通成员发言/邀请/历史/审批/@所有人策略。 */
export const roomPolicySetSchema = z
  .object({
    request_id: requestId,
    room_id: id(),
    member_message_policy: groupPolicy.optional(),
    member_invite_policy: groupPolicy.optional(),
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
  /**
   * 退群会撤销本人在该群的在途任务与投递。先调用
   * `network_room_leave_preview` 展示；确认后传 true，避免静默丢失工作。
   */
  confirm_in_flight: z.boolean().optional(),
});

/** 只读预览退群后果：在途任务、待处理投递与 owner 转移要求。 */
export const roomLeavePreviewSchema = z.object({ room_id: id() });

/** 解散群聊；owner only，reason 只作为审计摘要，不复制消息正文。 */
export const roomDissolveSchema = z.object({
  request_id: requestId,
  room_id: id(),
  reason: z.string().trim().max(500).optional(),
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
  /** 显式归属的消息式 Task 起点；省略时按父消息继承。 */
  task_root_id: id().optional(),
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

/** 消息式 Task：把任意可见消息标记为聚合起点。 */
export const messageTaskMarkSchema = z.object({
  request_id: requestId,
  room_id: id(),
  message_id: id(),
});

/** 消息式 Task：取消起点标记，只撤销聚合入口，不删除消息。 */
export const messageTaskUnmarkSchema = z.object({
  request_id: requestId,
  room_id: id(),
  message_id: id(),
});

/** 批量摘要；未标记或当前不可见的根由服务端省略。 */
export const messageTaskSummariesSchema = z.object({
  room_id: id(),
  root_message_ids: z.array(id()).min(1).max(LIMITS.taskSummaryRootsMax),
});

/** Trace 分页；cursor 优先于 focus_message_id，二者可同时传。 */
export const messageTaskTraceSchema = z.object({
  room_id: id(),
  root_message_id: id(),
  cursor,
  focus_message_id: id().optional(),
  limit: z.number().int().min(1).max(LIMITS.taskTracePageMax).optional(),
});

/** 按起点聚合的 Task 搜索；普通 network_message_search 契约不变。 */
export const messageTaskSearchSchema = z.object({
  room_id: id(),
  query: z.string().trim().min(1).max(LIMITS.messageSearchQueryMax),
  limit: z.number().int().min(1).max(LIMITS.taskSearchPageMax).optional(),
  cursor: z.string().min(1).max(LIMITS.messageSearchCursorMax).optional(),
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
  version: z.number().int().min(1).max(LIMITS.artifactVersionMax).optional(),
  summary: z.string().trim().max(LIMITS.artifactSummaryBytes).optional(),
});

export const artifactListSchema = z.object({
  room_id: id(),
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
export type AgentTransferProposeInput = z.infer<typeof agentTransferProposeSchema>;
export type AgentTransferRespondInput = z.infer<typeof agentTransferRespondSchema>;
export type AgentTransferCancelInput = z.infer<typeof agentTransferCancelSchema>;
export type AgentTransferGetInput = z.infer<typeof agentTransferGetSchema>;
export type AgentTransferListInput = z.infer<typeof agentTransferListSchema>;
export type AgentsGetInput = z.infer<typeof agentsGetSchema>;
export type RecoveryRedeemInput = z.infer<typeof recoveryRedeemSchema>;
export type DevicePairingCreateInput = z.infer<typeof devicePairingCreateSchema>;
export type DevicePairingJoinInput = z.infer<typeof devicePairingJoinSchema>;
export type DevicePairingListInput = z.infer<typeof devicePairingListSchema>;
export type DevicePairingApproveInput = z.infer<typeof devicePairingApproveSchema>;
export type DevicePairingCancelInput = z.infer<typeof devicePairingCancelSchema>;
export type DevicePairingRedeemInput = z.infer<typeof devicePairingRedeemSchema>;
export type DeviceListInput = z.infer<typeof deviceListSchema>;
export type DeviceRevokeInput = z.infer<typeof deviceRevokeSchema>;
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
export type ContactLinkCreateInput = z.infer<typeof contactLinkCreateSchema>;
export type ContactLinkPreviewInput = z.infer<typeof contactLinkPreviewSchema>;
export type ContactLinkRedeemInput = z.infer<typeof contactLinkRedeemSchema>;
export type ContactLinkRevokeInput = z.infer<typeof contactLinkRevokeSchema>;
export type ContactLinkListInput = z.infer<typeof contactLinkListSchema>;
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
export type RoomLeavePreviewInput = z.infer<typeof roomLeavePreviewSchema>;
export type RoomDissolveInput = z.infer<typeof roomDissolveSchema>;
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
export type FeedbackCreateInput = z.infer<typeof feedbackCreateSchema>;
