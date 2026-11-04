/**
 * 消息文件自动归档验收：服务端/浏览器共用 fixture、同源链接解析、
 * message_send 与 final_body 的 best-effort 归档、幂等、跨房间、
 * 他人/删除/过期/配额跳过与历史不补归档。
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
  newRequestId,
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

interface PendingDelivery {
  delivery_id: string;
  message_id: string;
  state: string;
  attempt: number;
  claim_id: string | null;
}

interface CompleteView {
  delivery: PendingDelivery;
  message: { message_id: string; room_id: string; created_seq: string } | null;
}

/** 按触发消息找到接收方待办并原子领取。 */
async function claimForMessage(
  connection: McpConnection,
  messageId: string,
): Promise<PendingDelivery> {
  const page = await callTool<{ items: PendingDelivery[] }>(
    connection.client,
    'network_inbox_list',
    { state: 'pending', limit: 50 },
  );
  const target = page.items.find((item) => item.message_id === messageId);
  check(
    `找到触发消息的待办：${messageId}`,
    Boolean(target),
    page.items.map((item) => item.message_id),
  );
  const delivery = await callTool<PendingDelivery>(connection.client, 'network_delivery_claim', {
    request_id: newRequestId('claim'),
    delivery_id: target!.delivery_id,
  });
  checkEqual('claim 返回 claim_id', Boolean(delivery.claim_id), true);
  return delivery;
}

function completeDelivery(
  connection: McpConnection,
  delivery: PendingDelivery,
  options: { requestId: string; finalBody?: string },
): Promise<CompleteView> {
  return callTool<CompleteView>(connection.client, 'network_delivery_complete', {
    request_id: options.requestId,
    delivery_id: delivery.delivery_id,
    attempt: delivery.attempt,
    claim_id: delivery.claim_id ?? '',
    ...(options.finalBody === undefined ? {} : { final_body: options.finalBody }),
  });
}

export interface MessageFileFixture {
  label: string;
  body: string;
  expected: string[];
}

/**
 * 服务端解析器与浏览器 `messageFileLinks` 共用的 fixture。
 *
 * 同一个 fixture 同时用于 `runFileLinkParserCases` 与 `verify-web` 的
 * `page.evaluate` parity 断言，避免客户端/服务端规则再次漂移。
 */
export function messageFileLinkFixtures(origin: string): MessageFileFixture[] {
  const host = new URL(origin).host;
  const id = (char: string) => `f_${char.repeat(22)}`;
  const a = id('a');
  const b = id('b');
  const dash = 'f_--d6iupwwZu42Zvph93Ahg';
  return [
    {
      label: '真实换行与同源绝对 URL',
      body: `第一行\n${origin}/f/${a}\n下一行`,
      expected: [a],
    },
    {
      label: '字面量反斜杠 n 与粗体文件名',
      body: `\\n\\n**文件说明.md**\\n${origin}/f/${a}\\n\\n后续正文`,
      expected: [a],
    },
    {
      label: '字面量反斜杠 r 反斜杠 n 与反斜杠 t',
      body: `\\r\\n\\t${origin}/f/${a}`,
      expected: [a],
    },
    {
      label: 'Markdown 粗体包住 URL',
      body: `**${origin}/f/${a}**`,
      expected: [a],
    },
    {
      label: '反引号包住 URL',
      body: '`' + `${origin}/f/${a}` + '`',
      expected: [a],
    },
    {
      label: 'Markdown 链接',
      body: `[报告](${origin}/f/${a})`,
      expected: [a],
    },
    {
      label: '尖括号包住 URL',
      body: `<${origin}/f/${a}>`,
      expected: [a],
    },
    {
      label: '圆括号包住 URL',
      body: `(${origin}/f/${a})`,
      expected: [a],
    },
    {
      label: '根相对路径',
      body: `/f/${a}`,
      expected: [a],
    },
    {
      label: 'query 与 hash',
      body: `${origin}/f/${a}?download=1#preview`,
      expected: [a],
    },
    {
      label: '尾部标点',
      body: `/f/${a}。 ${origin}/f/${b}.`,
      expected: [a, b],
    },
    {
      label: '双横线 fileId',
      body: `${origin}/f/${dash}`,
      expected: [dash],
    },
    {
      label: '/f/<id>/extra 路径片段',
      body: `${origin}/f/${a}/extra`,
      expected: [],
    },
    {
      label: '.txt 扩展名',
      body: `${origin}/f/${a}.txt`,
      expected: [],
    },
    {
      label: '外站绝对 URL',
      body: `https://evil.example/f/${a}`,
      expected: [],
    },
    {
      label: '协议相对外站 URL',
      body: `//evil.example/f/${a}`,
      expected: [],
    },
    {
      label: '同源 userinfo',
      body: `https://u:p@${host}/f/${a}`,
      expected: [],
    },
    {
      label: '非根相对路径',
      body: `dir/f/${a}`,
      expected: [],
    },
    {
      label: '去重与出现顺序',
      body: `/f/${a} ${origin}/f/${a}?download=1 /f/${b}`,
      expected: [a, b],
    },
  ];
}

