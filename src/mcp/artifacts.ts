import type { McpServer } from '@modelcontextprotocol/server';

import {
  artifactListSchema,
  artifactReleaseSchema,
  artifactSubmitSchema,
  filePublishSchema,
} from '../contracts/schemas';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';
import {
  artifactList,
  artifactRelease,
  artifactSubmit,
} from '../domain/artifacts';
import { publishFile } from '../domain/file-access';
import { fileTicketSecret } from '../domain/file-ticket';
import {
  artifactPageSchema,
  artifactReleasedSchema,
  artifactResultSchema,
  filePublishResultSchema,
} from './outputs';
import { createRoomFileSource, type RoomFileToolBinding } from './room-files';
import { register } from './tools';
import { requireActor } from './auth';

/**
 * 私有文件发布与成果保留工具。
 *
 * 与房间文件工具一起只在启用 MCPP Files 时注册；所有写操作都走
 * runIdempotent，配额与权限在同一事务内裁决。
 */
export function registerArtifactTools(
  server: McpServer,
  env: Env,
  principal: Principal,
  binding: RoomFileToolBinding,
): void {
  const db = env.DB;
  const origin = env.PUBLIC_ORIGIN;
  const secret = fileTicketSecret(env.FILE_TICKET_SECRET);
  const source = createRoomFileSource(binding);

  register(
    server,
    'network_file_publish',
    '显式发布或撤销发布文件。公开发布是独立、需有权限的动作，默认关闭；发布不会延长 TTL，公开文件仍受草稿 24 小时或附件 30 天期限约束。已绑定房间的文件只有上传者或群 owner（单聊仅上传者）可以操作；未绑定草稿只有上传者可以操作。撤销后公开 URL 立即 404，客户端应重新调用 network_room_file_get 或 drive_file_info 获取带票据地址。',
    filePublishSchema,
    filePublishResultSchema,
    async (input) => {
      requireActor(principal);
      return publishFile(db, principal, input, secret, origin);
    },
  );

  register(
    server,
    'network_artifact_submit',
    '提交交付成果：把当前身份自己的文件绑定到房间，作为独立成果版本持续保留，不再随 30 天附件 TTL 清理，直到有权限者显式释放。提交前检查房间文件数量/字节配额，超限整批失败，不产生半成品成果或房间文件。返回成果版本、文件票据地址与当前配额。',
    artifactSubmitSchema,
    artifactResultSchema,
    async (input) => {
      requireActor(principal);
      return artifactSubmit(db, principal, input, source, origin, secret);
    },
  );

  register(
    server,
    'network_artifact_list',
    '分页读取当前成员可见的成果版本，按提交时间倒序。群默认全历史，成员可见全部成果；群主收紧为 from_join 后只能看到加入后提交的成果。历史边界外的成果不返回。返回附带文件票据地址与房间保留配额。',
    artifactListSchema,
    artifactPageSchema,
    async (input) => {
      requireActor(principal);
      return artifactList(db, principal, input, origin, secret);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_artifact_release',
    '显式释放成果版本。只有成果提交者、文件上传者或群 owner 可以释放；若文件仍被其他有效成果引用，继续保留并返回 retained: true；否则恢复普通 30 天附件 TTL。释放是幂等的，重复调用返回同一结果。',
    artifactReleaseSchema,
    artifactReleasedSchema,
    async (input) => {
      requireActor(principal);
      return artifactRelease(db, principal, input);
    },
  );
}
