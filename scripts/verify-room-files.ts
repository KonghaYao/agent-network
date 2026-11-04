/**
 * 房间绑定文件验收：bind/list/get/delete、配额、墓碑、/f 的 HEAD/Range/304
 * 与统一流 `room.file` 事件。
 *
 * 需要独立实例，避免影响并行验收：
 *
 *   DATA_DIR=/tmp/an-roomfiles-verify PORT=18880 PUBLIC_ORIGIN=http://127.0.0.1:18880 \
 *     bun src/bun/main.ts
 *   AGENTNET_URL=http://127.0.0.1:18880 DATA_DIR=/tmp/an-roomfiles-verify \
 *     bun scripts/verify-room-files.ts
 *
 * 数据库级用例（过期、墓碑清理、房间配额）需要直连 DATA_DIR 下的 SQLite；
 * 远端目标没有本地库时自动跳过，并在输出中标注。
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LIMITS } from '../src/contracts/limits';
import { filePreviewKind } from '../src/drive/service';
import { maintain } from '../src/maintenance';
import { createD1 } from '../src/bun/d1';
import type { Env } from '../src/env';
import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  uploadTestFile,
  type McpConnection,
  type UploadedTestFile,
} from './lib/harness';
import { registerIdentity, sendMessage, type RoomDetail } from './lib/acceptance-helpers';
import { runAutoArchiveCases, runFileLinkParserCases } from './lib/room-file-archive';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface RoomFileView {
  room_file_id: string;
  room_id: string;
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  public_url: string;
  preview_url: string;
  download_url: string;
  preview_kind: string;
  uploader_id: string;
  uploader_name: string;
  can_delete: boolean;
  created_at: string;
  expires_at: string;
}

interface RoomFilePage {
  items: RoomFileView[];
  next_cursor: string | null;
  has_more: boolean;
}

function bind(
  connection: McpConnection,
  roomId: string,
  fileId: string,
  requestId = newRequestId('bind'),
): Promise<{ file: RoomFileView }> {
  return callTool(connection.client, 'network_room_file_bind', {
    request_id: requestId,
    room_id: roomId,
    file_id: fileId,
  });
}

function listFiles(
  connection: McpConnection,
  roomId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<RoomFilePage> {
  return callTool(connection.client, 'network_room_file_list', {
    room_id: roomId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

function getFile(connection: McpConnection, roomId: string, fileId: string): Promise<{ file: RoomFileView }> {
  return callTool(connection.client, 'network_room_file_get', { room_id: roomId, file_id: fileId });
}

function deleteFile(
  connection: McpConnection,
  roomId: string,
  fileId: string,
  requestId = newRequestId('rmfile'),
): Promise<{ file_id: string; deleted: true }> {
  return callTool(connection.client, 'network_room_file_delete', {
    request_id: requestId,
    room_id: roomId,
    file_id: fileId,
  });
}

async function createGroup(connection: McpConnection, member: string, title: string): Promise<string> {
  const detail = await callTool<RoomDetail>(connection.client, 'network_room_create', {
    request_id: newRequestId('room'),
    kind: 'group',
    members: [member],
    title,
  });
  return detail.room.room_id;
}

interface StreamItemView {
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  message_id?: string;
  file_id?: string;
  ref_id?: string;
}

function streamItems(
  events: { params: Record<string, unknown> }[],
  source: string,
): StreamItemView[] {
  const items: StreamItemView[] = [];
  for (const event of events) {
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
    for (const item of payload?.items ?? []) {
      if (item.source === source) items.push(item);
    }
  }
  return items;
}

function streamFileItems(
  events: { params: Record<string, unknown> }[],
): StreamItemView[] {
  return streamItems(events, 'room.file');
}

/** 直连同一 SQLite 的数据库级用例；没有本地库（远端验收）时返回 null。 */
function openLocalDb(): { db: Database; d1: D1Database } | null {
  const dataDir = process.env.DATA_DIR ?? '.data';
  const path = process.env.AGENTNET_DB ?? join(dataDir, 'agent-network.sqlite');
  if (!existsSync(path)) return null;
  const db = new Database(path, { readwrite: true });
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return { db, d1: createD1(db) };
}

