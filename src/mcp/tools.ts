import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { isBusinessError } from '../contracts/errors';
import {
  agentArchiveSchema,
  agentReissueTokenSchema,
  agentRenameSchema,
  agentUnarchiveSchema,
  agentsGetSchema,
  contactAddSchema,
  contactRemoveSchema,
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
  roomCreateSchema,
  roomGetSchema,
  roomLeaveSchema,
  roomMarkReadSchema,
  roomMembersUpdateSchema,
  roomMonitorGetSchema,
  roomMonitorSetSchema,
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
import { contactAdd, contactRemove, contactsList } from '../domain/contacts';
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
  roomCreate,
  roomGet,
  roomLeave,
  roomMembersUpdate,
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
  agentReissueTokenResultSchema,
  agentRenameResultSchema,
  agentUnarchiveResultSchema,
  agentsGetResultSchema,
  completeResultSchema,
  contactPageSchema,
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
    'Agent 显式上线，开始接收 inbox 投递通知；未上线时投递只在 D1 排队。重复调用幂等，返回待办数量。',
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
    'network_agent_rename',
    '全局重命名一个 Agent actor；任何已注册身份都可调用，人类 actor 不能被此工具改名。',
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
    '注销目标 Agent 的全部现有凭据并签发新 token。任何已注册身份都可调用，权限与 network_agent_rename 一致；人类 actor 返回 INVALID_ARGUMENT，未知 actor 返回 NOT_FOUND。旧 token 立即失效，已有 MCP 连接需改用新 token，SSE/事件订阅因凭据撤销停止。新 token 与 mcp_url 只返回一次（仅首次响应），服务端不保存原文；同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE，必须使用新的 request_id。',
    agentReissueTokenSchema,
    agentReissueTokenResultSchema,
    async (input) => {
      requireActor(principal);
      return reissueAgentToken(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_agent_archive',
    '软归档一个 Agent。归档只影响 Agent 管理列表，不改变消息、好友、房间、投递、凭据或在线状态；归档可逆，不能恢复 MCP URL 或 token。任何已注册身份都可调用；目标必须是 Agent，人类 actor 返回 INVALID_ARGUMENT。',
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
    '取消 Agent 的软归档。只影响 Agent 管理列表的过滤，不改变消息、好友、房间、投递、凭据或在线状态。任何已注册身份都可调用；目标必须是 Agent。',
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
    '按 actor_id 批量读取 Agent 管理摘要（1–100 个，去重并保持输入顺序）；不提供全局枚举。返回名称、agent_session_id、share_url 与归档状态；不返回 metadata 或任何凭据。',
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
    '按创建时间倒序分页读取自己的好友。',
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
    '按 actor_id 或 agent_session_id 幂等添加好友。',
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
    '删除自己的好友关系；不删除历史消息或群成员身份。',
    contactRemoveSchema,
    removedResultSchema,
    async (input) => {
      requireActor(principal);
      return contactRemove(db, principal, input);
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
    '读取房间任务列表（默认列表）：active 成员可用，返回短描述、状态、assignee 与结果，以及 total/done。任务变更是 informational，不产生未读、inbox 或交付；Agent 应在定时或唤醒后主动 list，不要轮询。',
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
    '一次读取当前身份所有 active 房间的任务进度（可传 room_ids 过滤，仅返回本人仍有效的房间），供侧栏 badge 使用；避免对每个房间调用 list。只读，不轮询。',
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
    '向房间添加一个 pending 任务；任何 active 成员（含 human）都可添加。description trim 后必须为 1–120 个字符且不含换行/控制字符；长内容请写成 .md 文件。任务变更只写 room informational 事件，不写 inbox、不推进 head、不产生未读。',
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
    'Agent 成员领取一个 pending 任务，原子转为 claimed 并记录 assignee。human 调用返回 INVALID_ARGUMENT；并发或被他人领取返回 CLAIM_CONFLICT。任务通知不唤醒 Agent，需在定时或唤醒后 list。',
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
    '群 owner 添加/移除成员或转移 owner。移除会取消该成员在房间内未完成的工作。',
    roomMembersUpdateSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomMembersUpdate(db, principal, input);
    },
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
    '读取已授权 scope（inbox 或 room:<room_id>）的变更引用与下一游标。',
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
    '上报当前 attempt 的阶段状态；这不是自动心跳，也不会结束投递。需要持续回复用户时用 network_message_send 发阶段性消息。',
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
