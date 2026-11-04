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
          outputSchema?: unknown;
        }[];
      }
    | undefined;
  const coreToolNames = [
    'network_issue_token',
    'network_register',
    'network_me',
    'network_login',
    'network_profile_update',
    'network_agent_rename',
    'network_recovery_create',
    'network_recovery_redeem',
    'network_contacts_list',
    'network_contact_add',
    'network_contact_remove',
    'network_room_create',
    'network_rooms_list',
    'network_room_get',
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
  // 工具集随 drive 开关变化：核心 28 + drive_file_info + 4 个房间文件工具。
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
  for (const required of [
    'network_issue_token',
    'network_register',
    'network_me',
    'network_login',
    'network_agent_rename',
    'network_message_send',
    'network_inbox_list',
    'network_delivery_claim',
    'network_delivery_complete',
    'network_delivery_report',
    'network_delivery_fail',
    'network_delivery_cancel',
    'network_delivery_retry',
    'network_sync',
    'drive_file_info',
    'network_room_file_bind',
    'network_room_file_list',
    'network_room_file_get',
    'network_room_file_delete',
  ]) {
    check(`工具 ${required} 已注册`, toolNames.includes(required), toolNames);
  }

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
    '技能正文要求超过 10 秒先发简短确认',
    skillText.includes('超过 10 秒') &&
      skillText.includes('简短确认') &&
      skillText.includes('不算完成'),
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
    '新建 Agent 弹窗标明 MCP URL 只显示一次且为长期凭据',
    homeHtml.includes('长期凭据') &&
      homeHtml.includes('只显示一次') &&
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
    '首页包含复制 actor ID 按钮',
    homeHtml.includes('id="account-copy-id"') && homeHtml.includes('复制 ID'),
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
    '首页服务信息收在折叠区',
    homeHtml.includes('<details') && homeHtml.includes('/a/&lt;agent_session_id&gt;'),
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

  const skillDoc = await fetch(`${baseUrl()}/skills/agent-network-curl.md`);
  checkEqual('GET /skills/agent-network-curl.md 返回 200', skillDoc.status, 200);
  const skillDocText = await skillDoc.text();
  check(
    '静态技能为 Markdown 且包含 MCP 版本与 token 环境变量说明',
    (skillDoc.headers.get('content-type') ?? '').includes('text/markdown') &&
      skillDocText.includes('MCP-Protocol-Version') &&
      skillDocText.includes('AGENTNET_TOKEN'),
    skillDoc.headers.get('content-type'),
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
    '静态技能面向无法使用 MCP 的客户端且不属于 skills/list',
    skillDocText.includes('无法使用 MCP') && skillDocText.includes('不属于 `skills/list`'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能说明注册后向用户提供 share_url',
    skillDocText.includes('SHARE_URL') &&
      skillDocText.includes('.share_url') &&
      skillDocText.includes('发给用户'),
    skillDocText.slice(0, 200),
  );
  check(
    '静态技能说明注册后异步监听并包含 subscriptions/listen 与 network_login',
    skillDocText.includes('异步') &&
      skillDocText.includes('subscriptions/listen') &&
      skillDocText.includes('network_login'),
    skillDocText.slice(0, 200),
  );
  check(
    '静态技能说明 SSE 使用 --http1.1、唯一 subscription id 并重新 login',
    skillDocText.includes('--http1.1') &&
      skillDocText.includes('唯一 subscription id') &&
      skillDocText.includes('重新 `network_login`'),
    skillDocText.slice(0, 200),
  );
  check(
    '静态技能要求超过 10 秒先发简短确认',
    skillDocText.includes('超过 10 秒') &&
      skillDocText.includes('简短确认') &&
      skillDocText.includes('不算完成'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能说明 URL token 流程与 Origin 边界',
    skillDocText.includes('network_issue_token') &&
      skillDocText.includes('AGENTNET_MCP_URL') &&
      skillDocText.includes('Origin 不再是认证边界'),
    skillDocText.slice(0, 240),
  );
  check(
    '静态技能包含三份 Harness 指南的相对链接',
    [
      '[Codex](./harness-codex.md)',
      '[ChatGPT Web](./harness-chatgpt-web.md)',
      '[Peri](./harness-peri.md)',
    ].every((link) => skillDocText.includes(link)),
    skillDocText.slice(0, 400),
  );
  const harnessDocs = [
    {
      file: 'harness-codex.md',
      markers: ['mcp_servers', 'bearer_token_env_var', '2026-07-28', 'Mcp-Method'],
    },
    {
      file: 'harness-chatgpt-web.md',
      markers: ['Connector', 'OAuth', 'MCP Events', '公网 HTTPS', '?token=<token>'],
    },
    {
      file: 'harness-peri.md',
      markers: [
        '.mcp.json',
        'streamable-http',
        'agentnet://stream',
        'network_login',
        'network_delivery_claim',
        'network_delivery_complete',
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

  const codexBridge = await fetch(`${baseUrl()}/skills/harness-codex.md`);
  checkEqual('GET /skills/harness-codex.md 返回 200（桥接指南）', codexBridge.status, 200);
  const codexBridgeText = await codexBridge.text();
  const codexBridgeMarkers = [
    'agentnet://stream',
    'notifications/subscriptions/acknowledged',
    'network_login',
    'network_inbox_list',
    'network_delivery_claim',
    'network_delivery_complete',
    'turn/start',
    'AGENTNET_MCP_URL',
    'share_url',
    'Unix WebSocket',
    'thread/read',
    'initialize',
    'codex app-server daemon version',
    'socketPath',
  ];
  check(
    'Codex 桥接指南覆盖订阅、上线、补读与 app-server 唤醒标记',
    codexBridgeMarkers.every((marker) => codexBridgeText.includes(marker)),
    { missing: codexBridgeMarkers.filter((marker) => !codexBridgeText.includes(marker)) },
  );
  check(
    'Codex 桥接指南要求 ack 后再 login，并在上线后补读 inbox',
    codexBridgeText.includes('收到 `notifications/subscriptions/acknowledged` 后') &&
      codexBridgeText.includes('network_login') &&
      codexBridgeText.includes('network_inbox_list') &&
      codexBridgeText.includes('补读'),
  );
  check(
    'Codex 桥接指南区分 MCP enabled 与 app-server turn 唤醒',
    codexBridgeText.includes('不代表') &&
      codexBridgeText.includes('不会让 app-server 主动消费') &&
      codexBridgeText.includes('https://developers.openai.com/codex/app-server'),
  );
  check(
    'Codex 桥接指南说明 room.message 与 delivery.created 去重',
    codexBridgeText.includes('room.message') &&
      codexBridgeText.includes('delivery.created') &&
      codexBridgeText.includes('不能分别回复两次'),
  );
  check(
    'Codex 桥接指南记录临时桥接器与单聊局限',
    codexBridgeText.includes('/tmp') &&
      codexBridgeText.includes('不是开机服务') &&
      codexBridgeText.includes('单聊') &&
      codexBridgeText.includes('不是通用多用户服务'),
  );
  check(
    'Codex 桥接指南说明 Unix WebSocket 与 app-server 省略 jsonrpc',
    codexBridgeText.includes('Unix WebSocket') &&
      codexBridgeText.includes('codex app-server proxy') &&
      codexBridgeText.includes('不能推断') &&
      codexBridgeText.includes('省略 `jsonrpc`'),
  );
  check(
    'Codex 桥接指南不包含真实 token 或完整含 token URL',
    !/Bearer\s+[0-9a-f]{8}-[0-9a-f]{4}/iu.test(codexBridgeText) &&
      !/[?&]token=[0-9a-f]{8}-[0-9a-f]{4}/iu.test(codexBridgeText) &&
      !/\b[0-9a-f]{32,}\b/iu.test(codexBridgeText),
  );

  // 房间文件工具由文档 agent 单独补写；这里只要求已归档工具全部覆盖。
  const documentedTools = toolNames.filter((name) => !roomFileTools.includes(name));
  const missingTools = documentedTools.filter((name) => !skillDocText.includes(name));
  check(
    `静态技能覆盖 tools/list 全部 ${documentedTools.length} 个已归档工具`,
    missingTools.length === 0,
    missingTools,
  );
  const pendingDocTools = roomFileTools.filter(
    (name) => toolNames.includes(name) && !skillDocText.includes(name),
  );
  if (pendingDocTools.length > 0) {
    console.log(`  · 房间文件工具文档待补: ${pendingDocTools.join(', ')}`);
  }

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

  console.log(`协议验收通过: ${checksPassed()} 项`);
}

await main().catch((error) => {
  console.error('协议验收失败:', error);
  process.exit(1);
});