function syntheticFileId(): string {
  return `f_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

async function databaseCases(
  connection: McpConnection,
  recipientConnection: McpConnection,
  recipientId: string,
  actorIdValue: string,
  rooms: { quota: string; byte: string; expiry: string; cleanup: string },
): Promise<void> {
  const local = openLocalDb();
  if (!local) {
    console.log('  · 跳过数据库级用例：未找到本地 SQLite（设置 DATA_DIR 后重跑）');
    return;
  }
  const { db, d1 } = local;
  const insertSynthetic = db.prepare(
    `INSERT INTO room_files
       (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
        created_at, expires_at, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, NULL, NULL)`,
  );
  const now = Date.now();

  try {
    // 数量配额：先塞满 199 个，再绑定真实文件应成功一次、下一次失败。
    const nearFull = db.transaction(() => {
      for (let index = 0; index < LIMITS.roomFilesPerRoom - 1; index += 1) {
        insertSynthetic.run(
          `rf_${crypto.randomUUID().replace(/-/g, '')}`,
          rooms.quota,
          syntheticFileId(),
          actorIdValue,
          `quota-${index}.txt`,
          1,
          'a'.repeat(64),
          now,
          now + 60 * 60_000,
        );
      }
    });
    nearFull();
    check('数量配额：房间已被预置到上限前一条', true);

    const dbFile = await uploadTestFile(connection.token, {
      name: 'quota.txt',
      mimeType: 'text/plain',
      body: 'q',
    });
    const filled = await bind(connection, rooms.quota, dbFile.fileId);
    checkEqual('数量配额：达到上限的最后一条可以绑定', filled.file.file_id, dbFile.fileId);
    const overflowFile = await uploadTestFile(connection.token, {
      name: 'quota-overflow.txt',
      mimeType: 'text/plain',
      body: 'q',
    });
    await expectToolError(
      '数量配额：超过 200 个返回 ROOM_FILE_LIMIT',
      bind(connection, rooms.quota, overflowFile.fileId),
      'ROOM_FILE_LIMIT',
    );

    // 配额满时消息仍成功；自动归档 best-effort 跳过，不新增 room_files。
    const archiveOverflow = await uploadTestFile(connection.token, {
      name: 'quota-auto.txt',
      mimeType: 'text/plain',
      body: 'q',
    });
    const quotaMessage = await sendMessage(
      connection,
      rooms.quota,
      `配额满自动归档 ${archiveOverflow.publicUrl}`,
    );
    check('数量配额满时含文件链接的消息仍成功', Boolean(quotaMessage.message.message_id));
    const quotaCount = db
      .prepare(
        'SELECT COUNT(*) AS n FROM room_files WHERE room_id = ? AND deleted_at IS NULL AND expires_at > ?',
      )
      .get(rooms.quota, now) as { n: number };
    checkEqual('数量配额满时自动归档跳过', quotaCount.n, LIMITS.roomFilesPerRoom);
    check(
      '数量配额满时新文件未写入 room_files',
      db.prepare('SELECT 1 AS ok FROM room_files WHERE file_id = ?').get(archiveOverflow.fileId) ===
        null,
    );

    // 配额满时 final_body 自动归档同样 best-effort 跳过，complete 仍成功。
    const quotaFinal = await uploadTestFile(recipientConnection.token, {
      name: 'quota-final.txt',
      mimeType: 'text/plain',
      body: 'q',
    });
    const quotaTrigger = await sendMessage(connection, rooms.quota, '配额满 final_body', {
      invoke: [recipientId],
    });
    const quotaInbox = await callTool<{
      items: { delivery_id: string; message_id: string }[];
    }>(recipientConnection.client, 'network_inbox_list', { state: 'pending', limit: 50 });
    const quotaDelivery = quotaInbox.items.find(
      (item) => item.message_id === quotaTrigger.message.message_id,
    );
    check('数量配额满 final_body：找到待办', Boolean(quotaDelivery), quotaInbox.items);
    const quotaClaimed = await callTool<{
      delivery_id: string;
      attempt: number;
      claim_id: string | null;
    }>(recipientConnection.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: quotaDelivery!.delivery_id,
    });
    const quotaCompleted = await callTool<{ message: { message_id: string } | null }>(
      recipientConnection.client,
      'network_delivery_complete',
      {
        request_id: newRequestId('complete'),
        delivery_id: quotaClaimed.delivery_id,
        attempt: quotaClaimed.attempt,
        claim_id: quotaClaimed.claim_id ?? '',
        final_body: `配额满最终文件 ${quotaFinal.publicUrl}`,
      },
    );
    check('数量配额满 final_body complete 仍成功', Boolean(quotaCompleted.message));
    const quotaFinalCount = db
      .prepare(
        'SELECT COUNT(*) AS n FROM room_files WHERE room_id = ? AND deleted_at IS NULL AND expires_at > ?',
      )
      .get(rooms.quota, now) as { n: number };
    checkEqual('数量配额满 final_body 自动归档跳过', quotaFinalCount.n, LIMITS.roomFilesPerRoom);
    check(
      '数量配额满 final_body 文件未写入 room_files',
      db.prepare('SELECT 1 AS ok FROM room_files WHERE file_id = ?').get(quotaFinal.fileId) ===
        null,
    );

    // 字节配额：预置接近 1 GiB 的占用，再绑定小文件触发上限。
    insertSynthetic.run(
      `rf_${crypto.randomUUID().replace(/-/g, '')}`,
      rooms.byte,
      syntheticFileId(),
      actorIdValue,
      'huge.bin',
      LIMITS.roomFileBytesPerRoom - 16,
      'b'.repeat(64),
      now,
      now + 60 * 60_000,
    );
    const byteFile = await uploadTestFile(connection.token, {
      name: 'bytes.bin',
      mimeType: 'application/octet-stream',
      body: 'x'.repeat(64),
    });
    await expectToolError(
      '字节配额：超过 1 GiB 返回 ROOM_FILE_LIMIT',
      bind(connection, rooms.byte, byteFile.fileId),
      'ROOM_FILE_LIMIT',
    );

    // 过期：直接改写 expires_at（保持 expires_at > created_at 的约束）。
    const expiryFile = await uploadTestFile(connection.token, {
      name: 'expiring.txt',
      mimeType: 'text/plain',
      body: 'expiring',
    });
    await bind(connection, rooms.expiry, expiryFile.fileId);
    // 两个时间一起前移 60 秒：既保持 expires_at > created_at 的约束，又不依赖时钟边界。
    db.prepare(
      `UPDATE room_files
          SET created_at = created_at - 60000, expires_at = created_at - 59999
        WHERE file_id = ?`,
    ).run(expiryFile.fileId);
    const expiredDownload = await fetch(`${baseUrl()}/f/${expiryFile.fileId}`);
    checkEqual('过期房间文件的公开 URL 返回 404', expiredDownload.status, 404);
    await expectToolError(
      '过期房间文件 get 返回 FILE_UNAVAILABLE',
      getFile(connection, rooms.expiry, expiryFile.fileId),
      'FILE_UNAVAILABLE',
    );
    const expiredList = await listFiles(connection, rooms.expiry);
    check(
      '过期房间文件不出现在列表',
      !expiredList.items.some((item) => item.file_id === expiryFile.fileId),
      expiredList.items.map((item) => item.file_id),
    );

    // TTL 清理：过期超过宽限期的行被 maintenance 删除，未过期的行保留。
    const oldCreated = now - 10 * 24 * 60 * 60_000;
    insertSynthetic.run(
      `rf_${crypto.randomUUID().replace(/-/g, '')}`,
      rooms.cleanup,
      syntheticFileId(),
      actorIdValue,
      'stale.txt',
      1,
      'c'.repeat(64),
      oldCreated,
      now - LIMITS.roomFileTombstoneGraceMs - 60_000,
    );
    const fresh = await uploadTestFile(connection.token, {
      name: 'fresh.txt',
      mimeType: 'text/plain',
      body: 'fresh',
    });
    await bind(connection, rooms.cleanup, fresh.fileId);
    await maintain({ DB: d1 } as unknown as Env);
    const staleCount = db
      .prepare('SELECT COUNT(*) AS n FROM room_files WHERE room_id = ? AND name = ?')
      .get(rooms.cleanup, 'stale.txt') as { n: number };
    checkEqual('maintenance 清理过期宽限期后的房间文件行', staleCount.n, 0);
    const freshCount = db
      .prepare('SELECT COUNT(*) AS n FROM room_files WHERE file_id = ?')
      .get(fresh.fileId) as { n: number };
    checkEqual('maintenance 保留未过期房间文件', freshCount.n, 1);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  console.log(`房间文件验收: ${baseUrl()}`);
  runFileLinkParserCases();
  const aConn = await connectClient(newToken());
  const bConn = await connectClient(newToken());
  const cConn = await connectClient(newToken());

  try {
    const a = await registerIdentity(aConn, {
      kind: 'agent',
      name: '文件验收 Agent A',
      sessionId: `roomfiles_a_${crypto.randomUUID()}`,
    });
    const b = await registerIdentity(bConn, {
      kind: 'agent',
      name: '文件验收 Agent B',
      sessionId: `roomfiles_b_${crypto.randomUUID()}`,
    });
    const c = await registerIdentity(cConn, {
      kind: 'agent',
      name: '文件验收 Agent C',
      sessionId: `roomfiles_c_${crypto.randomUUID()}`,
    });
    await callTool(aConn.client, 'network_contact_add', {
      request_id: newRequestId('friend'),
      actor_id: b.actor_id,
    });

    const roomId = await createGroup(aConn, b.actor_id, '房间文件验收群');
    const conflictRoom = await createGroup(aConn, b.actor_id, '房间文件冲突群');
    const pageRoom = await createGroup(aConn, b.actor_id, '房间文件分页群');
    const quotaRoom = await createGroup(aConn, b.actor_id, '房间文件配额群');
    const byteRoom = await createGroup(aConn, b.actor_id, '房间文件字节群');
    const expiryRoom = await createGroup(aConn, b.actor_id, '房间文件过期群');
    const cleanupRoom = await createGroup(aConn, b.actor_id, '房间文件清理群');
    const archiveRoom = await createGroup(aConn, b.actor_id, '消息文件自动归档群');
    const archiveSecondRoom = await createGroup(aConn, b.actor_id, '消息文件自动归档二群');

    const textBody = 'room file payload';
    const uploaded = await uploadTestFile(aConn.token, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      body: textBody,
    });

    const baseline = await fetch(uploaded.publicUrl);
    checkEqual('未绑定的普通文件仍可公开下载', baseline.status, 200);

    const requestId = newRequestId('bind');
    const bound = await bind(aConn, roomId, uploaded.fileId, requestId);
    check(
      'bind 返回 rf_ 前缀的 room_file_id',
      /^rf_[a-f0-9]{32}$/u.test(bound.file.room_file_id),
      bound.file.room_file_id,
    );
    checkEqual('bind 返回原始 file_id', bound.file.file_id, uploaded.fileId);
    checkEqual('bind 返回房间 ID', bound.file.room_id, roomId);
    checkEqual('bind 返回上传者', bound.file.uploader_id, a.actor_id);
    checkEqual('bind 返回上传者名称', bound.file.uploader_name, a.name);
    checkEqual('bind 返回大小', bound.file.size, new TextEncoder().encode(textBody).length);
    checkEqual('bind 返回 sha256', bound.file.sha256, uploaded.sha256);
    checkEqual('public_url 由 PUBLIC_ORIGIN 派生', bound.file.public_url, `${baseUrl()}/f/${uploaded.fileId}`);
    checkEqual('preview_url 与 public_url 一致', bound.file.preview_url, bound.file.public_url);
    checkEqual('download_url 强制下载', bound.file.download_url, `${bound.file.public_url}?download=1`);
    checkEqual('text/plain 预览分类为 text', bound.file.preview_kind, 'text');
    checkEqual('上传者可以删除', bound.file.can_delete, true);
    check(
      'expires_at 在 created_at 之后且不超过 30 天',
      Number(bound.file.expires_at) > Number(bound.file.created_at) &&
        Number(bound.file.expires_at) - Number(bound.file.created_at) <= LIMITS.roomFileTtlMs,
      { created_at: bound.file.created_at, expires_at: bound.file.expires_at },
    );
    checkEqual(
      '预览分类：SVG/HTML/XML/JS/未知一律 download',
      [
        filePreviewKind('image/svg+xml'),
        filePreviewKind('text/html'),
        filePreviewKind('application/xml'),
        filePreviewKind('application/javascript'),
        filePreviewKind('application/octet-stream'),
        filePreviewKind('image/png'),
        filePreviewKind('application/pdf'),
        filePreviewKind('audio/mpeg'),
        filePreviewKind('video/mp4'),
      ].join(','),
      'download,download,download,download,download,image,pdf,audio,video',
    );

    const replay = await bind(aConn, roomId, uploaded.fileId, requestId);
    checkEqual('相同 request_id 幂等重放返回同一文件', replay.file.room_file_id, bound.file.room_file_id);
    const rebound = await bind(aConn, roomId, uploaded.fileId);
    checkEqual('同房间换 request_id 重复绑定收敛到同一行', rebound.file.room_file_id, bound.file.room_file_id);
    const afterRebindList = await listFiles(aConn, roomId);
    checkEqual(
      '重复绑定不产生第二行',
      afterRebindList.items.filter((item) => item.file_id === uploaded.fileId).length,
      1,
    );
    await expectToolError(
      '同一 request_id 换房间返回 IDEMPOTENCY_CONFLICT',
      bind(aConn, conflictRoom, uploaded.fileId, requestId),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectToolError(
      '同一文件绑定到其他房间返回 CONFLICT',
      bind(aConn, conflictRoom, uploaded.fileId),
      'CONFLICT',
    );
    await expectToolError(
      '他人 fileId 绑定返回 FILE_UNAVAILABLE',
      bind(bConn, conflictRoom, uploaded.fileId),
      'FILE_UNAVAILABLE',
    );
    await expectToolError(
      '非成员绑定返回 NOT_MEMBER',
      bind(cConn, roomId, uploaded.fileId),
      'NOT_MEMBER',
    );

    const listA = await listFiles(aConn, roomId);
    checkEqual('list 返回已绑定文件', listA.items.length, 1);
    checkEqual('list 第一项就是刚绑定的文件', listA.items[0]?.file_id, uploaded.fileId);
    const listB = await listFiles(bConn, roomId);
    checkEqual('后加入的成员可见历史文件', listB.items[0]?.file_id, uploaded.fileId);
    checkEqual('非上传者的 can_delete 为 false', listB.items[0]?.can_delete, false);
    await expectToolError('非成员 list 返回 NOT_MEMBER', listFiles(cConn, roomId), 'NOT_MEMBER');

    const got = await getFile(bConn, roomId, uploaded.fileId);
    checkEqual('get 返回文件元数据', got.file.room_file_id, bound.file.room_file_id);
    await expectToolError(
      'get 用错房间返回 FILE_UNAVAILABLE',
      getFile(bConn, conflictRoom, uploaded.fileId),
      'FILE_UNAVAILABLE',
    );
    await expectToolError(
      'get 非成员返回 NOT_MEMBER',
      getFile(cConn, roomId, uploaded.fileId),
      'NOT_MEMBER',
    );

    // 群 owner 可以删除任意成员上传的文件；成员只能删自己的。
    const bUpload = await uploadTestFile(bConn.token, {
      name: 'b-report.txt',
      mimeType: 'text/plain',
      body: 'from agent b',
    });
    const bBound = await bind(bConn, roomId, bUpload.fileId);
    checkEqual('成员可以绑定自己的文件', bBound.file.uploader_id, b.actor_id);
    const listOwner = await listFiles(aConn, roomId);
    checkEqual(
      '群 owner 对他人文件 can_delete 为 true',
      listOwner.items.find((item) => item.file_id === bUpload.fileId)?.can_delete,
      true,
    );
    await expectToolError(
      '单聊/群成员不能删他人文件',
      deleteFile(bConn, roomId, uploaded.fileId),
      'NOT_OWNER',
    );

    // 单聊没有群 owner：只有上传者可以删除。
    const directRoom = await callTool<RoomDetail>(aConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [c.actor_id],
    });
    const directFile = await uploadTestFile(aConn.token, {
      name: 'direct.txt',
      mimeType: 'text/plain',
      body: 'direct room file',
    });
    await bind(aConn, directRoom.room.room_id, directFile.fileId);
    await expectToolError(
      '单聊中非上传者不能删除文件',
      deleteFile(cConn, directRoom.room.room_id, directFile.fileId),
      'NOT_OWNER',
    );
    const directDeleted = await deleteFile(aConn, directRoom.room.room_id, directFile.fileId);
    checkEqual('单聊上传者可以删除自己的文件', directDeleted.deleted, true);

    // 分页：3 个文件，limit=2，按 created_at DESC 且游标不重复。
    const pageFiles: UploadedTestFile[] = [];
    for (let index = 0; index < 3; index += 1) {
      const file = await uploadTestFile(aConn.token, {
        name: `page-${index}.txt`,
        mimeType: 'text/plain',
        body: `page ${index}`,
      });
      pageFiles.push(file);
      await bind(aConn, pageRoom, file.fileId);
    }
    const firstPage = await listFiles(aConn, pageRoom, { limit: 2 });
    checkEqual('分页第一页返回 2 条', firstPage.items.length, 2);
    checkEqual('分页第一页 has_more', firstPage.has_more, true);
    check('分页第一页返回 next_cursor', Boolean(firstPage.next_cursor));
    await expectToolError(
      '游标不能跨房间复用',
      listFiles(aConn, roomId, {
        limit: 2,
        ...(firstPage.next_cursor ? { cursor: firstPage.next_cursor } : {}),
      }),
      'INVALID_ARGUMENT',
    );
    const secondPage = await listFiles(aConn, pageRoom, {
      limit: 2,
      ...(firstPage.next_cursor ? { cursor: firstPage.next_cursor } : {}),
    });
    checkEqual('分页第二页返回剩余 1 条', secondPage.items.length, 1);
    checkEqual('分页第二页没有更多', secondPage.has_more, false);
    const pagedIds = [...firstPage.items, ...secondPage.items].map((item) => item.file_id);
    checkEqual('分页覆盖全部文件且不重复', new Set(pagedIds).size, 3);
    const expectedOrder = [...pageFiles].reverse().map((file) => file.fileId);
    checkEqual('列表按绑定时间倒序', pagedIds.join(','), expectedOrder.join(','));

    // /f：公开无凭据、HEAD、Range、416、304、download=1 与 P0 安全头。
    const publicText = await fetch(uploaded.publicUrl);
    checkEqual('公开下载无需 Bearer', publicText.status, 200);
    checkEqual('公开下载内容一致', await publicText.text(), textBody);
    checkEqual('公开下载保留 nosniff', publicText.headers.get('x-content-type-options'), 'nosniff');

    const head = await fetch(uploaded.publicUrl, { method: 'HEAD' });
    checkEqual('HEAD 返回 200', head.status, 200);
    checkEqual('HEAD 返回 content-length', head.headers.get('content-length'), String(bound.file.size));
    checkEqual('HEAD 声明 accept-ranges', head.headers.get('accept-ranges'), 'bytes');
    checkEqual('HEAD 不返回正文', (await head.text()).length, 0);

    const ranged = await fetch(uploaded.publicUrl, { headers: { range: 'bytes=0-3' } });
    checkEqual('Range 返回 206', ranged.status, 206);
    checkEqual('Range 正文长度正确', (await ranged.text()).length, 4);
    checkEqual(
      'Range 声明 content-range',
      ranged.headers.get('content-range'),
      `bytes 0-3/${bound.file.size}`,
    );
    checkEqual('Range 保留 accept-ranges', ranged.headers.get('accept-ranges'), 'bytes');

    const suffix = await fetch(uploaded.publicUrl, { headers: { range: 'bytes=-5' } });
    checkEqual('后缀 Range 返回 206', suffix.status, 206);
    checkEqual('后缀 Range 正文长度正确', (await suffix.text()).length, 5);

    const unsatisfiable = await fetch(uploaded.publicUrl, {
      headers: { range: `bytes=${bound.file.size}-` },
    });
    checkEqual('越界 Range 返回 416', unsatisfiable.status, 416);
    checkEqual(
      '416 声明完整长度',
      unsatisfiable.headers.get('content-range'),
      `bytes */${bound.file.size}`,
    );

    const etag = publicText.headers.get('etag') ?? '';
    check('公开下载返回 ETag', etag.length > 2, etag);
    const notModified = await fetch(uploaded.publicUrl, {
      headers: { 'if-none-match': etag },
    });
    checkEqual('If-None-Match 命中返回 304', notModified.status, 304);
    checkEqual('304 不返回正文', (await notModified.text()).length, 0);

    const download = await fetch(bound.file.download_url);
    check(
      '?download=1 强制 attachment',
      (download.headers.get('content-disposition') ?? '').startsWith('attachment'),
      download.headers.get('content-disposition'),
    );

    const html = await uploadTestFile(aConn.token, {
      name: 'danger.html',
      mimeType: 'text/html',
      body: '<script>fetch("/mcp")</script>',
    });
    const htmlBound = await bind(aConn, roomId, html.fileId);
    checkEqual('HTML 预览分类为 download', htmlBound.file.preview_kind, 'download');

    const pngBytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      ),
      (character) => character.charCodeAt(0),
    );
    const png = await uploadTestFile(aConn.token, {
      name: 'pixel.png',
      mimeType: 'image/png',
      body: pngBytes,
    });
    const pngBound = await bind(aConn, roomId, png.fileId);
    checkEqual('光栅图片预览分类为 image', pngBound.file.preview_kind, 'image');
    checkEqual('光栅图片公开下载返回 image/png', (await fetch(pngBound.file.public_url)).headers.get('content-type'), 'image/png');

    // 跨 chunk 的 Range：200 KB 文本取中间 11 字节，验证跳过逻辑。
    const largeBody = 'abcdefghijklmnopqrstuvwxyz'.repeat(8_000).slice(0, 200_000);
    const large = await uploadTestFile(aConn.token, {
      name: 'large.txt',
      mimeType: 'text/plain',
      body: largeBody,
    });
    const largeBound = await bind(aConn, roomId, large.fileId);
    const middle = await fetch(largeBound.file.public_url, {
      headers: { range: 'bytes=65530-65540' },
    });
    checkEqual('跨 chunk Range 返回 206', middle.status, 206);
    checkEqual('跨 chunk Range 内容正确', await middle.text(), largeBody.slice(65530, 65541));
    const htmlDownload = await fetch(htmlBound.file.public_url);
    check(
      '绑定的 HTML 仍强制 attachment',
      (htmlDownload.headers.get('content-disposition') ?? '').startsWith('attachment'),
      htmlDownload.headers.get('content-disposition'),
    );
    checkEqual(
      '绑定的 HTML 仍加 sandbox CSP',
      htmlDownload.headers.get('content-security-policy'),
      "default-src 'none'; sandbox",
    );

    // 统一流：room.file 只发 informational 提示，不创建 delivery、不推进 head。
    const collector = notificationCollector(bConn.client);
    const subscription = await openSubscription(bConn.client, [STREAM_URI]);
    await callTool(bConn.client, 'network_login');
    const pendingBefore = await callTool<{ pending_count: number }>(bConn.client, 'network_me');
    const headBefore = await callTool<RoomDetail>(aConn.client, 'network_room_get', { room_id: roomId });

    const streamFile = await uploadTestFile(aConn.token, {
      name: 'stream.txt',
      mimeType: 'text/plain',
      body: 'stream file',
    });
    const streamBound = await bind(aConn, roomId, streamFile.fileId);
    const deadline = Date.now() + 15_000;
    while (streamFileItems(collector.events).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const addedItems = streamFileItems(collector.events);
    check('统一流收到 room.file 事件', addedItems.length >= 1, addedItems);
    checkEqual('room.file 的 kind 为 file', addedItems[0]?.kind, 'file');
    checkEqual('room.file 为 informational', addedItems[0]?.attention, 'informational');
    checkEqual('room.file 携带 room_id', addedItems[0]?.room_id, roomId);
    checkEqual('room.file 携带 file_id', addedItems[0]?.file_id, streamFile.fileId);
    checkEqual('room.file 携带 room_file_id', addedItems[0]?.ref_id, streamBound.file.room_file_id);

    await deleteFile(aConn, roomId, streamFile.fileId);
    const deleteDeadline = Date.now() + 15_000;
    while (
      streamFileItems(collector.events).filter((item) => item.ref_id === streamBound.file.room_file_id)
        .length < 2 &&
      Date.now() < deleteDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    checkEqual(
      '删除同样推送 room.file',
      streamFileItems(collector.events).filter(
        (item) => item.ref_id === streamBound.file.room_file_id,
      ).length,
      2,
    );
    const headAfter = await callTool<RoomDetail>(aConn.client, 'network_room_get', { room_id: roomId });
    checkEqual('文件事件不推进 head_seq', headAfter.room.head_seq, headBefore.room.head_seq);
    const pendingAfter = await callTool<{ pending_count: number }>(bConn.client, 'network_me');
    checkEqual('文件事件不创建待办', pendingAfter.pending_count, pendingBefore.pending_count);
    await subscription.close();

    // 删除：墓碑让公开 URL 立即 404，get/list 同步失效。
    const deleted = await deleteFile(aConn, roomId, bUpload.fileId);
    checkEqual('群 owner 删除成员文件成功', deleted.deleted, true);
    checkEqual('删除返回 file_id', deleted.file_id, bUpload.fileId);
    const afterDelete = await fetch(bUpload.publicUrl);
    checkEqual('删除后公开 URL 返回 404', afterDelete.status, 404);
    await expectToolError(
      '删除后 get 返回 FILE_UNAVAILABLE',
      getFile(aConn, roomId, bUpload.fileId),
      'FILE_UNAVAILABLE',
    );
    const afterDeleteList = await listFiles(aConn, roomId);
    check(
      '删除后列表不再包含该文件',
      !afterDeleteList.items.some((item) => item.file_id === bUpload.fileId),
      afterDeleteList.items.map((item) => item.file_id),
    );
    const repeatDelete = await deleteFile(aConn, roomId, bUpload.fileId);
    checkEqual('重复删除保持成功且不复活', repeatDelete.deleted, true);
    checkEqual('重复删除后公开 URL 仍为 404', (await fetch(bUpload.publicUrl)).status, 404);
    await expectToolError(
      '已删除文件的 file_id 不能重新绑定',
      bind(aConn, roomId, bUpload.fileId),
      'FILE_UNAVAILABLE',
    );

    await expectToolError(
      '删除他人文件返回 NOT_OWNER',
      deleteFile(bConn, roomId, uploaded.fileId),
      'NOT_OWNER',
    );

    // 已分享 URL 不随成员移出房间失效（公开 URL 即下载权限，直到过期或删除）。
    const membershipRoom = await createGroup(aConn, b.actor_id, '房间文件成员移出群');
    const surviving = await uploadTestFile(aConn.token, {
      name: 'surviving.txt',
      mimeType: 'text/plain',
      body: 'still downloadable',
    });
    const survivingBound = await bind(aConn, membershipRoom, surviving.fileId);
    await callTool(aConn.client, 'network_room_members_update', {
      request_id: newRequestId('members'),
      room_id: membershipRoom,
      remove: [b.actor_id],
    });
    checkEqual(
      '成员移出后已分享 URL 仍可下载',
      (await fetch(survivingBound.file.public_url)).status,
      200,
    );
    await expectToolError(
      '成员移出后无法再 list 房间文件',
      listFiles(bConn, membershipRoom),
      'NOT_MEMBER',
    );

    await runAutoArchiveCases(
      aConn,
      bConn,
      b.actor_id,
      { archive: archiveRoom, second: archiveSecondRoom },
      { bind, listFiles, deleteFile },
    );

    await databaseCases(aConn, bConn, b.actor_id, a.actor_id, {
      quota: quotaRoom,
      byte: byteRoom,
      expiry: expiryRoom,
      cleanup: cleanupRoom,
    });

    console.log(`\nroom file checks passed: ${checksPassed()}`);
  } finally {
    await Promise.all([aConn.close(), bConn.close(), cConn.close()]);
  }
}

await main();
