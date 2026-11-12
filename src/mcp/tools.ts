import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { isBusinessError } from '../contracts/errors';
import { memoryIntakeFromEnv } from '../memory/intake';
import { messageSearch, messageContext, messageSearchSchema, messageContextSchema, messageSearchOutputSchema, messageContextOutputSchema } from '../domain/message-search';
import {
  messageTaskMark,
  messageTaskSummaries,
  messageTaskTrace,
  messageTaskUnmark,
} from '../domain/message-tasks';
import { messageTaskSearch } from '../domain/message-task-search';
import { fileTicketSecret } from '../domain/file-ticket';
import { messageRecallSchema } from '../contracts/message-recall';
import { messageRecall } from '../domain/message-recall';
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
  agentTransferCancelSchema,
  agentTransferGetSchema,
  agentTransferListSchema,
  agentTransferProposeSchema,
  agentTransferRespondSchema,
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
  contactSearchSchema,
  contactLinkCreateSchema,
  contactLinkListSchema,
  contactLinkPreviewSchema,
  contactLinkRedeemSchema,
  contactLinkRevokeSchema,
  contactUnblockSchema,
  contactsListSchema,
  deliveryCancelSchema,
  deliveryClaimSchema,
  deliveryCompleteSchema,
  deliveryFailSchema,
  deliveryReportSchema,
  deliveryRetrySchema,
  deviceListSchema,
  devicePairingApproveSchema,
  devicePairingCancelSchema,
  devicePairingCreateSchema,
  devicePairingJoinSchema,
  devicePairingListSchema,
  devicePairingRedeemSchema,
  deviceRevokeSchema,
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
  messageTaskMarkSchema,
  messageTaskSearchSchema,
  messageTaskSummariesSchema,
  messageTaskTraceSchema,
  messageTaskUnmarkSchema,
  profileUpdateSchema,
  recoveryCreateSchema,
  recoveryRedeemSchema,
  registerSchema,
  roomRenameSchema,
  roomAnnouncementSetSchema,
  roomCreateSchema,
  roomDissolveSchema,
  roomGetSchema,
  roomInviteCreateSchema,
  roomInviteGetSchema,
  roomInviteRespondSchema,
  roomInviteRevokeSchema,
  roomJoinRequestListSchema,
  roomJoinRequestRespondSchema,
  roomLeavePreviewSchema as roomLeavePreviewQuerySchema,
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
import {
  agentTransferCancel,
  agentTransferPropose,
  agentTransferRespond,
} from '../domain/agent-transfers';
import { agentTransferGet, agentTransferList } from '../domain/agent-transfer-reads';
import { contactAdd, contactRemove, contactsList } from '../domain/contacts';
import { contactSearch } from '../domain/contact-search';
import {
  contactBlock,
  contactBlocksList,
  contactReport,
  contactReportsList,
  contactUnblock,
} from '../domain/contact-blocks';
import { contactPolicyGet, contactPolicySet } from '../domain/contact-policies';
import {
  contactLinkCreate,
  contactLinkList,
  contactLinkPreview,
  contactLinkRedeem,
  contactLinkRevoke,
} from '../domain/contact-invite-links';
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
  approveDevicePairing,
  cancelDevicePairing,
  createDevicePairing,
  joinDevicePairing,
  listDevicePairings,
  redeemDevicePairing,
} from '../domain/device-pairings';
import {
  listDevices,
  revokeDevice,
} from '../domain/devices';
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
  type RoomPage,
} from '../domain/rooms';
import { roomRename } from '../domain/room-profile';
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
import { roomDissolve, roomLeavePreview } from '../domain/room-lifecycle';
import {
  roomOwnerTransferCancel,
  roomOwnerTransferPropose,
  roomOwnerTransferRespond,
} from '../domain/owner-transfers';
import { sync } from '../domain/sync';
import type { Env } from '../env';
import { login, presenceOf, presenceOfMany } from '../realtime/presence';
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
  agentTransferAcceptedResultSchema,
  agentTransferListResultSchema,
  agentTransferRespondResultSchema,
  agentTransferSimpleResultSchema,
  agentTransferViewSchema,
  agentReissueTokenResultSchema,
  agentRenameResultSchema,
  agentUnarchiveResultSchema,
  agentsGetResultSchema,
  agentsManagedListResultSchema,
  completeResultSchema,
  contactBlockPageSchema,
  contactBlockResultSchema,
  contactPageSchema,
  contactLinkCreateResultSchema,
  contactLinkListResultSchema,
  contactLinkPreviewResultSchema,
  contactLinkRedeemResultSchema,
  contactLinkRevokeResultSchema,
  contactPolicySchema,
  contactReportPageSchema,
  contactReportResultSchema,
  contactRequestPageSchema,
  contactRequestResultSchema,
  contactSearchResultSchema,
  contactSchema,
  contactUnblockResultSchema,
  deliverySchema,
  deviceListResultSchema,
  devicePairingCreatedSchema,
  devicePairingJoinResultSchema,
  devicePairingListResultSchema,
  devicePairingRedeemResultSchema,
  devicePairingResultSchema,
  deviceRevokeResultSchema,
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
  roomDissolveResultSchema,
  roomLeavePreviewSchema as roomLeavePreviewResultSchema,
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
  sendResultSchema,
  messageSendStatusPageSchema,
  syncPageSchema,
  taskMarkResultSchema,
  taskSearchResultSchema,
  taskSummariesResultSchema,
  taskTraceResultSchema,
  taskUnmarkResultSchema,
} from './outputs';
import type { Principal } from '../domain/principal';
import {
  clientGuide, clientGuideInputSchema, clientGuideOutputSchema,
  clientServiceInfo, recordToolContract, registeredToolNames, serviceInfoSchema,
} from './client-contract';
import { memoryCapabilityCatalog } from '../memory/capability-catalog';
import { DEFAULT_MEMORY_HOST_POLICY } from '../memory/host-bridge';

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
  recordToolContract(server, name, { description, inputSchema, outputSchema, annotations });
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
  // MEMORY_ENABLED=1 且运行时已启动时才追加来源/预热语句；否则保持原事务。
  const memory = memoryIntakeFromEnv(env);
  const memoryCatalog = () =>
    memoryCapabilityCatalog({
      enabled: env.MEMORY?.instanceId != null,
      capture: env.MEMORY?.captureEnabled ?? false,
      policy: env.MEMORY_HOST ?? DEFAULT_MEMORY_HOST_POLICY,
      tools: registeredToolNames(server).filter((name) => name.startsWith('network_memory_')),
      engine: env.MEMORY_ENGINE ?? null,
      reflect: env.MEMORY?.capabilities().reflect ?? false,
    });

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

  /**
   * 为 rooms_list 当前页的 direct Agent 对端批量补充在线快照。
   *
   * 域层只返回 peer 的稳定资料，online 保持 null；这里用一次批量
   * presence 查询覆盖整页，避免把浏览器的逐房间补全转移成逐 Agent
   * 的数据库查询。人类对端保持 null。
   */
  async function withRoomListPresence(page: RoomPage): Promise<RoomPage> {
    const agentIds = page.items.flatMap((item) =>
      item.peer && item.peer.kind === 'agent' ? [item.peer.actor_id] : [],
    );
    if (agentIds.length === 0) return page;
    const presences = await presenceOfMany(env, agentIds);
    return {
      ...page,
      items: page.items.map((item) => {
        if (!item.peer || item.peer.kind !== 'agent') return item;
        const presence = presences.get(item.peer.actor_id);
        return {
          ...item,
          peer: { ...item.peer, online: presence ? presence.online : null },
        };
      }),
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

  register(server, 'network_me', '读取当前身份与 service（协议/契约版本、工具集摘要和可用能力）。完整宿主流程用 network_client_guide；服务端工具与连接器目录不同步时刷新目录，不要换身份。', meSchema, identitySchema.extend({ service: serviceInfoSchema }), async () => {
    requireActor(principal);
    return { ...(await me(db, principal, origin)), service: clientServiceInfo(server, !!env.EVENTS, memoryCatalog()) };
  }, { readOnlyHint: true });

  register(server, 'network_client_guide',
    '按 one_shot（默认单次操作）、webhook（宿主事件回调）或 persistent（常驻 MCP 客户端）读取完整操作指引与当前工具目录。可传 client_tool_names 比对连接器缺失项；只读，不注册身份、不 login、不订阅、不领取工作。',
    clientGuideInputSchema, clientGuideOutputSchema,
    async (input) => clientGuide(server, !!env.EVENTS, memoryCatalog(), input), { readOnlyHint: true });

  register(
    server,
    'network_login',
    '常驻 MCP 客户端在 agentnet://stream 订阅 ack 后显式上线；未上线时投递仍保存在 SQLite。单次收发与宿主 webhook 回调无需以 login 建立监听。重复调用幂等，返回待办数量与 inbox 头。pending_count 是未领取的普通投递数，不代表任务总数；会话与任务摘要由 network_inbox_list、network_rooms_list 与 network_task_summaries 读取。login 不改变 pending_count、房间 head、未读或在线状态。online: true 只代表调用成功，不能证明订阅可达。',
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
    '按最近绑定时间倒序分页列出当前 human 作为 manager 或 delegate 管理的 Agent。默认排除已归档 Agent；需要读取归档状态时显式传 include_archived: true。只包含调用者确有权管理的目标；cursor/limit 分页（默认 50，最大 100）。',
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
    '停用一个 Agent：拒绝该 Agent 的新写入、新投递、领取、上报、完成与失败；同一事务撤销 active 委托、取消 pending/claimed 投递并递增 permission_version。只有 active manager 或持有 manage_agent 委托的 human 可调用；归档状态不影响本操作。',
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
    'network_agent_transfer_propose',
    '当前管理者发起 Agent 管理权交接，指定一个有效 human 作为接任者。接任者必须是已注册、未停用/归档、仍有有效凭据的 human，不能是当前管理者或 Agent 自己；同一 Agent 只允许一条 pending 提议，默认 24 小时有效。提议只写人类 inbox 提示与审计事件，不创建 Agent delivery、不改变管理权、委托或 Agent 凭据。拒绝/取消/过期同样不改变管理权。只有 active manager 可发起，委托人与 Agent 自己返回 PERMISSION_DENIED。',
    agentTransferProposeSchema,
    agentTransferViewSchema,
    async (input) => {
      requireActor(principal);
      return agentTransferPropose(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_transfer_respond',
    '接任者接受或拒绝管理权交接。只有提议中的 to_manager 本人可调用，其他身份返回 NOT_FOUND；过期返回 REQUEST_EXPIRED，状态已变化返回 CONFLICT。接受在同一事务内切换 agent_managements、permission_version + 1、撤销旧管理者全部 active 委托、撤销该 Agent 全部运行凭据并签发一个新 token。新 token 只在首次 accept 响应出现一次，服务端只保存 SHA-256，不写入 operations；同一 request_id 重放返回同一非秘密结果（token 为 null），不会再次轮换。旧管理者提交后所有管理工具返回 PERMISSION_DENIED，旧 token 立即 CREDENTIAL_INVALID。',
    agentTransferRespondSchema,
    agentTransferRespondResultSchema,
    async (input) => {
      requireActor(principal);
      return agentTransferRespond(db, principal, input, origin, {
        onAccepted: ({ agentId, revokedCredentialIds }) => {
          for (const credentialId of revokedCredentialIds) {
            env.NOTIFICATION_HUB.revokeCredential(credentialId);
          }
          // 旧运行连接的订阅随凭据轮换关闭；Agent 需用新 token 重连并重新 login。
          env.NOTIFICATION_HUB.closeActorStreams(agentId);
        },
      });
    },
  );

  register(
    server,
    'network_agent_transfer_cancel',
    '发起人取消尚未接受的 Agent 管理权交接。只有 from_manager 本人可调用，其他身份返回 NOT_FOUND；过期返回 REQUEST_EXPIRED。取消不改变管理权、委托、运行凭据或其他业务状态。',
    agentTransferCancelSchema,
    agentTransferSimpleResultSchema,
    async (input) => {
      requireActor(principal);
      return agentTransferCancel(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_transfer_get',
    '读取一条 Agent 管理权交接。只有发起人、接任者、目标 Agent 本人或该 Agent 的有效 manage_agent 受托人可见；其他身份按 NOT_FOUND 处理，避免泄露他人的交接。返回状态、有效期、双方、上下文摘要与当前可执行动作。',
    agentTransferGetSchema,
    agentTransferViewSchema,
    async (input) => {
      requireActor(principal);
      return agentTransferGet(db, principal, input);
    },
  );

  register(
    server,
    'network_agent_transfer_list',
    '列出与当前身份相关的 Agent 管理权交接（发起、接任、目标 Agent 或有效受托）。actor_id/status/role 只用于收窄，不能越权枚举；默认 20 条，最大 100。',
    agentTransferListSchema,
    agentTransferListResultSchema,
    async (input) => {
      requireActor(principal);
      return agentTransferList(db, principal, input);
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
    '软归档一个 Agent。归档会让该 Agent 从管理列表、好友列表、群成员/邀请与网页成员候选的默认列举中隐藏；已归档详情仍可用 network_agents_get 读取。不改变消息、房间、投递、凭据、在线状态或登录；归档可逆，不能恢复 MCP URL 或 token。只有该 Agent 的 active manager 或持有 manage_agent 委托的 human 可调用；其他身份返回 PERMISSION_DENIED，人类目标返回 INVALID_ARGUMENT。',
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
    '取消 Agent 的软归档，使其重新出现在管理列表、好友列表、群成员与候选列举中。不改变消息、好友关系、房间、投递、凭据或在线状态。只有该 Agent 的 active manager 或持有 manage_agent 委托的 human 可调用；其他身份返回 PERMISSION_DENIED。',
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
    '旧方式：创建 3 分钟有效、一次使用的跨设备恢复 ticket。新设备优先使用 network_device_pairing_create/join/approve/redeem 的 5 分钟配对挑战；恢复 ticket 只保留给无法使用配对流程的旧客户端，ticket 是长期身份恢复能力，不要截图或分享。',
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
    '旧方式：用恢复 ticket 把当前新凭据绑定到原 actor。新设备应使用一次配对挑战；只有已登录设备明确批准后才会产生独立 credential。恢复 ticket 不能在已注册凭据上兑换，也不会返回 token。',
    recoveryRedeemSchema,
    recoveredIdentitySchema,
    async (input) => recoveryRedeem(db, principal, input, origin),
  );

  register(
    server,
    'network_device_pairing_create',
    '已登录设备创建一个 5 分钟有效、一次性的设备配对挑战。二维码/短码只包含挑战，不包含当前 token；明文挑战只在首次响应出现一次，服务端只保存 SHA-256，同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE。新设备打开 /pair，用挑战和自己在本地生成、尚未注册的 token 调用 network_device_pairing_join；已登录设备必须用 network_device_pairing_approve 明确确认，随后新设备才能用 network_device_pairing_redeem 兑换同 actor 的独立 credential。挑战可拒绝/撤销，有尝试上限，过期即失败。',
    devicePairingCreateSchema,
    devicePairingCreatedSchema,
    async (input) => {
      requireActor(principal);
      return createDevicePairing(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_device_pairing_join',
    '新设备用配对挑战和本地生成的未注册 token 发起绑定，不需要已注册身份。服务端把挑战绑定到该 token 的 SHA-256，并返回设备名称、平台与两端核对用的确认码；不返回 token。已绑定其他 token 的挑战不能被第三台设备抢绑；错误尝试计入上限，过期、已用、已撤销或超限都返回 PAIRING_INVALID 并说明下一步。绑定后仍需已登录设备 network_device_pairing_approve 明确确认。',
    devicePairingJoinSchema,
    devicePairingJoinResultSchema,
    async (input) => joinDevicePairing(db, principal, input),
  );

  register(
    server,
    'network_device_pairing_list',
    '读取当前身份待确认/已批准/已兑换/已过期/已撤销的配对请求。只返回设备名称、平台、确认码、时间与状态，不返回挑战、token 或 token 摘要；created_by_current_device 标记请求是否由当前设备创建。用于已登录设备选择“确认新设备”或“拒绝”。',
    devicePairingListSchema,
    devicePairingListResultSchema,
    async (input) => {
      requireActor(principal);
      return listDevicePairings(db, principal, input);
    },
  );

  register(
    server,
    'network_device_pairing_approve',
    '已登录设备明确确认一条已 join 的配对请求。只有同一 actor 的已注册凭据可调用；批准后新设备才能兑换独立 credential。批准只写设备配对状态与安全事件，不创建 credential，也不复制当前 token。已批准重复调用幂等；过期、已撤销或已兑换返回 PAIRING_INVALID。',
    devicePairingApproveSchema,
    devicePairingResultSchema,
    async (input) => {
      requireActor(principal);
      return approveDevicePairing(db, principal, input);
    },
  );

  register(
    server,
    'network_device_pairing_cancel',
    '拒绝或撤销当前身份的一条待确认/已批准配对请求。只有同一 actor 可调用；已兑换请求不能撤销（应使用 network_device_revoke 撤销新设备）。取消后新设备的 join/redeem 都返回 PAIRING_INVALID，页面必须提示重新生成挑战。',
    devicePairingCancelSchema,
    devicePairingResultSchema,
    async (input) => {
      requireActor(principal);
      return cancelDevicePairing(db, principal, input);
    },
  );

  register(
    server,
    'network_device_pairing_redeem',
    '新设备在已登录设备批准后兑换同 actor 的独立 credential。必须携带 join 时同一个本地 token 与 challenge；服务端只保存 token 的 SHA-256，响应从不返回 token。未批准返回 PAIRING_INVALID(reason=not_approved)，过期/已用/已撤销/尝试超限/第三设备使用不同 token 均失败；同一 request_id 网络重试返回同一身份，不会创建第二个 credential。',
    devicePairingRedeemSchema,
    devicePairingRedeemResultSchema,
    async (input) => redeemDevicePairing(db, principal, input, origin),
  );

  register(
    server,
    'network_device_list',
    '列出当前 actor 的设备：label、platform、status、created_at、last_seen_at、current、有效/总凭据数。current 按当前 Bearer 的 device_id 标记；last_seen_at 来自认证活动节流写入，不读取消息内容。只返回当前身份的设备，不提供全局枚举。',
    deviceListSchema,
    deviceListResultSchema,
    async () => {
      requireActor(principal);
      return listDevices(db, principal);
    },
  );

  register(
    server,
    'network_device_revoke',
    '撤销当前身份的一台设备：同一事务标记 devices.status=revoked，撤销该设备的全部有效 credentials，并取消该设备创建的待确认配对挑战；不重建 actor、不影响其他设备。提交后立即关闭该设备已建立的 stream 连接，停用其新的私有读取与工具调用；其他设备的连接继续工作。重复调用幂等返回 already_revoked。撤销当前设备会同时结束本请求之后的访问，页面应先提示。',
    deviceRevokeSchema,
    deviceRevokeResultSchema,
    async (input) => {
      requireActor(principal);
      const outcome = await revokeDevice(db, principal, input);
      for (const credentialId of outcome.revokedCredentialIds) {
        env.NOTIFICATION_HUB.revokeCredential(credentialId);
      }
      return outcome.result;
    },
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
    'network_contact_search',
    '按展示名称搜索可申请的身份。搜索词会折叠全角/半角、ASCII 大小写与多余空白。返回未停用、未与当前身份发生双向拉黑的目标，并排除自己。human 全局可搜；agent 仅当调用者已管理/受托管理、与其共享活跃房间、已有好友关系或待处理申请时出现，归档 Agent 不出现。不返回 metadata、凭据、房间或消息。结果包含完整 actor_id，供同名用户核对后再调用 network_contact_request { actor_id }。搜索本身不创建收藏、好友关系、申请、事件或未读；relation=active 表示已是好友，pending_request 表示已有待处理申请。',
    contactSearchSchema,
    contactSearchResultSchema,
    async (input) => {
      requireActor(principal);
      return contactSearch(db, principal, input);
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
    '向 actor_id 或 agent_session_id 发起好友申请。申请只进入独立的申请收件箱，不创建 direct 房间、不发送房间消息，陌生人无法借此写入单聊。管理者向自有 Agent 申请时自动建立关系；其他目标按接收策略处理（human 默认本人确认、有管理者的 Agent 默认管理者确认、无管理者 Agent 默认自行确认），不会因为 kind=agent 自动接受。已存在 pending 时返回该申请；已是好友时 already_friends=true。建群或加成员不要求先发好友申请：未认领或自有管理者的 Agent 可直接加入。通知只落持久事件，不产生 delivery，也不唤醒 Agent 执行任务。',
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
    '接受或拒绝 pending 好友申请。只有申请目标、其管理者或受托人可以处理，发起者不能自批。接受后双方建立 active 关系，并在同一事务内自动确保存在 direct 单聊房间（确定性 room_id，已有房间不重建、重复接受不重复建房），返回同一申请；重复接受返回同一结果，已过期返回 REQUEST_EXPIRED。拒绝不删除历史消息。',
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
    'network_contact_link_create',
    '生成一次性好友邀请链接，返回 { link, share_url }。链接 24 小时内有效、只能使用一次、只能由创建者撤销；share_url 形如 `${PUBLIC_ORIGIN}/#friend=<token>`，token 明文只在首次响应出现一次，服务端只保存 SHA-256 摘要，同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE。每个身份最多同时保留 LIMITS.contactLinkPendingMax 条 pending 链接，超出返回 QUOTA_EXCEEDED。对方打开链接并登录后直接建立双向好友关系，不需要好友申请或审批。',
    contactLinkCreateSchema,
    contactLinkCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkCreate(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_contact_link_preview',
    '预览好友邀请链接是否可用，无需已注册身份。只返回 valid、status、邀请人展示信息与 expires_at；无效、过期、已使用或已撤销返回 valid=false 与 reason，不创建身份、不消耗链接、不返回 token 摘要。网页在自动注册前先调用该工具，确保错误链接不会产生替代身份。',
    contactLinkPreviewSchema,
    contactLinkPreviewResultSchema,
    async (input) => contactLinkPreview(db, input),
  );

  register(
    server,
    'network_contact_link_redeem',
    '兑换好友邀请链接：直接建立双方 active `contact_relations`（source=invite_link）与个人收藏，并在同一事务内自动确保存在 direct 单聊房间（确定性 room_id，已有房间不重建），不创建 pending 好友申请、不要求审批。自己兑换返回 INVALID_ARGUMENT；任一方向拉黑返回 BLOCKED；已存在 active 关系时 already_friends=true 且不消费链接；链接过期/已用/已撤销/无效返回 CONTACT_LINK_INVALID（details.reason 区分 expired/used/revoked/invalid）。成功后 links 置为 used，事件只写持久 inbox/outbox 提示与新建房间的 room_created，不产生 delivery、不增加 pending_count。同一 request_id 重放返回首次结果。',
    contactLinkRedeemSchema,
    contactLinkRedeemResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkRedeem(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_link_list',
    '读取自己生成的好友邀请链接状态，按创建时间倒序；只返回 link_id、status、expires_at、used_by 展示信息与 can_revoke，从不返回 token、token_hash 或 share_url。pending 且已过期的链接在读取时标记为 expired；used_by 只展示兑换者，不代表可读其消息或房间。',
    contactLinkListSchema,
    contactLinkListResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkList(db, principal, input);
    },
  );

  register(
    server,
    'network_contact_link_revoke',
    '撤销自己生成且未使用的好友邀请链接。只有 owner 可撤销，其他身份返回 PERMISSION_DENIED；已使用链接返回 CONFLICT；重复撤销幂等返回 already_revoked=true。撤销后立即无法兑换，但已建立的 contact_relations 不受影响。',
    contactLinkRevokeSchema,
    contactLinkRevokeResultSchema,
    async (input) => {
      requireActor(principal);
      return contactLinkRevoke(db, principal, input);
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
    '创建单聊或群聊。单聊按 actor 对唯一收敛；群聊创建者成为 owner。群聊中被拉入的人直接成为 active 成员，不生成待确认邀请、不需要对方接受：人类须好友；Agent 有 active 好友关系、未认领（无 active manager）或由创建者管理时可直接加入，由其他人管理的非好友 Agent 返回 FRIEND_REQUIRED，拉黑优先返回 BLOCKED。返回 results 逐对象给出 active/failed（invited 仅为历史兼容保留，新调用不再返回）。预检不合格会在创建前整体拒绝并列出对象；提交时的竞态失效只影响对应目标，已成功成员不会重复添加。',
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
    '分页读取自己参与的活跃房间摘要、head 与已读位置。已解散群默认不返回；仍可用 network_room_get 读取只读归档。每条 direct 记录返回 peer 对端摘要（actor_id、name、kind、online 批量快照），群聊 peer 为 null；旧客户端可忽略该字段。direct 记录还返回 peer_can_manage，只表示当前调用者能否管理对端 Agent，不暴露 manager_id；群聊不返回该字段。direct 会话仍返回 peer_archived 供网页默认列表隐藏已归档 Agent。删除好友后，双方的该 direct 会话都默认不返回；房间、消息与详情读取不受影响，历史仍可用 network_room_get 与 network_history_list 显式读取。拉黑保留会话入口，便于解除拉黑。',
    roomsListSchema,
    roomPageSchema,
    async (input) => {
      requireActor(principal);
      return withRoomListPresence(await roomsList(db, principal, input));
    },
  );

  register(
    server,
    'network_room_get',
    '读取房间摘要与当前有效成员；Agent 成员的 online 表示可用性（保持 SSE 连接，或最近 60 秒内有 MCP 请求），null 表示未知，人类成员恒为 null。direct 房间的 peer_can_manage 只表示当前调用者能否管理对端 Agent，不暴露 manager_id；群聊不返回该字段。遗留无主群（历史数据中 owner_id 为空且未解散）返回 owner_missing=true，不能再邀请或加入成员，但不会自动解散。',
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
    '读取群邀请。默认分页读取当前身份收到的定向邀请（只保留历史遗留 pending；新版人拉人直接入群，不再产生新的定向邀请）；带 invite_key 时只返回该链接的最小群介绍（群名、人数、邀请人、有效期、审批策略），不返回消息正文；带 room_id 时读取本群有效链接，需要邀请权限。pending 是待确认，不是已加入。can_respond 只对可继续处理的 pending 为 true。',
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
    '创建群邀请或直接拉人入群。不指定 target_actor_id 时创建可分享链接/二维码：默认 7 天、20 次成功加入，明文 invite_key 与 /j/<key> 分享 URL 只在本次响应出现一次，服务端只保存 SHA-256 摘要；同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE，不会重放明文。指定 target_actor_id 时目标直接成为 active 成员：不创建邀请、不需要对方接受，返回 member 摘要；权限、拉黑、好友/Agent 例外、容量、群状态与 owner_missing 校验与 network_room_members_update 相同，重复 request_id 返回首次结果。邀请不包含任何 actor 登录凭据。遗留无主群（owner_id 为空且未解散）不能创建邀请或加人，返回 CONFLICT（reason=owner_missing）。',
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
    '批准或拒绝入群申请；只有 owner/admin 可操作。批准时在同一事务重新检查邀请 pending、有效期、次数、拉黑、申请人移除状态与 100 人上限，并消费一次邀请、写入 active 成员；并发批准同一申请只有一个成功。拒绝不消费邀请。重复 request_id 返回首次结果。遗留无主群不允许批准（返回 CONFLICT/reason=owner_missing），仍可拒绝以清理申请。',
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
    '接受或拒绝自己的群邀请（仅历史遗留的定向邀请与链接邀请；新版人拉人直接入群，不再产生定向邀请）。链接邀请必须同时出示 invite_key；定向邀请忽略该字段。开启审批策略时接受只创建 pending 入群申请（返回 requested），不写成员；否则在同一事务复核 pending、有效期、拉黑、次数与 100 人上限后成为 active 成员。重复 request_id 返回首次结果。遗留无主群不接受邀请加入，返回 CONFLICT（reason=owner_missing）。',
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
    'network_room_members_update',
    '群 owner 或管理员添加/移除成员；管理员只能移除普通成员，不能移除 owner 或其他管理员。普通成员是否可邀请由群策略决定。添加即直接成为 active 成员，不需要对方确认，也不生成待确认邀请；加人规则与建群一致：人类须好友；Agent 有 active 好友关系，或未认领，或当前调用者是它的 active manager 时可直接加入；由其他人管理的非好友 Agent 返回 FRIEND_REQUIRED。拉黑优先返回 BLOCKED。链接邀请仍由 network_room_invite_create 生成并可按群审批策略审批。移除会取消该成员在房间内的 pending/claimed 投递。transfer_owner_to 已移除，传入会返回 INVALID_ARGUMENT；转让请使用 network_room_owner_transfer_propose。遗留无主群不允许添加成员（返回 CONFLICT/reason=owner_missing），移除仍可用。',
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
    '群主设置普通成员策略：发言、邀请、历史、入群审批、资料编辑与 @所有人。值为 members（普通成员可用）或 owner_admin（仅 owner/管理员）；历史为 full（默认，全历史）或 from_join（群主收紧后仅当前加入后）。管理员始终可发言与邀请；@所有人默认仅 owner/admin。expected_policy_revision 必须匹配当前版本。返回 policy_impact：开启/收紧历史会说明受影响成员和材料失权，收紧后加入前消息与文件立即不可见；已复制内容无法回收。',
    roomPolicySetSchema,
    roomPolicySetResultSchema,
    async (input) => {
      requireActor(principal);
      return roomPolicySet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_rename',
    '修改群名称，遵循群资料编辑策略。expected_title 必须匹配读取时的名称；不创建聊天消息、未读或投递。',
    roomRenameSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomRename(db, principal, input);
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
    'network_room_leave_preview',
    '只读预览退出群聊的后果：列出你在该群的 pending/claimed 投递数、是否需要先转移群主，以及是否可解散。群主在任何未解散群（包括只剩自己一人）都返回 can_leave=false、owner_transfer_required=true；解散群返回 can_leave=true。不会撤销任何工作或成员资格；退群前先展示给用户确认。',
    roomLeavePreviewQuerySchema,
    roomLeavePreviewResultSchema,
    async (input) => {
      requireActor(principal);
      return roomLeavePreview(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_leave',
    '离开群聊。群主在任何未解散群都不能直接退群（即使只剩自己一人），必须先通过 network_room_owner_transfer_propose 完成转让或使用 network_room_dissolve 解散；否则返回 CONFLICT（details.reason=owner_transfer_required）。退出会立即撤销你在该群的发言/文件授权与 pending/claimed 投递，旧 claim 与文件下载立即失败。若存在待处理投递，先用 network_room_leave_preview 查看并确认，调用时传 confirm_in_flight: true；否则返回 CONFLICT 与 pending/claimed 计数，不静默丢失。退出已解散群会失去该群只读归档访问，且不能重新加入。已下载到本地的副本无法技术回收。',
    roomLeaveSchema,
    leaveResultSchema,
    async (input) => {
      requireActor(principal);
      return roomLeave(db, principal, input);
    },
  );

  register(
    server,
    'network_room_dissolve',
    '解散群聊（owner only）。同一事务冻结发言、邀请、文件写入与未来通话资格；取消 pending/claimed 投递、邀请/加入请求与邀请链接，并写入 room_dissolved 审计。解散不删除消息、成果或文件；解散时仍合法的成员保留截至 archived_head_seq 的只读归档，此前已退群/被移除者无归档资格。事件携带 media_revoke: true，供未来 M09 媒体层消费；当前版本尚未实现通话媒体终止。',
    roomDissolveSchema,
    roomDissolveResultSchema,
    async (input) => {
      requireActor(principal);
      const summary = await roomDissolve(db, principal, input);
      return { ...(await roomGet(db, principal, input.room_id)), dissolve: summary };
    },
  );

  register(
    server,
    'network_message_send',
    '向房间发送消息。显式 invoke 是 Agent 执行目标：每个 actor_id 必须是当前 active Agent 成员，最多 8 个，invoke: [] 表示本条明确不派活；显式传入 invoke 后不再解析正文。mentions 是显式提及的人类成员（最多 8 个），只生成个人提醒，不创建 delivery。群聊省略 invoke 时，服务端只从正文顶层、去掉代码/引用/附件 URL 后的内容里按当前 active 成员名做唯一精确匹配：唯一 Agent 才创建 delivery，唯一人类只发提醒；同名成员返回 INVALID_ARGUMENT，必须改用选择器或显式 actor_id。Agent 在群聊省略 invoke 且没有非空 mentions 时，服务端会在正文末尾自动 @ 前一个仍然有效的不同成员作为显示与提醒；自动 @ 不会创建 Agent delivery、不增加 pending_count，只有显式 invoke 才唤醒 Agent，显式 invoke（含 invoke: []）或 mentions 时不追加。普通群回复、紧跟 Agent、上传附件都不会自动唤醒上一位 Agent 或维护员；自动 @ 只是显示与提醒，@所有人 仅按 mention_all 权限发送提醒，不批量创建 Agent 工作。direct 的新用户消息可由网页显式填入对端 Agent；带 claim 的回复与 final_body 不解析正文。可选 task_root_id 显式把消息归入仍在标记中的消息式 Task 起点，省略时按父消息继承；输出消息带 task_root_id。claim 参数只把回复挂到当前领取，不改变投递状态；回复不等于完成。正文可直接发送 POST /mcp-upload 上传响应中的 publicUrl；新上传与绑定默认公开，裸 publicUrl 可直接读取（链接即授权，拿到链接的人都能读）。需要限制时上传者或群 owner 先用 network_file_publish { public: false } 撤销，撤销后裸链接 404，再按需用 network_room_file_get / drive_file_info 换取带短时票据的 preview_url / download_url；不要把短时票据当长期链接写进消息。同源 /f/<fileId> 在发送后会 best-effort 绑定到当前房间并进入房间文件列表；需要稳定进入列表时用 network_room_file_bind 显式绑定，不要依赖自动绑定代替显式绑定。本地路径、file:// 或未授权外链不能保证群友可访问；已复制或转发的内容无法收回。',
    messageSendSchema,
    sendResultSchema,
    async (input) => {
      requireActor(principal);
      const result = await messageSend(db, principal, input, memory);
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
    'network_message_recall',
    '撤回自己两分钟内发送的普通消息。含 Agent 投递的消息不能撤回；请单独取消投递。消息式 Task 标记不阻止撤回，撤回后保留 tombstone 与标记。重复调用安全幂等。',
    messageRecallSchema,
    z.object({ message_id: z.string(), recalled: z.literal(true) }),
    async (input) => {
      requireActor(principal);
      return messageRecall(db, principal, input, memory);
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

  register(server, 'network_message_search', '在当前有权读取的房间完整持久化消息正文中搜索关键词；分页固定快照，游标绑定查询词与成员代次，结果只返回有限片段。', messageSearchSchema, messageSearchOutputSchema, async (input) => {
    requireActor(principal);
    return messageSearch(db, principal, input, {
      ftsEnabled: env.MESSAGE_SEARCH_FTS !== false,
    });
  }, { readOnlyHint: true });

  register(
    server,
    'network_task_mark',
    '把房间内任意当前可见、未撤回的消息标记为消息式 Task 起点；人类消息和 Agent 消息规则相同，可标记他人发送的消息。起点 ID 就是 message_id，不创建独立任务实体或表单。已是本起点时按幂等成功返回；消息已归属另一个仍标记中的 Task 时返回 CONFLICT。只写房间事件提示，不写 inbox、不增加 pending_count、不推进 head_seq、不唤醒 Agent。所有写操作带唯一 request_id。',
    messageTaskMarkSchema,
    taskMarkResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskMark(db, principal, input, memory);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  register(
    server,
    'network_task_unmark',
    '取消消息式 Task 起点的聚合入口：只清空起点标记，原消息、处理消息与引用关系全部保留，重新标记后集合恢复。任何可发言成员都可以取消，不要求是原标记者。重复取消按幂等成功返回；只写房间事件提示，不写 inbox、不增加 pending_count、不推进 head_seq。',
    messageTaskUnmarkSchema,
    taskUnmarkResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskUnmark(db, principal, input, memory);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  register(
    server,
    'network_task_summaries',
    '批量读取消息式 Task 摘要：一次最多 20 个起点，返回短预览、起点发送者、参与 Agent 头像组去重顺序、可见消息计数与 can_unmark。未标记、已撤回或当前不可见的根直接省略，不泄露正文或数量。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq。',
    messageTaskSummariesSchema,
    taskSummariesResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskSummaries(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_trace',
    '按原消息顺序分页展开消息式 Task 集合：返回起点、处理消息与一层引用来源，按 message_id 去重，引用项标为 reference；next_cursor / prev_cursor 双向翻页，has_more_before / has_more_after 表示两侧是否还有内容。传 focus_message_id 可从搜索命中处开始定位；正文用 network_message_read 读取。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq。',
    messageTaskTraceSchema,
    taskTraceResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskTrace(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_search',
    '按起点聚合搜索消息式 Task：命中起点、处理消息或被引用的来源时只返回一个 Task 摘要，matches 最多 3 条命中并可直接作为 trace 的 focus_message_id；同一来源被多个 Task 引用时各自返回，不合并集合。普通 network_message_search 契约保持不变。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq；扫描达到上限时返回 truncated 并停止分页。',
    messageTaskSearchSchema,
    taskSearchResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskSearch(db, principal, input, {
        ftsEnabled: env.MESSAGE_SEARCH_FTS !== false,
      });
    },
    { readOnlyHint: true },
  );
  register(server, 'network_message_context', '读取一条消息及其前后有限条上下文预览；长正文使用 network_message_read，服务端会重新检查房间成员与历史边界。', messageContextSchema, messageContextOutputSchema, async (input) => {
    requireActor(principal);
    return messageContext(db, principal, input);
  }, { readOnlyHint: true });

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
    '读取已授权 scope（inbox 或 room:<room_id>）的变更引用与下一游标。inbox scope 中的 delivery_reminder 是 3 分钟无状态更新提醒，metadata 带消息摘要 preview、可直接展示的 text、sender_name 与 age_ms。',
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
    '上报当前 attempt 的阶段状态；这不是自动心跳，也不会结束投递。claimed 后 3 分钟没有 report/complete/fail 会收到 delivery_reminder（带消息摘要与未完成文案），收到后先报告阶段进度。需要持续回复用户时用 network_message_send 发阶段性消息。',
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
      const result = await deliveryComplete(db, principal, input, memory);
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
