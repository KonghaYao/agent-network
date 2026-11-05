/**
 * 协议面验收：2026-07-28 单端点、无 initialize、无 session、订阅入口。
 *
 * 这些断言直接发 HTTP/JSON-RPC，确保服务端边界不依赖客户端 SDK 的兼容层。
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  rawRpc,
} from './lib/harness';
import { runStreamProtocolChecks } from './lib/stream-protocol';
import { runAgentPresenceUnitChecks } from './lib/presence-unit';
import { runFeedbackUnitChecks } from './lib/feedback-unit';
import { runFeedbackCliChecks } from './lib/feedback-cli';

const STREAM_URI = 'agentnet://stream';

interface SkillEntry {
  uri: string;
  frontmatter: { name: string; description: string };
  resources?: { uri: string; digest: string }[];
}

function toolErrorCode(body: Record<string, unknown>): string | undefined {
  const result = body.result as
    | { isError?: boolean; content?: { type?: string; text?: string }[] }
    | undefined;
  if (!result?.isError) return undefined;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  try {
    return (JSON.parse(text) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

interface RawToolCall<T> {
  status: number;
  body: Record<string, unknown>;
  data: T | undefined;
  code: string | undefined;
}

/** 直接走 JSON-RPC 的工具调用，保留 schema 错误与业务错误码。 */
async function rawToolCall<T>(
  token: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<RawToolCall<T>> {
  const response = await rawRpc(
    'tools/call',
    { name, arguments: args },
    token ? { token } : {},
  );
  const result = response.body.result as
    | { isError?: boolean; structuredContent?: T }
    | undefined;
  return {
    status: response.status,
    body: response.body,
    data: result?.structuredContent,
    code: toolErrorCode(response.body),
  };
}

/** SDK 的输入校验失败可能是 JSON-RPC -32602 或 isError 的 Input validation error。 */
function isInputValidationFailure(body: Record<string, unknown>): boolean {
  const error = body.error as { code?: number; message?: string } | undefined;
  if (error?.code === -32602) return true;
  const result = body.result as
    | { isError?: boolean; content?: { type?: string; text?: string }[] }
    | undefined;
  if (result?.isError !== true) return false;
  return (result.content ?? []).some(
    (item) => item.type === 'text' && (item.text ?? '').includes('Input validation error'),
  );
}

function toolStructured<T>(body: Record<string, unknown>): T | undefined {
  return (body.result as { structuredContent?: T } | undefined)?.structuredContent;
}

async function main(): Promise<void> {
  console.log(`协议验收: ${baseUrl()}`);

  const health = await fetch(`${baseUrl()}/health`);
  checkEqual('GET /health 返回 200', health.status, 200);

  const discover = await rawRpc('server/discover');
  checkEqual('server/discover HTTP 200', discover.status, 200);
  const discoverResult = discover.body.result as Record<string, unknown> | undefined;
  check('server/discover 返回 result', discoverResult !== undefined, discover.body);
  const versions = discoverResult?.supportedVersions as string[] | undefined;
  check('supportedVersions 仅包含 2026-07-28', Array.isArray(versions) && versions.length === 1 && versions[0] === '2026-07-28', versions);
  checkEqual('discover resultType 为 complete', discoverResult?.resultType, 'complete');
  checkEqual('discover ttlMs 为 0', discoverResult?.ttlMs, 0);
  checkEqual('discover cacheScope 为 private', discoverResult?.cacheScope, 'private');
  const discoverCapabilities = discoverResult?.capabilities as
    | { extensions?: Record<string, unknown>; events?: unknown }
    | undefined;
  check(
    'server/discover 声明 Skills 扩展',
    discoverCapabilities?.extensions?.['io.modelcontextprotocol/skills'] !== undefined,
    discoverCapabilities?.extensions,
  );

  if (discoverCapabilities?.events !== undefined) {
    check('server/discover 声明顶层 events', discoverCapabilities.events !== null, discoverCapabilities);
    checkEqual(
      'events 是顶层能力而不是扩展',
      (discoverCapabilities.extensions as Record<string, unknown> | undefined)?.events,
      undefined,
    );

    const eventsList = await rawRpc('events/list');
    const eventsResult = eventsList.body.result as
      | { events?: Record<string, unknown>[]; resultType?: string; _meta?: unknown }
      | undefined;
    check('events/list 返回事件目录', Array.isArray(eventsResult?.events), eventsResult);
    checkEqual('events/list 只有一个事件', eventsResult?.events?.length, 1);
    const eventDefinition = eventsResult?.events?.[0] ?? {};
    checkEqual('事件名为 agentnet.message.created', eventDefinition.name, 'agentnet.message.created');
    checkEqual(
      '事件 delivery 只有 webhook',
      JSON.stringify(eventDefinition.delivery),
      '["webhook"]',
    );
    checkEqual(
      'events/list inputSchema additionalProperties:false',
      (eventDefinition.inputSchema as Record<string, unknown>)?.additionalProperties,
      false,
    );
    checkEqual(
      'events/list payloadSchema additionalProperties:false',
      (eventDefinition.payloadSchema as Record<string, unknown>)?.additionalProperties,
      false,
    );
    const inputProperties = (
      (eventDefinition.inputSchema as Record<string, unknown>)?.properties as
        | Record<string, { description?: unknown }>
        | undefined
    ) ?? {};
    check(
      'events/list room_id 有语义描述',
      typeof inputProperties.room_id?.description === 'string' &&
        inputProperties.room_id.description.length > 0,
      inputProperties.room_id,
    );
    check(
      'events/list attention 有语义描述',
      typeof inputProperties.attention?.description === 'string' &&
        inputProperties.attention.description.length > 0,
      inputProperties.attention,
    );
    checkEqual('events/list 保留 resultType', eventsResult?.resultType, 'complete');
    console.log(
      `  · events/list wire shape: result keys = ${Object.keys(eventsResult ?? {}).join(',')}`,
    );

    const unauthSubscribe = await rawRpc('events/subscribe', {
      name: 'agentnet.message.created',
      arguments: {},
      delivery: {
        mode: 'webhook',
        url: 'https://127.0.0.1:9/callback',
        secret: `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`,
      },
    });
    const unauthError = unauthSubscribe.body.error as { code?: number } | undefined;
    checkEqual('未注册身份 events/subscribe 返回 -32024', unauthError?.code, -32024);

    const eventsAgentToken = newToken();
    const eventsAgent = await connectClient(eventsAgentToken);
    try {
      await callTool(eventsAgent.client, 'network_register', {
        request_id: newRequestId('reg-events'),
        kind: 'agent',
        agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
        name: 'Events 协议验收',
      });
      const invalidUrl = await rawRpc(
        'events/subscribe',
        {
          name: 'agentnet.message.created',
          arguments: {},
          delivery: {
            mode: 'webhook',
            url: 'http://127.0.0.1:9/callback',
            secret: `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`,
          },
        },
        { token: eventsAgentToken },
      );
      const invalidUrlError = invalidUrl.body.error as { code?: number } | undefined;
      checkEqual('非 HTTPS callback 返回 -32602', invalidUrlError?.code, -32602);

      const nonMember = await rawRpc(
        'events/subscribe',
        {
          name: 'agentnet.message.created',
          arguments: { room_id: 'room_missing_events' },
          delivery: {
            mode: 'webhook',
            url: 'https://127.0.0.1:9/callback',
            secret: `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`,
          },
        },
        { token: eventsAgentToken },
      );
      const nonMemberError = nonMember.body.error as { code?: number } | undefined;
      checkEqual('非成员 room_id 返回 -32024', nonMemberError?.code, -32024);

      const invalidSecret = await rawRpc(
        'events/subscribe',
        {
          name: 'agentnet.message.created',
          arguments: {},
          delivery: { mode: 'webhook', url: 'https://127.0.0.1:9/callback', secret: 'not-a-secret' },
        },
        { token: eventsAgentToken },
      );
      const invalidSecretError = invalidSecret.body.error as { code?: number } | undefined;
      checkEqual('非法 secret 返回 -32602', invalidSecretError?.code, -32602);
    } finally {
      await eventsAgent.close();
    }
  } else {
    console.log('  · 目标未声明 events 能力（EVENTS_ENABLED != 1），跳过 events 协议断言');
  }

  const inconsistent = await rawRpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'legacy-check', version: '0.1.0' },
  }, { protocolVersion: null });
  checkEqual('请求头与 body 版本不一致返回 400', inconsistent.status, 400);
  const inconsistentError = inconsistent.body.error as Record<string, unknown> | undefined;
  checkEqual('版本不一致错误码为 -32020', inconsistentError?.code, -32020);

  const legacy = await rawRpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'legacy-check', version: '0.1.0' },
  }, { protocolVersion: null, versionHeader: '2025-06-18' });
  checkEqual('legacy initialize 返回 400', legacy.status, 400);
  const legacyError = legacy.body.error as Record<string, unknown> | undefined;
  checkEqual('legacy initialize 错误码为 -32022', legacyError?.code, -32022);

  const oldHeader = await rawRpc('tools/list', {}, { versionHeader: '2025-06-18' });
  checkEqual('旧 MCP-Protocol-Version 头返回 400', oldHeader.status, 400);
  const oldHeaderError = oldHeader.body.error as Record<string, unknown> | undefined;
  checkEqual('旧协议头错误码为 -32020', oldHeaderError?.code, -32020);

  const list = await rawRpc('tools/list');
  const listed = list.body.result as
    | {
        tools?: {
          name: string;
          description?: string;
          inputSchema?: unknown;
          outputSchema?: unknown;
        }[];
      }
    | undefined;
  const coreToolNames = [
    'network_issue_token',
    'network_register',
    'network_me',
    'network_me_rename',
    'network_login',
    'network_profile_update',
    'network_agent_rename',
    'network_agent_reissue_token',
    'network_agent_archive',
    'network_agent_unarchive',
    'network_agents_get',
    'network_feedback_create',
    'network_recovery_create',
    'network_recovery_redeem',
    'network_contacts_list',
    'network_contact_add',
    'network_contact_remove',
    'network_room_create',
    'network_rooms_list',
    'network_room_get',
    'network_room_monitor_get',
    'network_room_monitor_set',
    'network_task_list_get',
    'network_task_summary',
    'network_task_add',
    'network_task_claim',
    'network_task_complete',
    'network_task_fail',
    'network_task_update',
    'network_task_delete',
    'network_room_members_update',
    'network_room_leave',
    'network_message_send',
    'network_history_list',
    'network_message_read',
    'network_room_mark_read',
    'network_sync',
    'network_inbox_list',
    'network_delivery_claim',
    'network_delivery_report',
    'network_delivery_complete',
    'network_delivery_fail',
    'network_delivery_cancel',
    'network_delivery_retry',
  ];
  const roomFileTools = [
    'network_room_file_bind',
    'network_room_file_list',
    'network_room_file_get',
    'network_room_file_delete',
  ];
  const toolNames = listed?.tools?.map((tool) => tool.name) ?? [];
  // 工具集随 drive 开关变化：核心 36 + drive_file_info + 4 个房间文件工具。
  const hasDrive = toolNames.includes('drive_file_info');
  const hasRoomFiles = roomFileTools.every((name) => toolNames.includes(name));
  check(
    '房间文件工具与 drive 开关一起注册',
    hasRoomFiles === hasDrive,
    roomFileTools.filter((name) => toolNames.includes(name)),
  );
  const expectedToolCount =
    coreToolNames.length + (hasDrive ? 1 : 0) + (hasRoomFiles ? roomFileTools.length : 0);
  check(`tools/list 返回 ${expectedToolCount} 个工具`, toolNames.length === expectedToolCount, toolNames.length);
  const requiredCoreTools = [
    'network_issue_token',
    'network_register',
    'network_me',
    'network_me_rename',
    'network_login',
    'network_agent_rename',
    'network_agent_reissue_token',
    'network_agent_archive',
    'network_agent_unarchive',
    'network_agents_get',
    'network_feedback_create',
    'network_message_send',
    'network_room_monitor_get',
    'network_room_monitor_set',
    'network_task_list_get',
    'network_task_summary',
    'network_task_add',
    'network_task_claim',
    'network_task_complete',
    'network_task_fail',
    'network_task_update',
    'network_task_delete',
    'network_inbox_list',
    'network_delivery_claim',
    'network_delivery_complete',
    'network_delivery_report',
    'network_delivery_fail',
    'network_delivery_cancel',
    'network_delivery_retry',
    'network_sync',
  ];
  for (const required of requiredCoreTools) {
    check(`工具 ${required} 已注册`, toolNames.includes(required), toolNames);
  }
  if (hasDrive) {
    for (const required of ['drive_file_info', ...roomFileTools]) {
      check(`工具 ${required} 已注册`, toolNames.includes(required), toolNames);
    }
  } else {
    check(
      '关闭 Drive 时不注册 drive_file_info 与房间文件工具',
      !toolNames.includes('drive_file_info') &&
        roomFileTools.every((name) => !toolNames.includes(name)),
      toolNames,
    );
  }

  const meRenameTool = listed?.tools?.find((tool) => tool.name === 'network_me_rename');
  const meRenameProperties =
    ((meRenameTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties) ?? {};
  check(
    'network_me_rename 只接受自己的名字（无 actor_id 参数）',
    'name' in meRenameProperties &&
      'request_id' in meRenameProperties &&
      !('actor_id' in meRenameProperties),
    meRenameProperties,
  );
  check(
    'network_me_rename 描述声明只能改自己',
    typeof meRenameTool?.description === 'string' &&
      meRenameTool.description.includes('自己的展示名称') &&
      meRenameTool.description.includes('只能改自己'),
    meRenameTool?.description,
  );

  const claimTool = listed?.tools?.find((tool) => tool.name === 'network_delivery_claim');
  check(
    'claim 工具描述声明只是接手且回复不等于完成',
    typeof claimTool?.description === 'string' &&
      claimTool.description.includes('只是接手') &&
      claimTool.description.includes('回复不等于完成'),
    claimTool?.description,
  );
  const sendTool = listed?.tools?.find((tool) => tool.name === 'network_message_send');
  check(
    'message_send 描述声明 claim 不改变投递状态',
    typeof sendTool?.description === 'string' &&
      sendTool.description.includes('不改变投递状态'),
    sendTool?.description,
  );
  check(
    'message_send 描述声明群聊省略 invoke 时按 @名字 解析',
    typeof sendTool?.description === 'string' &&
      sendTool.description.includes('群聊') &&
      sendTool.description.includes('@名字') &&
      sendTool.description.includes('省略 invoke') &&
      sendTool.description.includes('显式 invoke 优先') &&
      sendTool.description.includes('invoke: []') &&
      sendTool.description.includes('claim'),
    sendTool?.description,
  );
  const roomGetTool = listed?.tools?.find((tool) => tool.name === 'network_room_get');
  check(
    'room_get 输出 schema 包含成员 online',
    JSON.stringify(roomGetTool?.outputSchema ?? {}).includes('"online"'),
    roomGetTool?.outputSchema,
  );
  const historyTool = listed?.tools?.find((tool) => tool.name === 'network_history_list');
  const historySchema = JSON.stringify(historyTool?.outputSchema ?? {});
  check(
    'history 输出 schema 包含 claimed 时间字段',
    historySchema.includes('"delivery_claimed_at"') && historySchema.includes('"delivery_updated_at"'),
    historyTool?.outputSchema,
  );
  check(
    'history 输出 schema 包含权威 sender_kind',
    historySchema.includes('"sender_kind"'),
    historyTool?.outputSchema,
  );

  const monitorGetTool = listed?.tools?.find(
    (tool) => tool.name === 'network_room_monitor_get',
  );
  const monitorSetTool = listed?.tools?.find(
    (tool) => tool.name === 'network_room_monitor_set',
  );
  const monitorGetDescription = monitorGetTool?.description ?? '';
  const monitorSetDescription = monitorSetTool?.description ?? '';
  check(
    'monitor_get 描述声明 human 私有、服务端不访问且不写 events',
    monitorGetDescription.includes('当前 human 身份') &&
      monitorGetDescription.includes('仅本人可见') &&
      monitorGetDescription.includes('服务端不访问') &&
      monitorGetDescription.includes('不写 events/outbox'),
    monitorGetTool?.description,
  );
  check(
    'monitor_set 描述声明 http/https、幂等与 human-only',
    monitorSetDescription.includes('只允许 http/https') &&
      monitorSetDescription.includes('IDEMPOTENCY_CONFLICT') &&
      monitorSetDescription.includes('仅人类网页身份可用') &&
      monitorSetDescription.includes('Agent 调用返回 INVALID_ARGUMENT'),
    monitorSetTool?.description,
  );
  check(
    'monitor_set 描述声明 XFO/CSP 与不改变未读/head/pending',
    monitorSetDescription.includes('X-Frame-Options') &&
      monitorSetDescription.includes('CSP') &&
      monitorSetDescription.includes('不改变未读、head 或 pending_count'),
    monitorSetTool?.description,
  );
  const monitorOutput = JSON.stringify(monitorGetTool?.outputSchema ?? {});
  check(
    'monitor 输出 schema 允许 monitor 为 null',
    monitorOutput.includes('"monitor"') &&
      (monitorOutput.includes('"type":"null"') || monitorOutput.includes('null')),
    monitorGetTool?.outputSchema,
  );
  check(
    'monitor_get 注册为只读工具',
    (monitorGetTool as { annotations?: { readOnlyHint?: boolean } } | undefined)?.annotations
      ?.readOnlyHint === true,
    (monitorGetTool as { annotations?: unknown } | undefined)?.annotations,
  );

  const taskTools = new Map(
    listed?.tools
      ?.filter((tool) => tool.name.startsWith('network_task_'))
      .map((tool) => [tool.name, tool]) ?? [],
  );
  const taskToolNames = [
    'network_task_list_get',
    'network_task_summary',
    'network_task_add',
    'network_task_claim',
    'network_task_complete',
    'network_task_fail',
    'network_task_update',
    'network_task_delete',
  ];
  check(
    '房间任务 8 个工具全部注册',
    taskToolNames.every((name) => taskTools.has(name)),
    taskToolNames.filter((name) => !taskTools.has(name)),
  );
  const taskAddInput = JSON.stringify(taskTools.get('network_task_add')?.inputSchema ?? {});
  check(
    'task_add 输入含 request_id/room_id/description',
    ['request_id', 'room_id', 'description'].every((key) => taskAddInput.includes(`"${key}"`)),
    taskTools.get('network_task_add')?.inputSchema,
  );
  const taskClaimInput = JSON.stringify(taskTools.get('network_task_claim')?.inputSchema ?? {});
  check(
    'task_claim 只接受 request_id/task_id（房间由任务推导）',
    taskClaimInput.includes('"task_id"') && !taskClaimInput.includes('"room_id"'),
    taskTools.get('network_task_claim')?.inputSchema,
  );
  const taskListOutput = JSON.stringify(taskTools.get('network_task_list_get')?.outputSchema ?? {});
  check(
    'task_list 输出含 tasks/total/done',
    ['tasks', 'total', 'done'].every((key) => taskListOutput.includes(`"${key}"`)),
    taskTools.get('network_task_list_get')?.outputSchema,
  );
  const taskAddDescription = taskTools.get('network_task_add')?.description ?? '';
  check(
    'task_add 描述声明 120 字、informational 且不写 inbox/未读',
    taskAddDescription.includes('120') &&
      taskAddDescription.includes('informational') &&
      taskAddDescription.includes('不写 inbox') &&
      taskAddDescription.includes('不产生未读'),
    taskAddDescription,
  );
  const taskClaimDescription = taskTools.get('network_task_claim')?.description ?? '';
  check(
    'task_claim 描述声明仅 Agent、human 拒绝与不唤醒',
    taskClaimDescription.includes('Agent 成员') &&
      taskClaimDescription.includes('human 调用返回 INVALID_ARGUMENT') &&
      taskClaimDescription.includes('不唤醒'),
    taskClaimDescription,
  );
  const taskCompleteDescription = taskTools.get('network_task_complete')?.description ?? '';
  check(
    'task_complete 描述声明仅 assignee 且不写 inbox',
    taskCompleteDescription.includes('assignee') &&
      taskCompleteDescription.includes('不写 inbox'),
    taskCompleteDescription,
  );
  const taskUpdateDescription = taskTools.get('network_task_update')?.description ?? '';
  const taskDeleteDescription = taskTools.get('network_task_delete')?.description ?? '';
  check(
    'task_update/delete 描述声明创建者或房间 owner',
    taskUpdateDescription.includes('创建者或房间 owner') &&
      taskDeleteDescription.includes('创建者或房间 owner'),
    { taskUpdateDescription, taskDeleteDescription },
  );
  check(
    'task_list 与 task_summary 注册为只读工具',
    (taskTools.get('network_task_list_get') as { annotations?: { readOnlyHint?: boolean } } | undefined)
      ?.annotations?.readOnlyHint === true &&
      (taskTools.get('network_task_summary') as { annotations?: { readOnlyHint?: boolean } } | undefined)
        ?.annotations?.readOnlyHint === true,
  );

  const reissueTool = listed?.tools?.find(
    (tool) => tool.name === 'network_agent_reissue_token',
  );
  const reissueDescription = reissueTool?.description ?? '';
  check(
    'reissue 描述声明旧凭据撤销且 token 只返回一次',
    reissueDescription.includes('注销目标 Agent 的全部现有凭据') &&
      reissueDescription.includes('只返回一次') &&
      reissueDescription.includes('TOKEN_NOT_REPLAYABLE') &&
      reissueDescription.includes('任何已注册身份'),
    reissueTool?.description,
  );
  const reissueInput = JSON.stringify(reissueTool?.inputSchema ?? {});
  check(
    'reissue 输入包含 request_id 与 actor_id',
    reissueInput.includes('"request_id"') && reissueInput.includes('"actor_id"'),
    reissueTool?.inputSchema,
  );
  const reissueOutput = JSON.stringify(reissueTool?.outputSchema ?? {});
  check(
    'reissue 输出包含 token/mcp_url/revoked_count/issued_at',
    reissueOutput.includes('"token"') &&
      reissueOutput.includes('"mcp_url"') &&
      reissueOutput.includes('"revoked_count"') &&
      reissueOutput.includes('"issued_at"'),
    reissueTool?.outputSchema,
  );

  const archiveTool = listed?.tools?.find((tool) => tool.name === 'network_agent_archive');
  const archiveDescription = archiveTool?.description ?? '';
  check(
    'archive 描述声明只影响管理列表且不改变业务',
    archiveDescription.includes('只影响 Agent 管理列表') &&
      archiveDescription.includes('不改变消息') &&
      archiveDescription.includes('任何已注册身份'),
    archiveTool?.description,
  );
  check(
    'archive 描述声明不能恢复 MCP URL 或 token',
    archiveDescription.includes('不能恢复 MCP URL 或 token'),
    archiveTool?.description,
  );
  const agentsGetTool = listed?.tools?.find((tool) => tool.name === 'network_agents_get');
  check(
    'agents_get 描述声明不做全局枚举',
    typeof agentsGetTool?.description === 'string' &&
      agentsGetTool.description.includes('全局枚举'),
    agentsGetTool?.description,
  );
  const agentsGetInput = JSON.stringify(agentsGetTool?.inputSchema ?? {});
  check(
    'agents_get 输入限制为 1–100 个 actor_id',
    agentsGetInput.includes('"minItems":1') && agentsGetInput.includes('"maxItems":100'),
    agentsGetTool?.inputSchema,
  );
  const agentsGetOutput = JSON.stringify(agentsGetTool?.outputSchema ?? {});
  check(
    'agents_get 输出包含归档状态且不含 metadata 或凭据',
    agentsGetOutput.includes('"archived"') &&
      agentsGetOutput.includes('"archived_at"') &&
      agentsGetOutput.includes('"archived_by"') &&
      !agentsGetOutput.includes('"metadata"') &&
      !agentsGetOutput.includes('token'),
    agentsGetTool?.outputSchema,
  );

  const feedbackTool = listed?.tools?.find((tool) => tool.name === 'network_feedback_create');
  const feedbackInput = feedbackTool?.inputSchema as
    | {
        type?: string;
        properties?: Record<string, { type?: string; description?: string; pattern?: string }>;
        required?: string[];
        additionalProperties?: boolean;
      }
    | undefined;
  checkEqual(
    'feedback 输入字段精确为四个',
    Object.keys(feedbackInput?.properties ?? {}).sort().join(','),
    'environment,harness,problem,request_id',
  );
  checkEqual(
    'feedback 输入四个字段全部必填',
    [...(feedbackInput?.required ?? [])].sort().join(','),
    'environment,harness,problem,request_id',
  );
  check('feedback 输入 schema 为严格对象', feedbackInput?.additionalProperties === false);
  check(
    'feedback 输入字段均为 string',
    Object.values(feedbackInput?.properties ?? {}).every((property) => property.type === 'string'),
    feedbackInput?.properties,
  );
  check(
    'feedback 字段 describe 包含 UTF-8 字节上限',
    JSON.stringify(feedbackTool?.inputSchema ?? {}).includes('4096') &&
      JSON.stringify(feedbackTool?.inputSchema ?? {}).includes('16384') &&
      JSON.stringify(feedbackTool?.inputSchema ?? {}).includes('128'),
    feedbackTool?.inputSchema,
  );
  check(
    'feedback request_id 限制为 ASCII 标识符',
    typeof feedbackInput?.properties?.request_id?.pattern === 'string' &&
      feedbackInput.properties.request_id.pattern.includes('A-Za-z0-9'),
    feedbackInput?.properties?.request_id?.pattern,
  );
  const feedbackOutput = feedbackTool?.outputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  checkEqual(
    'feedback 输出只含 feedback_id/created_at',
    Object.keys(feedbackOutput?.properties ?? {}).sort().join(','),
    'created_at,feedback_id',
  );
  check(
    'feedback 未被标记为只读工具',
    (feedbackTool as { annotations?: { readOnlyHint?: boolean } } | undefined)?.annotations
      ?.readOnlyHint !== true,
  );
  for (const [label, tool] of [
    ['network_me', listed?.tools?.find((item) => item.name === 'network_me')],
    ['network_room_get', roomGetTool],
    ['network_contacts_list', listed?.tools?.find((item) => item.name === 'network_contacts_list')],
    ['network_history_list', historyTool],
  ] as const) {
    check(
      `${label} 输出 schema 不增加 archived 字段`,
      !JSON.stringify(tool?.outputSchema ?? {}).includes('"archived'),
      tool?.outputSchema,
    );
  }

  const issueTool = listed?.tools?.find((tool) => tool.name === 'network_issue_token');
  check(
    'network_issue_token 标记为只读工具',
    (issueTool as { annotations?: { readOnlyHint?: boolean } } | undefined)?.annotations
      ?.readOnlyHint === true,
  );

  const publicOrigin = (process.env.PUBLIC_ORIGIN ?? baseUrl()).replace(/\/+$/u, '');
  const issuedResponse = await rawRpc('tools/call', {
    name: 'network_issue_token',
    arguments: {},
  });
  const issued = (
    issuedResponse.body.result as
      | { structuredContent?: { token?: string; url?: string } }
      | undefined
  )?.structuredContent;
  const issuedToken = issued?.token ?? '';
  const issuedUrlValue = issued?.url;
  checkEqual('无 Authorization 调用 network_issue_token 返回 200', issuedResponse.status, 200);
  check('network_issue_token 返回非空 token', issuedToken.length > 0);
  check(
    'network_issue_token 返回 PUBLIC_ORIGIN 下的 /mcp?token= URL',
    typeof issuedUrlValue === 'string' &&
      issuedUrlValue.startsWith(`${publicOrigin}/mcp?token=`) &&
      new URL(issuedUrlValue).searchParams.get('token') === issuedToken,
  );

  const secondIssued = await rawRpc('tools/call', {
    name: 'network_issue_token',
    arguments: {},
  });
  const secondToken = (
    secondIssued.body.result as { structuredContent?: { token?: string } } | undefined
  )?.structuredContent?.token;
  check(
    '连续两次 network_issue_token 返回不同 token',
    secondToken !== undefined && secondToken !== issuedToken,
  );

  // 与网页“新建 Agent”一致：用 issue_token 返回的新 token 注册，不复用浏览器身份。
  const newAgentSession = `sess_ui_${crypto.randomUUID().replaceAll('-', '')}`;
  const newAgentName = '网页新建 Agent 检查';
  const newAgentRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: newRequestId('ui_agent_reg'),
        kind: 'agent',
        name: newAgentName,
        agent_session_id: newAgentSession,
      },
    },
    { token: secondToken },
  );
  const newAgentIdentity = (
    newAgentRegister.body.result as
      | { structuredContent?: { actor_id?: string; name?: string; share_url?: string | null } }
      | undefined
  )?.structuredContent;
  check(
    '新建 Agent 流程：新 token 可注册 agent',
    typeof secondToken === 'string' &&
      secondToken.length > 0 &&
      typeof newAgentIdentity?.actor_id === 'string',
  );
  check(
    '新建 Agent 流程：注册返回 share_url',
    typeof newAgentIdentity?.share_url === 'string' &&
      newAgentIdentity.share_url.endsWith(`/a/${encodeURIComponent(newAgentSession)}`),
  );
  const newAgentMe = await rawRpc(
    'tools/call',
    { name: 'network_me', arguments: {} },
    { token: secondToken },
  );
  const newAgentMeIdentity = (
    newAgentMe.body.result as
      | { structuredContent?: { actor_id?: string; name?: string } }
      | undefined
  )?.structuredContent;
  checkEqual(
    '新建 Agent 流程：新 token 调用 network_me 返回同一 actor',
    newAgentMeIdentity?.actor_id,
    newAgentIdentity?.actor_id,
  );
  checkEqual('新建 Agent 流程：network_me 返回注册名称', newAgentMeIdentity?.name, newAgentName);

  // 问题反馈：已注册但未 login 的 Agent 可提交；认证失败时返回 CREDENTIAL_INVALID。
  const feedbackArgs = {
    request_id: newRequestId('feedback_protocol'),
    environment: 'os=Protocol kernel=test arch=test bash=5 cli=1.0.0',
    harness: 'protocol',
    problem: '协议反馈\n多行中文与特殊字符 <>&"`',
  };
  const feedbackMeBefore = toolStructured<{ pending_count?: number }>(
    (await rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: secondToken }))
      .body,
  );
  const feedbackCall = await rawRpc(
    'tools/call',
    { name: 'network_feedback_create', arguments: feedbackArgs },
    { token: secondToken },
  );
  const feedbackResult = toolStructured<Record<string, unknown>>(feedbackCall.body);
  check(
    '已注册未 login 的 Agent 可提交反馈',
    typeof feedbackResult?.feedback_id === 'string' &&
      typeof feedbackResult?.created_at === 'string',
  );
  checkEqual(
    'feedback 输出只含 feedback_id/created_at',
    Object.keys(feedbackResult ?? {}).sort().join(','),
    'created_at,feedback_id',
  );
  check(
    'feedback created_at 为毫秒字符串',
    Number.isInteger(Number(feedbackResult?.created_at)),
  );
  check(
    'feedback 响应不回显正文',
    !JSON.stringify(feedbackResult ?? {}).includes('协议反馈'),
  );
  const feedbackReplay = toolStructured<Record<string, unknown>>(
    (
      await rawRpc(
        'tools/call',
        { name: 'network_feedback_create', arguments: feedbackArgs },
        { token: secondToken },
      )
    ).body,
  );
  checkEqual(
    'feedback 同参重放返回原 feedback_id',
    feedbackReplay?.feedback_id,
    feedbackResult?.feedback_id,
  );
  checkEqual(
    'feedback 同参重放返回原 created_at',
    feedbackReplay?.created_at,
    feedbackResult?.created_at,
  );
  const feedbackConflict = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, problem: '不同的问题正文' },
    },
    { token: secondToken },
  );
  checkEqual(
    'feedback 同 request_id 改参数返回 IDEMPOTENCY_CONFLICT',
    toolErrorCode(feedbackConflict.body),
    'IDEMPOTENCY_CONFLICT',
  );

  const feedbackMissing = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { request_id: newRequestId('feedback'), environment: 'x', harness: 'h' },
    },
    { token: secondToken },
  );
  check('feedback 缺 problem 被输入校验拒绝', isInputValidationFailure(feedbackMissing.body));
  const feedbackExtra = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback'), actor_id: 'agt_nope' },
    },
    { token: secondToken },
  );
  check('feedback 额外字段被严格 schema 拒绝', isInputValidationFailure(feedbackExtra.body));
  const feedbackWrongType = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback'), problem: 123 },
    },
    { token: secondToken },
  );
  check('feedback problem 类型错误被拒绝', isInputValidationFailure(feedbackWrongType.body));
  const feedbackBlank = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback'), environment: ' \n\t ' },
    },
    { token: secondToken },
  );
  checkEqual(
    'feedback 全空白 environment 返回 INVALID_ARGUMENT',
    toolErrorCode(feedbackBlank.body),
    'INVALID_ARGUMENT',
  );
  const feedbackBadId = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: 'bad request id' },
    },
    { token: secondToken },
  );
  check(
    'feedback 非法 request_id 被拒绝',
    isInputValidationFailure(feedbackBadId.body) ||
      toolErrorCode(feedbackBadId.body) === 'INVALID_ARGUMENT',
  );
  const feedbackControlHarness = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback'), harness: 'codex\nperi' },
    },
    { token: secondToken },
  );
  checkEqual(
    'feedback harness 控制字符返回 INVALID_ARGUMENT',
    toolErrorCode(feedbackControlHarness.body),
    'INVALID_ARGUMENT',
  );

  const feedbackCanary = `canary-${crypto.randomUUID()}`;
  const feedbackOverlong = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: {
        ...feedbackArgs,
        request_id: newRequestId('feedback'),
        problem: `${feedbackCanary}${'测'.repeat(5462)}`,
      },
    },
    { token: secondToken },
  );
  checkEqual(
    'feedback 多字节超长 problem 返回 PAYLOAD_TOO_LARGE',
    toolErrorCode(feedbackOverlong.body),
    'PAYLOAD_TOO_LARGE',
  );
  check(
    'feedback 超长错误不回显正文 canary',
    !JSON.stringify(feedbackOverlong.body).includes(feedbackCanary),
  );

  const feedbackAnonymous = await rawRpc('tools/call', {
    name: 'network_feedback_create',
    arguments: feedbackArgs,
  });
  checkEqual(
    '无凭据调用 feedback 返回 CREDENTIAL_INVALID',
    toolErrorCode(feedbackAnonymous.body),
    'CREDENTIAL_INVALID',
  );
  const feedbackUnknown = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback') },
    },
    { token: newToken() },
  );
  checkEqual(
    '未知/未注册凭据调用 feedback 返回 CREDENTIAL_INVALID',
    toolErrorCode(feedbackUnknown.body),
    'CREDENTIAL_INVALID',
  );

  const revokedFeedbackToken = toolStructured<{ token?: string }>(
    (await rawRpc('tools/call', { name: 'network_issue_token', arguments: {} })).body,
  )?.token;
  const revokedFeedbackRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: newRequestId('revoked_feedback_reg'),
        kind: 'agent',
        name: '撤销反馈检查 Agent',
        agent_session_id: `sess_revoked_feedback_${crypto.randomUUID().replaceAll('-', '')}`,
      },
    },
    { token: revokedFeedbackToken },
  );
  const revokedFeedbackActor = toolStructured<{ actor_id?: string }>(
    revokedFeedbackRegister.body,
  )?.actor_id;
  check('撤销前反馈目标 Agent 注册成功', typeof revokedFeedbackActor === 'string');
  const revokedFeedbackReissue = await rawRpc(
    'tools/call',
    {
      name: 'network_agent_reissue_token',
      arguments: { request_id: newRequestId('revoked_feedback_reissue'), actor_id: revokedFeedbackActor },
    },
    { token: secondToken },
  );
  check(
    '撤销反馈目标 Agent 凭据成功',
    (revokedFeedbackReissue.body.result as { isError?: boolean } | undefined)?.isError !== true,
  );
  const revokedFeedback = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback') },
    },
    { token: revokedFeedbackToken },
  );
  const revokedFeedbackError = revokedFeedback.body.error as
    | { data?: { code?: string } }
    | undefined;
  checkEqual(
    '已撤销凭据调用 feedback 返回 CREDENTIAL_INVALID',
    toolErrorCode(revokedFeedback.body) ?? revokedFeedbackError?.data?.code,
    'CREDENTIAL_INVALID',
  );

  const humanFeedbackToken = newToken();
  const humanFeedbackRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: newRequestId('human_feedback_reg'),
        kind: 'human',
        name: '反馈协议人类',
      },
    },
    { token: humanFeedbackToken },
  );
  check(
    '反馈协议人类注册成功',
    typeof toolStructured<{ actor_id?: string }>(humanFeedbackRegister.body)?.actor_id === 'string',
  );
  const humanFeedbackCall = await rawRpc(
    'tools/call',
    {
      name: 'network_feedback_create',
      arguments: { ...feedbackArgs, request_id: newRequestId('feedback'), harness: 'human-protocol' },
    },
    { token: humanFeedbackToken },
  );
  check(
    '人类身份可提交反馈',
    typeof toolStructured<Record<string, unknown>>(humanFeedbackCall.body)?.feedback_id === 'string',
  );

  const feedbackMeAfter = toolStructured<{ pending_count?: number }>(
    (await rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: secondToken }))
      .body,
  );
  checkEqual(
    '反馈不改变调用者 pending_count',
    feedbackMeAfter?.pending_count,
    feedbackMeBefore?.pending_count,
  );

  const issuedUrl = new URL(issuedUrlValue ?? `${baseUrl()}/mcp?token=missing`);

  const issuedMe = await rawRpc(
    'tools/call',
    { name: 'network_me', arguments: {} },
    { url: issuedUrl },
  );
  checkEqual(
    '未注册 URL token 调用 network_me 返回 CREDENTIAL_INVALID',
    toolErrorCode(issuedMe.body),
    'CREDENTIAL_INVALID',
  );

  const urlSession = `sess_url_${crypto.randomUUID().replaceAll('-', '')}`;
  const urlRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: newRequestId('url_reg'),
        kind: 'agent',
        name: 'URL 凭据检查',
        agent_session_id: urlSession,
      },
    },
    { url: issuedUrl },
  );
  const urlIdentity = (
    urlRegister.body.result as
      | { structuredContent?: { actor_id?: string; share_url?: string | null } }
      | undefined
  )?.structuredContent;
  check('URL token 可完成 network_register', typeof urlIdentity?.actor_id === 'string');
  check(
    'URL token 注册返回 share_url',
    typeof urlIdentity?.share_url === 'string' &&
      urlIdentity.share_url.endsWith(`/a/${encodeURIComponent(urlSession)}`),
  );
  const issuedRegisteredMe = await rawRpc(
    'tools/call',
    { name: 'network_me', arguments: {} },
    { url: issuedUrl },
  );
  const issuedRegisteredIdentity = (
    issuedRegisteredMe.body.result as
      | { structuredContent?: { actor_id?: string } }
      | undefined
  )?.structuredContent;
  checkEqual(
    'URL token 调用 network_me 返回同一 actor',
    issuedRegisteredIdentity?.actor_id,
    urlIdentity?.actor_id,
  );

  const invalidUrl = new URL(`${baseUrl()}/mcp`);
  invalidUrl.searchParams.set('token', `invalid_${crypto.randomUUID()}`);
  const invalidMe = await rawRpc(
    'tools/call',
    { name: 'network_me', arguments: {} },
    { url: invalidUrl },
  );
  checkEqual(
    '无效 query token 调用私有工具返回 CREDENTIAL_INVALID',
    toolErrorCode(invalidMe.body),
    'CREDENTIAL_INVALID',
  );

  const bearerToken = newToken();
  const bearerRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: newRequestId('bearer_reg'),
        kind: 'agent',
        name: 'Bearer 优先检查',
        agent_session_id: `sess_bearer_${crypto.randomUUID().replaceAll('-', '')}`,
      },
    },
    { token: bearerToken },
  );
  const bearerIdentity = (
    bearerRegister.body.result as
      | { structuredContent?: { actor_id?: string } }
      | undefined
  )?.structuredContent;
  const precedenceUrl = new URL(`${baseUrl()}/mcp`);
  precedenceUrl.searchParams.set('token', `invalid_${crypto.randomUUID()}`);
  const precedenceMe = await rawRpc(
    'tools/call',
    { name: 'network_me', arguments: {} },
    { url: precedenceUrl, token: bearerToken },
  );
  const precedenceIdentity = (
    precedenceMe.body.result as
      | { structuredContent?: { actor_id?: string } }
      | undefined
  )?.structuredContent;
  checkEqual(
    '合法 Bearer 优先于无效 query token',
    precedenceIdentity?.actor_id,
    bearerIdentity?.actor_id,
  );

  const originIssue = await rawRpc(
    'tools/call',
    { name: 'network_issue_token', arguments: {} },
    { headers: { origin: 'https://example.com' } },
  );
  checkEqual('任意 Origin 调用 /mcp 返回 200', originIssue.status, 200);
  checkEqual(
    '跨域响应允许任意 Origin',
    originIssue.headers.get('access-control-allow-origin'),
    '*',
  );
  check(
    '跨域响应包含 Vary: Origin',
    (originIssue.headers.get('vary') ?? '').toLowerCase().includes('origin'),
  );

  const nullOrigin = await rawRpc(
    'tools/call',
    { name: 'network_issue_token', arguments: {} },
    { headers: { origin: 'null' } },
  );
  checkEqual('Origin: null 不触发 403', nullOrigin.status, 200);

  const slashOrigin = await rawRpc(
    'tools/call',
    { name: 'network_issue_token', arguments: {} },
    { headers: { origin: 'https://example.com/' } },
  );
  checkEqual('带尾斜杠 Origin 不触发 403', slashOrigin.status, 200);

  const preflight = await fetch(`${baseUrl()}/mcp`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name',
    },
  });
  checkEqual('OPTIONS /mcp 预检返回 204', preflight.status, 204);
  checkEqual('预检允许任意 Origin', preflight.headers.get('access-control-allow-origin'), '*');
  check(
    '预检允许 Authorization 请求头',
    (preflight.headers.get('access-control-allow-headers') ?? '')
      .toLowerCase()
      .includes('authorization'),
  );
  check(
    '预检声明 POST',
    (preflight.headers.get('access-control-allow-methods') ?? '').includes('POST'),
  );

  if (hasDrive) {
    const uploadPreflight = await fetch(`${baseUrl()}/mcp-upload`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, mcpp-files-version',
      },
    });
    checkEqual('OPTIONS /mcp-upload 预检返回 204', uploadPreflight.status, 204);

    const uploadBody = 'url token upload';
    const queryUploadUrl = new URL(`${baseUrl()}/mcp-upload`);
    queryUploadUrl.searchParams.set('token', issuedToken);
    const queryUpload = await fetch(queryUploadUrl, {
      method: 'POST',
      headers: {
        origin: 'https://example.com',
        'MCPP-Files-Version': '1',
        'content-type': 'text/plain',
        'MCPP-File-Name': 'url-token.txt',
        'MCPP-File-Size': String(new TextEncoder().encode(uploadBody).length),
      },
      body: uploadBody,
    });
    checkEqual('URL token 可用于 /mcp-upload', queryUpload.status, 201);
    checkEqual(
      '上传跨域响应允许任意 Origin',
      queryUpload.headers.get('access-control-allow-origin'),
      '*',
    );
  }

  const skills = await rawRpc('skills/list');
  const skillEntries =
    (skills.body.result as { skills?: SkillEntry[] } | undefined)?.skills ?? [];
  checkEqual('skills/list 返回 1 个技能', skillEntries.length, 1);
  const skill = skillEntries[0];
  checkEqual('技能 frontmatter.name 为 agent-network', skill?.frontmatter.name, 'agent-network');
  check(
    '技能 frontmatter.description 为非空字符串',
    typeof skill?.frontmatter.description === 'string' && skill.frontmatter.description.length > 0,
    skill?.frontmatter,
  );
  checkEqual('技能 URI 最终段与 name 一致', skill?.uri, 'skill://agent-network/agent-network/SKILL.md');
  checkEqual(
    'skills/list 结果不含 _meta（rmcp 兼容）',
    (skills.body.result as Record<string, unknown> | undefined)?._meta,
    undefined,
  );
  checkEqual(
    'skills/list 结果保留 resultType',
    (skills.body.result as Record<string, unknown> | undefined)?.resultType,
    'complete',
  );
  const skillResource = skill?.resources?.find((resource) => resource.uri === skill?.uri);
  check('技能 resources 含 SKILL.md 自身条目', skillResource !== undefined, skill?.resources);
  check(
    '技能 digest 格式为 sha256:<64 位小写 hex>',
    typeof skillResource?.digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(skillResource.digest),
    skillResource?.digest,
  );

  const skillRead = await rawRpc(
    'resources/read',
    { uri: skill?.uri },
    { headers: { 'mcp-name': skill?.uri ?? '' } },
  );
  const readContents =
    (skillRead.body.result as
      | { contents?: { uri: string; mimeType?: string; text?: string }[] }
      | undefined)?.contents ?? [];
  const skillText = readContents[0]?.text ?? '';
  checkEqual('resources/read 返回技能正文', readContents[0]?.uri, skill?.uri);
  checkEqual('技能正文 mimeType 为 text/markdown', readContents[0]?.mimeType, 'text/markdown');
  const actualDigest = new Bun.CryptoHasher('sha256').update(skillText).digest('hex');
  checkEqual('技能正文 digest 与条目一致', `sha256:${actualDigest}`, skillResource?.digest);
  check(
    '技能正文含与条目一致的 frontmatter',
    skillText.startsWith(`---\nname: ${skill?.frontmatter.name}\ndescription: ${skill?.frontmatter.description}\n---\n`),
    skillText.slice(0, 160),
  );
  check(
    '技能正文声明回复不等于完成',
    skillText.includes('回复不等于完成') && skillText.includes('claim 只是接手'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文要求阶段性回复进度',
    skillText.includes('阶段性节点回复进度') && skillText.includes('阶段性回复不改变 delivery 状态'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文包含回复去重规范',
    ['### 回复去重', '同一房间', '只发一条', 'network_delivery_complete', '不重贴正文'].every(
      (marker) => skillText.includes(marker),
    ),
    skillText.slice(0, 240),
  );
  check(
    '技能正文包含短回复与长内容 Markdown 文件规范',
    skillText.includes('默认短回复') &&
      skillText.includes('一行摘要') &&
      skillText.includes('network_room_file_bind') &&
      skillText.includes('file.public_url') &&
      skillText.includes('Markdown 渲染'),
    skillText.slice(0, 240),
  );
  check(
    '技能正文包含 Markdown 写法与空行规范',
    skillText.includes('### Markdown 写法') &&
      skillText.includes('至少留一个空行') &&
      skillText.includes('不要把多段正文') &&
      skillText.includes('列表一项一行') &&
      skillText.includes('围栏代码块') &&
      skillText.includes('标注语言') &&
      skillText.includes('聊天只发摘要和链接'),
    skillText.slice(0, 260),
  );
  check(
    '技能正文要求超过 10 秒先发简短确认',
    skillText.includes('超过 10 秒') &&
      skillText.includes('简短确认') &&
      skillText.includes('不算完成'),
    skillText.slice(0, 240),
  );
  check(
    '技能正文要求首次进入新会话发送一次问候',
    skillText.includes('## 首次进入会话') &&
      skillText.includes('先读') &&
      skillText.includes('自我介绍') &&
      skillText.includes('每个房间只发一次') &&
      skillText.includes('不要向所有房间批量群发或刷屏') &&
      skillText.includes('网页也不会用用户身份冒充 Agent 发送'),
    skillText.slice(0, 240),
  );
  check(
    '技能正文说明 CLAIM_CONFLICT 不代表放弃全部工作',
    skillText.includes('CLAIM_CONFLICT') && skillText.includes('不代表放弃全部任务'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文说明状态变更不自我唤醒',
    skillText.includes('claim/report/complete/fail 不会再触发自己的 inbox 提示'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文包含房间任务完整工具与不唤醒语义',
    ['## 房间任务', 'network_task_list_get', 'network_task_summary', 'network_task_add',
      'network_task_claim', 'network_task_complete', 'network_task_fail',
      'network_task_update', 'network_task_delete', 'room.tasks',
      '不写 inbox', '不推进 `head_seq`', '不要轮询任务列表',
      'agent_tasks.sh'].every((marker) => skillText.includes(marker)),
    skillText.slice(0, 320),
  );
  check(
    '技能正文声明任务文本 120 字与长内容 .md',
    skillText.includes('1–120') &&
      skillText.includes('拒绝换行与控制字符') &&
      skillText.includes('.md'),
    skillText.slice(0, 260),
  );
  check(
    '技能正文说明群聊 @ 名字由服务端解析',
    skillText.includes('群聊派活') &&
      skillText.includes('省略 `invoke`') &&
      skillText.includes('不需要 actor_id') &&
      skillText.includes('仍可用且优先') &&
      skillText.includes('invoke: []') &&
      skillText.includes('同名 Agent') &&
      skillText.includes('direct 仍需显式'),
    skillText.slice(0, 300),
  );
  check(
    '技能正文说明群聊 @ 解析的原文匹配边界',
    skillText.includes('@自己') &&
      skillText.includes('非 Agent') &&
      skillText.includes('代码块'),
    skillText.slice(0, 300),
  );
  check(
    '技能正文说明 MCP Events room_id 硬过滤与群聊订阅',
    skillText.includes('arguments.room_id') &&
      skillText.includes('硬过滤') &&
      skillText.includes('群聊') &&
      skillText.includes('action_required') &&
      skillText.includes('默认为 active') &&
      skillText.includes('events/unsubscribe'),
    skillText.slice(0, 240),
  );
  check(
    '技能正文要求注册后向用户提供 share_url',
    skillText.includes('share_url') && skillText.includes('发给用户'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文要求注册后立即进入异步监听',
    skillText.includes('异步') &&
      skillText.includes('network_login') &&
      skillText.includes('监听') &&
      skillText.includes('订阅') &&
      skillText.includes('不要轮询'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文只覆盖 Agent 类型',
    !skillText.includes('kind: "human"') && !skillText.includes('human actor'),
    skillText.slice(0, 200),
  );
  check(
    'MCP 技能声明与静态技能面分离',
    skillText.includes('无法使用 MCP') && skillText.includes('不属于 `skills/list`'),
    skillText.slice(0, 240),
  );
  check(
    '技能正文说明 URL 凭据与 Origin 边界',
    skillText.includes('network_issue_token') &&
      skillText.includes('?token=') &&
      skillText.includes('Origin 不再是认证边界') &&
      skillText.includes('丢失 URL'),
    skillText.slice(0, 240),
  );

  const skillGet = await rawRpc('skills/get', { uri: skill?.uri ?? '' });
  const gotSkill = (skillGet.body.result as { skill?: SkillEntry } | undefined)?.skill;
  checkEqual(
    'skills/get 结果不含 _meta（rmcp 兼容）',
    (skillGet.body.result as Record<string, unknown> | undefined)?._meta,
    undefined,
  );
  check(
    'skills/get 返回同一技能快照',
    JSON.stringify(gotSkill) === JSON.stringify(skill),
    { gotSkill, skill },
  );
  const missingSkill = await rawRpc('skills/get', { uri: 'skill://unknown/unknown/SKILL.md' });
  checkEqual(
    'skills/get 未知 URI 返回 -32602',
    (missingSkill.body.error as Record<string, unknown> | undefined)?.code,
    -32602,
  );

  const shareSession = `sess_share_${crypto.randomUUID().replaceAll('-', '')}`;
  const shareToken = newToken();
  const shareRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: `reg_${crypto.randomUUID().replaceAll('-', '')}`,
        kind: 'agent',
        name: '分享页检查',
        agent_session_id: shareSession,
      },
    },
    { token: shareToken },
  );
  const shareIdentity = (
    shareRegister.body.result as
      | { structuredContent?: { actor_id?: string; share_url?: string | null } }
      | undefined
  )?.structuredContent;
  check(
    '注册返回指向 /a/<session> 的 share_url',
    typeof shareIdentity?.share_url === 'string' &&
      shareIdentity.share_url.endsWith(`/a/${encodeURIComponent(shareSession)}`),
    shareIdentity?.share_url,
  );
  const sharePath = shareIdentity?.share_url
    ? new URL(shareIdentity.share_url).pathname
    : '/a/missing';
  const sharePage = await fetch(`${baseUrl()}${sharePath}`);
  checkEqual('分享页 GET 返回 200', sharePage.status, 200);
  check(
    '分享页 Content-Type 为 text/html',
    (sharePage.headers.get('content-type') ?? '').includes('text/html'),
    sharePage.headers.get('content-type'),
  );
  const shareHtml = await sharePage.text();
  check('分享页包含 actor_id', shareHtml.includes(shareIdentity?.actor_id ?? '\u0000'));
  check('分享页包含 agent_session_id', shareHtml.includes(shareSession));

  const missingShare = await fetch(
    `${baseUrl()}/a/${encodeURIComponent(`missing_${crypto.randomUUID().replaceAll('-', '')}`)}`,
  );
  checkEqual('未知分享 session 返回 404', missingShare.status, 404);
  check(
    '未知分享 session 返回 HTML',
    (missingShare.headers.get('content-type') ?? '').includes('text/html'),
    missingShare.headers.get('content-type'),
  );

  const home = await fetch(`${baseUrl()}/`);
  checkEqual('GET / 返回 200', home.status, 200);
  check(
    '首页 Content-Type 为 text/html',
    (home.headers.get('content-type') ?? '').includes('text/html'),
    home.headers.get('content-type'),
  );
  const homeHtml = await home.text();
  check('首页包含会话列表容器', homeHtml.includes('id="room-list"'));
  check('首页包含双栏空状态', homeHtml.includes('id="empty-state"') && homeHtml.includes('选择一个会话开始聊天'));
  check('首页包含会话搜索框', homeHtml.includes('id="room-search"') && homeHtml.includes('搜索'));
  check('首页包含新建群聊入口', homeHtml.includes('id="new-group"'));
  check('首页包含新建群聊弹窗', homeHtml.includes('id="group-modal"'));
  check(
    '首页包含新建 Agent 入口',
    homeHtml.includes('id="new-agent"') && homeHtml.includes('新建 Agent'),
  );
  check(
    '首页包含新建 Agent 弹窗',
    homeHtml.includes('id="new-agent-modal"') &&
      homeHtml.includes('id="new-agent-name"') &&
      homeHtml.includes('id="new-agent-create"') &&
      homeHtml.includes('id="new-agent-url"') &&
      homeHtml.includes('id="new-agent-copy"') &&
      homeHtml.includes('id="new-agent-share"') &&
      homeHtml.includes('id="new-agent-close"') &&
      homeHtml.includes('id="new-agent-error"'),
  );
  check(
    '新建 Agent 弹窗标明 MCP URL 保存在本浏览器且为长期凭据',
    homeHtml.includes('长期 token') &&
      homeHtml.includes('Agents 注册表') &&
      homeHtml.includes('localStorage 可被同源脚本读取') &&
      homeHtml.includes('不要截图、发群或写入日志'),
  );
  check(
    '新建 Agent 使用 issue_token 的新 token 注册',
    homeHtml.includes('callToolWithToken') &&
      homeHtml.includes('network_issue_token') &&
      homeHtml.includes("requestId('web_agent_reg')"),
  );
  check('首页包含手机扫码入口', homeHtml.includes('id="device-handoff"') && homeHtml.includes('手机扫码'));
  check(
    '首页不再包含复制 actor ID 按钮',
    !homeHtml.includes('id="account-copy-id"') && !homeHtml.includes('复制 ID'),
  );
  check(
    '首页脚本包含剪贴板复制与 execCommand 兜底',
    homeHtml.includes('navigator.clipboard') &&
      homeHtml.includes('writeText') &&
      homeHtml.includes("execCommand('copy')"),
  );
  check(
    '首页包含扫码弹窗与二维码画布',
    homeHtml.includes('id="handoff-modal"') && homeHtml.includes('id="handoff-qr"'),
  );
  check(
    '扫码页内联 fragment 采纳脚本',
    homeHtml.includes("#t=") && homeHtml.includes('history.replaceState'),
  );
  check(
    '首页脚本首次访问自动注册 human 身份',
    homeHtml.includes("requestId('web_reg')") && homeHtml.includes("kind: 'human'"),
  );
  check('扫码弹窗标明凭据泄露风险', homeHtml.includes('请勿截图或分享'));
  const removedHandoff = await fetch(`${baseUrl()}/j/removed`);
  checkEqual('服务端不提供 /j 扫码兑换端点', removedHandoff.status, 404);
  check(
    '首页不再包含服务信息入口与折叠面板',
    !homeHtml.includes('服务信息') &&
      !homeHtml.includes('class="service-info"') &&
      !homeHtml.includes('/a/&lt;agent_session_id&gt;'),
  );
  check(
    '首页包含本人姓名编辑入口与弹窗',
    homeHtml.includes('id="account-rename"') &&
      homeHtml.includes('aria-label="编辑姓名"') &&
      homeHtml.includes('id="me-rename-modal"') &&
      homeHtml.includes('id="me-rename-input"') &&
      homeHtml.includes("callTool('network_me_rename'"),
  );
  check(
    '首页脚本内联 claimed 超时提示与阈值',
    homeHtml.includes('CLAIM_STALE_MS') && homeHtml.includes('处理中未更新'),
  );
  check(
    '首页包含 Agent 在线状态点与在线/离线/未知文案',
    homeHtml.includes('presence-dot') &&
      homeHtml.includes('在线') &&
      homeHtml.includes('离线') &&
      homeHtml.includes('未知'),
  );
  check(
    '首页包含房间任务行、浮层与侧栏 badge 脚本',
    homeHtml.includes('id="task-toggle"') &&
      homeHtml.includes('id="task-popover"') &&
      homeHtml.includes('id="task-list"') &&
      homeHtml.includes('room-task-badge') &&
      homeHtml.includes('network_task_list_get') &&
      homeHtml.includes("callTool('network_task_summary'"),
  );
  check(
    '任务 UI 使用 textContent 且不写 token',
    homeHtml.includes('description.textContent') &&
      homeHtml.includes('result.textContent') &&
      !homeHtml.includes('taskPopoverElement.innerHTML') &&
      !homeHtml.includes('taskListElement.innerHTML'),
  );

  const skillDoc = await fetch(`${baseUrl()}/skills/agent-network-skills.md`);
  checkEqual('GET /skills/agent-network-skills.md 返回 200', skillDoc.status, 200);
  const skillDocText = await skillDoc.text();
  check(
    '静态技能为 Markdown 且包含行为模式与 Harness 指南',
    (skillDoc.headers.get('content-type') ?? '').includes('text/markdown') &&
      skillDocText.includes('行为模式') &&
      skillDocText.includes('Harness 指南'),
    skillDoc.headers.get('content-type'),
  );
  check(
    '静态技能说明群聊 @ 名字由服务端解析',
    skillDocText.includes('群聊派活') &&
      skillDocText.includes('省略 `invoke`') &&
      skillDocText.includes('不需要 actor_id') &&
      skillDocText.includes('`--no-invoke`') &&
      skillDocText.includes('同名 Agent') &&
      !skillDocText.includes('仅在正文写 @ 不等于指定 invoke'),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能不包含硬编码 Bearer token',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(skillDocText),
  );
  check(
    '静态技能只覆盖 Agent 类型',
    !skillDocText.includes('kind: "human"'),
    skillDocText.slice(0, 200),
  );
  check(
    '静态技能包含四种命令与监听脚本',
    ['agentnet.sh', 'peri-watch.sh', 'codex-watch.sh', 'claude-watch.sh'].every((name) =>
      skillDocText.includes(name),
    ),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能包含房间任务命令与不唤醒规范',
    ['agent_tasks.sh', '### 房间任务', 'network_task_list_get', 'network_task_claim',
      'network_task_summary', 'room.tasks', '不写 inbox', '不会唤醒 Agent'].every((marker) =>
      skillDocText.includes(marker),
    ),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能包含短回复与长内容文件指引',
    skillDocText.includes('回复长度与长内容') && skillDocText.includes('一行摘要'),
    skillDocText.slice(0, 240),
  );
  const markdownSection = (text: string): string => {
    const heading = '### Markdown 写法';
    const start = text.indexOf(heading);
    if (start < 0) return '';
    const rest = text.slice(start + heading.length);
    const next = rest.search(/\n#{2,3} /u);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };
  const mainMarkdownSection = markdownSection(skillText);
  const staticMarkdownSection = markdownSection(skillDocText);
  check(
    '静态技能包含 Markdown 写法与空行规范',
    staticMarkdownSection.includes('至少留一个空行') &&
      staticMarkdownSection.includes('列表一项一行') &&
      staticMarkdownSection.includes('围栏代码块') &&
      staticMarkdownSection.includes('标注语言') &&
      staticMarkdownSection.includes('摘要和链接'),
    staticMarkdownSection,
  );
  const sectionDigest = (text: string): string =>
    new Bun.CryptoHasher('sha256').update(text).digest('hex');
  checkEqual(
    '静态/主 skill Markdown 写法 digest 一致',
    sectionDigest(staticMarkdownSection),
    sectionDigest(mainMarkdownSection),
  );
  check(
    '静态技能包含首次进入会话规范',
    skillDocText.includes('### 首次进入会话') &&
      skillDocText.includes('每个房间只发一次') &&
      skillDocText.includes('不领取投递') &&
      skillDocText.includes('服务端和网页都不会自动生成'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能包含 MCP Events 硬过滤与群聊补读规范',
    skillDocText.includes('### MCP Events 订阅过滤') &&
      skillDocText.includes('硬过滤') &&
      skillDocText.includes('群聊普通消息默认不产生 delivery') &&
      skillDocText.includes('紧邻上一条来自 active Agent') &&
      skillDocText.includes('默认为 active') &&
      skillDocText.includes('events/unsubscribe'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能包含五份 Harness 指南的相对链接',
    [
      '[Codex](./harness-codex.md)',
      '[ChatGPT Web](./harness-chatgpt-web.md)',
      '[Peri](./harness-peri.md)',
      '[Claude](./harness-claude.md)',
      '[Other](./harness-other.md)',
    ].every((link) => skillDocText.includes(link)),
    skillDocText.slice(0, 400),
  );
  check(
    '静态技能包含 Other 哨兵与无 monitor 接入标记',
    ['Other', '无 monitor', 'other-sentinel.sh', 'watch.log', 'MAX_WAIT', '360', '哨兵'].every(
      (marker) => skillDocText.includes(marker),
    ),
    skillDocText.slice(0, 400),
  );
  check(
    '静态技能包含回复去重规范',
    ['### 回复去重', '同一房间', '只发一条', 'complete', '文件链接只发一次'].every((marker) =>
      skillDocText.includes(marker),
    ),
    skillDocText.slice(0, 400),
  );
  const harnessDocs = [
    {
      file: 'harness-codex.md',
      markers: ['codex-watch.sh', 'AGENTNET_TOKEN', 'CODEX_THREAD_ID', 'turn/steer'],
    },
    {
      file: 'harness-chatgpt-web.md',
      markers: ['Connector', 'OAuth', 'MCP Events', '公网 HTTPS', '?token=<token>'],
    },
    {
      file: 'harness-peri.md',
      markers: [
        'monitor',
        'peri-watch.sh',
        'AGENTNET_TOKEN',
        'network_inbox_list',
        'ALERT',
        'network_delivery_claim',
        'network_delivery_complete',
      ],
    },
    {
      file: 'harness-claude.md',
      markers: [
        'claude-watch.sh',
        'Monitor',
        'AGENTNET_TOKEN',
        'share_url',
        'event_file',
        'agentnet.sh reply',
        'network_delivery_complete',
        'network_delivery_fail',
        '10 秒',
        '简短确认',
        '持续',
      ],
    },
    {
      file: 'harness-other.md',
      markers: [
        '无 monitor',
        '哨兵',
        'other-sentinel.sh',
        'peri-watch.sh',
        'watch.log',
        'READY',
        'ALERT',
        'MAX_WAIT',
        '360',
        'network_inbox_list',
        'network_delivery_claim',
        'network_delivery_complete',
        '重新挂',
        'cron',
        'curl: (28)',
        '401/403',
      ],
    },
  ] as const;
  for (const doc of harnessDocs) {
    const response = await fetch(`${baseUrl()}/skills/${doc.file}`);
    checkEqual(`GET /skills/${doc.file} 返回 200`, response.status, 200);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    check(
      `${doc.file} 为 Markdown 且包含关键标记`,
      contentType.includes('text/markdown') &&
        doc.markers.every((marker) => text.includes(marker)),
      {
        contentType,
        missing: doc.markers.filter((marker) => !text.includes(marker)),
      },
    );
    check(
      `${doc.file} 不包含硬编码 Bearer token 或完整 token URL`,
      !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(text) &&
        !/[?&]token=[0-9a-f]{8}-[0-9a-f]{4}/iu.test(text),
    );
    check(
      `${doc.file} 只覆盖 Agent 类型`,
      !text.includes('kind: "human"') && !text.includes('人类'),
      text.slice(0, 200),
    );
  }

  const otherSentinel = await fetch(`${baseUrl()}/skills/other-sentinel.sh`);
  checkEqual('GET /skills/other-sentinel.sh 返回 200', otherSentinel.status, 200);
  const otherSentinelType = otherSentinel.headers.get('content-type') ?? '';
  const otherSentinelText = await otherSentinel.text();
  check(
    'Other 哨兵脚本只读本地日志并支持 MAX_WAIT/POLL',
    otherSentinelType.includes('text/x-shellscript') &&
      ['LOG', 'MAX_WAIT', 'POLL', 'ALERT', 'WAKE'].every((marker) =>
        otherSentinelText.includes(marker),
      ) &&
      !otherSentinelText.includes('AGENTNET_TOKEN') &&
      !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(otherSentinelText),
    { contentType: otherSentinelType },
  );
  const otherSentinelSyntax = Bun.spawnSync({
    cmd: ['bash', '-n', 'public/skills/other-sentinel.sh'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    'Other 哨兵脚本通过 bash -n',
    otherSentinelSyntax.exitCode === 0,
    otherSentinelSyntax.stderr.toString(),
  );

  const chatgptGuide = await fetch(`${baseUrl()}/skills/harness-chatgpt-web.md`);
  checkEqual('GET /skills/harness-chatgpt-web.md 返回 200（群聊订阅）', chatgptGuide.status, 200);
  const chatgptGuideText = await chatgptGuide.text();
  const chatgptGroupMarkers = [
    '群聊',
    '省略 invoke',
    '@名字',
    'invoke 传 []',
    'room_id',
    'attention',
    'action_required',
    'network_inbox_list',
    'network_delivery_claim',
    'network_delivery_complete',
    '补读',
    '不要只订阅单个 direct 房间',
    'events/unsubscribe',
  ];
  check(
    'ChatGPT 指南说明 room_id 硬过滤、群聊订阅与投递闭环',
    chatgptGroupMarkers.every((marker) => chatgptGuideText.includes(marker)),
    { missing: chatgptGroupMarkers.filter((marker) => !chatgptGuideText.includes(marker)) },
  );
  check(
    'ChatGPT 指南说明群聊 @ 名字服务端解析',
    chatgptGuideText.includes('服务端按正文 @名字 解析') &&
      chatgptGuideText.includes('direct 不解析正文') &&
      !chatgptGuideText.includes('只有发送者显式 invoke'),
    chatgptGuideText.slice(0, 400),
  );
  check(
    'ChatGPT 指南明确新订阅不重放旧事件',
    chatgptGuideText.includes('不重放') &&
      chatgptGuideText.includes('network_sync { scope: "inbox" }'),
    chatgptGuideText.slice(0, 400),
  );
  check(
    'ChatGPT 指南不出现非 Agent 类型字面量',
    !chatgptGuideText.includes('人类'),
    chatgptGuideText.slice(0, 200),
  );

  const periGuide = await fetch(`${baseUrl()}/skills/harness-peri.md`);
  checkEqual('GET /skills/harness-peri.md 返回 200（Peri 指南）', periGuide.status, 200);
  const periGuideType = periGuide.headers.get('content-type') ?? '';
  const periGuideText = await periGuide.text();
  const periMonitorMarkers = [
    '24 小时',
    '24h',
    'monitor',
    'peri-watch.sh',
    'network_inbox_list',
    'ALERT',
    'READY',
  ];
  check(
    'Peri 指南标注单次 monitor 最长 24h 并说明脚本重启与 ALERT',
    periGuideType.includes('text/markdown') &&
      periMonitorMarkers.every((marker) => periGuideText.includes(marker)) &&
      !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(periGuideText) &&
      !/[?&]token=[0-9a-f]{8}-[0-9a-f]{4}/iu.test(periGuideText),
    {
      contentType: periGuideType,
      missing: periMonitorMarkers.filter((marker) => !periGuideText.includes(marker)),
    },
  );

  const periScript = await fetch(`${baseUrl()}/skills/peri-watch.sh`);
  checkEqual('GET /skills/peri-watch.sh 返回 200', periScript.status, 200);
  const periScriptType = periScript.headers.get('content-type') ?? '';
  const periScriptText = await periScript.text();
  check(
    'Peri monitor 脚本只监听投递并包含 ALERT',
    periScriptType.includes('text/x-shellscript') &&
      ['ALERT', 'AGENTNET_TOKEN', 'network_inbox_list', 'delivery_id', 'ERROR type=inbox', 'agentnet://stream', 'subscriptions/listen', 'sender_id', '--connect-timeout'].every((marker) =>
        periScriptText.includes(marker),
      ),
    { contentType: periScriptType },
  );
  check(
    'Peri monitor 脚本不轮询房间，也不要求 ROOM_ID',
    !periScriptText.includes('ROOM_ID') &&
      !periScriptText.includes('network_rooms_list') &&
      !periScriptText.includes('network_room_get'),
  );
  check(
    'Peri monitor 脚本不包含硬编码 Bearer token',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(periScriptText),
  );

  const codexScript = await fetch(`${baseUrl()}/skills/codex-watch.sh`);
  checkEqual('GET /skills/codex-watch.sh 返回 200', codexScript.status, 200);
  const codexScriptText = await codexScript.text();
  check(
    'Codex 脚本独立保持 SSE 与 Unix WebSocket 并处理投递',
    (codexScript.headers.get('content-type') ?? '').includes('text/x-shellscript') &&
      ['subscriptions/listen', 'agentnet://stream', 'network_login', 'network_delivery_claim',
       'network_message_read', 'network_delivery_complete', 'network_delivery_fail',
       'websockets.unix_connect', 'turn/start', 'turn/steer', 'expectedTurnId',
       'turn/completed', 'CODEX_THREAD_ID'].every(
        (marker) => codexScriptText.includes(marker),
      ) &&
      !codexScriptText.includes('peri-watch.sh') &&
      !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(codexScriptText),
  );

  const claudeScript = await fetch(`${baseUrl()}/skills/claude-watch.sh`);
  checkEqual('GET /skills/claude-watch.sh 返回 200', claudeScript.status, 200);
  const claudeScriptType = claudeScript.headers.get('content-type') ?? '';
  const claudeScriptText = await claudeScript.text();
  const claudeScriptMarkers = [
    'AGENTNET_TOKEN',
    'subscriptions/listen',
    'agentnet://stream',
    'notifications/subscriptions/acknowledged',
    'network_login',
    'network_inbox_list',
    'network_message_read',
    'event_file',
    'action_required',
    'delivery_id',
    'READY',
    'reconnect_delay',
    '--connect-timeout',
  ];
  check(
    'Claude Code 监听脚本订阅统一流并在 ack 后登录补读',
    claudeScriptType.includes('text/x-shellscript') &&
      claudeScriptMarkers.every((marker) => claudeScriptText.includes(marker)),
    {
      contentType: claudeScriptType,
      missing: claudeScriptMarkers.filter((marker) => !claudeScriptText.includes(marker)),
    },
  );
  check(
    'Claude Code 监听脚本不包含硬编码 Bearer token',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(claudeScriptText),
  );
  const claudeEmitFoundBody =
    claudeScriptText.match(/emit_found\(\) \{([\s\S]*?)^\}/mu)?.[1] ?? '';
  check(
    'Claude Code 监听脚本输出事件后保持同一条持续监听',
    claudeEmitFoundBody.includes("printf '%s\\n'") &&
      !/\bexit\b/u.test(claudeEmitFoundBody) &&
      claudeScriptText.includes('while :; do'),
    claudeEmitFoundBody,
  );
  const claudeWriteEventBody =
    claudeScriptText.match(/write_event_file\(\) \{([\s\S]*?)^\}/mu)?.[1] ?? '';
  check(
    'Claude Code 监听脚本把完整正文写入 0600 私有事件文件',
    claudeWriteEventBody.includes('network_message_read') &&
      claudeWriteEventBody.includes('next_cursor') &&
      claudeWriteEventBody.includes('--rawfile body') &&
      claudeWriteEventBody.includes('chmod 600') &&
      claudeEmitFoundBody.includes('event_file') &&
      !claudeEmitFoundBody.includes('body:$body'),
    { claudeWriteEventBody, claudeEmitFoundBody },
  );

  const agentnetScript = await fetch(`${baseUrl()}/skills/agentnet.sh`);
  checkEqual('GET /skills/agentnet.sh 返回 200', agentnetScript.status, 200);
  const agentnetScriptType = agentnetScript.headers.get('content-type') ?? '';
  const agentnetScriptText = await agentnetScript.text();
  check(
    '通用 Agent 命令脚本可通过 /skills 下载并包含核心子命令',
    agentnetScriptType.includes('text/x-shellscript') &&
      ['login', 'send', 'reply', 'send-file', 'inbox', 'upload', 'contact-add', 'room-create', 'mark-read', 'sync', 'network_message_send', 'network_delivery_claim', 'network_delivery_complete', 'network_contact_add', 'network_room_create', 'network_room_mark_read', 'network_sync', 'network_delivery_report', 'network_room_file_bind', 'mcp-upload', 'MCPP-Files-Version', '--connect-timeout'].every(
        (marker) => agentnetScriptText.includes(marker),
      ),
    { contentType: agentnetScriptType },
  );
  check(
    '通用 Agent 命令脚本不包含硬编码 Bearer token',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(agentnetScriptText),
  );
  check(
    'agentnet reply 自动恢复投递状态并一次完成最终回复',
    ['cmd_reply', 'find_inbox_delivery', 'network_delivery_claim',
     'network_delivery_complete', 'final_body'].every((marker) =>
      agentnetScriptText.includes(marker),
    ),
  );
  check(
    'agentnet send 默认省略 invoke 并提供 --no-invoke',
    agentnetScriptText.includes('--no-invoke') &&
      agentnetScriptText.includes('群聊默认省略 invoke') &&
      agentnetScriptText.includes('if $invoke == null then {} else {invoke:$invoke} end') &&
      agentnetScriptText.includes('--no-invoke) invoke=\'[]\''),
    agentnetScriptText.slice(0, 300),
  );

  const agentTasksScript = await fetch(`${baseUrl()}/skills/agent_tasks.sh`);
  checkEqual('GET /skills/agent_tasks.sh 返回 200', agentTasksScript.status, 200);
  const agentTasksType = agentTasksScript.headers.get('content-type') ?? '';
  const agentTasksText = await agentTasksScript.text();
  check(
    '任务命令脚本可通过 /skills 下载并包含全部子命令',
    agentTasksType.includes('text/x-shellscript') &&
      ['list', 'summary', 'add', 'claim', 'complete', 'fail', 'update', 'delete'].every(
        (marker) => agentTasksText.includes(`  ${marker}`),
      ) &&
      ['network_task_list_get', 'network_task_summary', 'network_task_add',
        'network_task_claim', 'network_task_complete', 'network_task_fail',
        'network_task_update', 'network_task_delete'].every((marker) =>
        agentTasksText.includes(marker),
      ),
    { contentType: agentTasksType },
  );
  check(
    '任务命令脚本使用 Bearer、--json 与 0600 curl 配置且不轮询',
    agentTasksText.includes('Authorization: Bearer') &&
      agentTasksText.includes('--json') &&
      agentTasksText.includes('chmod 600') &&
      agentTasksText.includes('umask 077') &&
      agentTasksText.includes('不轮询') &&
      !/\bwhile true\b/u.test(agentTasksText),
    agentTasksText.slice(0, 320),
  );
  check(
    '任务命令脚本不包含硬编码 Bearer token',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(agentTasksText),
  );
  const agentTasksSyntax = Bun.spawnSync({
    cmd: ['bash', '-n', 'public/skills/agent_tasks.sh'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    'agent_tasks.sh 通过 bash -n',
    agentTasksSyntax.exitCode === 0,
    agentTasksSyntax.stderr.toString(),
  );

  const claudeGuide = await fetch(`${baseUrl()}/skills/harness-claude.md`);
  const claudeGuideText = await claudeGuide.text();
  const claudeGuideMarkers = [
    'claude-watch.sh',
    'Monitor 工具',
    'AGENTNET_TOKEN',
    'share_url',
    'event_file',
    'agentnet.sh reply',
    'network_delivery_complete.final_body',
    'network_delivery_fail',
    '10 秒',
    '简短确认',
    '持续运行',
  ];
  check(
    'Claude 指南覆盖原生 Monitor、持续监听与投递处理闭环',
    claudeGuideMarkers.every((marker) => claudeGuideText.includes(marker)),
    {
      missing: claudeGuideMarkers.filter((marker) => !claudeGuideText.includes(marker)),
    },
  );
  check(
    'Claude 指南要求原生 Monitor，不使用 MCP 客户端载入方式',
    claudeGuideText.includes('不要使用普通后台 Bash') &&
      !claudeGuideText.includes('claude mcp') &&
      !claudeGuideText.includes('.mcp.json'),
  );
  check(
    'Claude 指南只使用 token 占位符且不含 32 位以上十六进制凭据',
    claudeGuideText.includes("AGENTNET_TOKEN='<token>'") &&
      !/\b[0-9a-f]{32,}\b/iu.test(claudeGuideText),
  );

  const codexBridge = await fetch(`${baseUrl()}/skills/harness-codex.md`);
  checkEqual('GET /skills/harness-codex.md 返回 200（桥接指南）', codexBridge.status, 200);
  const codexBridgeText = await codexBridge.text();
  const codexBridgeMarkers = [
    'codex-watch.sh',
    'CODEX_THREAD_ID',
    'CODEX_READY',
    'READY',
    'AGENTNET_TOKEN',
    'share_url',
    'codex app-server daemon version',
    'websockets',
    'SSE 长连接',
    'turn/steer',
    '10 秒',
  ];
  check(
    'Codex 指南覆盖身份、启动和持续监听操作',
    codexBridgeMarkers.every((marker) => codexBridgeText.includes(marker)),
    { missing: codexBridgeMarkers.filter((marker) => !codexBridgeText.includes(marker)) },
  );
  check(
    'Codex 指南说明工作中插话、任务排队与异常时人工核对',
    codexBridgeText.includes('排队') &&
      codexBridgeText.includes('即时交给') &&
      codexBridgeText.includes('人工核对') &&
      codexBridgeText.includes('不轮询'),
  );
  check(
    'Codex 桥接指南不包含真实 token 或完整含 token URL',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(codexBridgeText) &&
      !/[?&]token=[0-9a-f]{8}-[0-9a-f]{4}/iu.test(codexBridgeText) &&
      !/\b[0-9a-f]{32,}\b/iu.test(codexBridgeText),
  );


  const browserToken = newToken();
  const browserRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: `web_reg_${crypto.randomUUID().replaceAll('-', '')}`,
        kind: 'human',
        name: '网页访客检查',
      },
    },
    { token: browserToken },
  );
  const browserIdentity = (
    browserRegister.body.result as
      | { structuredContent?: { actor_id?: string; share_url?: string | null } }
      | undefined
  )?.structuredContent;
  checkEqual('human actor 不生成 share_url', browserIdentity?.share_url, null);

  // network_me_rename：只能改自己，trim/长度/控制字符校验与 request_id 幂等。
  const selfRenameRequest = `self_rename_${crypto.randomUUID().replaceAll('-', '')}`;
  const selfRenamed = await rawToolCall<{ actor_id: string; name: string; updated_at: string }>(
    browserToken,
    'network_me_rename',
    { request_id: selfRenameRequest, name: '  协议自助改名  ' },
  );
  checkEqual('self rename 只改调用者并 trim', selfRenamed.data?.actor_id, browserIdentity?.actor_id);
  checkEqual('self rename 返回 trim 后的名称', selfRenamed.data?.name, '协议自助改名');
  const selfRenamedMe = await rawToolCall<{ name: string }>(browserToken, 'network_me', {});
  checkEqual('self rename 后 network_me 返回新名称', selfRenamedMe.data?.name, '协议自助改名');
  const selfRenameReplay = await rawToolCall<{ actor_id: string; name: string }>(
    browserToken,
    'network_me_rename',
    { request_id: selfRenameRequest, name: '  协议自助改名  ' },
  );
  checkEqual('self rename 幂等重放返回同一名称', selfRenameReplay.data?.name, '协议自助改名');
  const selfRenameConflict = await rawToolCall(
    browserToken,
    'network_me_rename',
    { request_id: selfRenameRequest, name: '另一个名字' },
  );
  checkEqual(
    'self rename 同一 request_id 改不同名称返回 IDEMPOTENCY_CONFLICT',
    selfRenameConflict.code,
    'IDEMPOTENCY_CONFLICT',
  );
  const selfRenameTargetAttempt = await rawToolCall<{ actor_id: string; name: string }>(
    browserToken,
    'network_me_rename',
    {
      request_id: `self_rename_target_${crypto.randomUUID().replaceAll('-', '')}`,
      name: '不能借工具改别人',
      actor_id: shareIdentity?.actor_id,
    },
  );
  checkEqual(
    'self rename 忽略伪造 actor_id 且仍只改自己',
    selfRenameTargetAttempt.data?.actor_id,
    browserIdentity?.actor_id,
  );
  const shareAfterTargetAttempt = await rawToolCall<{ name: string }>(shareToken, 'network_me', {});
  checkEqual(
    'self rename 不能修改其他 actor',
    shareAfterTargetAttempt.data?.name,
    '分享页检查',
  );
  for (const [label, value] of [
    ['空名称', '   '],
    ['超过 96 字符', '名'.repeat(97)],
    ['控制字符', '坏\n名'],
  ] as const) {
    const rejected = await rawToolCall(browserToken, 'network_me_rename', {
      request_id: `self_rename_bad_${crypto.randomUUID().replaceAll('-', '')}`,
      name: value,
    });
    checkEqual(`self rename 拒绝${label}`, rejected.code, 'INVALID_ARGUMENT');
    check(
      `self rename ${label}错误不回显凭据`,
      !JSON.stringify(rejected.body).includes(browserToken),
      rejected.body,
    );
  }
  const agentSelfRenamed = await rawToolCall<{ actor_id: string; name: string }>(
    shareToken,
    'network_me_rename',
    {
      request_id: `self_rename_agent_${crypto.randomUUID().replaceAll('-', '')}`,
      name: '分享页检查 Agent 自助名',
    },
  );
  checkEqual('Agent 可调用 self rename 修改自己', agentSelfRenamed.data?.name, '分享页检查 Agent 自助名');
  const agentGlobalRenamed = await rawToolCall<{ actor_id: string; name: string }>(
    browserToken,
    'network_agent_rename',
    {
      request_id: `agent_rename_compat_${crypto.randomUUID().replaceAll('-', '')}`,
      actor_id: shareIdentity?.actor_id,
      name: '分享页检查全局名',
    },
  );
  checkEqual(
    'self rename 不改变 network_agent_rename 的开放边界',
    agentGlobalRenamed.data?.name,
    '分享页检查全局名',
  );
  const humanTarget = await rawToolCall(browserToken, 'network_agent_rename', {
    request_id: `agent_rename_human_${crypto.randomUUID().replaceAll('-', '')}`,
    actor_id: browserIdentity?.actor_id,
    name: '人类不能这样改',
  });
  checkEqual(
    'network_agent_rename 仍拒绝 human 目标',
    humanTarget.code,
    'INVALID_ARGUMENT',
  );

  const browserContact = await rawRpc(
    'tools/call',
    {
      name: 'network_contact_add',
      arguments: {
        request_id: `web_contact_${crypto.randomUUID().replaceAll('-', '')}`,
        agent_session_id: shareSession,
      },
    },
    { token: browserToken },
  );
  const contactResult = (
    browserContact.body.result as
      | { structuredContent?: { contact?: { actor_id?: string } } }
      | undefined
  )?.structuredContent;
  checkEqual(
    '浏览器身份可按 agent_session_id 添加好友',
    contactResult?.contact?.actor_id,
    shareIdentity?.actor_id,
  );
  const browserRoom = await rawRpc(
    'tools/call',
    {
      name: 'network_room_create',
      arguments: {
        request_id: `web_room_${crypto.randomUUID().replaceAll('-', '')}`,
        kind: 'direct',
        members: [shareIdentity?.actor_id],
      },
    },
    { token: browserToken },
  );
  const roomResult = (
    browserRoom.body.result as
      | { structuredContent?: { room?: { kind?: string; room_id?: string } } }
      | undefined
  )?.structuredContent;
  checkEqual('浏览器身份可建立单聊', roomResult?.room?.kind, 'direct');

  // 历史页权威 sender_kind：人类消息为 human，Agent 消息为 agent。
  const historyRoomId = roomResult?.room?.room_id ?? '';
  for (const [token, name, body] of [
    [browserToken, 'network_message_send', '人类历史 sender_kind'],
    [shareToken, 'network_message_send', 'Agent 历史 sender_kind'],
  ] as const) {
    const sent = await rawRpc(
      'tools/call',
      {
        name,
        arguments: {
          request_id: `history_msg_${crypto.randomUUID().replaceAll('-', '')}`,
          client_message_id: crypto.randomUUID(),
          room_id: historyRoomId,
          body,
        },
      },
      { token },
    );
    check(
      `history fixture 写入成功（${body}）`,
      (sent.body.result as { isError?: boolean } | undefined)?.isError !== true,
      sent.body,
    );
  }
  const historyResponse = await rawRpc(
    'tools/call',
    {
      name: 'network_history_list',
      arguments: { room_id: historyRoomId, direction: 'before', limit: 50 },
    },
    { token: browserToken },
  );
  const historyResult = (
    historyResponse.body.result as
      | { structuredContent?: { items?: { sender_kind?: string | null }[] } }
      | undefined
  )?.structuredContent;
  const historyKinds = new Set((historyResult?.items ?? []).map((item) => item.sender_kind));
  check(
    'history 返回 human 与 agent 的权威 sender_kind',
    historyKinds.has('human') && historyKinds.has('agent'),
    [...historyKinds],
  );
  check(
    'history sender_kind 仅允许 human/agent/null',
    (historyResult?.items ?? []).every(
      (item) =>
        item.sender_kind === 'human' ||
        item.sender_kind === 'agent' ||
        item.sender_kind === null ||
        item.sender_kind === undefined,
    ),
    historyResult?.items?.map((item) => item.sender_kind),
  );

  // 网页监控：human + room 私有配置、URL 校验、幂等与不改变房间状态。
  const monitorBToken = newToken();
  const monitorBRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: `monitor_b_reg_${crypto.randomUUID().replaceAll('-', '')}`,
        kind: 'human',
        name: '监控成员 B',
      },
    },
    { token: monitorBToken },
  );
  const monitorB = (
    monitorBRegister.body.result as
      | { structuredContent?: { actor_id?: string } }
      | undefined
  )?.structuredContent;
  const monitorOutsiderToken = newToken();
  const monitorOutsiderRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: `monitor_c_reg_${crypto.randomUUID().replaceAll('-', '')}`,
        kind: 'human',
        name: '监控非成员 C',
      },
    },
    { token: monitorOutsiderToken },
  );
  const monitorOutsider = (
    monitorOutsiderRegister.body.result as
      | { structuredContent?: { actor_id?: string } }
      | undefined
  )?.structuredContent;
  await rawRpc(
    'tools/call',
    {
      name: 'network_contact_add',
      arguments: {
        request_id: `monitor_contact_${crypto.randomUUID().replaceAll('-', '')}`,
        actor_id: monitorB?.actor_id,
      },
    },
    { token: browserToken },
  );
  const monitorRoomResponse = await rawRpc(
    'tools/call',
    {
      name: 'network_room_create',
      arguments: {
        request_id: `monitor_room_${crypto.randomUUID().replaceAll('-', '')}`,
        kind: 'group',
        title: '监控面板协议群',
        members: [monitorB?.actor_id, shareIdentity?.actor_id],
      },
    },
    { token: browserToken },
  );
  const monitorRoomId =
    (
      monitorRoomResponse.body.result as
        | { structuredContent?: { room?: { room_id?: string } } }
        | undefined
    )?.structuredContent?.room?.room_id ?? '';
  check('监控测试群创建成功', monitorRoomId.length > 0, monitorRoomResponse.body);

  const monitorHeadBefore =
    (
      (
        await rawToolCall<{ room: { head_seq: string } }>(
          browserToken,
          'network_room_get',
          { room_id: monitorRoomId },
        )
      ).data
    )?.room.head_seq ?? '';
  const monitorPendingBefore =
    (await rawToolCall<{ pending_count: number }>(browserToken, 'network_me', {}))
      .data?.pending_count ?? -1;

  const monitorEmpty = await rawToolCall<{ monitor: unknown }>(
    browserToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual('监控 get 无配置返回 monitor:null', monitorEmpty.data?.monitor, null);

  const monitorAUrl = 'http://DSH.Example/panel?token=secret-monitor-value';
  const monitorANormalized = 'http://dsh.example/panel?token=secret-monitor-value';
  const monitorASetRequest = `monitor_set_${crypto.randomUUID().replaceAll('-', '')}`;
  const monitorASet = await rawToolCall<{
    monitor: { room_id: string; url: string; updated_at: string } | null;
  }>(browserToken, 'network_room_monitor_set', {
    request_id: monitorASetRequest,
    room_id: monitorRoomId,
    url: monitorAUrl,
  });
  checkEqual('监控 set 返回规范化 URL', monitorASet.data?.monitor?.url, monitorANormalized);
  checkEqual('监控 set 返回 room_id', monitorASet.data?.monitor?.room_id, monitorRoomId);
  check(
    '监控 set 返回 updated_at',
    typeof monitorASet.data?.monitor?.updated_at === 'string' &&
      monitorASet.data.monitor.updated_at.length > 0,
    monitorASet.data,
  );

  const monitorReplay = await rawToolCall<{ monitor: { updated_at: string } | null }>(
    browserToken,
    'network_room_monitor_set',
    {
      request_id: monitorASetRequest,
      room_id: monitorRoomId,
      url: monitorAUrl,
    },
  );
  checkEqual(
    '同一 request_id 重放返回同一结果',
    monitorReplay.data?.monitor?.updated_at,
    monitorASet.data?.monitor?.updated_at,
  );
  const monitorConflict = await rawToolCall(
    browserToken,
    'network_room_monitor_set',
    {
      request_id: monitorASetRequest,
      room_id: monitorRoomId,
      url: 'https://different.example/',
    },
  );
  checkEqual('同一 request_id 不同参数返回 IDEMPOTENCY_CONFLICT', monitorConflict.code, 'IDEMPOTENCY_CONFLICT');

  const monitorAGet = await rawToolCall<{ monitor: { url: string } | null }>(
    browserToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual('监控 get 返回本人保存的 URL', monitorAGet.data?.monitor?.url, monitorANormalized);
  const monitorBGetEmpty = await rawToolCall<{ monitor: unknown }>(
    monitorBToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual('同房间另一成员看不到 A 的 URL', monitorBGetEmpty.data?.monitor, null);
  const monitorBSet = await rawToolCall<{ monitor: { url: string } | null }>(
    monitorBToken,
    'network_room_monitor_set',
    {
      request_id: `monitor_b_set_${crypto.randomUUID().replaceAll('-', '')}`,
      room_id: monitorRoomId,
      url: 'https://b.example/panel',
    },
  );
  checkEqual('另一成员可保存自己的 URL', monitorBSet.data?.monitor?.url, 'https://b.example/panel');
  const monitorAGetAgain = await rawToolCall<{ monitor: { url: string } | null }>(
    browserToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual(
    '其他成员写入不覆盖 A 的配置',
    monitorAGetAgain.data?.monitor?.url,
    monitorANormalized,
  );

  const monitorAgentGet = await rawToolCall(
    shareToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual('Agent 读取监控配置返回 INVALID_ARGUMENT', monitorAgentGet.code, 'INVALID_ARGUMENT');
  const monitorAgentSet = await rawToolCall(
    shareToken,
    'network_room_monitor_set',
    {
      request_id: `monitor_agent_${crypto.randomUUID().replaceAll('-', '')}`,
      room_id: monitorRoomId,
      url: 'https://agent.example/',
    },
  );
  checkEqual('Agent 写入监控配置返回 INVALID_ARGUMENT', monitorAgentSet.code, 'INVALID_ARGUMENT');

  const monitorOutsiderGet = await rawToolCall(
    monitorOutsiderToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual('非成员读取监控配置返回 NOT_MEMBER', monitorOutsiderGet.code, 'NOT_MEMBER');
  const monitorOutsiderSet = await rawToolCall(
    monitorOutsiderToken,
    'network_room_monitor_set',
    {
      request_id: `monitor_out_${crypto.randomUUID().replaceAll('-', '')}`,
      room_id: monitorRoomId,
      url: 'https://outsider.example/',
    },
  );
  checkEqual('非成员写入监控配置返回 NOT_MEMBER', monitorOutsiderSet.code, 'NOT_MEMBER');
  const monitorUnknown = await rawToolCall(browserToken, 'network_room_monitor_get', {
    room_id: 'rm_missing_monitor',
  });
  checkEqual('未知房间读取监控配置返回 NOT_FOUND', monitorUnknown.code, 'NOT_FOUND');

  for (const invalidUrl of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/panel',
    '/relative-panel',
  ]) {
    const invalid = await rawToolCall(browserToken, 'network_room_monitor_set', {
      request_id: `monitor_invalid_${crypto.randomUUID().replaceAll('-', '')}`,
      room_id: monitorRoomId,
      url: invalidUrl,
    });
    checkEqual(`监控拒绝非 http/https URL：${invalidUrl.slice(0, 24)}`, invalid.code, 'INVALID_ARGUMENT');
  }
  const monitorTooManyBytes = await rawToolCall(browserToken, 'network_room_monitor_set', {
    request_id: `monitor_bytes_${crypto.randomUUID().replaceAll('-', '')}`,
    room_id: monitorRoomId,
    url: `https://example.com/${'你'.repeat(1000)}`,
  });
  checkEqual('监控拒绝超过字节上限的 URL', monitorTooManyBytes.code, 'INVALID_ARGUMENT');
  const monitorTooManyChars = await rawToolCall(browserToken, 'network_room_monitor_set', {
    request_id: `monitor_chars_${crypto.randomUUID().replaceAll('-', '')}`,
    room_id: monitorRoomId,
    url: `https://example.com/${'a'.repeat(2049)}`,
  });
  const monitorTooManyCharsResult = monitorTooManyChars.body.result as
    | { isError?: boolean; content?: { type?: string; text?: string }[] }
    | undefined;
  const monitorTooManyCharsText =
    monitorTooManyCharsResult?.content?.find((item) => item.type === 'text')?.text ?? '';
  check(
    '监控超长 URL 在 schema 层被拒绝',
    monitorTooManyCharsResult?.isError === true &&
      (monitorTooManyCharsText.includes('2048') || monitorTooManyCharsText.includes('Too big')),
    monitorTooManyCharsText,
  );

  const monitorClearRequest = `monitor_clear_${crypto.randomUUID().replaceAll('-', '')}`;
  const monitorClear = await rawToolCall<{ monitor: unknown }>(
    browserToken,
    'network_room_monitor_set',
    {
      request_id: monitorClearRequest,
      room_id: monitorRoomId,
      url: null,
    },
  );
  checkEqual('监控 set null 清除配置', monitorClear.data?.monitor, null);
  const monitorClearReplay = await rawToolCall<{ monitor: unknown }>(
    browserToken,
    'network_room_monitor_set',
    {
      request_id: monitorClearRequest,
      room_id: monitorRoomId,
      url: null,
    },
  );
  checkEqual('清除配置可用同一 request_id 重放', monitorClearReplay.data?.monitor, null);
  const monitorAfterClear = await rawToolCall<{ monitor: unknown }>(
    browserToken,
    'network_room_monitor_get',
    { room_id: monitorRoomId },
  );
  checkEqual('清除后 get 返回 monitor:null', monitorAfterClear.data?.monitor, null);
  const monitorWhitespaceClear = await rawToolCall<{ monitor: unknown }>(
    browserToken,
    'network_room_monitor_set',
    {
      request_id: `monitor_ws_${crypto.randomUUID().replaceAll('-', '')}`,
      room_id: monitorRoomId,
      url: '   ',
    },
  );
  checkEqual('纯空白 URL 视为清除', monitorWhitespaceClear.data?.monitor, null);
  await rawToolCall(browserToken, 'network_room_monitor_set', {
    request_id: `monitor_refill_${crypto.randomUUID().replaceAll('-', '')}`,
    room_id: monitorRoomId,
    url: monitorAUrl,
  });

  const monitorNoAuth = await rawToolCall(null, 'network_room_monitor_get', {
    room_id: monitorRoomId,
  });
  checkEqual('无凭据读取监控配置返回 CREDENTIAL_INVALID', monitorNoAuth.code, 'CREDENTIAL_INVALID');
  const monitorNoAuthSet = await rawToolCall(null, 'network_room_monitor_set', {
    request_id: `monitor_noauth_${crypto.randomUUID().replaceAll('-', '')}`,
    room_id: monitorRoomId,
    url: monitorAUrl,
  });
  checkEqual('无凭据写入监控配置返回 CREDENTIAL_INVALID', monitorNoAuthSet.code, 'CREDENTIAL_INVALID');

  const monitorHeadAfter =
    (
      (
        await rawToolCall<{ room: { head_seq: string } }>(
          browserToken,
          'network_room_get',
          { room_id: monitorRoomId },
        )
      ).data
    )?.room.head_seq ?? '';
  checkEqual('监控配置不改变房间 head_seq', monitorHeadAfter, monitorHeadBefore);
  const monitorPendingAfter =
    (await rawToolCall<{ pending_count: number }>(browserToken, 'network_me', {}))
      .data?.pending_count ?? -2;
  checkEqual('监控配置不改变 pending_count', monitorPendingAfter, monitorPendingBefore);

  const monitorShell = await fetch(`${baseUrl()}/c/${monitorRoomId}`);
  const monitorShellHtml = await monitorShell.text();
  checkEqual('无 token 的聊天页仍返回 200', monitorShell.status, 200);
  check(
    '无 token 的 HTML 不包含已保存 URL',
    !monitorShellHtml.includes(monitorANormalized) &&
      !monitorShellHtml.includes('secret-monitor-value'),
  );

  const chatPage = await fetch(`${baseUrl()}/c/${roomResult?.room?.room_id ?? ''}`);
  checkEqual('单聊页 GET 返回 200', chatPage.status, 200);
  check(
    '单聊页 Content-Type 为 text/html',
    (chatPage.headers.get('content-type') ?? '').includes('text/html'),
    chatPage.headers.get('content-type'),
  );
  const chatHtml = await chatPage.text();
  check('单聊页包含 room_id', chatHtml.includes(roomResult?.room?.room_id ?? '\u0000'));
  check('单聊页包含会话列表容器', chatHtml.includes('id="room-list"'));
  check('单聊页包含消息输入框', chatHtml.includes('id="composer"'));
  check('单聊页包含改名入口', chatHtml.includes('id="rename"'));
  check('单聊页包含 @ 成员选择器', chatHtml.includes('id="mention-picker"'));
  check('单聊页包含手机扫码入口', chatHtml.includes('id="device-handoff"'));
  check('单聊页订阅统一 stream', chatHtml.includes('agentnet://stream'));
  check(
    '单聊页头部按成员 online 渲染在线状态',
    chatHtml.includes('presenceLabel(peer.online)'),
  );
  check(
    '单聊页回执包含 claimed 超时提示',
    chatHtml.includes('CLAIM_STALE_MS') && chatHtml.includes('处理中未更新'),
  );

  const getResponse = await fetch(`${baseUrl()}/mcp`);
  checkEqual('GET /mcp 返回 405', getResponse.status, 405);
  check('GET /mcp 声明 Allow: POST', (getResponse.headers.get('allow') ?? '').includes('POST'), getResponse.headers.get('allow'));

  const deleteResponse = await fetch(`${baseUrl()}/mcp`, { method: 'DELETE' });
  checkEqual('DELETE /mcp 返回 405', deleteResponse.status, 405);

  const unregistered = newToken();
  const connection = await connectClient(unregistered);
  try {
    const tools = await connection.client.listTools();
    const sdkToolCount =
      coreToolNames.length +
      (tools.tools.some((tool) => tool.name === 'drive_file_info') ? 1 : 0) +
      (tools.tools.some((tool) => tool.name === 'network_room_file_bind') ? roomFileTools.length : 0);
    checkEqual('官方 SDK 可通过 server/discover 建连', tools.tools.length, sdkToolCount);
    await expectToolError('未注册凭据调用 network_me 返回 CREDENTIAL_INVALID', callTool(connection.client, 'network_me'), 'CREDENTIAL_INVALID');
    await expectToolError(
      '未注册凭据调用 network_login 返回 CREDENTIAL_INVALID',
      callTool(connection.client, 'network_login'),
      'CREDENTIAL_INVALID',
    );

    const listen = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI] } },
      { token: unregistered },
    );
    const listenError = listen.body.error as Record<string, unknown> | undefined;
    checkEqual('未注册身份建立订阅被拒绝', listenError?.code, -32602);
    const listenData = listenError?.data as Record<string, unknown> | undefined;
    checkEqual('订阅拒绝返回 CREDENTIAL_INVALID', listenData?.code, 'CREDENTIAL_INVALID');
  } finally {
    await connection.close();
  }

  const anonymous = new Client(
    { name: 'protocol-anonymous', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await anonymous.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl()}/mcp`)));
  try {
    await expectToolError(
      '无 Authorization 调用 network_me 返回 CREDENTIAL_INVALID',
      callTool(anonymous, 'network_me'),
      'CREDENTIAL_INVALID',
    );
  } finally {
    await anonymous.close();
  }

  if (!secondToken) throw new Error('missing registered agent token');
  await runStreamProtocolChecks(secondToken, newAgentIdentity?.actor_id);
  await runAgentPresenceUnitChecks();
  await runFeedbackUnitChecks();
  await runFeedbackCliChecks();

  console.log(`协议验收通过: ${checksPassed()} 项`);
}

await main().catch((error) => {
  console.error('协议验收失败:', error);
  process.exit(1);
});
