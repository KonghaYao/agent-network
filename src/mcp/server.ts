import { McpServer } from '@modelcontextprotocol/server';
import type { ServerCapabilities } from '@modelcontextprotocol/server';
import type { FileScope, FileService } from '@peri-code/mcpp/files';

import { CLIENT_INSTRUCTIONS } from './client-contract';
import { registerUploadTool } from './upload';
import { registerDriveTool } from '../drive/tool';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';
import { fileTicketSecret } from '../domain/file-ticket';
import { registerEvents } from './events';
import { registerResources } from './resources';
import { createMessageFileArchiver, registerRoomFileTools } from './room-files';
import { registerArtifactTools } from './artifacts';
import { registerSkill } from './skill';
import { registerTools, type ToolHooks } from './tools';

type WeBotsCapabilities = ServerCapabilities & { events?: Record<string, unknown> };

export interface DriveBinding {
  fileService: FileService;
  scope: () => FileScope;
}

export function buildServer(env: Env, principal: Principal, drive?: DriveBinding): McpServer {
  const instructions = CLIENT_INSTRUCTIONS;
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
      db: env.DB,
      ticketSecret: fileTicketSecret(env.FILE_TICKET_SECRET),
    });
    registerUploadTool(server, env, principal);
    registerRoomFileTools(server, env, principal, drive);
    registerArtifactTools(server, env, principal, drive);
  }
  return server;
}
