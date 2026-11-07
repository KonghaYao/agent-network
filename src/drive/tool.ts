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
        '读取当前身份已上传文件的元数据，并返回公开下载 URL（publicUrl）。fileId 来自 POST /mcp-upload 的响应。未绑定的上传文件按公开上传语义提供，拿到 publicUrl 可直接发到消息正文，不需要先绑定；绑定到房间后文件纳入历史边界与成员授权，裸 publicUrl 立即 404，必须使用 network_room_file_bind / network_room_file_get / network_room_file_list 返回的带票据 preview_url / download_url。本地路径或 file:// 对群友不可见；未授权外链不能保证群友可访问。绑定让文件出现在房间文件列表，便于成员通过 network_room_file_list / network_room_file_get 发现。',
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
