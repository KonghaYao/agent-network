/**
 * 端到端验收中的房间文件片段。
 *
 * 只验证跨层行为：绑定后的公开下载、统一流 `room.file` 的 informational
 * 语义，以及文件事件不推进 head / 不创建待办。工具契约细节由
 * `scripts/verify-room-files.ts` 覆盖。
 */

import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  uploadTestFile,
  type McpConnection,
} from './harness';
import { registerIdentity, type RoomDetail } from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface StreamFileItem {
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  file_id?: string;
}

function streamFileItems(events: { params: Record<string, unknown> }[]): StreamFileItem[] {
  const items: StreamFileItem[] = [];
  for (const event of events) {
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.[STREAM_EVENT_META] as { items?: StreamFileItem[] } | undefined;
    for (const item of payload?.items ?? []) {
      if (item.source === 'room.file') items.push(item);
    }
  }
  return items;
}

async function waitForFileItems(
  events: { params: Record<string, unknown> }[],
  expected: number,
  label: string,
): Promise<StreamFileItem[]> {
  const deadline = Date.now() + 15_000;
  while (streamFileItems(events).length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const items = streamFileItems(events);
  check(`${label}（收到 ${items.length} 条）`, items.length >= expected, items);
  return items;
}

export async function runRoomFileAcceptance(): Promise<void> {
  const ownerConn: McpConnection = await connectClient(newToken());
  const memberConn: McpConnection = await connectClient(newToken());

  try {
    const owner = await registerIdentity(ownerConn, {
      kind: 'agent',
      name: '房间文件验收 Owner',
      sessionId: `roomfile_owner_${crypto.randomUUID()}`,
    });
    const member = await registerIdentity(memberConn, {
      kind: 'agent',
      name: '房间文件验收 Member',
      sessionId: `roomfile_member_${crypto.randomUUID()}`,
    });
    await callTool(ownerConn.client, 'network_contact_add', {
      request_id: newRequestId('friend'),
      actor_id: member.actor_id,
    });
    const room = await callTool<RoomDetail>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [member.actor_id],
      title: '端到端房间文件群',
    });
    const roomId = room.room.room_id;

    const collector = notificationCollector(memberConn.client);
    const subscription = await openSubscription(memberConn.client, [STREAM_URI]);
    await callTool(memberConn.client, 'network_login');

    const pendingBefore = await callTool<{ pending_count: number }>(memberConn.client, 'network_me');
    const headBefore = await callTool<RoomDetail>(ownerConn.client, 'network_room_get', {
      room_id: roomId,
    });

    const uploaded = await uploadTestFile(ownerConn.token, {
      name: 'e2e-room-file.txt',
      mimeType: 'text/plain',
      body: 'room file acceptance',
    });
    const bound = await callTool<{ file: { room_file_id: string; public_url: string } }>(
      ownerConn.client,
      'network_room_file_bind',
      { request_id: newRequestId('bind'), room_id: roomId, file_id: uploaded.fileId },
    );
    checkEqual('房间文件绑定返回公开 URL', bound.file.public_url, `${baseUrl()}/f/${uploaded.fileId}`);

    const items = await waitForFileItems(collector.events, 1, '统一流收到 room.file 新增');
    checkEqual('room.file kind 为 file', items[0]?.kind, 'file');
    checkEqual('room.file 为 informational', items[0]?.attention, 'informational');
    checkEqual('room.file 指向正确房间', items[0]?.room_id, roomId);
    checkEqual('room.file 携带 file_id', items[0]?.file_id, uploaded.fileId);

    const headAfter = await callTool<RoomDetail>(ownerConn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual('房间文件事件不推进 head_seq', headAfter.room.head_seq, headBefore.room.head_seq);
    const pendingAfter = await callTool<{ pending_count: number }>(memberConn.client, 'network_me');
    checkEqual('房间文件事件不创建待办', pendingAfter.pending_count, pendingBefore.pending_count);

    const download = await fetch(uploaded.publicUrl);
    checkEqual('房间文件公开下载无需 Bearer', download.status, 200);
    checkEqual('房间文件公开内容一致', await download.text(), 'room file acceptance');

    await callTool(ownerConn.client, 'network_room_file_delete', {
      request_id: newRequestId('rmfile'),
      room_id: roomId,
      file_id: uploaded.fileId,
    });
    await waitForFileItems(collector.events, 2, '统一流收到 room.file 删除');
    checkEqual('删除后公开 URL 返回 404', (await fetch(uploaded.publicUrl)).status, 404);

    await subscription.close();
  } finally {
    await Promise.all([ownerConn.close(), memberConn.close()]);
  }
}
