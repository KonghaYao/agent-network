import { memoryIntakeFromEnv } from '../memory/intake';
import { fileTicketSecret } from '../domain/file-ticket';
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
  deviceListSchema,
  devicePairingApproveSchema,
  devicePairingCancelSchema,
  devicePairingCreateSchema,
  devicePairingJoinSchema,
  devicePairingListSchema,
  devicePairingRedeemSchema,
  deviceRevokeSchema,
  feedbackCreateSchema,
  issueTokenSchema,
  loginSchema,
  meSchema,
  meRenameSchema,
  profileUpdateSchema,
  recoveryCreateSchema,
  recoveryRedeemSchema,
  registerSchema,
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
import { createFeedback } from '../domain/feedback';
import {
  approveDevicePairing,
  cancelDevicePairing,
  createDevicePairing,
  joinDevicePairing,
  listDevicePairings,
  redeemDevicePairing,
} from '../domain/device-pairings';
import { listDevices, revokeDevice } from '../domain/devices';
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
import type { Env } from '../env';
import { login } from '../realtime/presence';
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
  agentTransferListResultSchema,
  agentTransferRespondResultSchema,
  agentTransferSimpleResultSchema,
  agentTransferViewSchema,
  agentReissueTokenResultSchema,
  agentRenameResultSchema,
  agentUnarchiveResultSchema,
  agentsGetResultSchema,
  agentsManagedListResultSchema,
  deviceListResultSchema,
  devicePairingCreatedSchema,
  devicePairingJoinResultSchema,
  devicePairingListResultSchema,
  devicePairingRedeemResultSchema,
  devicePairingResultSchema,
  deviceRevokeResultSchema,
  feedbackCreateResultSchema,
  identitySchema,
  issuedTokenSchema,
  loginResultSchema,
  meRenameResultSchema,
  recoveredIdentitySchema,
  recoveryTicketSchema,
} from './outputs';
import type { Principal } from '../domain/principal';
import {
  clientGuide,
  clientGuideInputSchema,
  clientGuideOutputSchema,
  clientServiceInfo,
  registeredToolNames,
  serviceInfoSchema,
} from './client-contract';
import { memoryCapabilityCatalog } from '../memory/capability-catalog';
import { DEFAULT_MEMORY_HOST_POLICY } from '../memory/host-bridge';
import type { RegistrationServer } from './registration';
import { register } from './tool-registration';
import { registerContactTools } from './contact-tools';
import { registerFocusTools } from './focus-tools';
import { registerRoomTools } from './room-tools';
import { registerMessageTools, type ToolHooks } from './message-tools';

export { register, type RegisterOptions } from './tool-registration';
export type { MessageCommittedHookInput, ToolHooks } from './message-tools';

/** 生成并返回长期 URL 凭据；不写数据库，服务端只在注册时保存摘要。 */
function issueToken(origin: string): { token: string; url: string } {
  const token = crypto.randomUUID();
  const base = origin.replace(/\/+$/u, '');
  return { token, url: `${base}/mcp?token=${encodeURIComponent(token)}` };
}

export function registerTools(
  server: RegistrationServer,
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
    '更新自己的展示名称与小体积 metadata；可选 avatar_file_id 设置或清除头像。avatar_file_id 必须是自己通过 POST /mcp-upload 上传、仍为公开且未过期的 PNG/JPEG/WebP/GIF 草稿，传 null 清除；其他文件、SVG/HTML 或已过期文件返回 INVALID_ARGUMENT。已解绑的公开草稿会被长期保留，替换/清除后旧文件解除保留并按普通 TTL 回收。返回更新后的身份与同源 avatar_url（无头像为 null）。',
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

  registerContactTools(server, db, principal, origin);
  registerRoomTools(server, env, principal);
  registerMessageTools(server, env, principal, memory, hooks);
  registerFocusTools(server, { db: env.DB, principal, env }, register);
}
