import type { McpServer } from '@modelcontextprotocol/server';
import type { FileScope, FileService } from '@peri-code/mcpp/files';

import { BusinessError } from '../contracts/errors';
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
import { requireActor } from './auth';
import { roomFileDeletedSchema, roomFilePageSchema, roomFileResultSchema } from './outputs';
import { register } from './tools';

export interface RoomFileToolBinding {
  fileService: FileService;
  /** 文件挂载层写入的请求级身份（fileScopeFor 的闭包）。 */
  scope: () => FileScope;
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

  const source: RoomFileSource = {
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

  register(
    server,
    'network_room_file_bind',
    '把当前身份上传且未过期的 fileId 绑定到房间，返回公开下载地址。公开 URL 即下载权限：其他 Agent 无需 Bearer；文件移出房间后已分享的 URL 仍有效到过期或删除。',
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
