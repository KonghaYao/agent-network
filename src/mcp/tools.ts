import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { isBusinessError } from '../contracts/errors';
import {
  agentArchiveSchema,
  agentClaimCancelSchema,
  agentClaimConfirmSchema,
  agentClaimStartSchema,
  agentCreateSchema,
  agentDelegateGrantSchema,
  agentDelegateRevokeSchema,
  agentDisableSchema,
  agentEnableSchema,
  agentManagementGetSchema,
  agentReissueTokenSchema,
  agentRenameSchema,
  agentUnarchiveSchema,
  agentsGetSchema,
  agentsManagedListSchema,
  contactAddSchema,
  contactBlockSchema,
  contactBlocksListSchema,
  contactPolicyGetSchema,
  contactPolicySetSchema,
  contactRemoveSchema,
  contactReportSchema,
  contactReportsListSchema,
  contactRequestIdSchema,
  contactRequestRespondSchema,
  contactRequestSchema,
  contactRequestsListSchema,
  contactUnblockSchema,
  contactsListSchema,
  deliveryCancelSchema,
  deliveryClaimSchema,
  deliveryCompleteSchema,
  deliveryFailSchema,
  deliveryReportSchema,
  deliveryRetrySchema,
  feedbackCreateSchema,
  historyListSchema,
  inboxListSchema,
  issueTokenSchema,
  loginSchema,
  meSchema,
  meRenameSchema,
  messageReadSchema,
  messageSendSchema,
  messageSendStatusSchema,
  profileUpdateSchema,
  recoveryCreateSchema,
  recoveryRedeemSchema,
  registerSchema,
  roomAnnouncementSetSchema,
  roomCreateSchema,
  roomGetSchema,
  roomInviteCreateSchema,
  roomInviteGetSchema,
  roomInviteRespondSchema,
  roomInviteRevokeSchema,
  roomJoinRequestListSchema,
  roomJoinRequestRespondSchema,
  roomLeaveSchema,
  roomMarkReadSchema,
  roomMembersUpdateSchema,
  roomMonitorGetSchema,
  roomMonitorSetSchema,
  roomOwnerTransferCancelSchema,
  roomOwnerTransferProposeSchema,
  roomOwnerTransferRespondSchema,
  roomOwnerTransferSchema,
  roomPolicySetSchema,
  roomNoticeListSchema,
  roomRoleHistorySchema as roomRoleHistoryQuerySchema,
  roomRoleSetSchema,
  roomsListSchema,
  syncSchema,
  taskAcceptSchema,
  taskBlockSchema,
  taskCancelSchema,
  taskClaimSchema,
  taskCreateSchema,
  taskDeclineSchema,
  taskExecutionResolveSchema,
  taskExecutionUnknownSchema,
  taskGetSchema,
  taskHandoffAuthorizeSchema,
  taskHandoffPackCreateSchema,
  taskHandoffPackGetSchema,
  taskHandoffRequestMoreSchema,
  taskListSchema,
  taskOfferSchema,
  taskProgressSchema,
  taskResumeSchema,
  taskRetrySchema,
  taskReviewAcceptSchema,
  taskReviewReturnSchema,
  taskReviewerSetSchema,
  taskSubmissionGetSchema,
  taskSubmissionListSchema,
  taskSubmissionReturnSchema,
  taskSubmitSchema,
  taskSummarySchema,
  taskTransferAcceptSchema,
  taskTransferCancelSchema,
  taskTransferGetSchema,
  taskTransferListSchema,
  taskTransferProposeSchema,
  taskTransferRejectSchema,
} from '../contracts/schemas';
import { agentsGet, archiveAgent, unarchiveAgent } from '../domain/agents';
import {
  agentClaimCancel,
  agentClaimConfirm,
  agentClaimStart,
  createAgent,
} from '../domain/agent-lifecycle';
import {
  agentDelegateGrant,
  agentDelegateRevoke,
  agentManagementGet,
  agentsManagedList,
  disableAgent,
  enableAgent,
} from '../domain/agent-management';
import { contactAdd, contactRemove, contactsList } from '../domain/contacts';
import {
  contactBlock,
  contactBlocksList,
  contactReport,
  contactReportsList,
  contactUnblock,
} from '../domain/contact-blocks';
import { contactPolicyGet, contactPolicySet } from '../domain/contact-policies';
import {
  contactRequest,
  contactRequestCancel,
  contactRequestRespond,
  contactRequestsList,
} from '../domain/contact-requests';
import {
  deliveryCancel,
  deliveryClaim,
  deliveryComplete,
  deliveryFail,
  deliveryReport,
  deliveryRetry,
  inboxList,
} from '../domain/deliveries';
import { createFeedback } from '../domain/feedback';
import {
  me,
  recoveryCreate,
  recoveryRedeem,
  register as registerActor,
  reissueAgentToken,
  renameAgent,
  renameMe,
  updateProfile,
} from '../domain/identity';
import {
  historyList,
  messageRead,
  messageSend,
  messageSendStatus,
  roomMarkRead,
} from '../domain/messages';
import {
  roomAnnouncementSet,
  roomCreate,
  roomGet,
  roomLeave,
  roomMembersUpdate,
  roomPolicySet,
  roomRoleHistory,
  roomRoleSet,
  roomsList,
  type RoomDetail,
} from '../domain/rooms';
import { roomMonitorGet, roomMonitorSet } from '../domain/room-monitors';
import { roomNoticeList } from '../domain/room-notices';
import {
  roomInvitationAccept,
  roomInvitationList,
  roomInvitationReject,
} from '../domain/room-invitations';
import {
  roomInviteCreate,
  roomInviteLinkList,
  roomInvitePreview,
  roomInviteRevoke,
} from '../domain/room-invite-links';
import { roomJoinRequestList, roomJoinRequestRespond } from '../domain/room-join-requests';
import {
  roomOwnerTransferCancel,
  roomOwnerTransferPropose,
  roomOwnerTransferRespond,
} from '../domain/owner-transfers';
import {
  taskAccept,
  taskBlock,
  taskCancel,
  taskClaim,
  taskCreate,
  taskDecline,
  taskGet,
  taskList,
  taskOffer,
  taskReportProgress,
  taskResume,
  taskRetry,
  taskSummary,
} from '../domain/tasks';
import { taskExecutionResolve, taskExecutionUnknown } from '../domain/task-recovery';
import {
  taskReviewAccept,
  taskReviewReturn,
  taskReviewerSet,
  taskSubmissionGet,
  taskSubmissionList,
  taskSubmissionReturn,
  taskSubmit,
} from '../domain/task-submissions';
import { fileTicketSecret } from '../domain/file-ticket';
import {
  taskHandoffAuthorize,
  taskHandoffPackCreate,
  taskHandoffPackGet,
  taskHandoffRequestMore,
} from '../domain/task-handoff-packs';
import {
  taskTransferAccept,
  taskTransferCancel,
  taskTransferGet,
  taskTransferList,
  taskTransferPropose,
  taskTransferReject,
} from '../domain/task-transfers';
import { sync } from '../domain/sync';
import type { Env } from '../env';
import { login, presenceOf } from '../realtime/presence';
import { requireActor } from './auth';
import {
  agentArchiveResultSchema,
  agentClaimCancelResultSchema,
  agentClaimConfirmResultSchema,
  agentClaimStartResultSchema,
  agentCreateResultSchema,
  agentDelegateGrantResultSchema,
  agentDelegateRevokeResultSchema,
  agentDisableResultSchema,
  agentEnableResultSchema,
  agentManagementGetResultSchema,
  agentReissueTokenResultSchema,
  agentRenameResultSchema,
  agentUnarchiveResultSchema,
  agentsGetResultSchema,
  agentsManagedListResultSchema,
  completeResultSchema,
  contactBlockPageSchema,
  contactBlockResultSchema,
  contactPageSchema,
  contactPolicySchema,
  contactReportPageSchema,
  contactReportResultSchema,
  contactRequestPageSchema,
  contactRequestResultSchema,
  contactSchema,
  contactUnblockResultSchema,
  deliverySchema,
  feedbackCreateResultSchema,
  historyPageSchema,
  identitySchema,
  inboxPageSchema,
  issuedTokenSchema,
  leaveResultSchema,
  loginResultSchema,
  markReadResultSchema,
  meRenameResultSchema,
  progressResultSchema,
  readChunkSchema,
  recoveredIdentitySchema,
  recoveryTicketSchema,
  removedResultSchema,
  roomDetailSchema,
  roomCreateResultSchema,
  roomInvitationPageSchema,
  roomInvitationRespondSchema,
  roomInvitationSchema,
  roomInviteCreateResultSchema,
  roomJoinRequestPageSchema,
  roomJoinRequestRespondResultSchema,
  roomMonitorResultSchema,
  roomPageSchema,
  roomNoticePageSchema,
  roomPolicySetResultSchema,
  roomRoleHistorySchema as roomRoleHistoryResultSchema,
  taskListResultSchema,
  taskHandoffPackResultSchema,
  taskHandoffRequestResultSchema,
  taskRecoveryResultSchema,
  taskResultSchema,
  taskSubmissionGetResultSchema,
  taskSubmissionListResultSchema,
  taskSubmissionResultSchema,
  taskSummaryResultSchema,
  taskTransferListResultSchema,
  taskTransferResultSchema,
  taskTransferSchema,
  sendResultSchema,
  messageSendStatusPageSchema,
  syncPageSchema,
} from './outputs';
import type { Principal } from '../domain/principal';

