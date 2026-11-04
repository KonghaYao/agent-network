import { McpServer } from '@modelcontextprotocol/server';
import type { ServerCapabilities } from '@modelcontextprotocol/server';
import type { FileScope, FileService } from '@peri-code/mcpp/files';

import { registerDriveTool } from '../drive/tool';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';
import { registerEvents } from './events';
import { registerResources } from './resources';
import { createMessageFileArchiver, registerRoomFileTools } from './room-files';
import { registerSkill } from './skill';
import { registerTools, type ToolHooks } from './tools';

type WeBotsCapabilities = ServerCapabilities & { events?: Record<string, unknown> };

export interface DriveBinding {
  fileService: FileService;
  scope: () => FileScope;
}

const INSTRUCTIONS = [
  'WeBots：通过标准 MCP 工具收发消息并领取 Agent 工作。',
  '没有可用凭据时，先调用无鉴权的 network_issue_token 获取 { token, url }；URL 可直接作为 MCP 端点，是长期凭据，由自己保存，不要公开或写日志。',
  '开始或恢复工作时：',
  '1. network_register 绑定当前会话；已注册会返回同一身份。',
  '2. 订阅唯一统一投递流 agentnet://stream，并先读一次该资源快照。',
  '3. 调用 network_login 显式上线；Agent 未上线不会收到任何 stream 通知（人类无需 login）。',
  '4. 通知的 params.uri 固定为 agentnet://stream，来源在 params._meta["io.agent-network/event"]；按 item 的 source/attention 读取 inbox、房间历史或快照。',
  '5. 只有 attention 为 action_required 的帧需要立即处理；informational 帧只更新本地视图。',
  '6. 没有状态不明的旧工作时，调用 network_delivery_claim 原子领取一条。',
  '7. 用 network_message_read 读取正文，必要时回读房间历史。',
  '8. 执行后调用 network_delivery_complete，可附带最终答复消息；失败用 network_delivery_fail。',
  '9. 仍有待办则继续下一条，否则保持订阅等待。',
  '订阅连接断开即离线；重连后先建立 agentnet://stream，再调用 network_login，并读快照补齐。',
  '通知不带正文、preview 或 claim_id；stream 是提示通道，SQLite 读取结果才是权威。',
  '普通回复不要填写 invoke；不要轮询；不要用长时间 tools/call 代替订阅。',
  '归档只是管理列表标记：network_agent_archive / network_agent_unarchive 不改变消息、好友、房间、投递、凭据或在线状态，也不能恢复 MCP URL 或 token。',
  '通知只表示资源发生变化，正文和业务状态始终以 SQLite 读取结果为准。',
].join('\n');

export function buildServer(env: Env, principal: Principal, drive?: DriveBinding): McpServer {
  const instructions = env.EVENTS
    ? `${INSTRUCTIONS}\nMCP Events：客户端可用 webhook 订阅 agentnet.message.created；事件只含 ID、状态与时间，收到后先用工具读取正文，并按 eventId 去重。`
    : INSTRUCTIONS;
  const capabilities: WeBotsCapabilities = {
    tools: {},
    resources: { subscribe: true },
    // SEP-2640：声明 Skills 扩展后，客户端才走 skills/list 发现路径。
    extensions: { 'io.modelcontextprotocol/skills': {} },
    // MCP Events 是顶层能力（不是 extensions）；配置无效时不声明。
    ...(env.EVENTS ? { events: {} } : {}),
  };
  const server = new McpServer(
    { name: 'peri-agent-network', title: 'WeBots', version: '0.1.0' },
    {
      capabilities,
      instructions,
    },
  );
  const hooks: ToolHooks =
    env.FILES && drive
      ? { afterMessageCommitted: createMessageFileArchiver(env, principal, drive) }
      : {};
  registerTools(server, env, principal, hooks);
  registerResources(server, env, principal);
  registerSkill(server);
  if (env.EVENTS) registerEvents(server, env, principal);
  if (env.FILES && drive) {
    registerDriveTool(server, {
      ...drive,
      publicOrigin: env.PUBLIC_ORIGIN,
      principal,
    });
    registerRoomFileTools(server, env, principal, drive);
  }
  return server;
}
