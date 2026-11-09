import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { fileTicketSecret } from '../domain/file-ticket';
import type { Principal } from '../domain/principal';
import type { Env } from '../env';
import { issueUploadTicket, UPLOAD_TICKET_HEADER, uploadMetadataSchema } from '../drive/upload-ticket';
import { requireActor } from './auth';
import { register } from './tools';

export function registerUploadTool(server: McpServer, env: Env, principal: Principal): void {
  if (!env.FILES) return;
  const maxBytes = env.FILES.maxFileBytes;
  register(server, 'network_file_upload_prepare',
    '为当前身份准备文件上传，返回仅对指定文件名/MIME/大小/SHA-256 有效的 5 分钟上传凭证、URL 与完整请求头。先在宿主计算原始文件 SHA-256，再向 upload_url POST 原始字节并原样带 headers；无需获取或转发长期 token。上传时复核签发凭据仍有效，沿用文件大小/并发/配额限制；不读取本地路径、不抓取外部 URL、不自动发消息或公开文件。上传不是幂等操作：重放可能创建相同内容的新文件，响应丢失不要盲目重传。成功后核验 size/sha256，再以同身份 network_room_file_bind，分享带票据 download_url。凭证不得放进群消息或日志。',
    uploadMetadataSchema.extend({ size: z.number().int().nonnegative().max(maxBytes) }),
    z.object({
      actor_id: z.string(), upload_url: z.string(), method: z.literal('POST'),
      headers: z.record(z.string(), z.string()), expires_at: z.string(),
      max_file_bytes: z.number(),
    }),
    async (input) => {
      const actor = requireActor(principal);
      const { ticket, expires_at } = issueUploadTicket(fileTicketSecret(env.FILE_TICKET_SECRET), principal, input);
      return {
        actor_id: actor.actor_id,
        upload_url: `${env.PUBLIC_ORIGIN.replace(/\/+$/u, '')}/mcp-upload`,
        method: 'POST' as const,
        headers: {
          [UPLOAD_TICKET_HEADER]: ticket,
          'MCPP-Files-Version': '1',
          'Content-Type': input.mime_type.toLowerCase(),
          'MCPP-File-Name': encodeURIComponent(input.name),
          'MCPP-File-Size': String(input.size),
          'MCPP-File-Sha256': input.sha256,
        },
        expires_at: new Date(expires_at).toISOString(),
        max_file_bytes: maxBytes,
      };
    }, { readOnlyHint: false, destructiveHint: false }, { safeErrors: true });
}
