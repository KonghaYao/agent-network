/**
 * 消息文件自动归档验收：同源链接解析、best-effort 归档、幂等、跨房间、
 * 他人/删除/过期文件与配额跳过。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';
import { extractMessageFileLinks } from '../../src/contracts/file-links';
import { sendMessage } from './acceptance-helpers';
import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  notificationCollector,
  openSubscription,
  uploadTestFile,
  type McpConnection,
} from './harness';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

export interface RoomFileArchiveDeps {
  bind(
    connection: McpConnection,
    roomId: string,
    fileId: string,
  ): Promise<{ file: { room_file_id: string } }>;
  listFiles(
    connection: McpConnection,
    roomId: string,
  ): Promise<{ items: { file_id: string; room_file_id: string }[] }>;
  deleteFile(connection: McpConnection, roomId: string, fileId: string): Promise<unknown>;
}

interface StreamItemView {
  source?: string;
  attention?: string;
  message_id?: string;
  file_id?: string;
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

function streamMessageItems(
  events: { params: Record<string, unknown> }[],
): StreamItemView[] {
  return streamItems(events, 'room.message');
}

async function waitForItems(
  events: { params: Record<string, unknown> }[],
  source: string,
  predicate: (item: StreamItemView) => boolean,
  label: string,
): Promise<StreamItemView[]> {
  const deadline = Date.now() + 15_000;
  while (!streamItems(events, source).some(predicate) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const matched = streamItems(events, source).filter(predicate);
  check(label, matched.length > 0, streamItems(events, source));
  return matched;
}

/** 纯解析器用例：外站、路径片段、非法 ID、userinfo、去重与上限。 */
export function runFileLinkParserCases(): void {
  const origin = baseUrl();
  const host = new URL(origin).host;
  const id = (char: string) => `f_${char.repeat(22)}`;
  const a = id('a');
  const b = id('b');

  checkEqual('解析器接受根相对路径', extractMessageFileLinks(`/f/${a}`, origin).join(','), a);
  checkEqual(
    '解析器接受同源绝对 URL 并忽略 query/hash',
    extractMessageFileLinks(`${origin}/f/${a}?download=1#preview`, origin).join(','),
    a,
  );
  checkEqual(
    '解析器接受 Markdown 链接',
    extractMessageFileLinks(`[报告](${origin}/f/${a})`, origin).join(','),
    a,
  );
  checkEqual(
    '解析器清理尾部标点',
    extractMessageFileLinks(`/f/${a}。 ${origin}/f/${b}.`, origin).join(','),
    `${a},${b}`,
  );
  checkEqual(
    '解析器忽略外站绝对 URL',
    extractMessageFileLinks(`https://evil.example/f/${a}`, origin).length,
    0,
  );
  checkEqual(
    '解析器忽略协议相对外站 URL',
    extractMessageFileLinks(`//evil.example/f/${a}`, origin).length,
    0,
  );
  checkEqual(
    '解析器忽略 /f/<id>/extra',
    extractMessageFileLinks(`${origin}/f/${a}/extra`, origin).length,
    0,
  );
  checkEqual(
    '解析器忽略非法 fileId',
    extractMessageFileLinks(`${origin}/f/f_bad /f/F_${'a'.repeat(22)}`, origin).length,
    0,
  );
  checkEqual(
    '解析器忽略带 userinfo 的同源 URL',
    extractMessageFileLinks(`https://u:p@${host}/f/${a}`, origin).length,
    0,
  );
  checkEqual(
    '解析器忽略非根相对路径',
    extractMessageFileLinks(`dir/f/${a}`, origin).length,
    0,
  );
  checkEqual(
    '解析器按 fileId 去重',
    extractMessageFileLinks(`/f/${a} ${origin}/f/${a}?download=1 /f/${b}`, origin).join(','),
    `${a},${b}`,
  );

  const many = Array.from({ length: 9 }, (_, index) => `f_${String(index).repeat(22)}`);
  const parsed = extractMessageFileLinks(
    many.map((fileId) => `/f/${fileId}`).join(' '),
    origin,
  );
  checkEqual('解析器最多返回 8 个链接', parsed.length, LIMITS.messageFileLinksMax);
  checkEqual(
    '解析器按出现顺序截断',
    parsed.join(','),
    many.slice(0, LIMITS.messageFileLinksMax).join(','),
  );
}

