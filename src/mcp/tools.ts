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
  contactPolicyGetSchema,
  contactPolicySetSchema,
  contactRemoveSchema,
  contactRequestIdSchema,
  contactRequestRespondSchema,
  contactRequestSchema,
  contactRequestsListSchema,
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
  profileUpdateSchema,
  recoveryCreateSchema,
  recoveryRedeemSchema,
  registerSchema,
  roomAnnouncementSetSchema,
  roomCreateSchema,
  roomGetSchema,
  roomLeaveSchema,
  roomMarkReadSchema,
  roomMembersUpdateSchema,
  roomMonitorGetSchema,
  roomMonitorSetSchema,
  roomOwnerTransferSchema,
  roomPolicySetSchema,
  roomRoleHistorySchema as roomRoleHistoryQuerySchema,
  roomRoleSetSchema,
  roomsListSchema,
  syncSchema,
  taskAddSchema,
  taskClaimSchema,
  taskCompleteSchema,
  taskDeleteSchema,
  taskFailSchema,
  taskListGetSchema,
  taskSummarySchema,
  taskUpdateSchema,
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
  roomMarkRead,
} from '../domain/messages';
import {
  roomAnnouncementSet,
  roomCreate,
  roomGet,
  roomLeave,
  roomMembersUpdate,
  roomOwnerTransfer,
  roomPolicySet,
  roomRoleHistory,
  roomRoleSet,
  roomsList,
  type RoomDetail,
} from '../domain/rooms';
import { roomMonitorGet, roomMonitorSet } from '../domain/room-monitors';
import {
  taskAdd,
  taskClaim,
  taskComplete,
  taskDelete,
  taskFail,
  taskListGet,
  taskSummary,
  taskUpdate,
} from '../domain/tasks';
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
  contactPageSchema,
  contactPolicySchema,
  contactRequestPageSchema,
  contactRequestResultSchema,
  contactSchema,
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
  roomMonitorResultSchema,
  roomPageSchema,
  roomRoleHistorySchema as roomRoleHistoryResultSchema,
  roomTaskDeletedSchema,
  roomTaskListSchema,
  roomTaskResultSchema,
  roomTaskSummarySchema,
  sendResultSchema,
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
    return { room: detail.room, members };
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
    'network_room_create',
    '创建单聊或群聊。单聊按 actor 对唯一收敛；群聊创建者成为 owner。',
    roomCreateSchema,
    roomDetailSchema,
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
    'network_task_list_get',
    '读取房间任务列表（默认列表）：active 成员可用，返回短描述、状态、assignee 与结果，以及 total/done。先看 network_task_summary 或 network_login.task_summary 的 pending/claimed：pending > 0 或 claimed > 0 时按房间 list。任务变更不会唤醒 Agent，不要轮询。',
    taskListGetSchema,
    roomTaskListSchema,
    async (input) => {
      requireActor(principal);
      return taskListGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_summary',
    'Agent 的任务发现入口：一次读当前身份所有 active 房间的任务进度（可传 room_ids 过滤，仅返回本人仍有效的房间），每房间返回 pending/claimed/done/failed/total。pending 是未领取；claimed 只统计当前身份领取（不含他人）；done/failed/total 是房间总量，total 含他人 claimed。每次 network_login、重连或任何唤醒后先调用；pending > 0 或 claimed > 0 时再按房间 network_task_list_get（claimed 用于恢复自己断线前领取的任务）。也供侧栏 badge 使用，避免逐房间 list。只读，不轮询，不改变 pending_count、房间 head 或未读。',
    taskSummarySchema,
    roomTaskSummarySchema,
    async (input) => {
      requireActor(principal);
      return taskSummary(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_add',
    '向房间添加一个 pending 任务；任何 active 成员（含 human）都可添加。多步骤、跨文件或需要别人接手的交付物应先登记为任务，描述写目标与交付物。description trim 后必须为 1–120 个字符且不含换行/控制字符；长内容请写成 .md 文件。任务变更只写 room informational 事件，不写 inbox、不推进 head、不产生未读，也不唤醒 Agent；需要立即处理时另发消息并 @ 名字。',
    taskAddSchema,
    roomTaskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskAdd(db, principal, input);
    },
  );

  register(
    server,
    'network_task_claim',
    'Agent 成员领取一个 pending 任务，原子转为 claimed 并记录 assignee。human 调用返回 INVALID_ARGUMENT；并发或被他人领取返回 CLAIM_CONFLICT。任务通知不唤醒 Agent；先看 task_summary 的 pending/claimed，再按房间 list 后 claim。',
    taskClaimSchema,
    roomTaskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskClaim(db, principal, input);
    },
  );

  register(
    server,
    'network_task_complete',
    '仅任务 assignee 可把 claimed 任务完成为 done；result 必须为 1–120 个字符且不含换行/控制字符。任务完成不写 inbox、不产生未读或 head 变化。',
    taskCompleteSchema,
    roomTaskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskComplete(db, principal, input);
    },
  );

  register(
    server,
    'network_task_fail',
    '仅任务 assignee 可把 claimed 任务标记为 failed；error 必须为 1–120 个字符且不含换行/控制字符。任务失败不写 inbox、不产生未读或 head 变化。',
    taskFailSchema,
    roomTaskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskFail(db, principal, input);
    },
  );

  register(
    server,
    'network_task_update',
    '任务创建者或房间 owner 修改任务描述，不改变状态、assignee、结果或完成时间。description 限制同 add。',
    taskUpdateSchema,
    roomTaskResultSchema,
    async (input) => {
      requireActor(principal);
      return taskUpdate(db, principal, input);
    },
  );

  register(
    server,
    'network_task_delete',
    '任务创建者或房间 owner 删除任务；不改变消息、未读、head 或 inbox。',
    taskDeleteSchema,
    roomTaskDeletedSchema,
    async (input) => {
      requireActor(principal);
      return taskDelete(db, principal, input);
    },
  );

  register(
    server,
    'network_room_members_update',
    '群 owner 或管理员添加/移除成员；管理员只能移除普通成员，不能移除 owner 或其他管理员。普通成员是否可邀请由群策略决定。移除会取消该成员在房间内未完成的工作。transfer_owner_to 仅兼容旧客户端，必须同时给出 expected_role_revision；新调用请使用 network_room_owner_transfer。',
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
    '转移群 owner。只有当前 owner 可以调用；目标必须是 active 非 owner 成员，expected_role_revision 为目标当前角色版本。新旧 owner 角色与 rooms.owner_id 在同一事务提交，唯一 owner 约束保证不会出现两个群主。转移后原 owner 变为普通成员。',
    roomOwnerTransferSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomOwnerTransfer(db, principal, input);
    },
  );

  register(
    server,
    'network_room_policy_set',
    '群主设置普通成员策略：member_message_policy/member_invite_policy/member_task_policy，值为 members（普通成员可用）或 owner_admin（仅 owner/管理员）。管理员始终可发言、邀请和创建任务。expected_policy_revision 必须匹配当前版本。修改只影响后续操作，不追溯已有消息或任务。',
    roomPolicySetSchema,
    roomDetailSchema,
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
    '分页读取群管理审计（角色任免、成员增删、转移、策略和公告变更）。只有 owner/管理员可读。审计只含定位与版本，不包含消息正文或凭据。',
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
    '向房间发送消息。群聊省略 invoke 时服务端按正文 @名字 解析当前 active Agent 成员并创建 delivery；用户在群聊未 @ 且紧邻上一条来自 active Agent 时自动投递该 Agent；显式 invoke 优先且不再解析正文；invoke: [] 表示显式不投递；带 claim 的回复不自动解析。claim 参数只把回复挂到当前领取，不改变投递状态；回复不等于完成。',
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
