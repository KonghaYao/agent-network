/** 首次上线（issue/register/login）与 `me`。login 只建立推送门控，不改变投递状态。 */

import { newId, required } from '../options';
import { CliError, McpClient, type ResolvedConfig } from '../mcp';
import { asNumber, asString, emit, field, line } from '../output';

/**
 * 申请长期凭据。不依赖已有 token：即使环境里配置了 AGENTNET_TOKEN，
 * 这里也显式用匿名客户端，避免把旧身份带到首次上线流程。
 */
export async function issue(
  _client: McpClient,
  config: ResolvedConfig,
): Promise<void> {
  const anonymous = new McpClient({ ...config, token: null });
  const result = await anonymous.callTool('network_issue_token');
  emit(config, result, (value) => {
    const token = asString(value.token);
    const url = asString(value.url);
    line(field('token', token));
    line(field('url', url));
    line('MCP_URL=' + (url || config.endpoint));
    line('注意：凭据只给目标 Agent，勿发群、写入日志或截图。');
    line('丢失后只能重新申请并新建身份；服务端不保存原始 token。');
  });
}

export interface RegisterOptions {
  name?: string;
  session?: string;
  agentSessionId?: string;
  kind?: string;
  requestId?: string;
}

export async function register(
  client: McpClient,
  config: ResolvedConfig,
  options: RegisterOptions,
): Promise<void> {
  const kind = options.kind ?? 'agent';
  if (kind !== 'human' && kind !== 'agent') {
    throw new CliError('--kind 只支持 agent 或 human（运行 agentnet register --help 查看示例）');
  }
  const session = options.session ?? options.agentSessionId;
  if (kind === 'agent' && !session) {
    throw new CliError(
      '注册 Agent 需要 --session <agent-session-id>（运行 agentnet register --help 查看示例）',
    );
  }
  const requestId = options.requestId ?? newId('req');
  const result = await client.callTool('network_register', {
    request_id: requestId,
    kind,
    name: required(options.name, 'name', {
      suggestion: 'Agent 显示名',
      command: 'register',
    }),
    ...(session === undefined ? {} : { agent_session_id: session }),
  });
  emit(config, { ...result, request_id: requestId } as Record<string, unknown>, (value) => {
    line(
      `已注册 ${field('actor_id', asString(value.actor_id, '-'))} ${field(
        'kind',
        asString(value.kind, '-'),
      )} ${field('name', asString(value.name, '-'))}`,
    );
    line(
      `${field('agent_session_id', asString(value.agent_session_id, '-'))} ${field(
        'pending_count',
        asNumber(value.pending_count),
      )} ${field('inbox_head_seq', asString(value.inbox_head_seq, '-'))}`,
    );
    if (typeof value.share_url === 'string') line(field('share_url', value.share_url));
    line(`MCP_URL=${config.endpoint}`);
    line('下一步：保持 AGENTNET_TOKEN 不变，运行 agentnet login 上线。');
  });
}

export async function login(
  client: McpClient,
  config: ResolvedConfig,
): Promise<void> {
  const result = await client.callTool('network_login');
  emit(config, result, (value) => {
    line(
      `已上线 ${field('pending_count', asNumber(value.pending_count))} ${field(
        'inbox_head_seq',
        asString(value.inbox_head_seq, '-'),
      )}`,
    );
  });
}

export async function me(
  client: McpClient,
  config: ResolvedConfig,
): Promise<void> {
  const result = await client.callTool('network_me');
  emit(config, result, (value) => {
    line(`${asString(value.name, '(未命名)')} (${asString(value.actor_id, '-')})`);
    line(`kind=${asString(value.kind, '-')} pending_count=${asNumber(value.pending_count)}`);
    line(`inbox_head_seq=${asString(value.inbox_head_seq, '-')}`);
    if (typeof value.share_url === 'string') line(`share_url=${value.share_url}`);
  });
}
