import { FILE_ID_PATTERN, type FileScope, type FileService } from '@peri-code/mcpp/files';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Principal } from '../domain/principal';

export interface DriveToolBinding {
  fileService: FileService;
  /** 由文件挂载层写入的请求级身份（fileScopeFor 的闭包）。 */
  scope: () => FileScope;
  publicOrigin: string;
  principal: Principal;
}

export function publicFileUrl(publicOrigin: string, fileId: string): string {
  return `${publicOrigin.replace(/\/+$/u, '')}/f/${fileId}`;
}

function fileError(code: string, parameter: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ code, parameter, retryable: false }) }],
    structuredContent: { error: { code, parameter, retryable: false } },
  };
}

type RegisterToolCall = (
  name: string,
  config: Record<string, unknown>,
  callback: (args: { fileId: string }, context: unknown) => Promise<unknown>,
) => unknown;

/**
 * Drive 文件工具。
 *
 * 上传本身走 MCPP Files v1 的 `POST /mcp-upload`（原始字节 + MCPP 头）；
 * 这里按 fileId 返回元数据与公开下载 URL，并复用同一请求的 scope 校验，
 * 避免跨身份读取。参数保留 `x-mcpp-file` 标记，支持文件选择 UI 的客户端
 * 可以据此识别；服务端校验不依赖客户端能力声明，普通 MCP 客户端也能读取
 * 自己的文件。
 */
export function registerDriveTool(server: McpServer, binding: DriveToolBinding): void {
  const { fileService, scope, publicOrigin, principal } = binding;
  const register = server.registerTool as unknown as RegisterToolCall;

  register.call(
    server,
    'drive_file_info',
    {
      description:
        '读取当前身份已上传文件的元数据，并返回公开下载 URL。fileId 来自 POST /mcp-upload 的响应。',
      inputSchema: z.object({
        fileId: z
          .string()
          .regex(new RegExp(FILE_ID_PATTERN))
          .meta({ 'x-mcpp-file': { maxBytes: fileService.maxFileBytes } }),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
      if (!principal.actor) return fileError('FILE_UNAVAILABLE', 'fileId');
      let currentScope: FileScope;
      try {
        currentScope = scope();
      } catch {
        return fileError('FILE_UNAVAILABLE', 'fileId');
      }
      const record = await fileService.readRecord(fileId);
      if (
        !record ||
        record.ownerScope !== currentScope.key ||
        Date.parse(record.expiresAt) <= Date.now()
      ) {
        return fileError('FILE_UNAVAILABLE', 'fileId');
      }
      const info = {
        fileId: record.fileId,
        name: record.name,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        publicUrl: publicFileUrl(publicOrigin, record.fileId),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info) }],
        structuredContent: info,
      };
    },
  );
}
