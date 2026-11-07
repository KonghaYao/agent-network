import type { McpServer } from '@modelcontextprotocol/server';
import type { FileScope, FileService } from '@peri-code/mcpp/files';

import { BusinessError } from '../contracts/errors';
import { extractMessageFileLinks } from '../contracts/file-links';
import {
  roomFileBindSchema,
  roomFileDeleteSchema,
  roomFileGetSchema,
  roomFileListSchema,
} from '../contracts/schemas';
import {
  roomFileBind,
  roomFileDelete,
  roomFileGet,
  roomFileList,
  type RoomFileSource,
} from '../domain/room-files';
import type { Principal } from '../domain/principal';
import { purgeFilePayloads } from '../drive/service';
import type { Env } from '../env';
import { getRoomFile } from '../storage/queries';
import { requireActor } from './auth';
import { roomFileDeletedSchema, roomFilePageSchema, roomFileResultSchema } from './outputs';
import { register, type MessageCommittedHookInput } from './tools';

export interface RoomFileToolBinding {
  fileService: FileService;
  /** 文件挂载层写入的请求级身份（fileScopeFor 的闭包）。 */
  scope: () => FileScope;
}

/** 绑定与自动归档共用的文件前置：只返回当前身份自己的记录。 */
function createRoomFileSource(binding: RoomFileToolBinding): RoomFileSource {
  return {
    async readFile(fileId) {
      let current: FileScope;
      try {
        current = binding.scope();
      } catch {
        throw new BusinessError('DRIVE_UNAVAILABLE', '文件存储上下文不可用');
      }
      let record: Awaited<ReturnType<FileService['readRecord']>>;
      try {
        record = await binding.fileService.readRecord(fileId);
      } catch {
        throw new BusinessError('DRIVE_UNAVAILABLE', '文件存储暂不可用');
      }
      if (!record || record.ownerScope !== current.key) return null;
      return {
        name: record.name,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        expiresAt: record.expiresAt,
        ownerScope: record.ownerScope,
      };
    },
  };
}

/**
 * 消息提交后的自动归档（best-effort）。
 *
 * 由 `network_message_send` 与带 `final_body` 的 `network_delivery_complete`
 * 在消息事务提交后触发。只处理正文中的同源 `/f/<fileId>`，且仅当发送者
 * 拥有该文件、文件未过期、尚未绑定到任何房间时才调用 `roomFileBind`。
 * 任何失败（他人文件、跨房间 CONFLICT、配额、Drive 不可用、幂等冲突等）
 * 都只跳过当前文件，不影响已提交的消息响应。归档在消息事务之外串行执行，
 * 消息事务本身不感知文件。
 */
export function createMessageFileArchiver(
  env: Env,
  principal: Principal,
  binding: RoomFileToolBinding,
): (input: MessageCommittedHookInput) => Promise<void> {
  const source = createRoomFileSource(binding);
  return async (input) => {
    const fileIds = extractMessageFileLinks(input.body, env.PUBLIC_ORIGIN);
    if (fileIds.length === 0) return;

    for (const fileId of fileIds) {
      try {
        // 已绑定（含跨房间与墓碑）不重复处理；新消息不能改写旧绑定。
        if (await getRoomFile(env.DB, fileId)) continue;
        const file = await source.readFile(fileId);
        if (!file || Date.parse(file.expiresAt) <= Date.now()) continue;
        await roomFileBind(
          env.DB,
          principal,
          {
            request_id: `auto_bind:${input.messageId}:${fileId}`,
            room_id: input.roomId,
            file_id: fileId,
          },
          source,
          env.PUBLIC_ORIGIN,
        );
      } catch {
        // best-effort：FILE_UNAVAILABLE / CONFLICT / ROOM_FILE_LIMIT /
        // NOT_MEMBER / DRIVE_UNAVAILABLE / IDEMPOTENCY_CONFLICT 等一律跳过。
        continue;
      }
    }
  };
}

/**
 * 房间文件工具。
 *
 * 只在启用 MCPP Files 时注册；公开 URL 仍由 `/f/<file_id>` 提供，
 * 绑定/删除不会改变文件本身的过期时间，也不提供续期接口。
 */
export function registerRoomFileTools(
  server: McpServer,
  env: Env,
  principal: Principal,
  binding: RoomFileToolBinding,
): void {
  const db = env.DB;
  const origin = env.PUBLIC_ORIGIN;
  const source = createRoomFileSource(binding);

  register(
    server,
    'network_room_file_bind',
    '把当前身份上传且未过期的 fileId 绑定到房间，返回公开下载地址 file.public_url。绑定只用于让文件出现在房间文件列表，房间成员可用 network_room_file_list / network_room_file_get 发现；它不是下载前提，上传后拿到 publicUrl 即可直接分享。未绑定的上传文件不在房间文件列表，只能靠上传响应的 publicUrl 或已知 /f/<fileId> 链接下载。公开 URL 即下载权限：其他 Agent 无需 Bearer；成员被移出房间不影响已分享 URL，删除房间文件或过期才 404。',
    roomFileBindSchema,
    roomFileResultSchema,
    async (input) => {
      requireActor(principal);
      return roomFileBind(db, principal, input, source, origin);
    },
  );

  register(
    server,
    'network_room_file_list',
    '分页读取房间内未删除、未过期的文件，按绑定时间倒序。成员才可读取；后加入的成员可见历史文件。',
    roomFileListSchema,
    roomFilePageSchema,
    async (input) => {
      requireActor(principal);
      return roomFileList(db, principal, input, origin);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_file_get',
    '读取房间内单个文件的元数据与公开地址；已删除或已过期返回 FILE_UNAVAILABLE。',
    roomFileGetSchema,
    roomFileResultSchema,
    async (input) => {
      requireActor(principal);
      return roomFileGet(db, principal, input, origin);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_file_delete',
    '删除房间文件。上传者可删除自己的文件，单聊只有上传者可以删除，群 owner 可删除群内任意文件。删除写墓碑：公开 URL 立即 404 且不会复活。',
    roomFileDeleteSchema,
    roomFileDeletedSchema,
    async (input) => {
      requireActor(principal);
      const result = await roomFileDelete(db, principal, input);
      // 墓碑已提交；磁盘回收失败不回滚业务结果。
      void purgeFilePayloads(binding.fileService, input.file_id).catch(() => undefined);
      return result;
    },
  );
}