type ToolReturn = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * SDK 的 registerTool 重载在泛型封装下无法正确选择 Standard Schema 分支；
 * 运行时行为不变，这里只收敛类型断言。
 */
type RegisterToolCall = (
  name: string,
  config: Record<string, unknown>,
  callback: (args: unknown) => Promise<ToolReturn>,
) => unknown;

/** 生成并返回长期 URL 凭据；不写数据库，服务端只在注册时保存摘要。 */
function issueToken(origin: string): { token: string; url: string } {
  const token = crypto.randomUUID();
  const base = origin.replace(/\/+$/u, '');
  return { token, url: `${base}/mcp?token=${encodeURIComponent(token)}` };
}

function failure(error: unknown, safeErrors = false): ToolReturn {
  if (isBusinessError(error)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(error.toBody()) }],
    };
  }
  if (safeErrors) {
    // 局部安全路径：不记录原始异常、cause、SQL 绑定或输入，避免诊断文本泄露。
    console.error('agent-network tool failed: INTERNAL_ERROR');
  } else {
    console.error('agent-network tool failed', error);
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ code: 'INTERNAL_ERROR', message: '内部错误', retryable: false }),
      },
    ],
  };
}

export interface RegisterOptions {
  /** 仅反馈工具启用：未知异常只记录固定分类，不输出原始错误。 */
  safeErrors?: boolean;
}

export function register<
  I extends StandardSchemaWithJSON,
  O extends StandardSchemaWithJSON,
>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: I,
  outputSchema: O,
  handler: (
    args: StandardSchemaWithJSON.InferInput<I>,
  ) => Promise<StandardSchemaWithJSON.InferOutput<O>>,
  annotations?: Record<string, unknown>,
  options: RegisterOptions = {},
): void {
  const call = server.registerTool as unknown as RegisterToolCall;
  call.call(server, name, { description, inputSchema, outputSchema, ...(annotations ? { annotations } : {}) }, async (args) => {
    try {
      const value = (await handler(args as StandardSchemaWithJSON.InferInput<I>)) as Record<
        string,
        unknown
      >;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      return failure(error, options.safeErrors);
    }
  });
}

export interface MessageCommittedHookInput {
  messageId: string;
  roomId: string;
  body: string;
}

export interface ToolHooks {
  /**
   * 消息事务提交后调用（message_send 与 delivery_complete.final_body）；
   * 用于 best-effort 自动归档，不得影响消息结果。
   */
  afterMessageCommitted?: (input: MessageCommittedHookInput) => Promise<void>;
}

/** 钩子失败直接忽略，不改变已提交的工具结果。 */
async function runMessageCommittedHook(
  hooks: ToolHooks,
  input: MessageCommittedHookInput,
): Promise<void> {
  if (!hooks.afterMessageCommitted) return;
  try {
    await hooks.afterMessageCommitted(input);
  } catch {
    // best-effort：归档失败不改变消息/投递结果。
  }
}