/** 纯解析器用例：外站、路径片段、非法 ID、userinfo、去重与上限。 */
export function runFileLinkParserCases(): void {
  const origin = baseUrl();
  for (const fixture of messageFileLinkFixtures(origin)) {
    checkEqual(
      `解析器 fixture: ${fixture.label}`,
      extractMessageFileLinks(fixture.body, origin).join(','),
      fixture.expected.join(','),
    );
  }

  checkEqual(
    '解析器忽略非法 fileId',
    extractMessageFileLinks(`${origin}/f/f_bad /f/F_${'a'.repeat(22)}`, origin).length,
    0,
  );
  checkEqual('双横线 fileId 长度为 24', 'f_--d6iupwwZu42Zvph93Ahg'.length, 24);
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
  recipientId: string,
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

    // final_body：complete 提交后 best-effort 归档，不改变投递结果。
    const finalBold = await uploadTestFile(bConn.token, {
      name: 'final-bold.txt',
      mimeType: 'text/plain',
      body: 'final bold',
    });
    const finalCode = await uploadTestFile(bConn.token, {
      name: 'final-code.txt',
      mimeType: 'text/plain',
      body: 'final code',
    });
    const finalMarkdown = await uploadTestFile(bConn.token, {
      name: 'final-markdown.txt',
      mimeType: 'text/plain',
      body: 'final markdown',
    });
    const finalLiteral = await uploadTestFile(bConn.token, {
      name: 'final-literal.txt',
      mimeType: 'text/plain',
      body: 'final literal newline',
    });
    const finalTrigger = await sendMessage(aConn, rooms.archive, '请完成并附带最终文件', {
      invoke: [recipientId],
    });
    const finalClaimed = await claimForMessage(bConn, finalTrigger.message.message_id);
    const finalBody =
      `\\n\\n**${finalBold.publicUrl}**\\n` +
      '`' + finalCode.publicUrl + '`' + '\\n' +
      `[Markdown 最终](${finalMarkdown.publicUrl})\\n` +
      `/f/${finalLiteral.fileId}`;
    const completeRequestId = newRequestId('complete');
    const finalComplete = await completeDelivery(bConn, finalClaimed, {
      requestId: completeRequestId,
      finalBody,
    });
    check('带 final_body 的 complete 仍成功', Boolean(finalComplete.message));
    checkEqual(
      'final_body 归档的是 complete 产生的消息',
      finalComplete.message?.room_id,
      rooms.archive,
    );

    const finalList = await deps.listFiles(aConn, rooms.archive);
    for (const [label, file] of [
      ['粗体 URL', finalBold],
      ['反引号 URL', finalCode],
      ['Markdown 链接', finalMarkdown],
      ['字面量换行 + 相对路径', finalLiteral],
    ] as const) {
      check(
        `final_body 自动归档: ${label}`,
        finalList.items.some((item) => item.file_id === file.fileId),
        finalList.items.map((item) => item.file_id),
      );
    }
    const finalFileItems = await waitForItems(
      bCollector.events,
      'room.file',
      (item) => item.file_id === finalBold.fileId,
      'final_body 归档产生 room.file',
    );
    checkEqual(
      'final_body room.file 为 informational',
      finalFileItems[0]?.attention,
      'informational',
    );
    const headAfterFinal = await callTool<{ room: { head_seq: string } }>(
      aConn.client,
      'network_room_get',
      { room_id: rooms.archive },
    );
    checkEqual(
      'final_body 归档不额外推进 head_seq',
      headAfterFinal.room.head_seq,
      finalComplete.message!.created_seq,
    );
    const pendingAfterFinal = await callTool<{ pending_count: number }>(
      bConn.client,
      'network_inbox_list',
      { state: 'pending', limit: 1 },
    );
    checkEqual('final_body 不创建新待办', pendingAfterFinal.pending_count, 0);

    const replayFinal = await completeDelivery(bConn, finalClaimed, {
      requestId: completeRequestId,
      finalBody,
    });
    checkEqual(
      'final_body complete 幂等重放返回同一消息',
      replayFinal.message?.message_id,
      finalComplete.message?.message_id,
    );
    checkEqual(
      'final_body 幂等重放不重复归档',
      (await deps.listFiles(aConn, rooms.archive)).items.filter(
        (item) => item.file_id === finalBold.fileId,
      ).length,
      1,
    );
    checkEqual(
      'final_body 幂等重放不重复事件',
      streamItems(bCollector.events, 'room.file').filter(
        (item) => item.file_id === finalBold.fileId,
      ).length,
      1,
    );

    // 无 final_body：不触发归档。
    const noBodyFile = await uploadTestFile(bConn.token, {
      name: 'final-none.txt',
      mimeType: 'text/plain',
      body: 'no final body',
    });
    const noBodyTrigger = await sendMessage(aConn, rooms.archive, '没有最终正文', {
      invoke: [recipientId],
    });
    const noBodyClaimed = await claimForMessage(bConn, noBodyTrigger.message.message_id);
    const noBodyComplete = await completeDelivery(bConn, noBodyClaimed, {
      requestId: newRequestId('complete'),
    });
    checkEqual('无 final_body 的 complete 返回空消息', noBodyComplete.message, null);
    check(
      '无 final_body 不归档',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === noBodyFile.fileId,
      ),
    );

    // final_body 中的他人文件仍按所有权跳过。
    const otherFinal = await uploadTestFile(aConn.token, {
      name: 'final-other.txt',
      mimeType: 'text/plain',
      body: 'other owner final',
    });
    const otherFinalTrigger = await sendMessage(aConn, rooms.archive, '他人最终文件', {
      invoke: [recipientId],
    });
    const otherFinalClaimed = await claimForMessage(
      bConn,
      otherFinalTrigger.message.message_id,
    );
    const otherFinalComplete = await completeDelivery(bConn, otherFinalClaimed, {
      requestId: newRequestId('complete'),
      finalBody: `**${otherFinal.publicUrl}**`,
    });
    check('final_body 包含他人文件时 complete 仍成功', Boolean(otherFinalComplete.message));
    check(
      'final_body 不归档他人文件',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === otherFinal.fileId,
      ),
    );

    // final_body 中的跨房间已绑定文件不复制。
    const crossFinal = await uploadTestFile(bConn.token, {
      name: 'final-cross.txt',
      mimeType: 'text/plain',
      body: 'cross final',
    });
    await deps.bind(bConn, rooms.second, crossFinal.fileId);
    const crossFinalTrigger = await sendMessage(aConn, rooms.archive, '跨房间最终文件', {
      invoke: [recipientId],
    });
    const crossFinalClaimed = await claimForMessage(
      bConn,
      crossFinalTrigger.message.message_id,
    );
    const crossFinalComplete = await completeDelivery(bConn, crossFinalClaimed, {
      requestId: newRequestId('complete'),
      finalBody: `\`${crossFinal.publicUrl}\``,
    });
    check('final_body 跨房间时 complete 仍成功', Boolean(crossFinalComplete.message));
    check(
      'final_body 不复制跨房间文件',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === crossFinal.fileId,
      ),
    );
    check(
      'final_body 跨房间文件保留原绑定',
      (await deps.listFiles(aConn, rooms.second)).items.some(
        (item) => item.file_id === crossFinal.fileId,
      ),
    );

    // final_body 中的已删除文件跳过。
    const deletedFinal = await uploadTestFile(bConn.token, {
      name: 'final-deleted.txt',
      mimeType: 'text/plain',
      body: 'deleted final',
    });
    await deps.bind(bConn, rooms.second, deletedFinal.fileId);
    await deps.deleteFile(bConn, rooms.second, deletedFinal.fileId);
    const deletedFinalTrigger = await sendMessage(aConn, rooms.archive, '已删除最终文件', {
      invoke: [recipientId],
    });
    const deletedFinalClaimed = await claimForMessage(
      bConn,
      deletedFinalTrigger.message.message_id,
    );
    const deletedFinalComplete = await completeDelivery(bConn, deletedFinalClaimed, {
      requestId: newRequestId('complete'),
      finalBody: `[已删除](${deletedFinal.publicUrl})`,
    });
    check('final_body 已删除文件时 complete 仍成功', Boolean(deletedFinalComplete.message));
    check(
      'final_body 不归档已删除文件',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === deletedFinal.fileId,
      ),
    );

    // final_body 中的已过期底层文件跳过。
    const expiredFinal = await uploadTestFile(bConn.token, {
      name: 'final-expired.txt',
      mimeType: 'text/plain',
      body: 'expired final',
    });
    if (await expireDriveRecord(expiredFinal.fileId)) {
      const expiredFinalTrigger = await sendMessage(
        aConn,
        rooms.archive,
        '已过期最终文件',
        { invoke: [recipientId] },
      );
      const expiredFinalClaimed = await claimForMessage(
        bConn,
        expiredFinalTrigger.message.message_id,
      );
      const expiredFinalComplete = await completeDelivery(bConn, expiredFinalClaimed, {
        requestId: newRequestId('complete'),
        finalBody: `已过期 ${expiredFinal.publicUrl}`,
      });
      check(
        'final_body 已过期文件时 complete 仍成功',
        Boolean(expiredFinalComplete.message),
      );
      check(
        'final_body 不归档已过期文件',
        !(await deps.listFiles(aConn, rooms.archive)).items.some(
          (item) => item.file_id === expiredFinal.fileId,
        ),
      );
    } else {
      console.log('  · 跳过 final_body 已过期底层文件用例：无法访问本地 Drive 记录');
    }

    // 读取历史不会补归档。
    const historyFile = await uploadTestFile(bConn.token, {
      name: 'final-history.txt',
      mimeType: 'text/plain',
      body: 'history',
    });
    await sendMessage(aConn, rooms.archive, `历史消息中的文件 ${historyFile.publicUrl}`);
    await callTool(aConn.client, 'network_history_list', { room_id: rooms.archive });
    await callTool(bConn.client, 'network_history_list', { room_id: rooms.archive });
    check(
      '读取历史不补归档',
      !(await deps.listFiles(aConn, rooms.archive)).items.some(
        (item) => item.file_id === historyFile.fileId,
      ),
    );
  } finally {
    await Promise.all([aSubscription.close(), bSubscription.close()]);
  }
}