function driveRecordPath(fileId: string): string | null {
  const dataDir = process.env.DATA_DIR ?? '.data';
  const directory = process.env.DRIVE_DIRECTORY ?? join(dataDir, 'files');
  const namespace = process.env.DRIVE_NAMESPACE ?? 'agent-network';
  const namespaceKey = new Bun.CryptoHasher('sha256').update(namespace).digest('hex');
  const path = join(directory, 'uploads', namespaceKey, fileId, 'ready.json');
  return existsSync(path) ? path : null;
}

/** 让底层 Drive 记录过期；远端或自定义存储目录无法访问时返回 false。 */
async function expireDriveRecord(fileId: string): Promise<boolean> {
  const path = driveRecordPath(fileId);
  if (!path) return false;
  const record = (await Bun.file(path).json()) as { expiresAt?: string };
  record.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await Bun.write(path, JSON.stringify(record));
  return true;
}

export async function runAutoArchiveCases(
  aConn: McpConnection,
  bConn: McpConnection,
  rooms: { archive: string; second: string },
  deps: RoomFileArchiveDeps,
): Promise<void> {
  const aCollector = notificationCollector(aConn.client);
  const bCollector = notificationCollector(bConn.client);
  const aSubscription = await openSubscription(aConn.client, [STREAM_URI]);
  const bSubscription = await openSubscription(bConn.client, [STREAM_URI]);

  try {
    await callTool(aConn.client, 'network_login');
    await callTool(bConn.client, 'network_login');

    // 单文件：绝对 URL 自动归档，room.file informational，room.message 不回推发送者。
    const first = await uploadTestFile(aConn.token, {
      name: 'auto-first.txt',
      mimeType: 'text/plain',
      body: 'auto archive first',
    });
    const requestId = `auto_${crypto.randomUUID().replaceAll('-', '')}`;
    const clientMessageId = `cm_${crypto.randomUUID()}`;
    const firstBody = `自动归档第一份 ${first.publicUrl}`;
    const firstSent = await sendMessage(aConn, rooms.archive, firstBody, {
      requestId,
      clientMessageId,
    });
    const firstList = await deps.listFiles(aConn, rooms.archive);
    check(
      '含自己文件链接的消息自动归档',
      firstList.items.some((item) => item.file_id === first.fileId),
      firstList.items.map((item) => item.file_id),
    );
    const fileItems = await waitForItems(
      bCollector.events,
      'room.file',
      (item) => item.file_id === first.fileId,
      '接收方收到自动归档 room.file',
    );
    checkEqual('自动归档 room.file 为 informational', fileItems[0]?.attention, 'informational');
    await waitForItems(
      bCollector.events,
      'room.message',
      (item) => item.message_id === firstSent.message.message_id,
      '接收方收到自动归档消息的 room.message',
    );
    check(
      '发送者不收到自己的 room.message',
      !streamMessageItems(aCollector.events).some(
        (item) => item.message_id === firstSent.message.message_id,
      ),
      streamMessageItems(aCollector.events),
    );
    const headAfter = await callTool<{
      room: { head_seq: string };
    }>(aConn.client, 'network_room_get', { room_id: rooms.archive });
    checkEqual(
      '自动归档不额外推进 head_seq',
      headAfter.room.head_seq,
      firstSent.message.created_seq,
    );

    // 幂等重放：同一 request_id/client_message_id 与正文只产生一条绑定。
    const replay = await sendMessage(aConn, rooms.archive, firstBody, {
      requestId,
      clientMessageId,
    });
    checkEqual('自动归档消息幂等重放返回同一消息', replay.message.message_id, firstSent.message.message_id);
    const afterReplay = await deps.listFiles(aConn, rooms.archive);
    checkEqual(
      '幂等重放不重复归档',
      afterReplay.items.filter((item) => item.file_id === first.fileId).length,
      1,
    );

    // 多链接：重复、query、相对路径、Markdown、外站、路径片段。
    const absolute = await uploadTestFile(aConn.token, {
      name: 'auto-absolute.txt',
      mimeType: 'text/plain',
      body: 'absolute',
    });
    const relative = await uploadTestFile(aConn.token, {
      name: 'auto-relative.txt',
      mimeType: 'text/plain',
      body: 'relative',
    });
    const markdown = await uploadTestFile(aConn.token, {
      name: 'auto-markdown.txt',
      mimeType: 'text/plain',
      body: 'markdown',
    });
    const foreign = await uploadTestFile(aConn.token, {
      name: 'auto-foreign.txt',
      mimeType: 'text/plain',
      body: 'foreign',
    });
    const segment = await uploadTestFile(aConn.token, {
      name: 'auto-segment.txt',
      mimeType: 'text/plain',
      body: 'segment',
    });
    const mixedBody = [
      `绝对 ${absolute.publicUrl}?download=1`,
      `重复 ${absolute.publicUrl}`,
      `相对 (/f/${relative.fileId})。`,
      `Markdown [报告](${markdown.publicUrl})`,
      `外站 https://evil.example/f/${foreign.fileId}`,
      `路径 ${segment.publicUrl}/extra`,
    ].join('\n');
    await sendMessage(aConn, rooms.archive, mixedBody);
    const mixedList = await deps.listFiles(aConn, rooms.archive);
    for (const [label, file] of [
      ['绝对 URL', absolute],
      ['相对路径', relative],
      ['Markdown', markdown],
    ] as const) {
      check(
        `多链接自动归档: ${label}`,
        mixedList.items.some((item) => item.file_id === file.fileId),
        mixedList.items.map((item) => item.file_id),
      );
    }
    check(
      '外站链接不归档',
      !mixedList.items.some((item) => item.file_id === foreign.fileId),
      mixedList.items.map((item) => item.file_id),
    );
    check(
      '路径片段链接不归档',
      !mixedList.items.some((item) => item.file_id === segment.fileId),
      mixedList.items.map((item) => item.file_id),
    );

    // 跨房间：已绑定到其他房间的文件不复制，消息仍成功。
    const cross = await uploadTestFile(aConn.token, {
      name: 'auto-cross.txt',
      mimeType: 'text/plain',
      body: 'cross room',
    });
    const crossBound = await deps.bind(aConn, rooms.second, cross.fileId);
    const crossSent = await sendMessage(aConn, rooms.archive, `跨房间 ${cross.publicUrl}`);
    check('跨房间文件链接的消息仍成功', Boolean(crossSent.message.message_id));
    const archiveList = await deps.listFiles(aConn, rooms.archive);
    check(
      '跨房间文件不复制到新房间',
      !archiveList.items.some((item) => item.file_id === cross.fileId),
      archiveList.items.map((item) => item.file_id),
    );
    const secondList = await deps.listFiles(aConn, rooms.second);
    checkEqual(
      '原房间绑定保持不变',
      secondList.items.find((item) => item.file_id === cross.fileId)?.room_file_id,
      crossBound.file.room_file_id,
    );

    // 非自有文件、已删除文件与已过期底层文件都只跳过，不影响消息。
    const otherFile = await uploadTestFile(bConn.token, {
      name: 'auto-other.txt',
      mimeType: 'text/plain',
      body: 'other owner',
    });
    const otherSent = await sendMessage(aConn, rooms.archive, `他人文件 ${otherFile.publicUrl}`);
    check('他人文件链接的消息仍成功', Boolean(otherSent.message.message_id));
    check(
      '不归档他人文件',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === otherFile.fileId,
      ),
    );

    const deleted = await uploadTestFile(aConn.token, {
      name: 'auto-deleted.txt',
      mimeType: 'text/plain',
      body: 'deleted',
    });
    await deps.bind(aConn, rooms.second, deleted.fileId);
    await deps.deleteFile(aConn, rooms.second, deleted.fileId);
    const deletedSent = await sendMessage(aConn, rooms.archive, `已删除 ${deleted.publicUrl}`);
    check('已删除文件链接的消息仍成功', Boolean(deletedSent.message.message_id));
    check(
      '已删除文件不自动归档',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === deleted.fileId,
      ),
    );

    const expired = await uploadTestFile(aConn.token, {
      name: 'auto-expired.txt',
      mimeType: 'text/plain',
      body: 'expired',
    });
    if (await expireDriveRecord(expired.fileId)) {
      const expiredSent = await sendMessage(aConn, rooms.archive, `已过期 ${expired.publicUrl}`);
      check('已过期文件链接的消息仍成功', Boolean(expiredSent.message.message_id));
      check(
        '已过期文件不自动归档',
        !(await deps.listFiles(aConn, rooms.archive)).items.some(
          (item) => item.file_id === expired.fileId,
        ),
      );
    } else {
      console.log('  · 跳过已过期底层文件用例：无法访问本地 Drive 记录');
    }
  } finally {
    await Promise.all([aSubscription.close(), bSubscription.close()]);
  }
}
