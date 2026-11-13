import './telemetry';

import { MCPServer } from 'mcp-use';
import type { FileScope, FileService } from '@peri-code/mcpp/files';

import { CLIENT_INSTRUCTIONS } from './client-contract';
import { registerUploadTool } from './upload';
import { registerDriveTool } from '../drive/tool';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';
import { fileTicketSecret } from '../domain/file-ticket';
import { registerResources } from './resources';
import { createMessageFileArchiver, registerRoomFileTools } from './room-files';
import { registerArtifactTools } from './artifacts';
import { registerSkillResource } from './skill';
import { registerMemoryTools } from './memory';
import { SERVER_IDENTITY } from './identity';
import {
  mcpUseRegistrationServer,
  type RegistrationServer,
} from './registration';
import { registerTools, type ToolHooks } from './tools';

export interface DriveBinding {
  fileService: FileService;
  scope: () => FileScope;
}

function registerToolSet(
  server: RegistrationServer,
  env: Env,
  principal: Principal,
  drive?: DriveBinding,
): void {
  const hooks: ToolHooks =
    env.FILES && drive
      ? { afterMessageCommitted: createMessageFileArchiver(env, principal, drive) }
      : {};
  registerTools(server, env, principal, hooks);
  // Memory 工具始终注册；MEMORY_ENABLED=0 时工具返回 MEMORY_DISABLED，
  // 能力目录同时声明 memory.enabled=false，避免隐藏工具被误认为可调用。
  registerMemoryTools(server, env, principal);
  registerResources(server, env, principal);
  registerSkillResource(server);
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
}

/**
 * 构建本进程的 MCP 服务端：工具/资源走 `MCPServer.tool()` / `MCPServer.resource()`。
 *
 * `MCPServer` 没有公开的底层 `McpServer` 访问器，无法注册 `skills/*`、
 * `events/*` 这类自定义方法；这些方法由 `src/mcp/transport.ts` 在进入
 * mcp-use 前分发，`server/discover` 的能力目录由 compat 层修正。
 */
export function buildServer(
  env: Env,
  principal: Principal,
  drive?: DriveBinding,
): MCPServer {
  const server = new MCPServer({
    ...SERVER_IDENTITY,
    instructions: CLIENT_INSTRUCTIONS,
    basePath: '/mcp',
    legacy: 'reject',
    // 不启用约定目录的 Skills、landing、logging；技能面由 compat 层提供。
    skills: false,
    logging: { enabled: false },
  });
  registerToolSet(mcpUseRegistrationServer(server), env, principal, drive);
  return server;
}