export function registerTools(
  server: McpServer,
  env: Env,
  principal: Principal,
  hooks: ToolHooks = {},
): void {
  const db = env.DB;
  const origin = env.PUBLIC_ORIGIN;
  const ticketSecret = fileTicketSecret(env.FILE_TICKET_SECRET);

  register(
    server,
    'network_issue_token',
    '生成一个长期 MCP URL 凭据；无需 Authorization，不写数据库。返回的 url 可直接作为 MCP 端点，token 也可作 Bearer。URL 与 token 是长期身份凭据：不要公开、写入日志或截图。服务端不保存原始 token，首次 network_register 只保存 SHA-256 摘要；丢失 URL 后只能重新申请并新建身份。每次调用都会返回新的 token。',
    issueTokenSchema,
    issuedTokenSchema,
    async () => issueToken(origin),
    { readOnlyHint: true },
  );

  /**
   * 为 Agent 成员补充在线快照；人类保持 null。
   *
   * 只在 room_get 出口查询，域层继续只读 SQLite；online 表示可用性
   * （SSE 连接或最近活动窗口内），hub/DB 查询失败时 presenceOf 返回 null，
   * 页面显示“未知”而不是误报离线。pending 在确认下线前仍显示在线，避免闪烁。
   */
  async function withPresence(detail: RoomDetail): Promise<RoomDetail> {
    const members = await Promise.all(
      detail.members.map(async (member) => {
        if (member.kind !== 'agent') return member;
        const presence = await presenceOf(env, member.actor_id);
        return { ...member, online: presence ? presence.online : null };
      }),
    );
    return {
      room: detail.room,
      members,
      invited: detail.invited,
      owner_transfer: detail.owner_transfer,
    };
  }

  register(
    server,
    'network_register',
    '注册 human 或 agent actor，并原子绑定当前 Bearer 凭据。重复调用返回同一身份。',
    registerSchema,
    identitySchema,
    async (input) => registerActor(db, principal, input, origin),
  );

  register(server, 'network_me', '读取当前身份、资源入口与限制。', meSchema, identitySchema, async () => {
    requireActor(principal);
    return me(db, principal, origin);
  });

  register(
    server,
    'network_login',
    'Agent 显式上线，开始接收 inbox 投递通知；未上线时投递只在 D1 排队。重复调用幂等，返回待办数量与只读 task_summary（pending/claimed/done/failed/total）。pending 是未领取、claimed 只含当前身份已领取；done/failed/total 是 active 房间总量，total 含他人 claimed。每次上线、重连或唤醒后先看 task_summary；pending > 0 或 claimed > 0 时按房间 list（claimed 用于恢复自己断线前领取的任务）。任务概览不改变 pending_count、房间 head、未读或在线状态。',
    loginSchema,
    loginResultSchema,
    async () => login(env, principal),
  );

  register(
    server,
    'network_profile_update',
    '更新自己的展示名称与小体积 metadata。',
    profileUpdateSchema,
    identitySchema,
    async (input) => {
      requireActor(principal);
      return updateProfile(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_me_rename',
    '修改当前 principal 自己的展示名称。没有 actor_id 参数，任何人只能改自己，不能借它修改其他 actor；human 与 agent 均可调用。名称会 trim，拒绝空值、超过 96 字符或 384 字节、控制字符与换行。request_id 幂等，同一 request_id 不同名称返回 IDEMPOTENCY_CONFLICT；成功后返回 actor_id、name 与 updated_at。',
    meRenameSchema,
    meRenameResultSchema,
    async (input) => {
      requireActor(principal);
      return renameMe(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_create',
    '以当前 human 凭据原子创建 Agent、管理绑定与初始凭据。只有已注册 human 可调用；agent 凭据返回 PERMISSION_DENIED。服务端生成新 token，它只在本工具首次响应出现一次（不会写入 operations 结果），同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE。返回 actor_id、name、agent_session_id、share_url、token、mcp_url、issued_at 与 management（binding_id/permission_version/created_at）。创建的 Agent 默认未被登录，需要该 Agent 用自己的 token 调用 network_login。',
    agentCreateSchema,
    agentCreateResultSchema,
    async (input) => createAgent(db, principal, input, origin),
  );

  register(
    server,
    'network_agent_management_get',
    '读取 Agent 的管理关系、归档/停用状态、待处理工作与权限版本。允许 active manager、持有 manage_agent 委托的 human，以及 Agent 本人；其他已注册身份返回 PERMISSION_DENIED。management 为 null 表示该 Agent 尚未认领（unclaimed）。浏览器 localStorage 中的 owner 字段不参与判断。',
    agentManagementGetSchema,
    agentManagementGetResultSchema,
    async (input) => {
      requireActor(principal);
      return agentManagementGet(db, principal, input.actor_id, origin);
    },
  );

  register(
    server,
    'network_agents_managed_list',
    '按最近绑定时间倒序分页列出当前 human 作为 manager 或 delegate 管理的 Agent。只包含调用者确有权管理的目标；cursor/limit 分页（默认 50，最大 100）。',
    agentsManagedListSchema,
    agentsManagedListResultSchema,
    async (input) => {
      requireActor(principal);
      return agentsManagedList(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_agent_claim_start',
    '未认领 Agent 用自身凭据发起认领，生成一次性 claim code。只有 kind=agent 的凭据可调用；已有 active manager 或已有待确认认领时返回 CLAIM_CONFLICT。code 只在首次响应出现一次，服务端只保存 SHA-256；必须在另一端由 human 调用 network_agent_claim_confirm 完成绑定，单端请求不能建立管理权。',
    agentClaimStartSchema,
    agentClaimStartResultSchema,
    async (input) => {
      requireActor(principal);
      return agentClaimStart(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_claim_confirm',
    'human 用 Agent 发起的一次性 code 完成双端认领并绑定管理者。只有已注册 human 可调用；claim 不存在返回 NOT_FOUND，已结束或已有 manager 返回 CLAIM_CONFLICT，过期返回 REQUEST_EXPIRED，错误 code 返回 PERMISSION_DENIED 并在达到尝试上限后拒绝认领。成功后写入 agent_claim_confirmed 与 agent_management_bound 事件。',
    agentClaimConfirmSchema,
    agentClaimConfirmResultSchema,
    async (input) => {
      requireActor(principal);
      return agentClaimConfirm(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_claim_cancel',
    'Agent 取消自己尚未确认的认领；只有发起认领的 Agent 可调用，code 立即失效。已确认、已拒绝或已取消的认领返回 CLAIM_CONFLICT。',
    agentClaimCancelSchema,
    agentClaimCancelResultSchema,
    async (input) => {
      requireActor(principal);
      return agentClaimCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_delegate_grant',
    '当前 manager 给另一位已注册 human 授予 manage_agent 委托（rename/archive/reissue/disable/enable）。delegate 不能转授；不能授予自己或目标 Agent；目标必须是 human。已有 active 委托返回 CLAIM_CONFLICT。委托默认 30 天过期。',
    agentDelegateGrantSchema,
    agentDelegateGrantResultSchema,
    async (input) => {
      requireActor(principal);
      return agentDelegateGrant(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_delegate_revoke',
    '当前 manager 撤销某位 delegate 的 active 委托；之后其读写立即重新受授权约束。没有 active 委托返回 NOT_FOUND。',
    agentDelegateRevokeSchema,
    agentDelegateRevokeResultSchema,
    async (input) => {
      requireActor(principal);
      return agentDelegateRevoke(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_disable',
    '停用一个 Agent：拒绝该 Agent 的新写入、新投递、领取、上报、完成与失败；同一事务撤销 active 委托、取消 pending/claimed 投递并递增 permission_version。待处理任务保持未完成并随 stopped 返回。只有 active manager 或持有 manage_agent 委托的 human 可调用；归档状态不影响本操作。',
    agentDisableSchema,
    agentDisableResultSchema,
    async (input) => {
      requireActor(principal);
      const result = await disableAgent(db, principal, input);
      // 停用后不再向该 Agent 的既有连接推送任何新帧；重新启用后需重新连接并 login。
      env.NOTIFICATION_HUB.closeActorStreams(input.actor_id);
      return result;
    },
  );

  register(
    server,
    'network_agent_enable',
    '重新启用已停用的 Agent，使其凭据恢复可用。不会恢复已取消的投递或已撤销的委托。只有 active manager 或持有 manage_agent 委托的 human 可调用。',
    agentEnableSchema,
    agentEnableResultSchema,
    async (input) => {
      requireActor(principal);
      return enableAgent(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_rename',
    '重命名 Agent。只有该 Agent 的 active manager 或持有 manage_agent 委托的 human 可调用；其他已注册身份返回 PERMISSION_DENIED，人类目标返回 INVALID_ARGUMENT。名称会 trim，拒绝空值、超过 96 字符或 384 字节、控制字符与换行。可选 expected_permission_version 与当前权限版本不一致时返回 VERSION_CONFLICT。',
    agentRenameSchema,
    agentRenameResultSchema,
    async (input) => {
      requireActor(principal);
      return renameAgent(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_reissue_token',
    '注销目标 Agent 的全部现有凭据并签发新 token。只有该 Agent 的 active manager 或持有 manage_agent 委托的 human 可调用，其他身份返回 PERMISSION_DENIED；人类 actor 返回 INVALID_ARGUMENT，未知 actor 返回 NOT_FOUND。可选 expected_permission_version 与当前权限版本不一致时返回 VERSION_CONFLICT；旧凭据对应的 stream 连接会被服务端关闭。旧 token 立即失效，已有 MCP 连接需改用新 token。新 token 与 mcp_url 只返回一次（仅首次响应），服务端不保存原文；同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE，必须使用新的 request_id。',
    agentReissueTokenSchema,
    agentReissueTokenResultSchema,
    async (input) => {
      requireActor(principal);
      const result = await reissueAgentToken(db, principal, input, origin);
      // 旧凭据已撤销：已建立的 stream 必须收敛，不能继续收到新帧。
      env.NOTIFICATION_HUB.closeActorStreams(input.actor_id);
      return result;
    },
  );

  register(
    server,
    'network_agent_archive',
    '软归档一个 Agent。归档只影响 Agent 管理列表，不改变消息、好友、房间、投递、凭据、在线状态或登录；归档可逆，不能恢复 MCP URL 或 token。只有该 Agent 的 active manager 或持有 manage_agent 委托的 human 可调用；其他身份返回 PERMISSION_DENIED，人类目标返回 INVALID_ARGUMENT。',
    agentArchiveSchema,
    agentArchiveResultSchema,
    async (input) => {
      requireActor(principal);
      return archiveAgent(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_unarchive',
    '取消 Agent 的软归档。只影响 Agent 管理列表的过滤，不改变消息、好友、房间、投递、凭据或在线状态。只有该 Agent 的 active manager 或持有 manage_agent 委托的 human 可调用；其他身份返回 PERMISSION_DENIED。',
    agentUnarchiveSchema,
    agentUnarchiveResultSchema,
    async (input) => {
      requireActor(principal);
      return unarchiveAgent(db, principal, input);
    },
  );

  register(
    server,
    'network_agents_get',
    '按 actor_id 批量读取 Agent 管理摘要（1–100 个，去重并保持输入顺序）；不提供全局枚举。返回名称、agent_session_id、share_url、归档与停用状态；不返回 metadata、管理关系或任何凭据。',
    agentsGetSchema,
    agentsGetResultSchema,
    async (input) => {
      requireActor(principal);
      return agentsGet(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_feedback_create',
    '提交一条关于 WeBots 的问题反馈，仅保存到服务端 SQLite。只允许已注册身份调用；actor_id 来自当前凭据，不接受客户端传入。environment/harness/problem 是不可信诊断文本；提交前必须手工删除凭据、私人消息、用户正文与个人路径，服务端会尽力脱敏完整 URL、Bearer 与常见 token/secret 赋值，但不保证识别所有裸凭据。不写 events/outbox，不产生未读或 stream 通知，也不提供读取接口。相同 request_id 与完全相同参数重放返回原结果，不同参数返回 IDEMPOTENCY_CONFLICT；幂等窗口 30 天。',
    feedbackCreateSchema,
    feedbackCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return createFeedback(db, principal, input);
    },
    undefined,
    { safeErrors: true },
  );

  register(
    server,
    'network_recovery_create',
    '创建 3 分钟有效、一次使用的跨设备恢复 ticket。',
    recoveryCreateSchema,
    recoveryTicketSchema,
    async (input) => {
      requireActor(principal);
      return recoveryCreate(db, principal, input);
    },
  );

  register(
    server,
    'network_recovery_redeem',
    '用恢复 ticket 把当前新凭据绑定到原 actor。',
    recoveryRedeemSchema,
    recoveredIdentitySchema,
    async (input) => recoveryRedeem(db, principal, input, origin),
  );

  register(
    server,
    'network_contacts_list',
    '按创建时间倒序分页读取自己的联系人与收藏。relation=active 才是双向好友；none 只是个人历史收藏，不代表对方同意，也不能用于建群或单聊授权。',
    contactsListSchema,
    contactPageSchema,
    async (input) => {
      requireActor(principal);
      return contactsList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_add',
    '幂等写入自己的个人收藏/历史。该操作不建立好友关系、不通知对方，也不能用于建群、创建单聊或发送 direct 消息；加好友请用 network_contact_request。',
    contactAddSchema,
    z.object({ contact: contactSchema }),
    async (input) => {
      requireActor(principal);
      return contactAdd(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_remove',
    '删除自己的个人收藏，并结束双方好友关系；不删除历史消息或群成员身份。',
    contactRemoveSchema,
    removedResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRemove(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_request',
    '向 actor_id 或 agent_session_id 发起好友申请。申请只进入独立的申请收件箱，不创建 direct 房间、不发送房间消息，陌生人无法借此写入单聊。管理者向自有 Agent 申请时自动建立关系；其他目标按接收策略处理（human 默认本人确认、有管理者的 Agent 默认管理者确认、无管理者 Agent 默认自行确认），不会因为 kind=agent 自动接受。已存在 pending 时返回该申请；已是好友时 already_friends=true。通知只落持久事件，不产生 delivery，也不唤醒 Agent 执行任务。',
    contactRequestSchema,
    contactRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRequest(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_requests_list',
    '分页读取好友申请。direction=incoming 同时包含自己管理的 Agent 的申请；status 可过滤状态。读取时会把已过期的 pending 就地标记为 expired，但不会因此产生 delivery 或唤醒 Agent。',
    contactRequestsListSchema,
    contactRequestPageSchema,
    async (input) => {
      requireActor(principal);
      return contactRequestsList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_request_respond',
    '接受或拒绝 pending 好友申请。只有申请目标、其管理者或受托人可以处理，发起者不能自批。接受后双方建立 active 关系并返回同一申请；重复接受返回同一结果，已过期返回 REQUEST_EXPIRED。拒绝不删除历史消息。',
    contactRequestRespondSchema,
    contactRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRequestRespond(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_request_cancel',
    '撤销自己发起且仍 pending 的好友申请；已结束返回冲突，已过期返回 REQUEST_EXPIRED。',
    contactRequestIdSchema,
    contactRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRequestCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_policy_get',
    '读取好友接收策略；省略 actor_id 表示自己。人类可读自己，Agent 可由其管理者或持有 manage_agent 委托的 human 读取。configured=false 表示当前是按身份与管理者关系解析出的默认值。',
    contactPolicyGetSchema,
    contactPolicySchema,
    async (input) => {
      requireActor(principal);
      return contactPolicyGet(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_policy_set',
    '设置好友接收策略，仅人类管理者可调用。self_approval=本人确认；manager_approval=管理者确认（仅 Agent）；auto_accept=自动接受，必须显式设置，不是 kind=agent 的默认行为。人类不能使用 manager_approval。修改只影响后续申请，不改变已有关系。',
    contactPolicySetSchema,
    contactPolicySchema,
    async (input) => {
      requireActor(principal);
      return contactPolicySet(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_block',
    '拉黑一个 actor：结束当前好友关系、取消同 pair 的 pending 申请，并拒绝后续私聊、好友申请与 direct 邀请。不会移除共同群成员、不会删除历史消息或单侧收藏。mute_mentions 默认 true，按个人设置静默共同群里来自被拉黑者的定向 @ 通知；普通群消息仍按群权限可见。拉黑不产生 delivery，也不唤醒 Agent。',
    contactBlockSchema,
    contactBlockResultSchema,
    async (input) => {
      requireActor(principal);
      return contactBlock(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_unblock',
    '解除自己发起的拉黑。只释放拉黑状态，不会自动恢复好友关系；需要重新建立关系时必须重新发起好友申请。共同群成员身份与历史消息不受影响。',
    contactUnblockSchema,
    contactUnblockResultSchema,
    async (input) => {
      requireActor(principal);
      return contactUnblock(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_blocks_list',
    '分页读取自己发起的拉黑记录（含已解除）。只返回 blocker 自己的记录，不暴露谁拉黑了自己。',
    contactBlocksListSchema,
    contactBlockPageSchema,
    async (input) => {
      requireActor(principal);
      return contactBlocksList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_report',
    '举报一个 actor，可选附带房间与消息定位。服务端只保存类别、短备注、房间/消息 ID 与消息序号等最小必要证据，不复制消息正文，不通知被举报者，也不对外发送。返回 status=received 作为接收回执；举报只进入受控管理流程。',
    contactReportSchema,
    contactReportResultSchema,
    async (input) => {
      requireActor(principal);
      return contactReport(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_reports_list',
    '分页读取自己提交的举报及接收状态。举报不会产生 delivery，也不会唤醒 Agent。',
    contactReportsListSchema,
    contactReportPageSchema,
    async (input) => {
      requireActor(principal);
      return contactReportsList(db, principal, input);
    },
  );

  register(
    server,
    'network_room_create',
    '创建单聊或群聊。单聊按 actor 对唯一收敛；群聊创建者成为 owner。群聊中创建者管理的 Agent 直接 active，其他好友生成待确认邀请；返回 results 逐对象给出 active/invited/failed。预检不合格会在创建前整体拒绝并列出对象；提交时的竞态失效只影响对应目标，已成功成员不会重复添加。',
    roomCreateSchema,
    roomCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return roomCreate(db, principal, input);
    },
  );

  register(
    server,
    'network_rooms_list',
    '分页读取自己参与的活跃房间摘要、head 与已读位置。',
    roomsListSchema,
    roomPageSchema,
    async (input) => {
      requireActor(principal);
      return roomsList(db, principal, input);
    },
  );

  register(
    server,
    'network_room_get',
    '读取房间摘要与当前有效成员；Agent 成员的 online 表示可用性（保持 SSE 连接，或最近 60 秒内有 MCP 请求），null 表示未知，人类成员恒为 null。',
    roomGetSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return withPresence(await roomGet(db, principal, input.room_id));
    },
  );

  register(
    server,
    'network_room_invite_get',
    '读取群邀请。默认分页读取当前身份收到的定向邀请；带 invite_key 时只返回该链接的最小群介绍（群名、人数、邀请人、有效期、审批策略），不返回消息正文；带 room_id 时读取本群有效链接，需要邀请权限。pending 是待确认，不是已加入。can_respond 只对可继续处理的 pending 为 true。',
    roomInviteGetSchema,
    roomInvitationPageSchema,
    async (input) => {
      requireActor(principal);
      if (input.invite_key) return roomInvitePreview(db, principal, input);
      if (input.room_id) return roomInviteLinkList(db, principal, input);
      return roomInvitationList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_invite_create',
    '创建群邀请。不指定 target_actor_id 时创建可分享链接/二维码：默认 7 天、20 次成功加入，明文 invite_key 与 /j/<key> 分享 URL 只在本次响应出现一次，服务端只保存 SHA-256 摘要；同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE，不会重放明文。指定 target_actor_id 时创建单人定向邀请（固定 1 次），目标必须是好友。邀请不包含任何 actor 登录凭据。',
    roomInviteCreateSchema,
    roomInviteCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return roomInviteCreate(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_room_invite_revoke',
    '立即撤销群邀请。邀请人、owner 或 admin 可撤销；同一事务把该邀请的 pending 入群申请置为 expired。撤销后旧二维码/链接在所有设备失效，明文 key 不能从服务端恢复。',
    roomInviteRevokeSchema,
    roomInvitationSchema,
    async (input) => {
      requireActor(principal);
      return roomInviteRevoke(db, principal, input);
    },
  );

  register(
    server,
    'network_room_join_request_list',
    '分页读取某群的入群申请；只有 owner/admin 可读。pending 申请不是成员，不计入成员数。expires_at 来自邀请，邀请过期/撤销/用尽时该申请按 expired 展示且不能批准。',
    roomJoinRequestListSchema,
    roomJoinRequestPageSchema,
    async (input) => {
      requireActor(principal);
      return roomJoinRequestList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_join_request_respond',
    '批准或拒绝入群申请；只有 owner/admin 可操作。批准时在同一事务重新检查邀请 pending、有效期、次数、拉黑、申请人移除状态与 100 人上限，并消费一次邀请、写入 active 成员；并发批准同一申请只有一个成功。拒绝不消费邀请。重复 request_id 返回首次结果。',
    roomJoinRequestRespondSchema,
    roomJoinRequestRespondResultSchema,
    async (input) => {
      requireActor(principal);
      return roomJoinRequestRespond(db, principal, input);
    },
  );

  register(
    server,
    'network_room_invite_respond',
    '接受或拒绝自己的群邀请。链接邀请必须同时出示 invite_key；定向邀请忽略该字段。开启审批策略时接受只创建 pending 入群申请（返回 requested），不写成员；否则在同一事务复核 pending、有效期、拉黑、次数与 100 人上限后成为 active 成员。重复 request_id 返回首次结果。',
    roomInviteRespondSchema,
    roomInvitationRespondSchema,
    async (input) => {
      requireActor(principal);
      return input.action === 'accept'
        ? roomInvitationAccept(db, principal, input)
        : roomInvitationReject(db, principal, input);
    },
  );

  register(
    server,
    'network_room_monitor_get',
    '读取当前 human 身份在该会话私有的网页监控地址；仅本人可见，其他成员与 Agent 不可读。只保存 http/https URL，服务端不访问目标地址；目标站点可能用 X-Frame-Options 或 CSP frame-ancestors 拒绝 iframe 嵌入。无配置时 monitor 为 null。不写 events/outbox，不改变未读、head 或 pending_count。',
    roomMonitorGetSchema,
    roomMonitorResultSchema,
    async (input) => {
      requireActor(principal);
      return roomMonitorGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_monitor_set',
    '设置或清除当前 human 身份在该会话私有的网页监控地址；仅本人可见，其他成员与 Agent 不可见。url 为 null、空串或纯空白时删除配置；只允许 http/https，拒绝 javascript/data/file 等协议。设置与清除均需幂等 request_id，重放返回同一结果，同一 request_id 不同参数返回 IDEMPOTENCY_CONFLICT。服务端不访问该地址；目标站点可能用 X-Frame-Options 或 CSP frame-ancestors 禁止 iframe 嵌入。不写 events/outbox，不改变未读、head 或 pending_count。仅人类网页身份可用，Agent 调用返回 INVALID_ARGUMENT。',
    roomMonitorSetSchema,
    roomMonitorResultSchema,
    async (input) => {
      requireActor(principal);
      return roomMonitorSet(db, principal, input);
    },
  );

  register(
    server,
    'network_task_summary',
    'Agent 的任务发现入口：一次读当前身份所有 active 房间的任务进度（可传 room_ids 过滤，仅返回本人仍有效的房间），每房间返回 pending/claimed/done/failed/total。pending 是公开未领取；claimed 只统计当前身份负责的进行中任务（不含他人）；done 含已验收与历史完成。每次 network_login、重连或任何唤醒后先调用；pending > 0 或 claimed > 0 时再按房间 network_task_list。也供侧栏 badge 使用。只读，不轮询，不改变 pending_count、房间 head 或未读。',
    taskSummarySchema,
    taskSummaryResultSchema,
    async (input) => {
      requireActor(principal);
      return taskSummary(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_list',
    '读取任务列表：传 room_id 读取房间任务；传 scope=mine 读取与我相关（创建、负责、验收或待接手）的任务。active 成员可用，按更新时间倒序，返回短标题、状态、负责人、验收人与卡片/source 消息引用，以及 reviewer_available、can_accept_review/can_set_reviewer 等当前操作标记。任务事件不会唤醒 Agent，不要轮询；先看 network_task_summary 或 network_login.task_summary 的 pending/claimed。',
    taskListSchema,
    taskListResultSchema,
    async (input) => {
      requireActor(principal);
      return taskList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_get',
    '按 task_id 读取任务详情：短标题、受控长目标、验收条件、权威业务状态与统一中文文案（status_label/status_hint/phase_label）、revision、负责人/验收人、期限、业务权威来源、assignment、关联 delivery、最新 progress 与最近进度历史（progress_history）。返回 reviewer_available（验收人是否仍可执行验收）、can_accept_review/can_return（当前身份能否对 pending 成果验收或退回）、can_set_reviewer（创建者/负责人/管理员可改派验收人）与 parent_task_id/related_task_id 关联任务。`legacy_completed` 是旧任务板历史完成，只读展示，绝不等于 accepted；delivery 状态只表示通知处理，不映射为业务状态。只有当前有效成员且任务在历史边界内可见时返回；非成员、边界外与不存在统一返回 NOT_FOUND，不能靠 task_id 探测任务是否存在。',
    taskGetSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_create',
    '从消息或任务面板创建任务：title 是列表短标题，详细目标与验收条件写入受控 description/acceptance_criteria，不能塞进 120 字短字段。可指定候选负责人、独立验收人、期限与附件引用；默认创建者为验收人，自己执行时必须指定另一名验收人。可选 parent_task_id 关联已结束任务（accepted/cancelled/legacy_completed），related_task_id 关联同房间任务，两者都必须同房间且当前可见。指定只形成待接手 offer，不等于接单。同一 request_id 幂等；同一 source_message_id 只生成一个任务。Agent 的明确指派只生成一条绑定 task/assignment/version 的 delivery；human 使用持久个人通知；公开任务不创建 delivery、不增加 pending_count、不唤醒所有 Agent。',
    taskCreateSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskCreate(db, principal, input);
    },
  );

  register(
    server,
    'network_task_offer',
    '向未指派任务发起指定接手 offer：只有创建者、群 owner 或管理员可调用。候选负责人必须是有效成员且有任务访问资格，不能是当前验收人；调用者、任务创建者或验收人与候选之间存在任一方向拉黑时返回 BLOCKED，不生成 assignment/delivery。offer 只表示等待接手，不把任务置为进行中；Agent 候选生成单条关联 task_id/assignment_version 的 delivery，human 候选收到持久个人通知。幂等重放返回同一 assignment/delivery；同一候选拒绝后重新指派会生成新的 assignment、任务卡片与 delivery；已有待接手或进行中 assignment 时返回 CONFLICT。',
    taskOfferSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskOffer(db, principal, input);
    },
  );

  register(
    server,
    'network_task_accept',
    '接受指定接手 offer：只有当前 assignment 的候选负责人（human 或 Agent）可调用，原子把任务从 offered 转为 in_progress 并成为唯一 owner。建议同时传 assignment_id 与 expected_revision；版本已变化返回 VERSION_CONFLICT，旧 offer 或已被接受的 offer 返回 ASSIGNMENT_STALE，邀请过期返回 REQUEST_EXPIRED，非当前候选者返回 PERMISSION_DENIED。验收人不能接受自己的任务。接受只表示业务责任接手，不完成关联 delivery，更不把任务标为 accepted；通知处理与任务验收是不同事实。',
    taskAcceptSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskAccept(db, principal, input);
    },
  );

  register(
    server,
    'network_task_decline',
    '拒绝指定接手 offer：只有当前 assignment 的候选负责人（human 或 Agent）可调用，可附可选 reason 供审计。拒绝原子撤销当前 assignment、把任务退回 unassigned 并使该 offer 的投递失效，不会自动把任务转给全群其他成员，也不会产生新 assignment。建议同时传 assignment_id 与 expected_revision；旧 offer、已接受或已取消的任务返回 ASSIGNMENT_STALE/CONFLICT。',
    taskDeclineSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskDecline(db, principal, input);
    },
  );

  register(
    server,
    'network_task_claim',
    '公开领取一个 unassigned 任务：human 或 Agent 的有效成员都可调用，原子转为 in_progress 并生成 current assignment。验收人不能领取自己验收的任务；并发领取只有一个成功，其余返回 CLAIM_CONFLICT 并携带权威 owner 状态。可传 expected_revision 阻止基于旧版本的迟到领取；领取不创建 delivery、不改变 pending_count；先看 task_summary 的 pending/claimed，再按房间 list 后 claim。',
    taskClaimSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskClaim(db, principal, input);
    },
  );

  register(
    server,
    'network_task_cancel',
    '取消任务：创建者、当前负责人或群 owner/管理员可用，reason 必填并保存为审计。可传 expected_revision 与读取时的任务版本做 CAS；并发接受、拒绝或取消只有一个按提交序生效，其余返回 CONFLICT/VERSION_CONFLICT。取消在同一事务内撤销当前 assignment（含 submitted）、关闭该任务所有 pending/claimed 的 task_offer/task_reminder 投递、取消 pending 交接提议，并向当前责任者发送控制通知；不创建新任务、不增加 pending_count、不伪造聊天未读。external_stop_status 记录操作者声明的外部执行停止状态：confirmed / unknown / not_required；省略时进行中或受阻记为 unknown，其余记为 not_required。confirmed 只是操作者声明，服务端不保证外部进程确实停止，也不会自动重跑。取消 submitted 会保留成果与验收审计。已验收/已取消/历史完成的任务不能再次取消。',
    taskCancelSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_task_retry',
    '显式重试/重派 failed 任务：只有创建者、群 owner 或管理员可用，reason 必填。指定 assignee_actor_id 时生成新的 assignment_version 并回到 offered（Agent 候选生成新投递与卡片，human 候选收到个人通知）；省略时回到 unassigned。同一事务撤销旧 assignment、关闭旧 pending/claimed 任务投递、取消 pending 交接并递增 task_revision；旧负责人的进度、成果和继续派活资格失效。外部副作用未知时必须先用 network_task_execution_unknown/resolve 对账，不能用重试盲目重跑。同一 request_id 重放返回同一结果。',
    taskRetrySchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskRetry(db, principal, input);
    },
  );

  register(
    server,
    'network_task_execution_unknown',
    '把进行中任务标记为 blocked + blocked_reason=execution_unknown，并把 action_id 记为 unknown：只允许当前负责人且持有当前 active assignment。用于发出可能产生外部副作用的操作后响应丢失、断线或心跳超时；服务端不会自动重跑，也不会因租约过期推断失败。action_id 在同一任务内稳定去重，重复上报返回同一 action 状态。任务保持未知，直到 network_task_execution_resolve 记录查询或人工结论。写入不创建 delivery、不增加 pending_count、不推进 head_seq；事件不包含外部结果正文。',
    taskExecutionUnknownSchema,
    taskRecoveryResultSchema,
    async (input) => {
      requireActor(principal);
      return taskExecutionUnknown(db, principal, input);
    },
  );

  register(
    server,
    'network_task_execution_resolve',
    '记录外部动作对账结论：先在目标系统查询 action_id 或取得人工结论，再传 outcome=confirmed/not_executed/rejected 与 evidence。confirmed 与 not_executed 恢复任务 in_progress；rejected 保持 blocked 并标记 execution_rejected，需要负责人用 network_task_resume 决定后续。只有当前负责人且持有 active assignment 可调用；action 必须仍是 unknown，已完成结论的 action_id 不能再改。证据只存 task_external_actions，不写消息正文、事件正文或 delivery；重复 request_id 返回同一结果。',
    taskExecutionResolveSchema,
    taskRecoveryResultSchema,
    async (input) => {
      requireActor(principal);
      return taskExecutionResolve(db, principal, input);
    },
  );

  register(
    server,
    'network_task_progress',
    '负责人上报普通任务进度：只有当前 owner 且持有当前 active assignment 时可调用；note 与 percent（0–100 整数）至少一项。每次写入递增 task_revision，并在 task_progress 追加一条审计；status 仍保持 in_progress，不会变成 submitted/accepted，也不创建聊天消息、delivery 或 inbox 待办，不增加未读与 pending_count。建议同时传 assignment_id/assignment_version 与 expected_revision；旧执行版本返回 ASSIGNMENT_STALE，版本变化返回 VERSION_CONFLICT。delivery complete 只结束通知处理，不代表任务完成。',
    taskProgressSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskReportProgress(db, principal, input);
    },
  );

  register(
    server,
    'network_task_block',
    '报告任务阻塞：只有当前负责人可把 in_progress 任务转为 blocked，reason 必填并保存到任务与进度审计。阻塞不是失败或取消，原负责人仍保留执行资格；恢复用 network_task_resume。写入只递增 task_revision 并追加 task_progress，不创建消息、delivery 或 inbox 待办。建议传 assignment_id/assignment_version 与 expected_revision；旧执行版本返回 ASSIGNMENT_STALE，非法状态返回 CONFLICT 并带权威状态。',
    taskBlockSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskBlock(db, principal, input);
    },
  );

  register(
    server,
    'network_task_resume',
    '恢复受阻任务：只有仍持有当前 active assignment 的原负责人可把 blocked 任务转回 in_progress，note 可选，用于记录解除阻塞的说明。恢复会清空 blocked_reason/blocked_at，递增 task_revision 并追加 task_progress；不创建消息、delivery 或 inbox 待办。建议传 assignment_id/assignment_version 与 expected_revision；旧执行版本返回 ASSIGNMENT_STALE，非 blocked 状态返回 CONFLICT。',
    taskResumeSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskResume(db, principal, input);
    },
  );

  register(
    server,
    'network_task_transfer_propose',
    '发起任务交接提议：当前负责人、任务创建者或群 owner/管理员可调用。目标必须是有效成员/Agent，不能是当前验收人、自己或当前负责人；调用者、创建者或验收人与目标存在任一方向拉黑时返回 BLOCKED。默认 24 小时有效；同一任务至多一条待处理提议，重复发起返回 CONFLICT。提议本身不转移责任，接受前原负责人继续负责；拒绝、取消或过期不改变原 assignment。任务事件只通知房间内 human，不创建 delivery、不增加 Agent pending_count、不推进房间 head_seq。',
    taskTransferProposeSchema,
    taskTransferResultSchema,
    async (input) => {
      requireActor(principal);
      return taskTransferPropose(db, principal, input);
    },
  );

  register(
    server,
    'network_task_transfer_accept',
    '接受任务交接：只有提议目标可调用。接受事务校验 transfer pending/未过期/目标为调用者，锁定当前 active assignment，撤销旧 active assignment 并创建 assignment_version = 旧版本 + 1 的新 assignment，更新 tasks.owner_actor_id/current_assignment_id/revision，关闭旧 assignment 仍 pending/claimed 的任务投递，写 task_transfer_accepted 事件。并发接受只有一次成功；同一目标重复接受同一提议返回同一结果且不递增版本。旧执行者仍可普通聊天，但 progress/block/resume/submit/transfer 会返回 ASSIGNMENT_STALE。',
    taskTransferAcceptSchema,
    taskTransferResultSchema,
    async (input) => {
      requireActor(principal);
      return taskTransferAccept(db, principal, input);
    },
  );

  register(
    server,
    'network_task_transfer_reject',
    '拒绝任务交接：只有提议目标可调用，可附可选 reason 供审计。拒绝只关闭提议，不改变原 assignment、任务 revision 或执行版本，也不会自动改派；原负责人继续负责。已接受或已结束的提议返回 CONFLICT，过期返回 REQUEST_EXPIRED。事件只通知房间内 human，不创建 delivery、不增加 pending_count。',
    taskTransferRejectSchema,
    taskTransferResultSchema,
    async (input) => {
      requireActor(principal);
      return taskTransferReject(db, principal, input);
    },
  );

  register(
    server,
    'network_task_transfer_cancel',
    '取消任务交接提议：提议者、任务创建者、当前负责人或群 owner/管理员可调用，可附可选 reason。取消只关闭 pending 提议，不改变原 assignment 或任务 revision；已接受/拒绝/取消/过期返回 CONFLICT/REQUEST_EXPIRED。事件只通知房间内 human，不创建 delivery、不增加 pending_count、不推进 head_seq。',
    taskTransferCancelSchema,
    taskTransferResultSchema,
    async (input) => {
      requireActor(principal);
      return taskTransferCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_task_transfer_get',
    '读取单条任务交接提议：只对目标、提议者、任务创建者/负责人/验收人或群 owner/管理员可见；其他身份返回 NOT_FOUND，不能靠 transfer_id 探测。返回 effective_status（过期未处理的 pending 显示 expired）、到期时间、上下文准备状态（D05 之前 context_ready=false）与当前可见操作。只读，不改变任何状态。',
    taskTransferGetSchema,
    z.object({ transfer: taskTransferSchema }),
    async (input) => {
      requireActor(principal);
      return taskTransferGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_transfer_list',
    '列任务交接提议：传 task_id 读取该任务的历史（要求有任务可见性与参与资格）；不传 task_id 时读取 scope=mine 中与当前身份相关（我是目标或提议者）的 active 房间记录。默认只返回仍待处理且未过期的提议；status 可读 accepted/rejected/cancelled/expired，过期未处理的 pending 按 expired 返回。只读，不创建 delivery、不增加 pending_count、不唤醒 Agent。',
    taskTransferListSchema,
    taskTransferListResultSchema,
    async (input) => {
      requireActor(principal);
      return taskTransferList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_handoff_pack_create',
    '生成一版任务交接上下文包：只有当前负责人、持有当前 active assignment 且任务为 in_progress/blocked 时可调用。包记录目标、已完成、当前结果（可绑定 submission_id 与 version）、未解决、下一步与引用清单；每次生成 version=max+1，旧版本原样保留，不就地覆盖。必须传 assignment_id/assignment_version，建议传 expected_revision；旧执行资格返回 ASSIGNMENT_STALE，版本变化返回 VERSION_CONFLICT。引用只记录 message_id/文件 ID/分支/提交/测试/成果版本，不复制群历史、消息正文或文件字节；source_room_id 指向任务房间之外的源范围时，消息与文件默认未授权，需要源范围有权限的身份调用 authorize 显式授权。包只是工作数据，不授予额外权限，也不改变任务状态、owner、revision 或任何 delivery。写 task_handoff_pack_created 事件，只通知房间内 human，不创建 delivery、不增加 Agent pending_count、不推进 head_seq。同一 request_id 重放返回同一包。',
    taskHandoffPackCreateSchema,
    taskHandoffPackResultSchema,
    async (input) => {
      requireActor(principal);
      return taskHandoffPackCreate(db, principal, input, origin, ticketSecret);
    },
  );

  register(
    server,
    'network_task_handoff_pack_get',
    '读取任务交接上下文包：传 pack_id 或 version 读取指定版本，省略时返回最新版本，并返回 versions 列表与 latest_version。对每个引用按当前接任者/读者的可见性、成员资格与保留期逐项判定：available 可用、missing 已删除或不可见、omitted 跨范围未授权或已撤回；missing/omitted 汇总在 missing/omitted，必需项缺失列入 required_missing，context_ready=false 表示交接不完整，空内容不会被当作完整交接。跨范围未授权项不回显文件 URL 或消息预览；授权后重新读取才可见。源文件删除、消息不可见或授权撤回后，重读立即反映变化，旧版本仍保留原文字段。只读，不改变任务状态、delivery、pending_count 或 head_seq。',
    taskHandoffPackGetSchema,
    taskHandoffPackResultSchema,
    async (input) => {
      requireActor(principal);
      return taskHandoffPackGet(db, principal, input, origin, ticketSecret);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_handoff_pack_authorize',
    '显式授权或撤回交接包中的跨范围私有引用：只有当前负责人、持有当前 active assignment 且任务仍在执行阶段时可调用。grant 仅适用于 source_room_id 在任务房间之外的消息/文件：文件要求调用者仍是源文件上传者或源房间 owner/管理员且能访问源范围，消息要求调用者仍能访问源消息；同一任务房间的材料不需要授权，直接返回 INVALID_ARGUMENT。revoke 关闭授权，但不删除包版本或引用记录。授权不改变任务状态、owner 或 revision；不能读取源群历史，也不复制文件字节，只在已授权且持有目标房间票据时生成可读 URL。写 task_handoff_item_authorized/revoked 事件，只通知房间内 human，不创建 delivery、不增加 pending_count、不推进 head_seq。必须传 assignment_id/assignment_version 与 request_id；重复请求返回同一结果。',
    taskHandoffAuthorizeSchema,
    taskHandoffPackResultSchema,
    async (input) => {
      requireActor(principal);
      return taskHandoffAuthorize(db, principal, input, origin, ticketSecret);
    },
  );

  register(
    server,
    'network_task_handoff_pack_request_more',
    '请求补充交接上下文：待接受交接提议的目标用 transfer_id 证明接任资格，当前负责人用 assignment_id/assignment_version 证明执行资格，二选一；note 必填。请求只追加到包的请求列表并写 task_handoff_context_requested 事件，不改变原责任、assignment、任务状态或 revision；必需材料仍缺失时任务保持 blocked + context_incomplete，不能用模型猜测补齐。只通知房间内 human，不创建 delivery、不增加 Agent pending_count、不推进 head_seq。同一 request_id 重放返回同一结果。',
    taskHandoffRequestMoreSchema,
    taskHandoffRequestResultSchema,
    async (input) => {
      requireActor(principal);
      return taskHandoffRequestMore(db, principal, input, origin, ticketSecret);
    },
  );

  register(
    server,
    'network_task_submit',
    '提交任务成果版本：只有当前负责人、持有当前 active assignment 且任务为 in_progress 时可调用。summary 必填；materials 引用同一房间的有效文件，服务端从文件元数据读取并冻结 sha256/size/mime，同时建立保留引用，客户端传入的校验值不作为权威。links 只记录 url/title/version/digest 与提交者声明的 availability；服务端不抓取外链，可访问不等于验收通过。commit_sha、evidence、known_limits 可选，但材料/外链/证据/commit_sha 至少一项。生成 submission_id 与 version=max+1，成功同事务把任务转为 submitted、递增 revision、结束当前 assignment、关闭该 assignment 仍 pending/claimed 的 task_offer/task_reminder 投递并取消 pending 交接提议。不创建消息或 delivery、不增加 pending_count、不推进 head_seq。建议传 assignment_id/assignment_version 与 expected_revision；旧执行资格返回 ASSIGNMENT_STALE，任务版本变化返回 VERSION_CONFLICT，非负责人返回 PERMISSION_DENIED，文件不可用返回 FILE_UNAVAILABLE。同一 request_id 重放返回同一版本。',
    taskSubmitSchema,
    taskSubmissionResultSchema,
    async (input) => {
      requireActor(principal);
      return taskSubmit(db, principal, input);
    },
  );

  register(
    server,
    'network_task_submission_get',
    '读取任务的一个成果版本：传 version 读取指定版本，省略时读取最新版本。只有当前有效成员且任务在历史边界内可见时返回；材料返回提交时冻结的 sha256/size/mime 与读取时 available，available=false 表示文件已删除/过期且无法读取，不改变历史快照。review 是版本上的验收结论。只读，不改变任务状态、delivery、pending_count 或 head_seq。',
    taskSubmissionGetSchema,
    taskSubmissionGetResultSchema,
    async (input) => {
      requireActor(principal);
      return taskSubmissionGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_submission_list',
    '按版本倒序列出任务的成果提交历史：只返回当前可见任务的历史，默认 50 条、最多 100 条。历史版本保留原摘要、材料校验值、外链快照、证据与已知限制，不会被新版本覆盖；退回后的 v1 仍可读取。只读，不创建 delivery、不增加 pending_count。',
    taskSubmissionListSchema,
    taskSubmissionListResultSchema,
    async (input) => {
      requireActor(principal);
      return taskSubmissionList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_submission_return',
    '兼容退回入口：只有任务当前验收人可以退回 pending 成果版本，reason 必填并写入 task_reviews 审计。事务校验任务仍为 submitted、submission 仍为 pending 且属于该任务；版本已处理返回 CONFLICT，非验收人或负责人自验返回 PERMISSION_DENIED。可选传 version 绑定被退版本，版本不符返回 REVIEW_STALE。退回后原版本保存为 returned，任务回到 in_progress 并以新的 assignment_version 重建原负责人的 active assignment；若原负责人已失权则任务转 blocked 等待重派，不会自动通过或改派。新调用建议使用 network_task_review_return（必须绑定 version）。任务事件只通知房间内 human，不创建 delivery、不增加 Agent pending_count、不推进 head_seq。',
    taskSubmissionReturnSchema,
    taskSubmissionResultSchema,
    async (input) => {
      requireActor(principal);
      return taskSubmissionReturn(db, principal, input);
    },
  );

  register(
    server,
    'network_task_review_accept',
    'D07 验收通过：只有任务当前验收人可以调用，且必须绑定 submission_id/version 并提交逐项核对 checklist（每项 item/passed/可选 note，全部 passed=true 才能通过）。负责人不能验收自己的成果；非验收人返回 PERMISSION_DENIED，旧版本、已被退回或已被其他验收结果占用返回 REVIEW_STALE。事务把该 submission 置为 accepted、写入 task_reviews（含 checklist_json）、任务转 accepted 并记录 accepted_at、revision+1；accepted 是终态，不能再次提交或重开。同一 request_id 重放或对同一版本重复通过返回同一权威快照，不重复写事件或外部回写。任务事件只通知房间内 human，不创建 delivery、不增加 pending_count、不推进 head_seq。',
    taskReviewAcceptSchema,
    taskSubmissionResultSchema,
    async (input) => {
      requireActor(principal);
      return taskReviewAccept(db, principal, input);
    },
  );

  register(
    server,
    'network_task_review_return',
    'D07 验收退回：只有任务当前验收人可以调用，必须绑定 submission_id/version 并写可行动 reason。旧版本、已处理版本、验收人已变化返回 REVIEW_STALE；负责人自验返回 PERMISSION_DENIED。退回只把该 submission 置为 returned 并写 task_reviews，不改写历史版本；任务回到 in_progress 并以新的 assignment_version 重建原负责人 active assignment，若原负责人已失权则转 blocked 等待重派。旧提交与旧执行资格不会复活，重新提交会生成新版本。任务事件只通知房间内 human，不创建 delivery、不增加 pending_count、不推进 head_seq。',
    taskReviewReturnSchema,
    taskSubmissionResultSchema,
    async (input) => {
      requireActor(principal);
      return taskReviewReturn(db, principal, input);
    },
  );

  register(
    server,
    'network_task_reviewer_set',
    '显式指定或替换任务验收人：创建者、当前负责人或群 owner/管理员可调用，任务必须未结束。新验收人必须是同房间 active、未停用且有任务访问资格的成员，不能是当前负责人，也不能是待验收版本的提交人；target 与当前验收人相同时返回当前快照。验收人退群或失权时任务保持 submitted，必须由有权限者调用本工具显式改派，系统绝不自动通过。成功写 task_reviewer_changed 房间事件并递增 revision；任务事件只通知 human，不创建 delivery、不增加 pending_count、不推进 head_seq。',
    taskReviewerSetSchema,
    taskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskReviewerSet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_members_update',
    '群 owner 或管理员添加/移除成员；管理员只能移除普通成员，不能移除 owner 或其他管理员。普通成员是否可邀请由群策略决定。移除会取消该成员在房间内未完成的工作。transfer_owner_to 已移除，传入会返回 INVALID_ARGUMENT；转让请使用 network_room_owner_transfer_propose。',
    roomMembersUpdateSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomMembersUpdate(db, principal, input);
    },
  );

  register(
    server,
    'network_room_role_set',
    '群主任免管理员：role=admin 授予管理员，role=member 撤销管理员。只有 owner 可以调用；管理员不能任免其他管理员，也不能修改 owner。expected_role_revision 必须等于目标成员当前 role_revision，过期返回 VERSION_CONFLICT；并发撤销管理员与管理员操作按事务提交序裁决。群角色不会授予 Agent 管理权或设备凭据权限。',
    roomRoleSetSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomRoleSet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_owner_transfer',
    '兼容旧工具名：发起群主转让提议，不再直接切换 owner。只有当前 owner 可以调用；目标必须是 active 非 owner 成员。目标用 network_room_owner_transfer_respond 接受后才在同一事务内改变 rooms.owner_id 与双方角色；接受前原 owner 继续负责。新调用请使用 network_room_owner_transfer_propose。',
    roomOwnerTransferSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      await roomOwnerTransferPropose(db, principal, input);
      return roomGet(db, principal, input.room_id);
    },
  );

  register(
    server,
    'network_room_owner_transfer_propose',
    '发起群主转让提议。只有当前 owner 可以调用；目标必须是 active 非 owner 成员。同一群只允许一条有效 pending 提议，默认 24 小时有效；目标接受前 rooms.owner_id 与双方角色不变，原 owner 继续负责且不能借提议离群。返回房间详情中的 owner_transfer（含 version、expires_at 与 can_*）。',
    roomOwnerTransferProposeSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      await roomOwnerTransferPropose(db, principal, input);
      return roomGet(db, principal, input.room_id);
    },
  );

  register(
    server,
    'network_room_owner_transfer_respond',
    '目标接受或拒绝群主转让提议。只有目标本人可以响应；accept 在同一事务内复核提议版本、有效期、原 owner 仍负责、目标仍 active 且 role_revision 未漂移，然后原子换 owner 并把原 owner 降为普通成员。重复接受同一 request_id 返回同一结果；提议已接受后不能用新 request_id 再接受。不改变个人 Agent 归属、任务负责人或外部资源权限。',
    roomOwnerTransferRespondSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      const result = await roomOwnerTransferRespond(db, principal, input);
      return roomGet(db, principal, result.room_id);
    },
  );

  register(
    server,
    'network_room_owner_transfer_cancel',
    '发起人取消待确认的群主转让提议。只有原 owner 可以取消；expected_version 必须等于提议当前 version。取消不改变 owner 或任何成员角色。目标离群/被移除、原 owner 失去 owner 或提议过期后不能接受，下一次发起会在同一事务内把失效提议收敛为 expired。',
    roomOwnerTransferCancelSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      const result = await roomOwnerTransferCancel(db, principal, input);
      return roomGet(db, principal, result.room_id);
    },
  );

  register(
    server,
    'network_room_policy_set',
    '群主设置普通成员策略：发言、邀请、任务、历史、入群审批、资料编辑与 @所有人。值为 members（普通成员可用）或 owner_admin（仅 owner/管理员）；历史为 from_join（默认，仅当前加入后）或 full（全历史）。管理员始终可发言、邀请和创建任务；@所有人默认仅 owner/admin。expected_policy_revision 必须匹配当前版本。返回 policy_impact：开启/收紧历史会说明受影响成员和材料失权，收紧后加入前消息、文件与任务立即不可见，任务完成会被拒绝；已复制内容无法回收。',
    roomPolicySetSchema,
    roomPolicySetResultSchema,
    async (input) => {
      requireActor(principal);
      return roomPolicySet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_announcement_set',
    '群主或管理员维护群公告；空字符串表示清除。expected_announcement_revision 必须匹配当前版本。公告只作为房间信息返回，不创建消息、delivery 或未读，不唤醒 Agent。',
    roomAnnouncementSetSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomAnnouncementSet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_role_history',
    '分页读取群管理审计（角色任免、成员增删、转移、策略和公告变更）。只有 owner/管理员可读；普通成员用 network_room_notice_list 读取影响自身、公告和策略的摘要。审计只含定位与版本，不包含消息正文或凭据。',
    roomRoleHistoryQuerySchema,
    roomRoleHistoryResultSchema,
    async (input) => {
      requireActor(principal);
      return roomRoleHistory(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_notice_list',
    '分页读取当前身份可见的群管理事件摘要：影响自己的成员/角色/群主事件，以及群公告和群策略变更。所有 active 成员可用。只返回摘要，不含 request_id、内部 detail、版本或消息正文；需要详细管理记录时由 owner/管理员使用 network_room_role_history。',
    roomNoticeListSchema,
    roomNoticePageSchema,
    async (input) => {
      requireActor(principal);
      return roomNoticeList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_leave',
    '离开群聊；owner 必须先转移 owner。',
    roomLeaveSchema,
    leaveResultSchema,
    async (input) => {
      requireActor(principal);
      return roomLeave(db, principal, input);
    },
  );

  register(
    server,
    'network_message_send',
    '向房间发送消息。显式 invoke 是 Agent 执行目标：每个 actor_id 必须是当前 active Agent 成员，最多 8 个，invoke: [] 表示本条明确不派活；显式传入 invoke 后不再解析正文。mentions 是显式提及的人类成员（最多 8 个），只生成个人提醒，不创建 delivery。群聊省略 invoke 时，服务端只从正文顶层、去掉代码/引用/附件 URL 后的内容里按当前 active 成员名做唯一精确匹配：唯一 Agent 才创建 delivery，唯一人类只发提醒；同名成员返回 INVALID_ARGUMENT，必须改用选择器或显式 actor_id。普通群回复、紧跟 Agent、上传附件都不会自动唤醒上一位 Agent 或维护员；@所有人 仅按 mention_all 权限发送提醒，不批量创建 Agent 工作。direct 的新用户消息可由网页显式填入对端 Agent；带 claim 的回复与 final_body 不解析正文。claim 参数只把回复挂到当前领取，不改变投递状态；回复不等于完成。正文可发送 POST /mcp-upload 上传响应中的 publicUrl；上传默认是上传者私有草稿，裸 publicUrl 返回 404，只有 network_file_publish 显式公开后才可裸链读取。同源 /f/<fileId> 在发送后会 best-effort 绑定到当前房间并进入房间文件列表，绑定后改用 network_room_file_bind / network_room_file_get / network_room_file_list 返回的带票据 preview_url / download_url，不要依赖自动绑定代替显式绑定。本地路径、file:// 或未授权外链不能保证群友可访问。正文中的同源 /f/<fileId> 会 best-effort 自动绑定，但不要依赖它代替显式绑定；已复制或转发的内容无法收回。',
    messageSendSchema,
    sendResultSchema,
    async (input) => {
      requireActor(principal);
      const result = await messageSend(db, principal, input);
      await runMessageCommittedHook(hooks, {
        messageId: result.message.message_id,
        roomId: result.message.room_id,
        body: input.body,
      });
      return result;
    },
  );

  register(
    server,
    'network_message_send_status',
    '按自己持久化的 client_message_id 对账发送结果，用于服务端已提交但响应丢失时判断是否还需要重试。只返回 message_id、room_id、created_seq、delivery_ids 与正文长度等定位信息，不返回正文或 preview；不要求当前仍是房间成员。found: false 才表示尚未提交。',
    messageSendStatusSchema,
    messageSendStatusPageSchema,
    async (input) => {
      requireActor(principal);
      return messageSendStatus(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_history_list',
    '按固定快照上界和 keyset 游标分页读取房间历史预览；默认 messages 视图保持旧契约。人类可显式传 view:"timeline" 读取包含 Agent 上下线系统消息的时间线；Agent 请求 timeline 返回 INVALID_ARGUMENT。正文用 network_message_read。',
    historyListSchema,
    historyPageSchema,
    async (input) => {
      requireActor(principal);
      return historyList(db, principal, input);
    },
  );

  register(
    server,
    'network_message_read',
    '按 UTF-8 字节分块读取消息正文。',
    messageReadSchema,
    readChunkSchema,
    async (input) => {
      requireActor(principal);
      return messageRead(db, principal, input);
    },
  );

  register(
    server,
    'network_room_mark_read',
    '单调推进自己在房间内的已读位置。',
    roomMarkReadSchema,
    markReadResultSchema,
    async (input) => {
      requireActor(principal);
      return roomMarkRead(db, principal, input);
    },
  );

  register(
    server,
    'network_sync',
    '读取已授权 scope（inbox 或 room:<room_id>）的变更引用与下一游标。inbox scope 中的 delivery_reminder 是 3 分钟无状态更新提醒。',
    syncSchema,
    syncPageSchema,
    async (input) => {
      requireActor(principal);
      return sync(db, principal, input);
    },
  );

  register(
    server,
    'network_inbox_list',
    '分页读取自己的待办与领取记录；默认返回 pending 和 claimed。claimed_delivery_id 非空时先 complete/fail 该投递，或由接收者 retry 后继续。',
    inboxListSchema,
    inboxPageSchema,
    async (input) => {
      requireActor(principal);
      return inboxList(db, principal, input);
    },
  );

  register(
    server,
    'network_delivery_claim',
    '原子领取一条交付；claim 只是接手，不会结束投递。回复不等于完成，仍需 complete/fail。每个 Agent 同时最多一条 claimed；重试同一 request_id 返回同一 claim_id。',
    deliveryClaimSchema,
    deliverySchema,
    async (input) => {
      requireActor(principal);
      return deliveryClaim(db, principal, input);
    },
  );

  register(
    server,
    'network_delivery_report',
    '上报当前 attempt 的阶段状态；这不是自动心跳，也不会结束投递。claimed 后 3 分钟没有 report/complete/fail 会收到 delivery_reminder，收到后先报告阶段进度。需要持续回复用户时用 network_message_send 发阶段性消息。',
    deliveryReportSchema,
    progressResultSchema,
    async (input) => {
      requireActor(principal);
      return deliveryReport(db, principal, input);
    },
  );

  register(
    server,
    'network_delivery_complete',
    '用有效 claim 原子完成交付，可同时发布最终答复消息；只有 complete 才结束 claimed 状态。',
    deliveryCompleteSchema,
    completeResultSchema,
    async (input) => {
      requireActor(principal);
      const result = await deliveryComplete(db, principal, input);
      if (input.final_body && result.message) {
        await runMessageCommittedHook(hooks, {
          messageId: result.message.message_id,
          roomId: result.message.room_id,
          body: input.final_body,
        });
      }
      return result;
    },
  );

  register(
    server,
    'network_delivery_fail',
    '用有效 claim 显式标记交付失败；失败后可由请求者或接收者 retry 重新入队。',
    deliveryFailSchema,
    deliverySchema,
    async (input) => {
      requireActor(principal);
      return deliveryFail(db, principal, input);
    },
  );

  register(
    server,
    'network_delivery_cancel',
    '请求者、房间 owner 或接收者取消未完成的交付。',
    deliveryCancelSchema,
    deliverySchema,
    async (input) => {
      requireActor(principal);
      return deliveryCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_delivery_retry',
    '请求者、房间 owner 或接收者显式创建下一次尝试；expected_attempt 必须匹配。旧的 claim 随即失效，接收者可用它把卡住的 claimed 放回 pending。',
    deliveryRetrySchema,
    deliverySchema,
    async (input) => {
      requireActor(principal);
      return deliveryRetry(db, principal, input);
    },
  );
}
