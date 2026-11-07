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
});

export const roomLeaveSchema = z.object({ request_id: requestId, room_id: id() });

export const messageSendSchema = z.object({
  request_id: requestId,
  client_message_id: id(128),
  room_id: id(),
  body: z.string().min(1).max(LIMITS.messageBodyBytes),
  invoke: z.array(id()).max(LIMITS.invokeMax).optional(),
  reply_to: id().optional(),
  claim: z
    .object({ delivery_id: id(), attempt: z.number().int().nonnegative(), claim_id: id() })
    .optional(),
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

/** 当前 human 在此会话私有的网页监控地址；null 表示清除。 */
export const roomMonitorGetSchema = z.object({ room_id: id() });

export const roomMonitorSetSchema = z.object({
  request_id: requestId,
  room_id: id(),
  url: z.string().trim().max(LIMITS.roomMonitorUrlMax).nullable(),
});

/**
 * 房间任务：描述与结果都只接受短文本。
 *
 * Zod 的 max 按 UTF-16 码元计，最多放宽到 2 倍字符上限；最终按 Unicode
 * 码点与换行/控制字符在领域层校验，错误返回可读的 INVALID_ARGUMENT。
 */
const taskText = z.string().trim().min(1).max(LIMITS.roomTaskTextMax * 2);

export const taskListGetSchema = z.object({ room_id: id() });

export const taskSummarySchema = z.object({
  room_ids: z.array(id()).min(1).max(LIMITS.taskLookupMax).optional(),
});

export const taskAddSchema = z.object({
  request_id: requestId,
  room_id: id(),
  description: taskText,
});

export const taskClaimSchema = z.object({ request_id: requestId, task_id: id() });

export const taskCompleteSchema = z.object({
  request_id: requestId,
  task_id: id(),
  result: taskText,
});

export const taskFailSchema = z.object({
  request_id: requestId,
  task_id: id(),
  error: taskText,
});

export const taskUpdateSchema = z.object({
  request_id: requestId,
  task_id: id(),
  description: taskText,
});

export const taskDeleteSchema = z.object({ request_id: requestId, task_id: id() });

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
export type RoomCreateInput = z.infer<typeof roomCreateSchema>;
export type RoomsListInput = z.infer<typeof roomsListSchema>;
export type RoomMembersUpdateInput = z.infer<typeof roomMembersUpdateSchema>;
export type RoomLeaveInput = z.infer<typeof roomLeaveSchema>;
export type MessageSendInput = z.infer<typeof messageSendSchema>;
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
export type RoomMonitorGetInput = z.infer<typeof roomMonitorGetSchema>;
export type RoomMonitorSetInput = z.infer<typeof roomMonitorSetSchema>;
export type TaskListGetInput = z.infer<typeof taskListGetSchema>;
export type TaskSummaryInput = z.infer<typeof taskSummarySchema>;
export type TaskAddInput = z.infer<typeof taskAddSchema>;
export type TaskClaimInput = z.infer<typeof taskClaimSchema>;
export type TaskCompleteInput = z.infer<typeof taskCompleteSchema>;
export type TaskFailInput = z.infer<typeof taskFailSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type TaskDeleteInput = z.infer<typeof taskDeleteSchema>;
export type FeedbackCreateInput = z.infer<typeof feedbackCreateSchema>;
