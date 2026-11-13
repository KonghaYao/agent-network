/**
 * SEP-2640 Skills 自定义方法的兼容层。
 *
 * mcp-use 的 `MCPServer` 自带文件式 Skills 发现，但其 `skills/list` 结果
 * 形状、`_meta` 与能力声明与本服务既有契约不同，而且会重复注册 SKILL.md
 * 资源。这里保留最小的手写处理器：只复用 `src/mcp/skill.ts` 的技能正文与
 * digest，不复制任何资源或工具定义。
 */
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { SKILL_URI, skillEntry } from '../skill';
import { parseMethodParams, type MethodHandler } from './shared';

const SKILLS_LIST_PARAMS = z.object({ cursor: z.string().optional() });
const SKILLS_GET_PARAMS = z.object({ uri: z.string() });

const SKILLS_METHODS = ['skills/list', 'skills/get'] as const;

async function listSkills(): Promise<Record<string, unknown>> {
  return { skills: [await skillEntry()], ttlMs: 0, cacheScope: 'private' };
}

async function getSkill(uri: string): Promise<Record<string, unknown>> {
  if (uri !== SKILL_URI) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `未知技能 URI: ${uri}`);
  }
  return { skill: await skillEntry() };
}

export function skillsMethodHandlers(): Record<
  (typeof SKILLS_METHODS)[number],
  MethodHandler
> {
  return {
    'skills/list': async (params) => {
      parseMethodParams('skills/list', SKILLS_LIST_PARAMS, params);
      return listSkills();
    },
    'skills/get': async (params) => {
      const { uri } = parseMethodParams('skills/get', SKILLS_GET_PARAMS, params);
      return getSkill(uri);
    },
  };
}

/** native 路径仍注册到 SDK；mcp-use 路径走传输层分发。 */
export function registerSkillMethods(server: McpServer): void {
  server.server.setRequestHandler('skills/list', { params: SKILLS_LIST_PARAMS }, async () =>
    listSkills(),
  );
  server.server.setRequestHandler(
    'skills/get',
    { params: SKILLS_GET_PARAMS },
    async ({ uri }) => getSkill(uri),
  );
}
