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
import { runDeliveryReminderUnitChecks } from './lib/delivery-reminder-unit';
import { runDeliverySenderUnitChecks } from './lib/delivery-sender-unit';
import { runRoomInviteReplayUnitChecks } from './lib/room-invite-replay-unit';
import { runOwnerlessRoomUnitChecks } from './lib/ownerless-room-unit';

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
    'network_client_guide',
    'network_me_rename',
    'network_login',
    'network_profile_update',
    'network_agent_create',
    'network_agent_management_get',
    'network_agents_managed_list',
    'network_agent_claim_start',
    'network_agent_claim_confirm',
    'network_agent_claim_cancel',
    'network_agent_delegate_grant',
    'network_agent_delegate_revoke',
    'network_agent_disable',
    'network_agent_enable',
    'network_agent_transfer_propose',
    'network_agent_transfer_respond',
    'network_agent_transfer_cancel',
    'network_agent_transfer_get',
    'network_agent_transfer_list',
    'network_agent_rename',
    'network_agent_reissue_token',
    'network_agent_archive',
    'network_agent_unarchive',
    'network_agents_get',
    'network_feedback_create',
    'network_recovery_create',
    'network_recovery_redeem',
    'network_device_pairing_create',
    'network_device_pairing_join',
    'network_device_pairing_list',
    'network_device_pairing_approve',
    'network_device_pairing_cancel',
    'network_device_pairing_redeem',
    'network_device_list',
    'network_device_revoke',
    'network_contacts_list',
    'network_contact_add',
    'network_contact_remove',
    'network_contact_request',
    'network_contact_requests_list',
    'network_contact_request_respond',
    'network_contact_request_cancel',
    'network_contact_link_create',
    'network_contact_link_preview',
    'network_contact_link_redeem',
    'network_contact_link_list',
    'network_contact_link_revoke',
    'network_contact_policy_get',
    'network_contact_policy_set',
    'network_contact_block',
    'network_contact_unblock',
    'network_contact_blocks_list',
    'network_contact_report',
    'network_contact_reports_list',
    'network_room_create',
    'network_rooms_list',
    'network_room_get',
    'network_room_invite_get',
    'network_room_invite_create',
    'network_room_invite_revoke',
    'network_room_invite_respond',
    'network_room_join_request_list',
    'network_room_join_request_respond',
    'network_room_monitor_get',
    'network_room_monitor_set',
    'network_task_mark',
    'network_task_unmark',
    'network_task_summaries',
    'network_task_trace',
    'network_task_search',
    'network_room_members_update',
    'network_room_role_set',
    'network_room_owner_transfer',
    'network_room_owner_transfer_propose',
    'network_room_owner_transfer_respond',
    'network_room_owner_transfer_cancel',
    'network_room_policy_set',
    'network_room_rename',
    'network_room_announcement_set',
    'network_room_role_history',
    'network_room_notice_list',
    'network_room_leave_preview',
    'network_room_leave',
    'network_room_dissolve',
    'network_message_send',
    'network_message_search',
    'network_message_context',
    'network_message_recall',
    'network_message_send_status',
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
    'network_file_publish',
    'network_artifact_submit',
    'network_artifact_list',
    'network_artifact_release',
  ];
  const toolNames = listed?.tools?.map((tool) => tool.name) ?? [];
  // 工具集随 drive 开关变化：核心工具 + info/upload_prepare + 文件/成果工具。
  const hasDrive = toolNames.includes('drive_file_info');
  const hasRoomFiles = roomFileTools.every((name) => toolNames.includes(name));
  check(
    '房间文件工具与 drive 开关一起注册',
    hasRoomFiles === hasDrive,
    roomFileTools.filter((name) => toolNames.includes(name)),
  );
  const expectedToolCount =
    coreToolNames.length + (hasDrive ? 2 : 0) + (hasRoomFiles ? roomFileTools.length : 0);
  check(`tools/list 返回 ${expectedToolCount} 个工具`, toolNames.length === expectedToolCount, toolNames.length);
  const requiredCoreTools = [
    'network_issue_token',
    'network_register',
    'network_me',
    'network_client_guide',
    'network_me_rename',
    'network_login',
    'network_agent_create',
    'network_agent_management_get',
    'network_agents_managed_list',
    'network_agent_claim_start',
    'network_agent_claim_confirm',
    'network_agent_claim_cancel',
    'network_agent_delegate_grant',
    'network_agent_delegate_revoke',
    'network_agent_disable',
    'network_agent_enable',
    'network_agent_transfer_propose',
    'network_agent_transfer_respond',
    'network_agent_transfer_cancel',
    'network_agent_transfer_get',
    'network_agent_transfer_list',
    'network_agent_rename',
    'network_agent_reissue_token',
    'network_agent_archive',
    'network_agent_unarchive',
    'network_agents_get',
    'network_feedback_create',
    'network_device_pairing_create',
    'network_device_pairing_join',
    'network_device_pairing_list',
    'network_device_pairing_approve',
    'network_device_pairing_cancel',
    'network_device_pairing_redeem',
    'network_device_list',
    'network_device_revoke',
    'network_message_send',
    'network_message_search',
    'network_message_context',
    'network_message_recall',
    'network_message_send_status',
    'network_room_monitor_get',
    'network_room_monitor_set',
    'network_room_invite_create',
    'network_room_invite_revoke',
    'network_room_join_request_list',
    'network_room_join_request_respond',
    'network_room_owner_transfer_propose',
    'network_room_owner_transfer_respond',
    'network_room_owner_transfer_cancel',
    'network_room_leave_preview',
    'network_room_dissolve',
    'network_task_mark',
    'network_task_unmark',
    'network_task_summaries',
    'network_task_trace',
    'network_task_search',
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
  const deviceDescription = (name: string): string =>
    String(listed?.tools?.find((tool) => tool.name === name)?.description ?? '');
  check(
    '设备配对 create 描述声明 5 分钟一次性挑战且不含 token',
    deviceDescription('network_device_pairing_create').includes('5 分钟') &&
      deviceDescription('network_device_pairing_create').includes('一次性') &&
      deviceDescription('network_device_pairing_create').includes('不包含当前 token'),
    deviceDescription('network_device_pairing_create'),
  );
  check(
    '设备配对 join 描述声明不返回 token 且第三设备不能抢绑',
    deviceDescription('network_device_pairing_join').includes('不返回 token') &&
      deviceDescription('network_device_pairing_join').includes('第三台设备'),
    deviceDescription('network_device_pairing_join'),
  );
  check(
    '设备配对 redeem 描述声明响应不返回 token',
    deviceDescription('network_device_pairing_redeem').includes('从不返回 token') &&
      deviceDescription('network_device_pairing_redeem').includes('同一 request_id'),
    deviceDescription('network_device_pairing_redeem'),
  );
  check(
    '设备撤销描述声明只影响单设备并关闭 stream',
    deviceDescription('network_device_revoke').includes('撤销该设备的全部有效 credentials') &&
      deviceDescription('network_device_revoke').includes('stream') &&
      deviceDescription('network_device_revoke').includes('不影响其他设备'),
    deviceDescription('network_device_revoke'),
  );
  const contactLinkCreateTool = listed?.tools?.find(
    (tool) => tool.name === 'network_contact_link_create',
  );
  const contactLinkCreateInput = contactLinkCreateTool?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  const contactLinkCreateOutput = contactLinkCreateTool?.outputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  check(
    '好友链接 create 描述声明一次性、24 小时、摘要与不可重放',
    deviceDescription('network_contact_link_create').includes('一次性') &&
      deviceDescription('network_contact_link_create').includes('24 小时') &&
      deviceDescription('network_contact_link_create').includes('SHA-256') &&
      deviceDescription('network_contact_link_create').includes('TOKEN_NOT_REPLAYABLE') &&
      deviceDescription('network_contact_link_create').includes('QUOTA_EXCEEDED'),
    deviceDescription('network_contact_link_create'),
  );
  check(
    '好友链接 create 输入只接受 request_id/expires_in_ms，输出含 link/share_url',
    Object.keys(contactLinkCreateInput?.properties ?? {}).sort().join(',') ===
      'expires_in_ms,request_id' &&
      Object.keys(contactLinkCreateOutput?.properties ?? {}).sort().join(',') ===
        'link,share_url' &&
      !JSON.stringify(contactLinkCreateOutput ?? {}).includes('token_hash'),
    contactLinkCreateOutput,
  );
  const contactLinkPreviewTool = listed?.tools?.find(
    (tool) => tool.name === 'network_contact_link_preview',
  );
  const contactLinkPreviewInput = contactLinkPreviewTool?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  const contactLinkPreviewOutput = contactLinkPreviewTool?.outputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  check(
    '好友链接 preview 无需身份且只返回可用状态',
    deviceDescription('network_contact_link_preview').includes('无需已注册身份') &&
      deviceDescription('network_contact_link_preview').includes('不创建身份') &&
      Object.keys(contactLinkPreviewInput?.properties ?? {}).sort().join(',') === 'token' &&
      Object.keys(contactLinkPreviewOutput?.properties ?? {}).sort().join(',') ===
        'expires_at,owner,reason,status,valid' &&
      !JSON.stringify(contactLinkPreviewOutput ?? {}).includes('token_hash'),
    contactLinkPreviewTool,
  );
  check(
    '好友链接 redeem 描述声明直接建联与明确错误',
    deviceDescription('network_contact_link_redeem').includes('invite_link') &&
      deviceDescription('network_contact_link_redeem').includes('不创建 pending') &&
      deviceDescription('network_contact_link_redeem').includes('BLOCKED') &&
      deviceDescription('network_contact_link_redeem').includes('already_friends') &&
      deviceDescription('network_contact_link_redeem').includes('CONTACT_LINK_INVALID'),
    deviceDescription('network_contact_link_redeem'),
  );
  check(
    '好友链接 revoke/list 描述声明 owner-only 与不返回明文',
    deviceDescription('network_contact_link_revoke').includes('只有 owner') &&
      deviceDescription('network_contact_link_list').includes('从不返回 token') &&
      deviceDescription('network_contact_link_list').includes('token_hash'),
    deviceDescription('network_contact_link_revoke'),
  );
  const syncTool = listed?.tools?.find((tool) => tool.name === 'network_sync');
  const syncOutput = syncTool?.outputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  check(
    'network_sync 输出声明 head_cursor',
    Boolean(syncOutput?.properties && 'head_cursor' in syncOutput.properties),
    syncOutput?.properties,
  );
  if (hasDrive) {
    for (const required of ['drive_file_info', 'network_file_upload_prepare', ...roomFileTools]) {
      check(`工具 ${required} 已注册`, toolNames.includes(required), toolNames);
    }
    const driveTool = listed?.tools?.find((tool) => tool.name === 'drive_file_info');
    check(
      'drive_file_info 描述声明上传默认私有、裸链接 404、需票据读取',
      typeof driveTool?.description === 'string' &&
        driveTool.description.includes('本地路径') &&
        driveTool.description.includes('file://') &&
        driveTool.description.includes('POST /mcp-upload') &&
        driveTool.description.includes('publicUrl') &&
        driveTool.description.includes('私有草稿') &&
        driveTool.description.includes('返回 404') &&
        driveTool.description.includes('network_room_file_bind') &&
        driveTool.description.includes('network_file_publish') &&
        driveTool.description.includes('previewUrl') &&
        driveTool.description.includes('downloadUrl') &&
        !driveTool.description.includes('分享文件必须') &&
        !driveTool.description.includes('移出房间后已分享'),
      driveTool?.description,
    );
    const bindTool = listed?.tools?.find((tool) => tool.name === 'network_room_file_bind');
    check(
      'room_file_bind 描述声明私有草稿、按历史边界授权、裸 public_url 404',
      typeof bindTool?.description === 'string' &&
        bindTool.description.includes('未过期') &&
        bindTool.description.includes('public_url') &&
        bindTool.description.includes('preview_url') &&
        bindTool.description.includes('download_url') &&
        bindTool.description.includes('私有草稿') &&
        bindTool.description.includes('历史边界') &&
        bindTool.description.includes('network_file_publish') &&
        bindTool.description.includes('立即失效') &&
        !bindTool.description.includes('文件移出房间'),
      bindTool?.description,
    );
  } else {
    check(
      '关闭 Drive 时不注册 drive_file_info 与房间文件工具',
      !toolNames.includes('drive_file_info') && !toolNames.includes('network_file_upload_prepare') &&
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
  const sendStatusTool = listed?.tools?.find(
    (tool) => tool.name === 'network_message_send_status',
  ) as
    | {
        name: string;
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
        annotations?: { readOnlyHint?: boolean };
      }
    | undefined;
  check(
    'message_send_status 只读对账且不返回正文',
    sendStatusTool?.annotations?.readOnlyHint === true &&
      typeof sendStatusTool.description === 'string' &&
      sendStatusTool.description.includes('client_message_id') &&
      sendStatusTool.description.includes('对账') &&
      sendStatusTool.description.includes('不返回正文') &&
      JSON.stringify(sendStatusTool.inputSchema ?? {}).includes('client_message_ids') &&
      JSON.stringify(sendStatusTool.outputSchema ?? {}).includes('"found"') &&
      !JSON.stringify(sendStatusTool.outputSchema ?? {}).includes('"preview"'),
    sendStatusTool,
  );
  check(
    'message_send 描述声明 claim 不改变投递状态',
    typeof sendTool?.description === 'string' &&
      sendTool.description.includes('不改变投递状态'),
    sendTool?.description,
  );
  check(
    'message_send 描述声明 actor_id 显式派活与正文唯一精确兜底',
    typeof sendTool?.description === 'string' &&
      sendTool.description.includes('actor_id') &&
      sendTool.description.includes('invoke: []') &&
      sendTool.description.includes('不再解析正文') &&
      sendTool.description.includes('mentions') &&
      sendTool.description.includes('只生成个人提醒') &&
      sendTool.description.includes('去掉代码/引用/附件 URL') &&
      sendTool.description.includes('唯一精确匹配') &&
      sendTool.description.includes('同名成员') &&
      sendTool.description.includes('不会自动唤醒') &&
      sendTool.description.includes('@所有人') &&
      sendTool.description.includes('claim'),
    sendTool?.description,
  );
  check(
    'message_send 输入 schema 包含 mentions 且声明最多 8 个',
    (() => {
      const schema = JSON.stringify(sendTool?.inputSchema ?? {});
      return (
        schema.includes('"mentions"') &&
        (sendTool?.description ?? '').includes('最多 8 个')
      );
    })(),
    sendTool?.inputSchema,
  );
  check(
    '消息输出 schema 包含结构化 mentions 来源',
    ['"mentions"', '"source"', '"explicit"', '"text"', '"all"'].every((marker) =>
      JSON.stringify(sendTool?.outputSchema ?? {}).includes(marker),
    ),
    sendTool?.outputSchema,
  );
  check(
    'message_send 描述声明上传默认私有、绑定后须用带票据地址',
    typeof sendTool?.description === 'string' &&
      sendTool.description.includes('本地路径') &&
      sendTool.description.includes('file://') &&
      sendTool.description.includes('POST /mcp-upload') &&
      sendTool.description.includes('publicUrl') &&
      sendTool.description.includes('私有草稿') &&
      sendTool.description.includes('network_file_publish') &&
      sendTool.description.includes('network_room_file_bind') &&
      sendTool.description.includes('房间文件列表') &&
      sendTool.description.includes('带票据') &&
      sendTool.description.includes('preview_url') &&
      sendTool.description.includes('download_url') &&
      !sendTool.description.includes('未绑定的文件保持公开') &&
      !sendTool.description.includes('分享文件先'),
    sendTool?.description,
  );
  const roomGetTool = listed?.tools?.find((tool) => tool.name === 'network_room_get');
  check(
    'room_get 输出 schema 包含成员 online',
    JSON.stringify(roomGetTool?.outputSchema ?? {}).includes('"online"'),
    roomGetTool?.outputSchema,
  );
  check(
    'room_get 输出 schema 包含 owner_transfer 待确认提议',
    JSON.stringify(roomGetTool?.outputSchema ?? {}).includes('"owner_transfer"'),
    roomGetTool?.outputSchema,
  );
  check(
    'room_get 输出 schema 包含解散归档与退群能力',
    ['"status"', '"dissolved_at"', '"archived_head_seq"', '"owner_missing"', '"read_only"', '"can_leave"', '"can_dissolve"'].every(
      (marker) => JSON.stringify(roomGetTool?.outputSchema ?? {}).includes(marker),
    ),
    roomGetTool?.outputSchema,
  );
  const leavePreviewTool = listed?.tools?.find(
    (tool) => tool.name === 'network_room_leave_preview',
  );
  check(
    'room_leave_preview 输出包含投递计数与转移要求',
    ['"pending_deliveries"', '"claimed_deliveries"', '"owner_transfer_required"'].every(
      (marker) => JSON.stringify(leavePreviewTool?.outputSchema ?? {}).includes(marker),
    ) &&
      !JSON.stringify(leavePreviewTool?.outputSchema ?? {}).includes('"in_flight_tasks"'),
    leavePreviewTool?.outputSchema,
  );
  const dissolveTool = listed?.tools?.find((tool) => tool.name === 'network_room_dissolve');
  check(
    'room_dissolve 输出包含归档边界与投递取消计数',
    ['"archived_head_seq"', '"archive_member_seq"', '"cancelled_deliveries"'].every(
      (marker) => JSON.stringify(dissolveTool?.outputSchema ?? {}).includes(marker),
    ) &&
      !JSON.stringify(dissolveTool?.outputSchema ?? {}).includes('"cancelled_tasks"'),
    dissolveTool?.outputSchema,
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
  check(
    'history 输出 schema 包含消息式 Task 归属',
    historySchema.includes('"task_root_id"'),
    historyTool?.outputSchema,
  );

  interface TaskToolView {
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
    };
  }
  const taskMarkTool = listed?.tools?.find((tool) => tool.name === 'network_task_mark') as
    | TaskToolView
    | undefined;
  const taskUnmarkTool = listed?.tools?.find((tool) => tool.name === 'network_task_unmark') as
    | TaskToolView
    | undefined;
  const taskSummariesTool = listed?.tools?.find(
    (tool) => tool.name === 'network_task_summaries',
  ) as TaskToolView | undefined;
  const taskTraceTool = listed?.tools?.find((tool) => tool.name === 'network_task_trace') as
    | TaskToolView
    | undefined;
  const taskSearchTool = listed?.tools?.find((tool) => tool.name === 'network_task_search') as
    | TaskToolView
    | undefined;
  const taskMarkInput = JSON.stringify(taskMarkTool?.inputSchema ?? {});
  const taskMarkOutput = JSON.stringify(taskMarkTool?.outputSchema ?? {});
  const taskUnmarkOutput = JSON.stringify(taskUnmarkTool?.outputSchema ?? {});
  const taskSummariesInput = JSON.stringify(taskSummariesTool?.inputSchema ?? {});
  const taskTraceInput = JSON.stringify(taskTraceTool?.inputSchema ?? {});
  const taskTraceOutput = JSON.stringify(taskTraceTool?.outputSchema ?? {});
  const taskSearchInput = JSON.stringify(taskSearchTool?.inputSchema ?? {});
  const taskSearchOutput = JSON.stringify(taskSearchTool?.outputSchema ?? {});

  check(
    'task_mark 可写、幂等且输入输出契约完整',
    taskMarkTool?.annotations?.readOnlyHint === false &&
      taskMarkTool?.annotations?.idempotentHint === true &&
      ['request_id', 'room_id', 'message_id'].every((key) =>
        taskMarkInput.includes(`"${key}"`),
      ) &&
      ['task_root_id', 'marked'].every((key) => taskMarkOutput.includes(`"${key}"`)) &&
      (taskMarkTool?.description ?? '').includes('任意') &&
      (taskMarkTool?.description ?? '').includes('幂等') &&
      (taskMarkTool?.description ?? '').includes('不写 inbox'),
    taskMarkTool,
  );
  check(
    'task_unmark 可写、幂等且保留消息',
    taskUnmarkTool?.annotations?.readOnlyHint === false &&
      taskUnmarkTool?.annotations?.idempotentHint === true &&
      taskUnmarkOutput.includes('"task_root_id"') &&
      taskUnmarkOutput.includes('"marked"') &&
      (taskUnmarkTool?.description ?? '').includes('消息') &&
      (taskUnmarkTool?.description ?? '').includes('幂等'),
    taskUnmarkTool,
  );
  check(
    'task_summaries 只读且最多 20 个根',
    taskSummariesTool?.annotations?.readOnlyHint === true &&
      taskSummariesInput.includes('"room_id"') &&
      taskSummariesInput.includes('"root_message_ids"') &&
      taskSummariesInput.includes('"maxItems":20') &&
      JSON.stringify(taskSummariesTool?.outputSchema ?? {}).includes('"participant_count"'),
    taskSummariesTool,
  );
  check(
    'task_trace 只读且包含双向游标与 focus 契约',
    taskTraceTool?.annotations?.readOnlyHint === true &&
      ['root_message_id', 'cursor', 'focus_message_id', 'limit'].every((key) =>
        taskTraceInput.includes(`"${key}"`),
      ) &&
      [
        'next_cursor',
        'prev_cursor',
        'has_more_before',
        'has_more_after',
        'message_count',
        'focus_message_id',
        'authorization',
      ].every((key) => taskTraceOutput.includes(`"${key}"`)),
    taskTraceTool,
  );
  check(
    'task_search 只读且按起点聚合、返回 truncated',
    taskSearchTool?.annotations?.readOnlyHint === true &&
      taskSearchInput.includes('"query"') &&
      ['hit_count', 'matches', 'truncated', 'snapshot'].every((key) =>
        taskSearchOutput.includes(`"${key}"`),
      ) &&
      (taskSearchTool?.description ?? '').includes('按起点聚合') &&
      (taskSearchTool?.description ?? '').includes('普通 network_message_search 契约保持不变'),
    taskSearchTool,
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
  const newTaskToolNames = [
    'network_task_mark',
    'network_task_unmark',
    'network_task_summaries',
    'network_task_trace',
    'network_task_search',
  ];
  const retiredTaskToolNames = [
    'network_task_summary',
    'network_task_list',
    'network_task_get',
    'network_task_create',
    'network_task_offer',
    'network_task_accept',
    'network_task_decline',
    'network_task_claim',
    'network_task_cancel',
    'network_task_retry',
    'network_task_execution_unknown',
    'network_task_execution_resolve',
    'network_task_progress',
    'network_task_block',
    'network_task_resume',
    'network_task_transfer_propose',
    'network_task_transfer_accept',
    'network_task_transfer_reject',
    'network_task_transfer_cancel',
    'network_task_transfer_get',
    'network_task_transfer_list',
    'network_task_handoff_pack_create',
    'network_task_handoff_pack_get',
    'network_task_handoff_pack_authorize',
    'network_task_handoff_pack_request_more',
    'network_task_submit',
    'network_task_submission_get',
    'network_task_submission_list',
    'network_task_submission_return',
    'network_task_review_accept',
    'network_task_review_return',
    'network_task_reviewer_set',
  ];
  check(
    '新旧任务工具边界：只注册 5 个消息式 Task 工具',
    newTaskToolNames.every((name) => taskTools.has(name)) &&
      taskTools.size === newTaskToolNames.length &&
      retiredTaskToolNames.every((name) => !taskTools.has(name)),
    [...taskTools.keys()],
  );
  const loginTool = listed?.tools?.find((tool) => tool.name === 'network_login');
  const loginOutputSchema = JSON.stringify(loginTool?.outputSchema ?? {});
  const loginDescription = loginTool?.description ?? '';
  check(
    'network_login 输出不再包含旧 task_summary',
    !loginOutputSchema.includes('"task_summary"') &&
      loginOutputSchema.includes('"pending_count"') &&
      loginOutputSchema.includes('"inbox_head_seq"'),
    loginTool?.outputSchema,
  );
  check(
    'network_login 描述不再承诺任务概览',
    !loginDescription.includes('task_summary') &&
      loginDescription.includes('pending_count') &&
      loginDescription.includes('不改变'),
    loginDescription,
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
      reissueDescription.includes('active manager') &&
      reissueDescription.includes('PERMISSION_DENIED'),
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

  // A06：管理权交接的工具面、双边确认与一次性 token 语义。
  const proposeTool = listed?.tools?.find(
    (tool) => tool.name === 'network_agent_transfer_propose',
  );
  const proposeDescription = proposeTool?.description ?? '';
  check(
    'transfer_propose 描述声明 active manager 与唯一 pending',
    proposeDescription.includes('active manager') &&
      proposeDescription.includes('同一 Agent 只允许一条 pending') &&
      proposeDescription.includes('不创建 Agent delivery') &&
      proposeDescription.includes('不改变管理权'),
    proposeTool?.description,
  );
  const respondTool = listed?.tools?.find(
    (tool) => tool.name === 'network_agent_transfer_respond',
  );
  const respondDescription = respondTool?.description ?? '';
  check(
    'transfer_respond 描述声明 token 只出现一次且重放不复用',
    respondDescription.includes('新 token 只在首次 accept 响应出现一次') &&
      respondDescription.includes('token 为 null') &&
      respondDescription.includes('不会再次轮换') &&
      respondDescription.includes('CREDENTIAL_INVALID'),
    respondTool?.description,
  );
  const respondInput = JSON.stringify(respondTool?.inputSchema ?? {});
  check(
    'transfer_respond 输入要求 decision accept/reject',
    respondInput.includes('"accept"') && respondInput.includes('"reject"'),
    respondTool?.inputSchema,
  );
  const respondOutput = JSON.stringify(respondTool?.outputSchema ?? {});
  check(
    'transfer_respond 输出含可空 token 与凭据变更摘要，不含旧任务字段',
    respondOutput.includes('"token"') &&
      respondOutput.includes('"mcp_url"') &&
      respondOutput.includes('"revoked_credentials"') &&
      !respondOutput.includes('"blocked_task_ids"') &&
      !respondOutput.includes('"unassigned_task_ids"'),
    respondTool?.outputSchema,
  );
  const managementTool = listed?.tools?.find(
    (tool) => tool.name === 'network_agent_management_get',
  );
  const managementOutput = JSON.stringify(managementTool?.outputSchema ?? {});
  check(
    'management_get 输出包含群关系、委托、在途投递、pending transfer 与审计摘要',
    managementOutput.includes('"rooms"') &&
      managementOutput.includes('"delegations"') &&
      managementOutput.includes('"in_flight_deliveries"') &&
      managementOutput.includes('"pending_transfer"') &&
      managementOutput.includes('"audit_summary"') &&
      managementOutput.includes('"successor"'),
    managementTool?.outputSchema,
  );
  const transferListTool = listed?.tools?.find(
    (tool) => tool.name === 'network_agent_transfer_list',
  );
  const agentTransferListInput = JSON.stringify(transferListTool?.inputSchema ?? {});
  check(
    'transfer_list 输入只含收窄条件',
    agentTransferListInput.includes('"status"') &&
      agentTransferListInput.includes('"role"') &&
      agentTransferListInput.includes('"actor_id"'),
    transferListTool?.inputSchema,
  );

  const archiveTool = listed?.tools?.find((tool) => tool.name === 'network_agent_archive');
  const archiveDescription = archiveTool?.description ?? '';
  check(
    'archive 描述声明从默认列举隐藏且不改变业务',
    archiveDescription.includes('管理列表') &&
      archiveDescription.includes('好友列表') &&
      archiveDescription.includes('不改变消息') &&
      archiveDescription.includes('active manager') &&
      archiveDescription.includes('PERMISSION_DENIED'),
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
  const managedListTool = listed?.tools?.find(
    (tool) => tool.name === 'network_agents_managed_list',
  );
  check(
    'agents_managed_list 默认隐藏归档并提供 include_archived 开关',
    (managedListTool?.description ?? '').includes('默认排除已归档 Agent') &&
      JSON.stringify(managedListTool?.inputSchema ?? {}).includes('"include_archived"'),
    managedListTool,
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
    ['network_contacts_list', listed?.tools?.find((item) => item.name === 'network_contacts_list')],
    ['network_history_list', historyTool],
  ] as const) {
    check(
      `${label} 输出 schema 不增加 archived 字段`,
      !JSON.stringify(tool?.outputSchema ?? {}).includes('"archived'),
      tool?.outputSchema,
    );
  }
  // room_get 只新增 G06 的 archived_head_seq；Agent 归档字段不得混入房间输出。
  check(
    'network_room_get 不增加 Agent archived_at/archived_by',
    (() => {
      const schema = JSON.stringify(roomGetTool?.outputSchema ?? {});
      return !schema.includes('"archived_at"') && !schema.includes('"archived_by"');
    })(),
    roomGetTool?.outputSchema,
  );

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
  // 自注册 Agent 默认未被认领；先完成双端认领，再由其管理者重发 token。
  const feedbackManagerIssued = await rawRpc('tools/call', {
    name: 'network_issue_token',
    arguments: {},
  });
  const feedbackManagerToken = (
    feedbackManagerIssued.body.result as { structuredContent?: { token?: string } } | undefined
  )?.structuredContent?.token;
  check('反馈检查管理者取得 token', typeof feedbackManagerToken === 'string');
  const feedbackManagerRegister = await rawRpc(
    'tools/call',
    {
      name: 'network_register',
      arguments: {
        request_id: newRequestId('feedback_manager_reg'),
        kind: 'human',
        name: '反馈检查管理者',
      },
    },
    { token: feedbackManagerToken },
  );
  check(
    '反馈检查管理者注册成功',
    (feedbackManagerRegister.body.result as { isError?: boolean } | undefined)?.isError !== true,
  );
  const feedbackClaimStart = await rawRpc(
    'tools/call',
    { name: 'network_agent_claim_start', arguments: { request_id: newRequestId('feedback_claim') } },
    { token: revokedFeedbackToken },
  );
  const feedbackClaim = toolStructured<{ claim_id?: string; code?: string }>(
    feedbackClaimStart.body,
  );
  check(
    '反馈目标 Agent 可发起认领',
    typeof feedbackClaim?.claim_id === 'string' && typeof feedbackClaim?.code === 'string',
  );
  const feedbackClaimConfirm = await rawRpc(
    'tools/call',
    {
      name: 'network_agent_claim_confirm',
      arguments: {
        request_id: newRequestId('feedback_claim_confirm'),
        claim_id: feedbackClaim?.claim_id,
        code: feedbackClaim?.code,
      },
    },
    { token: feedbackManagerToken },
  );
  check(
    '反馈检查管理者确认认领',
    (feedbackClaimConfirm.body.result as { isError?: boolean } | undefined)?.isError !== true,
  );
  const revokedFeedbackReissue = await rawRpc(
    'tools/call',
    {
      name: 'network_agent_reissue_token',
      arguments: { request_id: newRequestId('revoked_feedback_reissue'), actor_id: revokedFeedbackActor },
    },
    { token: feedbackManagerToken },
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
    '技能正文声明 watcher 自动 claim 且 raw MCP 仍需自行 claim',
    skillText.includes('watcher 自动 claim') &&
      skillText.includes('auto_claimed:true') &&
      skillText.includes('delivery_conflict') &&
      skillText.includes('delivery_deferred') &&
      skillText.includes('raw MCP 不自动 claim'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文声明回复不等于完成',
    skillText.includes('回复不等于完成') && skillText.includes('claim 只是接手'),
    skillText.slice(0, 200),
  );
  check(
    '技能正文声明 stream 快照包含解散归档状态',
    ['agentnet://stream', 'status', 'dissolved_at', 'read_only', 'archived_head_seq'].every(
      (marker) => skillText.includes(marker),
    ) &&
      skillText.includes('details.reason = "room_dissolved"') &&
      skillText.includes('不是 `STALE_ATTEMPT`'),
    skillText.slice(0, 260),
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
    '技能正文说明上传默认私有、绑定/成果按历史边界使用票据',
    [
      '上传默认是上传者私有草稿',
      'POST /mcp-upload',
      'publicUrl',
      'previewUrl',
      '24 小时',
      'network_room_file_bind',
      'network_file_publish',
      'network_artifact_submit',
      'network_artifact_release',
      '历史边界',
      '带票据',
      '旧票据',
    ].every((marker) => skillText.includes(marker)),
    skillText.slice(0, 400),
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
    '技能正文包含消息式 Task 的标记、摘要、Trace 与搜索语义',
    ['## 消息式 Task 与 Trace', 'network_task_mark', 'network_task_summaries',
      'network_task_trace', 'network_task_search', 'task_root_id',
      '不写 inbox', '不推进 `head_seq`', '不会唤醒 Agent', 'agent_tasks.sh'].every(
      (marker) => skillText.includes(marker),
    ),
    skillText.slice(0, 320),
  );
  check(
    '技能正文说明 Task 集合组成与一层引用来源',
    [
      '集合由',
      '一层来源',
      '不移动原归属',
      '不合并两个 Task',
      '参与者',
    ].every((marker) => skillText.includes(marker)),
    skillText.slice(0, 320),
  );
  check(
    '技能正文说明 login 不返回任务摘要且 Task 不唤醒 Agent',
    skillText.includes('login 只负责上线与待办计数') &&
      skillText.includes('不返回任务摘要') &&
      skillText.includes('network_task_search') &&
      skillText.includes('network_task_summaries') &&
      skillText.includes('多步骤') &&
      skillText.includes('network_task_mark'),
    skillText.slice(0, 320),
  );
  check(
    '技能正文声明 Task 摘要与 Trace 的只读字段',
    skillText.includes('root_message_ids') &&
      skillText.includes('focus_message_id') &&
      skillText.includes('truncated') &&
      skillText.includes('reference') &&
      skillText.includes('CONFLICT'),
    skillText.slice(0, 320),
  );
  check(
    '技能正文包含 multitask 异步分发行为模式',
    ['## multitask 异步分发', '### 何时拆分', '### 角色分离', '### 异步分发',
      '### 在途记录', '### 所有权与交接', 'TodoWrite', '一个交付物一个 owner',
      '独立验收', '不 sleep', 'CLAIM_CONFLICT', '取消与清理'].every((marker) =>
      skillText.includes(marker),
    ),
    skillText.slice(0, 320),
  );
  check(
    '技能正文声明 Task 没有独立实体、负责人或状态机',
    skillText.includes('没有独立任务实体') &&
      skillText.includes('负责人') &&
      skillText.includes('业务状态') &&
      skillText.includes('子任务'),
    skillText.slice(0, 260),
  );
  check(
    '技能正文说明 actor_id 显式派活与正文唯一精确兜底',
    skillText.includes('群聊派活') &&
      skillText.includes('actor_id') &&
      skillText.includes('纯文本 @') &&
      skillText.includes('唯一精确') &&
      skillText.includes('同名') &&
      skillText.includes('mentions') &&
      skillText.includes('@所有人') &&
      skillText.includes('不会自动唤醒'),
    skillText.slice(0, 300),
  );
  check(
    '技能正文说明代码、引用与附件 URL 不参与派活',
    skillText.includes('代码块') &&
      skillText.includes('引用行') &&
      skillText.includes('附件 URL'),
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
  check(
    '技能正文声明 Task 搜索按起点聚合且不合并集合',
    skillText.includes('按起点聚合') &&
      skillText.includes('不合并集合') &&
      skillText.includes('普通 `network_message_search` 契约不变') &&
      skillText.includes('truncated'),
    skillText.slice(0, 300),
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
    '新建 Agent 通过 network_agent_create 原子创建',
    homeHtml.includes('network_agent_create') &&
      homeHtml.includes("requestId('web_agent_create')") &&
      !homeHtml.includes('network_issue_token'),
  );
  check('首页包含配对设备入口', homeHtml.includes('id="device-handoff"') && homeHtml.includes('配对设备'));
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
    '首页包含配对弹窗与打开即生成的一次性挑战',
    homeHtml.includes('id="handoff-modal"') &&
      homeHtml.includes('id="handoff-qr"') &&
      homeHtml.includes('id="pairing-create"') &&
      homeHtml.includes('id="pairing-code"') &&
      homeHtml.includes('重新生成') &&
      homeHtml.includes('createPairingChallenge()') &&
      !homeHtml.includes('id="legacy-token-modal"'),
  );
  check(
    '旧 #t= 不再捕获或采纳',
    !homeHtml.includes('__agentNetworkLegacyToken') &&
      !homeHtml.includes('legacy-token') &&
      !homeHtml.includes('#t=') &&
      !homeHtml.includes('确认切换'),
  );
  check(
    '配对弹窗只保留简短配对与安全提示',
    homeHtml.includes('用另一台设备扫描或输入 12 位配对码') &&
      homeHtml.includes('只在核对设备名称/平台/确认码后批准；请勿截图或分享配对码') &&
      !homeHtml.includes('旧方式') &&
      !homeHtml.includes('长期凭据'),
  );
  check(
    '首页脚本首次访问自动注册 human 身份',
    homeHtml.includes("requestId('web_reg')") && homeHtml.includes("kind: 'human'"),
  );
  const invalidJoin = await fetch(`${baseUrl()}/j/not-a-valid-key`);
  checkEqual('格式错误的邀请 key 落地页返回 404', invalidJoin.status, 404);
  const handoffExchange = await fetch(`${baseUrl()}/j/${'a'.repeat(32)}`, { method: 'POST' });
  checkEqual('服务端不提供 /j 扫码兑换端点', handoffExchange.status, 404);
  const joinLanding = await fetch(`${baseUrl()}/j/${'a'.repeat(32)}`);
  const joinLandingHtml = await joinLanding.text();
  checkEqual('群邀请落地页可打开', joinLanding.status, 200);
  checkEqual('群邀请落地页禁止缓存', joinLanding.headers.get('cache-control'), 'no-store');
  check(
    '群邀请落地页只展示最小介绍与确认入口',
    joinLandingHtml.includes('id="join-action"') &&
      joinLandingHtml.includes('邀请码有效不等于已加入') &&
      joinLandingHtml.includes("callTool('network_room_invite_get'"),
  );
  check(
    '群邀请落地页不内联邀请码以外的身份凭据',
    !joinLandingHtml.includes('agent-network-token='),
  );
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
    '首页包含消息式 Task 摘要与 Trace 入口',
    homeHtml.includes('id="task-trace-drawer"') &&
      homeHtml.includes('id="task-trace-items"') &&
      homeHtml.includes('id="task-trace-title"') &&
      homeHtml.includes('network_task_summaries') &&
      homeHtml.includes('network_task_trace') &&
      homeHtml.includes('network_task_mark') &&
      !homeHtml.includes('id="task-toggle"') &&
      !homeHtml.includes('id="task-create"') &&
      !homeHtml.includes('network_task_create'),
  );
  check(
    '消息式 Task UI 使用 textContent 且保留分页入口',
    homeHtml.includes('taskTraceTitleElement.textContent') &&
      homeHtml.includes('taskTraceItemsElement.replaceChildren') &&
      homeHtml.includes('id="task-trace-older"') &&
      homeHtml.includes('id="task-trace-newer"') &&
      !homeHtml.includes('taskTraceItemsElement.innerHTML'),
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
    '静态技能说明 actor_id 显式派活与正文唯一精确兜底',
    skillDocText.includes('群聊派活') &&
      skillDocText.includes('actor_id') &&
      skillDocText.includes('纯文本 @') &&
      skillDocText.includes('唯一精确') &&
      skillDocText.includes('同名') &&
      skillDocText.includes('`--no-invoke`') &&
      skillDocText.includes('不会自动唤醒') &&
      !skillDocText.includes('不需要 actor_id'),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能不包含硬编码 Bearer token',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(skillDocText),
  );
  check(
    '静态技能声明消息式 Task 的摘要、Trace 与搜索规则',
    skillDocText.includes('network_task_summaries') &&
      skillDocText.includes('network_task_trace') &&
      skillDocText.includes('network_task_search') &&
      skillDocText.includes('task_root_id') &&
      skillDocText.includes('不唤醒 Agent'),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能只覆盖 Agent 类型',
    !skillDocText.includes('kind: "human"'),
    skillDocText.slice(0, 200),
  );
  check(
    '静态技能包含命令与监听脚本',
    ['agentnet.sh', 'peri-watch.sh', 'codex-watch.sh', 'claude-watch.sh', 'dsh-watch.sh'].every((name) =>
      skillDocText.includes(name),
    ),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能说明 watcher 自动 claim 与 raw MCP 差异',
    ['watcher 自动 claim', 'network_delivery_claim', 'auto_claimed', 'delivery_conflict',
      'delivery_deferred', 'delivery_claim_failed', 'raw MCP', '不自动 claim'].every((marker) =>
      skillDocText.includes(marker),
    ),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能包含 Task 命令与不唤醒规范',
    ['agent_tasks.sh', '### 消息式 Task 与 Trace', 'network_task_mark',
      'network_task_summaries', 'network_task_trace', 'network_task_search',
      '不写 inbox', '不唤醒 Agent', 'task_root_id'].every((marker) =>
      skillDocText.includes(marker),
    ),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能声明 Task 事件只刷新摘要且不生成待办',
    [
      'task.updated',
      'message_task_marked',
      'message_task_unmarked',
      'informational',
      '不写 inbox',
      'pending_count',
      '不唤醒 Agent',
    ].every((marker) => skillDocText.includes(marker)),
    skillDocText.slice(0, 300),
  );
  check(
    '静态技能包含 multitask 异步分发行为模式',
    ['## multitask 异步分发', '### 何时拆分', '### 角色分离', '### 异步分发',
      '### 在途记录', '### 所有权与交接', 'TodoWrite', '一个交付物一个 owner',
      '独立验收', '不 sleep', 'CLAIM_CONFLICT', '取消与清理'].every((marker) =>
      skillDocText.includes(marker),
    ),
    skillDocText.slice(0, 320),
  );
  check(
    '静态技能包含短回复与长内容文件指引',
    skillDocText.includes('回复长度与长内容') && skillDocText.includes('一行摘要'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能说明上传默认私有、绑定/成果按历史边界使用票据',
    [
      '上传默认是上传者私有草稿',
      'POST /mcp-upload',
      'publicUrl',
      'previewUrl',
      '24 小时',
      'network_room_file_bind',
      'network_file_publish',
      'network_artifact_submit',
      'network_artifact_release',
      '历史边界',
      '带票据',
      '旧票据',
    ].every((marker) => skillDocText.includes(marker)),
    skillDocText.slice(0, 400),
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
  const replyTargetSection = (text: string): string => {
    const heading = '## 回复对象与 @';
    const start = text.indexOf(heading);
    if (start < 0) return '';
    const rest = text.slice(start + heading.length);
    const next = rest.search(/\n## /u);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };
  const mainReplyTargetSection = replyTargetSection(skillText);
  const staticReplyTargetSection = replyTargetSection(skillDocText);
  check(
    '静态/主 skill 回复对象与 @ 语义完整',
    ['sender_name', 'sender_kind', '只在需要对方处理或回应时 @', '不要每条回复都 @',
      '不要凭记忆', 'network_message_context', '测试账号'].every((marker) =>
      mainReplyTargetSection.includes(marker) && staticReplyTargetSection.includes(marker),
    ),
    mainReplyTargetSection.slice(0, 400),
  );
  checkEqual(
    '静态/主 skill 回复对象与 @ digest 一致',
    sectionDigest(staticReplyTargetSection),
    sectionDigest(mainReplyTargetSection),
  );
  const multitaskSection = (text: string): string => {
    const heading = '## multitask 异步分发';
    const start = text.indexOf(heading);
    if (start < 0) return '';
    const rest = text.slice(start + heading.length);
    const next = rest.search(/\n## /u);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };
  const mainMultitaskSection = multitaskSection(skillText);
  const staticMultitaskSection = multitaskSection(skillDocText);
  check(
    '静态技能包含 multitask 异步分发正文',
    staticMultitaskSection.includes('### 何时拆分') &&
      staticMultitaskSection.includes('### 角色分离') &&
      staticMultitaskSection.includes('### 异步分发') &&
      staticMultitaskSection.includes('### 推荐节奏'),
    staticMultitaskSection.slice(0, 240),
  );
  checkEqual(
    '静态/主 skill multitask 异步分发 digest 一致',
    sectionDigest(staticMultitaskSection),
    sectionDigest(mainMultitaskSection),
  );
  const contactLinkSection = (text: string): string => {
    const heading = '### 好友邀请链接';
    const start = text.indexOf(heading);
    if (start < 0) return '';
    const rest = text.slice(start + heading.length);
    const next = rest.search(/\n#{2,3} /u);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };
  const mainContactLinkSection = contactLinkSection(skillText);
  const staticContactLinkSection = contactLinkSection(skillDocText);
  check(
    '静态/主 skill 好友邀请链接语义完整',
    mainContactLinkSection.includes('24 小时') &&
      mainContactLinkSection.includes('TOKEN_NOT_REPLAYABLE') &&
      mainContactLinkSection.includes('CONTACT_LINK_INVALID') &&
      mainContactLinkSection.includes('invite_link') &&
      mainContactLinkSection.includes('already_friends') &&
      mainContactLinkSection.includes('错误链接不得创建替代身份') &&
      staticContactLinkSection.includes('24 小时'),
    mainContactLinkSection.slice(0, 240),
  );
  checkEqual(
    '静态/主 skill 好友邀请链接 digest 一致',
    sectionDigest(staticContactLinkSection),
    sectionDigest(mainContactLinkSection),
  );
  const fileShareRules = (text: string): string[] => {
    const markers = [
      '上传默认是上传者私有草稿',
      '裸 `/f/<fileId>`',
      '- **公开发布是独立动作**',
      '`network_file_publish',
      '- **票据即下载权限，但会被撤权**',
      '不要假设链接只对房间成员长期可见。',
    ];
    return markers.filter((marker) => text.includes(marker));
  };
  const mainFileShareRules = fileShareRules(skillText);
  const staticFileShareRules = fileShareRules(skillDocText);
  check(
    '静态/主 skill 文件分享规则一致',
    mainFileShareRules.length === 6 &&
      staticFileShareRules.length === 6 &&
      sectionDigest(staticFileShareRules.join('\n')) === sectionDigest(mainFileShareRules.join('\n')),
    { main: mainFileShareRules, static: staticFileShareRules },
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
    '静态技能说明 3 分钟无进度提醒、摘要文案且不产生新待办',
    skillDocText.includes('delivery_reminder') &&
      skillDocText.includes('3 分钟') &&
      skillDocText.includes('network_delivery_report') &&
      skillDocText.includes('`preview`') &&
      skillDocText.includes('`text`') &&
      skillDocText.includes('pending_count') &&
      skillDocText.includes('head_seq'),
    skillDocText.slice(0, 240),
  );
  check(
    '主技能说明提醒携带摘要、文案与未完成时长',
    skillText.includes('delivery.reminder') &&
      skillText.includes('preview') &&
      skillText.includes('text') &&
      skillText.includes('age_ms') &&
      skillText.includes('不含完整正文'),
    skillText.slice(0, 240),
  );
  check(
    '静态技能包含 MCP Events 硬过滤与群聊补读规范',
    skillDocText.includes('### MCP Events 订阅过滤') &&
      skillDocText.includes('硬过滤') &&
      skillDocText.includes('群聊普通消息默认不产生 delivery') &&
      skillDocText.includes('紧跟 Agent') &&
      skillDocText.includes('不会自动派活') &&
      skillDocText.includes('默认为 active') &&
      skillDocText.includes('events/unsubscribe'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能包含六份 Harness 指南的相对链接',
    [
      '[Codex](./harness-codex.md)',
      '[ChatGPT Web](./harness-chatgpt-web.md)',
      '[Peri](./harness-peri.md)',
      '[Claude](./harness-claude.md)',
      '[Other](./harness-other.md)',
      '[DSH](./harness-dsh.md)',
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
    {
      file: 'harness-dsh.md',
      markers: [
        'dsh web',
        'dsh headless',
        '--session-id',
        'wake.queue',
        'agent.followup',
        'agent.inject',
        'action_required',
        'room.message',
        'delivery.updated',
        'session.login',
        'session.v4.jsonl.zstd',
        'cordis.patch.yml',
        'Landlock',
        'peerDependencies',
        'catchup',
        'CREDENTIAL_INVALID',
        'dsh-watch.sh',
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

  // CLI bundle 由服务启动时构建到内存；这里不构建磁盘文件，直接验收路由。
  const cliAsset = await fetch(`${baseUrl()}/skills/agentnet.js`);
  checkEqual('GET /skills/agentnet.js 返回 200', cliAsset.status, 200);
  const cliAssetType = cliAsset.headers.get('content-type') ?? '';
  const cliSource = await cliAsset.text();
  check(
    'CLI bundle 以 text/javascript 提供且带 bun shebang，不含部署占位符',
    cliAssetType.startsWith('text/javascript') &&
      cliSource.startsWith('#!/usr/bin/env bun') &&
      !cliSource.includes('__PUBLIC_ORIGIN__'),
    { contentType: cliAssetType, head: cliSource.slice(0, 80) },
  );
  // 从响应体反算内容哈希：ETag 必须对应当前内存 bundle，而不是磁盘上的旧文件。
  const cliEtag = cliAsset.headers.get('etag') ?? '';
  const cliVersion = new Bun.CryptoHasher('sha256').update(cliSource).digest('hex').slice(0, 12);
  checkEqual('CLI bundle ETag 为响应内容哈希', cliEtag, `"${cliVersion}"`);
  const cliCached = await fetch(`${baseUrl()}/skills/agentnet.js`, {
    headers: { 'if-none-match': cliEtag },
  });
  checkEqual('CLI bundle 命中 ETag 返回 304', cliCached.status, 304);

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
    'actor_id',
    '唯一精确',
    'invoke 传 []',
    '@所有人',
    'mentions',
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
    'ChatGPT 指南说明显式 actor_id 与无隐式自动投递',
    chatgptGuideText.includes('显式选择目标') &&
      chatgptGuideText.includes('代码、引用与转发内容不参与') &&
      chatgptGuideText.includes('不会自动投递上一位 Agent') &&
      chatgptGuideText.includes('human 提及') &&
      !chatgptGuideText.includes('服务端按正文 @名字 解析'),
    chatgptGuideText.slice(0, 400),
  );
  check(
    'ChatGPT 指南明确新订阅不重放旧事件',
    chatgptGuideText.includes('不重放') &&
      chatgptGuideText.includes('network_sync { scope: "inbox" }'),
    chatgptGuideText.slice(0, 400),
  );
  const chatgptFileMarkers = [
    '本地路径',
    'file://',
    'POST /mcp-upload',
    'publicUrl',
    'public_url',
    '私有草稿',
    'network_room_file_bind',
    'network_room_file_list',
    'network_room_file_get',
    'network_artifact_submit',
    'network_message_send',
    '房间文件列表',
    '历史边界',
    '带票据',
    '旧票据',
  ];
  check(
    'ChatGPT 指南说明上传默认私有、绑定/成果按历史边界使用票据',
    chatgptFileMarkers.every((marker) => chatgptGuideText.includes(marker)),
    { missing: chatgptFileMarkers.filter((marker) => !chatgptGuideText.includes(marker)) },
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
      ['ALERT', 'AGENTNET_TOKEN', 'network_inbox_list', 'delivery_id', 'ERROR type=inbox', 'agentnet://stream', 'subscriptions/listen', 'sender_id', '--connect-timeout', 'network_delivery_claim', 'auto_claimed', 'delivery_conflict', 'delivery_deferred', 'delivery_claim_failed'].every((marker) =>
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
    'Peri monitor 脚本识别 3 分钟提醒并输出 reminder ALERT',
    periScriptText.includes('delivery.reminder') &&
      periScriptText.includes('type:"reminder"') &&
      periScriptText.includes('network_delivery_report'),
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
       'turn/completed', 'CODEX_THREAD_ID', 'DELIVERY_CLAIMED', 'DELIVERY_DEFERRED',
       'DELIVERY_CONFLICT', 'DELIVERY_CLAIM_FAILED', 'auto_claimed=true'].every(
        (marker) => codexScriptText.includes(marker),
      ) &&
      !codexScriptText.includes('peri-watch.sh') &&
      !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(codexScriptText),
  );
  check(
    'Codex 脚本识别提醒并交给当前会话',
    codexScriptText.includes('delivery.reminder') &&
      codexScriptText.includes('wake_reminder') &&
      codexScriptText.includes('REMINDER_STEERED') &&
      codexScriptText.includes('network_delivery_report'),
  );

  const claudeScript = await fetch(`${baseUrl()}/skills/claude-watch.sh`);
  checkEqual('GET /skills/claude-watch.sh 返回 200', claudeScript.status, 200);
  const claudeScriptType = claudeScript.headers.get('content-type') ?? '';
  const claudeScriptText = await claudeScript.text();
  check(
    'claude-watch.sh 默认地址在响应中注入为测试实例 PUBLIC_ORIGIN',
    claudeScriptText.includes(`: "\${AGENTNET_URL:=${publicOrigin}}"`) &&
      !claudeScriptText.includes('__PUBLIC_ORIGIN__') &&
      !claudeScriptText.includes('net.peri-code.dev'),
    { publicOrigin, snippet: claudeScriptText.slice(0, 160) },
  );
  const claudeScriptMarkers = [
    'AGENTNET_TOKEN',
    'subscriptions/listen',
    'agentnet://stream',
    'notifications/subscriptions/acknowledged',
    'network_login',
    'network_inbox_list',
    'network_delivery_claim',
    'network_message_read',
    'event_file',
    'auto_claimed',
    'delivery_conflict',
    'delivery_deferred',
    'delivery_claim_failed',
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
  check(
    'Claude Code 监听脚本识别 3 分钟提醒并输出 reminder',
    claudeScriptText.includes('delivery.reminder') &&
      claudeScriptText.includes('type:"reminder"') &&
      claudeScriptText.includes('network_delivery_report'),
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
  const claudeBodyPreviewBody =
    claudeScriptText.match(/event_body_json\(\) \{([\s\S]*?)^\}/mu)?.[1] ?? '';
  check(
    'Claude Code 监听脚本把完整正文写入 0600 私有事件文件',
    claudeWriteEventBody.includes('network_message_read') &&
      claudeWriteEventBody.includes('next_cursor') &&
      claudeWriteEventBody.includes('--rawfile body') &&
      claudeWriteEventBody.includes('chmod 600') &&
      claudeEmitFoundBody.includes('event_file') &&
      !claudeEmitFoundBody.includes('--rawfile body'),
    { claudeWriteEventBody, claudeEmitFoundBody },
  );
  check(
    'Claude Code 监听脚本只在 stdout 携带受限正文预览',
    /^BODY_PREVIEW_CHARS=\d+$/mu.test(claudeScriptText) &&
      claudeBodyPreviewBody.includes('BODY_PREVIEW_CHARS') &&
      claudeBodyPreviewBody.includes('utf8bytelength') &&
      claudeBodyPreviewBody.includes('body_truncated') &&
      claudeEmitFoundBody.includes('body:$body_info.body') &&
      claudeEmitFoundBody.includes('body_truncated:$body_info.body_truncated'),
    { claudeBodyPreviewBody, claudeEmitFoundBody },
  );

  const dshScript = await fetch(`${baseUrl()}/skills/dsh-watch.sh`);
  checkEqual('GET /skills/dsh-watch.sh 返回 200', dshScript.status, 200);
  const dshScriptType = dshScript.headers.get('content-type') ?? '';
  const dshScriptText = await dshScript.text();
  const dshScriptMarkers = [
    'WEBBOTS_HOME',
    'AGENTNET_TOKEN',
    'AGENTNET_URL',
    'wake.queue',
    'status.json',
    'start',
    'stop',
    'status',
    'logs',
    'wait',
    'run',
    'subscriptions/listen',
    'agentnet://stream',
    'network_login',
    'network_room_get',
    'action_required',
    'room.message',
    'delivery.updated',
    'session.login',
    'catchup',
    'CREDENTIAL_INVALID',
    'reconnect_delay',
    '--connect-timeout',
    'EOF',
    'truncate',
  ];
  check(
    'DSH watcher 订阅统一流、写 wake.queue 并支持守护子命令',
    dshScriptType.includes('text/x-shellscript') &&
      dshScriptMarkers.every((marker) => dshScriptText.includes(marker)),
    {
      contentType: dshScriptType,
      missing: dshScriptMarkers.filter((marker) => !dshScriptText.includes(marker)),
    },
  );
  check(
    'DSH watcher 不包含硬编码 Bearer token 或完整 token URL',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(dshScriptText) &&
      !/[?&]token=[0-9a-f]{8}-[0-9a-f]{4}/iu.test(dshScriptText),
  );
  const dshSyntax = Bun.spawnSync({
    cmd: ['bash', '-n', 'public/skills/dsh-watch.sh'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    'DSH watcher 通过 bash -n',
    dshSyntax.exitCode === 0,
    dshSyntax.stderr.toString(),
  );

  const dshGuide = await fetch(`${baseUrl()}/skills/harness-dsh.md`);
  checkEqual('GET /skills/harness-dsh.md 返回 200（DSH 指南）', dshGuide.status, 200);
  const dshGuideText = await dshGuide.text();
  check(
    'DSH 指南说明无内置 monitor、事件过滤与不可重试凭据错误',
    ['没有内置 monitor', 'wake.queue', 'action_required', 'room.message', 'delivery.updated',
      'session.login', 'catchup', 'CREDENTIAL_INVALID', '不可重试', 'dsh-watch.sh'].every(
      (marker) => dshGuideText.includes(marker),
    ),
    { missing: ['没有内置 monitor', 'wake.queue', 'action_required', 'room.message', 'delivery.updated',
      'session.login', 'catchup', 'CREDENTIAL_INVALID', '不可重试', 'dsh-watch.sh'].filter(
      (marker) => !dshGuideText.includes(marker),
    ) },
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
    'agentnet.sh 默认地址在响应中注入为测试实例 PUBLIC_ORIGIN',
    agentnetScriptText.includes(`: "\${AGENTNET_URL:=${publicOrigin}}"`) &&
      !agentnetScriptText.includes('__PUBLIC_ORIGIN__') &&
      !agentnetScriptText.includes('net.peri-code.dev'),
    { publicOrigin, snippet: agentnetScriptText.slice(0, 160) },
  );
  const skillScriptFiles = [
    'agentnet.sh',
    'agent_tasks.sh',
    'claude-watch.sh',
    'codex-watch.sh',
    'dsh-watch.sh',
    'peri-watch.sh',
  ];
  for (const file of skillScriptFiles) {
    const source = await Bun.file(`public/skills/${file}`).text();
    check(
      `public/skills/${file} 源文件不含硬编码公网域名`,
      !source.includes('net.peri-code.dev') && source.includes('__PUBLIC_ORIGIN__'),
    );
  }
  check(
    'agentnet.sh 响应使用内容哈希 ETag 与 no-cache',
    (agentnetScript.headers.get('cache-control') ?? '').includes('no-cache') &&
      /^"[0-9a-f]{64}"$/u.test(agentnetScript.headers.get('etag') ?? ''),
    {
      cacheControl: agentnetScript.headers.get('cache-control'),
      etag: agentnetScript.headers.get('etag'),
    },
  );
  const agentnetRevalidated = await fetch(`${baseUrl()}/skills/agentnet.sh`, {
    headers: { 'if-none-match': agentnetScript.headers.get('etag') ?? '' },
  });
  checkEqual('agentnet.sh 携带 If-None-Match 返回 304', agentnetRevalidated.status, 304);
  check(
    'agentnet reply 自动恢复投递状态并一次完成最终回复',
    ['cmd_reply', 'find_inbox_delivery', 'network_delivery_claim',
     'network_delivery_complete', 'final_body'].every((marker) =>
      agentnetScriptText.includes(marker),
    ),
  );
  check(
    'agentnet send/send-file 支持显式 invoke、opt-out 与 human mentions',
    agentnetScriptText.includes('--no-invoke') &&
      agentnetScriptText.includes('--mention') &&
      agentnetScriptText.includes("--no-invoke) invoke='[]'; shift 1") &&
      agentnetScriptText.includes('--no-invoke) invoke=""; no_invoke=1; shift 1') &&
      agentnetScriptText.includes('if $mentions == null then {} else {mentions:$mentions} end') &&
      agentnetScriptText.includes('send_args+=(--mention "$mentions")') &&
      agentnetScriptText.includes('显式 invoke 是 Agent 执行目标'),
    agentnetScriptText.slice(0, 300),
  );

  const agentTasksScript = await fetch(`${baseUrl()}/skills/agent_tasks.sh`);
  checkEqual('GET /skills/agent_tasks.sh 返回 200', agentTasksScript.status, 200);
  const agentTasksType = agentTasksScript.headers.get('content-type') ?? '';
  const agentTasksText = await agentTasksScript.text();
  check(
    'Task 命令脚本可通过 /skills 下载并包含 5 个子命令',
    agentTasksType.includes('text/x-shellscript') &&
      ['mark', 'unmark', 'summaries', 'trace', 'search'].every(
        (marker) => agentTasksText.includes(`  ${marker})`),
      ) &&
      ['network_task_mark', 'network_task_unmark', 'network_task_summaries',
        'network_task_trace', 'network_task_search'].every((marker) =>
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
    'Task 命令脚本说明只读、不轮询与幂等 request_id',
    agentTasksText.includes('不创建 delivery') &&
      agentTasksText.includes('不增加 pending_count') &&
      agentTasksText.includes('不唤醒 Agent') &&
      agentTasksText.includes('--request-id') &&
      agentTasksText.includes('message_id 就是 task_root_id'),
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
    'network_agent_rename 拒绝非管理者',
    agentGlobalRenamed.code,
    'PERMISSION_DENIED',
  );
  const shareAfterDeniedRename = await rawToolCall<{ name: string }>(
    shareToken,
    'network_me',
    {},
  );
  checkEqual(
    '非管理者改名失败后名称保持不变',
    shareAfterDeniedRename.data?.name,
    '分享页检查 Agent 自助名',
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
      name: 'network_contact_request',
      arguments: {
        request_id: `web_contact_${crypto.randomUUID().replaceAll('-', '')}`,
        agent_session_id: shareSession,
      },
    },
    { token: browserToken },
  );
  const contactResult = (
    browserContact.body.result as
      | {
          structuredContent?: {
            status?: string;
            request?: { contact_request_id?: string } | null;
          };
        }
      | undefined
  )?.structuredContent;
  checkEqual('浏览器身份可按 agent_session_id 发起好友申请', contactResult?.status, 'pending');
  const shareAccepted = await rawToolCall<{ status: string }>(
    shareToken,
    'network_contact_request_respond',
    {
      request_id: `web_contact_accept_${crypto.randomUUID().replaceAll('-', '')}`,
      contact_request_id: contactResult?.request?.contact_request_id,
      action: 'accept',
    },
  );
  checkEqual('Agent 接受浏览器好友申请后关系建立', shareAccepted.data?.status, 'accepted');
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

  // 消息式 Task：标记幂等、读工具不写事件、取消标记保留消息。
  const taskTargetSent = await rawToolCall<{ message: { message_id: string } }>(
    browserToken,
    'network_message_send',
    {
      request_id: `task_mark_target_${crypto.randomUUID().replaceAll('-', '')}`,
      client_message_id: crypto.randomUUID(),
      room_id: historyRoomId,
      body: 'TASKTRACE 协议标记幂等',
      invoke: [],
    },
  );
  const taskTargetId = taskTargetSent.data?.message.message_id ?? '';
  check('task mark fixture 写入成功', taskTargetId.length > 0, taskTargetSent);
  const markRequestId = `task_mark_${crypto.randomUUID().replaceAll('-', '')}`;
  const roomStateBeforeTask = await rawToolCall<{
    room: { head_seq: string; my_last_read_seq: string };
  }>(browserToken, 'network_room_get', { room_id: historyRoomId });
  const markOnce = await rawToolCall<{
    room_id: string;
    message_id: string;
    task_root_id: string;
    marked: boolean;
  }>(shareToken, 'network_task_mark', {
    request_id: markRequestId,
    room_id: historyRoomId,
    message_id: taskTargetId,
  });
  const markReplay = await rawToolCall<typeof markOnce.data>(shareToken, 'network_task_mark', {
    request_id: markRequestId,
    room_id: historyRoomId,
    message_id: taskTargetId,
  });
  check(
    'task_mark 允许 Agent 标记人类消息且重放返回同一结果',
    markOnce.data?.marked === true &&
      markOnce.data?.task_root_id === taskTargetId &&
      JSON.stringify(markOnce.data) === JSON.stringify(markReplay.data),
    { markOnce: markOnce.data, markReplay: markReplay.data },
  );
  const summariesArgs = {
    room_id: historyRoomId,
    root_message_ids: [taskTargetId],
  };
  const summariesOnce = await rawToolCall<{
    items: { root_message_id: string; message_count: number }[];
  }>(browserToken, 'network_task_summaries', summariesArgs);
  const summariesTwice = await rawToolCall<typeof summariesOnce.data>(
    browserToken,
    'network_task_summaries',
    summariesArgs,
  );
  check(
    'task_summaries 返回已标记起点且重复读取结果一致',
    summariesOnce.data?.items.length === 1 &&
      summariesOnce.data?.items[0]?.root_message_id === taskTargetId &&
      JSON.stringify(summariesOnce.data) === JSON.stringify(summariesTwice.data),
    summariesOnce.data,
  );
  const traceArgs = { room_id: historyRoomId, root_message_id: taskTargetId, limit: 10 };
  const traceOnce = await rawToolCall<{
    items: { message_id: string; role: string }[];
    focus_message_id: string | null;
  }>(browserToken, 'network_task_trace', traceArgs);
  const traceTwice = await rawToolCall<typeof traceOnce.data>(
    browserToken,
    'network_task_trace',
    traceArgs,
  );
  check(
    'task_trace 返回起点且重复读取结果一致',
    traceOnce.data?.items.length === 1 &&
      traceOnce.data?.items[0]?.message_id === taskTargetId &&
      traceOnce.data?.items[0]?.role === 'root' &&
      JSON.stringify(traceOnce.data) === JSON.stringify(traceTwice.data),
    traceOnce.data,
  );
  const searchArgs = { room_id: historyRoomId, query: 'TASKTRACE', limit: 10 };
  const searchOnce = await rawToolCall<{
    items: { task: { root_message_id: string }; hit_count: number }[];
    truncated: boolean;
  }>(browserToken, 'network_task_search', searchArgs);
  const searchTwice = await rawToolCall<typeof searchOnce.data>(
    browserToken,
    'network_task_search',
    searchArgs,
  );
  check(
    'task_search 按起点聚合且重复读取结果一致',
    searchOnce.data?.items.length === 1 &&
      searchOnce.data?.items[0]?.task.root_message_id === taskTargetId &&
      searchOnce.data?.items[0]?.hit_count === 1 &&
      searchOnce.data?.truncated === false &&
      JSON.stringify(searchOnce.data) === JSON.stringify(searchTwice.data),
    searchOnce.data,
  );
  const syncAfterMark = await rawToolCall<{ items: { type: string }[] }>(
    browserToken,
    'network_sync',
    { scope: `room:${historyRoomId}`, limit: 200 },
  );
  const markedEventCount = (syncAfterMark.data?.items ?? []).filter(
    (item) => item.type === 'message_task_marked',
  ).length;
  check(
    'sync 保留新 message_task_marked 事件',
    markedEventCount === 1,
    syncAfterMark.data?.items?.map((item) => item.type),
  );
  const syncAfterReads = await rawToolCall<{ items: { type: string }[] }>(
    browserToken,
    'network_sync',
    { scope: `room:${historyRoomId}`, limit: 200 },
  );
  check(
    '读工具不写 events/outbox',
    JSON.stringify(syncAfterMark.data?.items) === JSON.stringify(syncAfterReads.data?.items),
    {
      before: syncAfterMark.data?.items?.length,
      after: syncAfterReads.data?.items?.length,
    },
  );
  const roomStateAfterTask = await rawToolCall<{
    room: { head_seq: string; my_last_read_seq: string };
  }>(browserToken, 'network_room_get', { room_id: historyRoomId });
  check(
    '标记与读工具不推进 head_seq 或已读位置',
    roomStateBeforeTask.data?.room.head_seq === roomStateAfterTask.data?.room.head_seq &&
      roomStateBeforeTask.data?.room.my_last_read_seq ===
        roomStateAfterTask.data?.room.my_last_read_seq,
    { before: roomStateBeforeTask.data?.room, after: roomStateAfterTask.data?.room },
  );
  const unmarkRequestId = `task_unmark_${crypto.randomUUID().replaceAll('-', '')}`;
  const unmarkOnce = await rawToolCall<{ marked: boolean; task_root_id: null }>(
    browserToken,
    'network_task_unmark',
    { request_id: unmarkRequestId, room_id: historyRoomId, message_id: taskTargetId },
  );
  const unmarkReplay = await rawToolCall<typeof unmarkOnce.data>(
    browserToken,
    'network_task_unmark',
    { request_id: unmarkRequestId, room_id: historyRoomId, message_id: taskTargetId },
  );
  const summariesAfterUnmark = await rawToolCall<typeof summariesOnce.data>(
    browserToken,
    'network_task_summaries',
    summariesArgs,
  );
  check(
    'task_unmark 幂等并只撤销聚合入口',
    unmarkOnce.data?.marked === false &&
      unmarkOnce.data?.task_root_id === null &&
      JSON.stringify(unmarkOnce.data) === JSON.stringify(unmarkReplay.data) &&
      summariesAfterUnmark.data?.items.length === 0,
    { unmark: unmarkOnce.data, summaries: summariesAfterUnmark.data },
  );
  const secondTargetSent = await rawToolCall<{ message: { message_id: string } }>(
    browserToken,
    'network_message_send',
    {
      request_id: `task_mark_target_two_${crypto.randomUUID().replaceAll('-', '')}`,
      client_message_id: crypto.randomUUID(),
      room_id: historyRoomId,
      body: 'TASKTRACE 第二个标记目标',
      invoke: [],
    },
  );
  const markConflict = await rawToolCall(shareToken, 'network_task_mark', {
    request_id: markRequestId,
    room_id: historyRoomId,
    message_id: secondTargetSent.data?.message.message_id,
  });
  checkEqual(
    '同 request_id 改目标返回 IDEMPOTENCY_CONFLICT',
    markConflict.code,
    'IDEMPOTENCY_CONFLICT',
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
  const monitorContact = await rawRpc(
    'tools/call',
    {
      name: 'network_contact_request',
      arguments: {
        request_id: `monitor_contact_${crypto.randomUUID().replaceAll('-', '')}`,
        actor_id: monitorB?.actor_id,
      },
    },
    { token: browserToken },
  );
  const monitorContactResult = (
    monitorContact.body.result as
      | {
          structuredContent?: {
            status?: string;
            request?: { contact_request_id?: string } | null;
          };
        }
      | undefined
  )?.structuredContent;
  checkEqual('监控验收好友申请进入 pending', monitorContactResult?.status, 'pending');
  const monitorAccepted = await rawToolCall<{ status: string }>(
    monitorBToken,
    'network_contact_request_respond',
    {
      request_id: `monitor_contact_accept_${crypto.randomUUID().replaceAll('-', '')}`,
      contact_request_id: monitorContactResult?.request?.contact_request_id,
      action: 'accept',
    },
  );
  checkEqual('监控成员接受好友申请', monitorAccepted.data?.status, 'accepted');
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

  // G01：非创建者管理的成员先收到邀请；监控用例需要一个真实 active 成员。
  const monitorInvitations = await rawToolCall<{
    items: { invitation_id: string; room_id: string; can_respond: boolean }[];
  }>(monitorBToken, 'network_room_invite_get', { limit: 100 });
  for (const invitation of monitorInvitations.data?.items ?? []) {
    if (invitation.room_id !== monitorRoomId || !invitation.can_respond) continue;
    await rawToolCall(monitorBToken, 'network_room_invite_respond', {
      request_id: `monitor_invite_${crypto.randomUUID().replaceAll('-', '')}`,
      invitation_id: invitation.invitation_id,
      action: 'accept',
    });
  }

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
      (tools.tools.some((tool) => tool.name === 'drive_file_info') ? 2 : 0) +
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
  await runOwnerlessRoomUnitChecks();
  await runFeedbackCliChecks();
  await runDeliveryReminderUnitChecks();
  await runDeliverySenderUnitChecks();
  await runRoomInviteReplayUnitChecks();

  console.log(`协议验收通过: ${checksPassed()} 项`);
}

await main().catch((error) => {
  console.error('协议验收失败:', error);
  process.exit(1);
});
