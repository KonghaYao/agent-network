import { FILE_ID_PATTERN, type FileScope, type FileService } from '@peri-code/mcpp/files';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Principal } from '../domain/principal';
import {
  privateFileUrls,
  quotaForOwnerScope,
  registerDriveFile,
  roomFileUrls,
} from '../domain/file-access';
import { historyBoundary } from '../domain/room-history';
import { getMember, getRoom, getRoomFile } from '../storage/queries';

export interface DriveToolBinding {
  fileService: FileService;
  /** 由文件挂载层写入的请求级身份（fileScopeFor 的闭包）。 */
  scope: () => FileScope;
  publicOrigin: string;
  principal: Principal;
  db: D1Database;
  ticketSecret: string;
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
  const { fileService, scope, publicOrigin, principal, db, ticketSecret } = binding;
  const register = server.registerTool as unknown as RegisterToolCall;

  register.call(
    server,
    'drive_file_info',
    {
      description:
        '读取当前身份已上传文件的元数据、配额与带短时票据的访问地址（previewUrl / downloadUrl）。fileId 来自 POST /mcp-upload 的响应。上传默认是上传者私有草稿（24 小时）；裸 publicUrl 不携带票据时返回 404。network_room_file_bind 把文件绑定到房间后，读取按成员资格、成员代次与历史边界授权，必须使用返回的带票据地址；network_file_publish 是独立、需有权限的公开发布动作，默认关闭。旧版本未登记文件在首次授权读取时登记为私有，旧裸 URL 同样失效。本地路径或 file:// 对群友不可见；未授权外链不能保证群友可访问。',
      inputSchema: z.object({
        fileId: z
          .string()
          .regex(new RegExp(FILE_ID_PATTERN))
          .meta({ 'x-mcpp-file': { maxBytes: fileService.maxFileBytes } }),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId }) => {
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
      const drive = await registerDriveFile(db, record, principal.actor?.actor_id ?? null);
      if (drive.state === 'deleted') return fileError('FILE_UNAVAILABLE', 'fileId');

      let urls = privateFileUrls(ticketSecret, publicOrigin, record.fileId, record.ownerScope);
      if (drive.state === 'bound' && drive.room_id) {
        const [room, roomFile] = await Promise.all([
          getRoom(db, drive.room_id),
          getRoomFile(db, record.fileId),
        ]);
        if (!room || !roomFile) return fileError('FILE_UNAVAILABLE', 'fileId');
        if (drive.visibility === 'public') {
          urls = {
            public_url: urls.public_url,
            preview_url: urls.public_url,
            download_url: `${urls.public_url}?download=1`,
          };
        } else {
          const member = principal.actor
            ? await getMember(db, drive.room_id, principal.actor.actor_id)
            : null;
          if (!member || member.status !== 'active') {
            return fileError('FILE_UNAVAILABLE', 'fileId');
          }
          urls = roomFileUrls(
            ticketSecret,
            publicOrigin,
            record.fileId,
            drive.room_id,
            member.actor_id,
            historyBoundary(room, member),
          );
        }
      }

      const info = {
        fileId: record.fileId,
        name: record.name,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        createdAt: record.createdAt,
        expiresAt:
          drive.expires_at === null
            ? new Date(Date.parse(record.expiresAt)).toISOString()
            : new Date(drive.expires_at).toISOString(),
        state: drive.state,
        visibility: drive.visibility,
        retained: drive.retained === 1,
        publicUrl: urls.public_url,
        previewUrl: urls.preview_url,
        downloadUrl: urls.download_url,
        quota: await quotaForOwnerScope(db, record.ownerScope),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info) }],
        structuredContent: info,
      };
    },
  );
}
