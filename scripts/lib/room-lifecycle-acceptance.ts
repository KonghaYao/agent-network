/**
 * G06 退群、移除、解散与在途工作端到端验收（T01–T04）。
 *
 * T01：移除成员后旧 claim、任务提交与旧文件票据立即失败，其他群不受影响；
 *      退群前预览并确认在途任务，未确认时返回 CONFLICT 而不是静默丢失。
 * T02：D04 接任与移除并发，最终唯一负责人或 blocked；确定性迟到接受失败。
 * T03：解散取消未结束任务与投递，合法成员按 archived_head_seq 只读归档，
 *      已移除者无归档资格，所有写入被拒绝，审计保留。
 * T04：成员失权/解散事件存在并携带 media_revoke 钩子；M09 媒体层未实现，
 *      因此不声称已验证媒体发布/订阅终止。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  readResourceJson,
  ToolError,
  uploadTestFile,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  registerIdentity,
  type Identity,
  type InboxPage,
} from './acceptance-helpers';

interface RoomView {
  room: {
    room_id: string;
    kind: string;
    head_seq: string;
    owner_id: string | null;
    my_role: string;
    member_count: number;
    status: 'active' | 'dissolved';
    dissolved_at: string | null;
    archived_head_seq: string | null;
    read_only: boolean;
    can_leave: boolean;
    can_dissolve: boolean;
    capabilities: Record<string, boolean>;
  };
  members: { actor_id: string; name: string; role: string; kind: string }[];
  invited: unknown[];
  owner_transfer: { transfer_id: string; status: string } | null;
}

interface LeavePreview {
  room_id: string;
  pending_deliveries: number;
  claimed_deliveries: number;
  can_leave: boolean;
  can_dissolve: boolean;
  owner_transfer_required: boolean;
  dissolved: boolean;
  read_only: boolean;
}

interface DissolveSummary {
  room_id: string;
  dissolved_at: string;
  archived_head_seq: string;
  archive_member_seq: string;
  cancelled_deliveries: number;
  revoked_invitations: number;
  cancelled_join_requests: number;
  cancelled_transfers: number;
}

interface EventRef {
  seq: string;
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
}

interface SyncPage {
  items: EventRef[];
  head_seq: string;
  min_seq: string;
}

interface HistoryPage {
  items: { message_id: string; preview: string; created_seq: string }[];
  snapshot: string;
  head_seq: string;
}

interface FileListView {
  items: {
    file_id: string;
    download_url: string;
    public_url: string;
    can_delete: boolean;
  }[];
}

async function readRoom(connection: McpConnection, roomId: string): Promise<RoomView> {
  return callTool<RoomView>(connection.client, 'network_room_get', { room_id: roomId });
}

interface EventRef {
  seq: string;
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
}

interface SyncPage {
  items: EventRef[];
  head_seq: string;
  min_seq: string;
}

interface HistoryPage {
  items: { message_id: string; preview: string; created_seq: string }[];
  snapshot: string;
  head_seq: string;
}

async function removeMember(
  owner: McpConnection,
  roomId: string,
  actorId: string,
): Promise<void> {
  await callTool(owner.client, 'network_room_members_update', {
    request_id: newRequestId('g06_remove'),
    room_id: roomId,
    remove: [actorId],
  });
}

async function addMember(
  owner: McpConnection,
  roomId: string,
  actorId: string,
): Promise<void> {
  await callTool(owner.client, 'network_room_members_update', {
    request_id: newRequestId('g06_add'),
    room_id: roomId,
    add: [actorId],
  });
}

function isRejection(error: unknown, allowed: string[]): boolean {
  return error instanceof ToolError && allowed.includes(error.code);
}

export async function runRoomLifecycleAcceptance(): Promise<void> {
  console.log('· G06 退群移除解散与在途工作');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const u3Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'G06 群主 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'G06 成员 U2' });
    const u3 = await registerIdentity(u3Conn, { kind: 'human', name: 'G06 外部 U3' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'G06 Agent B1',
      sessionId: `g06_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'G06 Agent B2',
      sessionId: `g06_b2_${crypto.randomUUID()}`,
    });
    check(
      'G06 身份注册成功',
      Boolean(u1.actor_id && u2.actor_id && u3.actor_id && b1.actor_id && b2.actor_id),
    );
    for (const [conn, identity] of [
      [u2Conn, u2],
      [u3Conn, u3],
      [b1Conn, b1],
      [b2Conn, b2],
    ] as const) {
      await befriend(u1Conn, u1.actor_id, conn, identity.actor_id);
    }

    const createGroup = async (
      title: string,
      members: Identity[],
      connections: { connection: McpConnection; identity: Identity }[],
    ): Promise<{ roomId: string; detail: RoomView }> => {
      const detail = await callTool<RoomView>(u1Conn.client, 'network_room_create', {
        request_id: newRequestId('g06_room'),
        kind: 'group',
        title,
        members: members.map((member) => member.actor_id),
      });
      const roomId = detail.room.room_id;
      for (const { connection } of connections) await acceptGroupInvites(connection, roomId);
      return { roomId, detail: await readRoom(u1Conn, roomId) };
    };

    // ---------- G06-T01：移除、退群预览与旧票据 ----------
    console.log('  G06-T01 移除与退群在途工作');
    const g1 = await createGroup(
      'G06-T01 移除验收群',
      [u2, b1, b2],
      [
        { connection: u2Conn, identity: u2 },
        { connection: b1Conn, identity: b1 },
        { connection: b2Conn, identity: b2 },
      ],
    );
    const room1 = g1.roomId;

    // B1 的另一个群：移除后仍应可用。
    const other = await createGroup(
      'G06-T01 B1 其他群',
      [b1],
      [{ connection: b1Conn, identity: b1 }],
    );
    const otherRoomId = other.roomId;

    await callTool(u1Conn.client, 'network_message_send', {
      request_id: newRequestId('g06_msg'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: room1,
      body: 'G06-T01 归档前消息',
    });
    const uploaded = await uploadTestFile(u1Conn.token, {
      name: 'g06-remove.txt',
      mimeType: 'text/plain',
      body: 'g06 removal file',
    });
    await callTool(u1Conn.client, 'network_room_file_bind', {
      request_id: newRequestId('g06_bind'),
      room_id: room1,
      file_id: uploaded.fileId,
    });
    const b1Files = await callTool<FileListView>(b1Conn.client, 'network_room_file_list', {
      room_id: room1,
    });
    const b1Download = b1Files.items.find((item) => item.file_id === uploaded.fileId)?.download_url;
    check('G06-T01 B1 退群前可拿到文件下载地址', Boolean(b1Download));
    checkEqual(
      'G06-T01 B1 移除前文件可下载',
      b1Download ? (await fetch(b1Download)).status : 0,
      200,
    );

    await callTool(u1Conn.client, 'network_message_send', {
      request_id: newRequestId('g06_invoke'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: room1,
      body: 'G06-T01 移除前投递',
      invoke: [b1.actor_id],
    });
    await callTool(b1Conn.client, 'network_login', {});
    const b1Inbox = await callTool<InboxPage>(b1Conn.client, 'network_inbox_list', {
      state: 'pending',
    });
    const offerDelivery = b1Inbox.items.find(
      (item) => item.room_id === room1 && item.state === 'pending',
    );
    check('G06-T01 B1 收到普通投递', Boolean(offerDelivery));
    const claimed = offerDelivery
      ? await callTool<{
          delivery_id: string;
          attempt: number;
          claim_id: string | null;
          state: string;
        }>(b1Conn.client, 'network_delivery_claim', {
          request_id: newRequestId('g06_claim'),
          delivery_id: offerDelivery.delivery_id,
        })
      : null;
    checkEqual('G06-T01 B1 成功 claim 投递', claimed?.state, 'claimed');

    await removeMember(u1Conn, room1, b1.actor_id);
    await expectToolError(
      'G06-T01 旧 claim 不能继续上报',
      callTool(b1Conn.client, 'network_delivery_report', {
        request_id: newRequestId('g06_report'),
        delivery_id: claimed?.delivery_id,
        attempt: claimed?.attempt,
        claim_id: claimed?.claim_id,
        status: '迟到上报',
      }),
      'STALE_ATTEMPT',
    );
    checkEqual(
      'G06-T01 旧文件票据在移除后立即 404',
      b1Download ? (await fetch(b1Download)).status : 0,
      404,
    );
    await expectToolError(
      'G06-T01 被移除者无法读取房间',
      readRoom(b1Conn, room1),
      'NOT_MEMBER',
    );
    const otherAfter = await readRoom(b1Conn, otherRoomId);
    checkEqual('G06-T01 被移除者其他群仍有效', otherAfter.room.room_id, otherRoomId);
    await callTool(b1Conn.client, 'network_message_send', {
      request_id: newRequestId('g06_other_msg'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: otherRoomId,
      body: 'B1 在其他群仍然正常',
    });
    const b1Me = await callTool<Identity>(b1Conn.client, 'network_me', {});
    checkEqual('G06-T01 被移除者身份不受影响', b1Me.actor_id, b1.actor_id);

    // B2 退群：有待处理投递时预览并要求确认，确认后撤销投递。
    await callTool(u1Conn.client, 'network_message_send', {
      request_id: newRequestId('g06_leave_invoke'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: room1,
      body: 'G06-T01 退群前投递',
      invoke: [b2.actor_id],
    });
    const preview = await callTool<LeavePreview>(b2Conn.client, 'network_room_leave_preview', {
      room_id: room1,
    });
    check(
      'G06-T01 退群预览列出待处理投递',
      preview.pending_deliveries >= 1,
      preview,
    );
    const leaveError = await expectToolError(
      'G06-T01 未确认待处理投递时退群被拒绝',
      callTool(b2Conn.client, 'network_room_leave', {
        request_id: newRequestId('g06_leave_unconfirmed'),
        room_id: room1,
      }),
      'CONFLICT',
    );
    checkEqual('G06-T01 拒绝原因标明在途工作', (leaveError.body.details as Record<string, unknown>)?.reason, 'in_flight_work');
    const leaveResult = await callTool<{
      left: true;
      pending_deliveries: number;
      claimed_deliveries: number;
    }>(b2Conn.client, 'network_room_leave', {
      request_id: newRequestId('g06_leave'),
      room_id: room1,
      confirm_in_flight: true,
    });
    checkEqual('G06-T01 确认退群返回被撤销的投递数', leaveResult.left, true);
    await expectToolError('G06-T01 退群后不能读取房间', readRoom(b2Conn, room1), 'NOT_MEMBER');

    // ---------- G06-T03：解散、归档与写入冻结 ----------
    console.log('  G06-T03 解散与只读归档');
    const g3 = await createGroup(
      'G06-T03 解散验收群',
      [u2, b1, b2],
      [
        { connection: u2Conn, identity: u2 },
        { connection: b1Conn, identity: b1 },
        { connection: b2Conn, identity: b2 },
      ],
    );
    const room3 = g3.roomId;

    await callTool(u1Conn.client, 'network_message_send', {
      request_id: newRequestId('g06_t03_msg'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: room3,
      body: 'G06-T03 解散前仍可读的历史',
    });
    const archiveFile = await uploadTestFile(u1Conn.token, {
      name: 'g06-archive.txt',
      mimeType: 'text/plain',
      body: 'g06 archive file',
    });
    await callTool(u1Conn.client, 'network_room_file_bind', {
      request_id: newRequestId('g06_t03_bind'),
      room_id: room3,
      file_id: archiveFile.fileId,
    });
    const b2FilesBefore = await callTool<FileListView>(b2Conn.client, 'network_room_file_list', {
      room_id: room3,
    });
    const b2ArchiveUrl = b2FilesBefore.items.find((item) => item.file_id === archiveFile.fileId)
      ?.download_url;
    const b1FilesBefore = await callTool<FileListView>(b1Conn.client, 'network_room_file_list', {
      room_id: room3,
    });
    const b1ArchiveUrl = b1FilesBefore.items.find((item) => item.file_id === archiveFile.fileId)
      ?.download_url;

    await callTool(u1Conn.client, 'network_message_send', {
      request_id: newRequestId('g06_t03_invoke'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: room3,
      body: 'G06-T03 解散前投递',
      invoke: [b1.actor_id, b2.actor_id],
    });
    const b2InboxBefore = await callTool<InboxPage>(b2Conn.client, 'network_inbox_list', {
      state: 'pending',
    });
    const b2Delivery = b2InboxBefore.items.find(
      (item) => item.room_id === room3 && item.state === 'pending',
    );
    check('G06-T03 解散前 B2 收到投递', Boolean(b2Delivery));
    const b2Claimed = b2Delivery
      ? await callTool<{
          delivery_id: string;
          attempt: number;
          claim_id: string | null;
          state: string;
        }>(b2Conn.client, 'network_delivery_claim', {
          request_id: newRequestId('g06_t03_claim'),
          delivery_id: b2Delivery.delivery_id,
        })
      : null;
    checkEqual('G06-T03 解散前 B2 成功 claim', b2Claimed?.state, 'claimed');
    await callTool(u1Conn.client, 'network_room_invite_create', {
      request_id: newRequestId('g06_t03_link'),
      room_id: room3,
    });
    const ownerTransfer = await callTool<RoomView>(u1Conn.client, 'network_room_owner_transfer_propose', {
      request_id: newRequestId('g06_t03_transfer'),
      room_id: room3,
      target_actor_id: u2.actor_id,
    });
    checkEqual('G06-T03 解散前存在 pending 群主转让', ownerTransfer.owner_transfer?.status, 'pending');
    const directInvite = await callTool<{ invitation: { invitation_id: string } }>(
      u1Conn.client,
      'network_room_invite_create',
      {
        request_id: newRequestId('g06_t03_direct'),
        room_id: room3,
        target_actor_id: u3.actor_id,
      },
    );

    // 群主不能带着其他成员直接退群；即使独自一人也必须先转移或解散。
    const ownerLeaveError = await expectToolError(
      'G06-T03 群主离群前必须转移或解散',
      callTool(u1Conn.client, 'network_room_leave', {
        request_id: newRequestId('g06_t03_owner_leave'),
        room_id: room3,
      }),
      'CONFLICT',
    );
    checkEqual(
      'G06-T03 群主退群拒绝原因标明 owner_transfer_required',
      (ownerLeaveError.body.details as Record<string, unknown>)?.reason,
      'owner_transfer_required',
    );

    // 先移除 B1：B1 失去归档资格。
    await removeMember(u1Conn, room3, b1.actor_id);

    const headBeforeDissolve = (await readRoom(u1Conn, room3)).room.head_seq;

    const beforeDissolveRooms = await callTool<{
      items: { room_id: string; status: string }[];
    }>(u1Conn.client, 'network_rooms_list', { limit: 100 });
    check(
      'G06-T03 解散前 rooms_list 包含群',
      beforeDissolveRooms.items.some((item) => item.room_id === room3),
    );

    const dissolve = await callTool<RoomView & { dissolve: DissolveSummary }>(
      u1Conn.client,
      'network_room_dissolve',
      {
        request_id: newRequestId('g06_dissolve'),
        room_id: room3,
        reason: 'G06 验收解散',
      },
    );
    check('G06-T03 解散撤销邀请链接', dissolve.dissolve.revoked_invitations >= 1, dissolve.dissolve);
    check('G06-T03 解散撤销 pending 交接', dissolve.dissolve.cancelled_transfers >= 1, dissolve.dissolve);
    check(
      'G06-T03 解散输出不再包含旧任务计数字段',
      !('cancelled_tasks' in dissolve.dissolve) && !('cancelled_task_ids' in dissolve.dissolve),
      dissolve.dissolve,
    );
    checkEqual('G06-T03 解散返回房间状态', dissolve.room.status, 'dissolved');
    checkEqual('G06-T03 解散后 read_only', dissolve.room.read_only, true);
    checkEqual('G06-T03 解散后不能再次解散', dissolve.room.can_dissolve, false);

    const u2Room = await readRoom(u2Conn, room3);
    check('G06-T03 合法成员保留归档边界', Number(u2Room.room.archived_head_seq) > 0);
    checkEqual('G06-T03 归档能力全部关闭', u2Room.room.capabilities.send_message, false);
    checkEqual('G06-T03 归档 read_only', u2Room.room.read_only, true);
    checkEqual('G06-T03 归档成员可退出', u2Room.room.can_leave, true);
    const ownerRoomsAfterDissolve = await callTool<{
      items: { room_id: string }[];
    }>(u1Conn.client, 'network_rooms_list', { limit: 100 });
    check(
      'G06-T03 owner 的 rooms_list 默认排除解散群',
      !ownerRoomsAfterDissolve.items.some((item) => item.room_id === room3),
    );
    const memberRoomsAfterDissolve = await callTool<{
      items: { room_id: string }[];
    }>(u2Conn.client, 'network_rooms_list', { limit: 100 });
    check(
      'G06-T03 成员的 rooms_list 默认排除解散群',
      !memberRoomsAfterDissolve.items.some((item) => item.room_id === room3),
    );
    const b2Snapshot = await readResourceJson<{
      rooms: {
        room_id: string;
        status: 'active' | 'dissolved';
        dissolved_at: string | null;
        read_only: boolean;
        archived_head_seq: string | null;
      }[];
    }>(b2Conn.client, 'agentnet://stream');
    const b2SnapshotRoom = b2Snapshot.rooms.find((item) => item.room_id === room3);
    checkEqual('G06-T03 stream 快照保留解散群', b2SnapshotRoom?.status, 'dissolved');
    checkEqual('G06-T03 stream 快照标记只读', b2SnapshotRoom?.read_only, true);
    checkEqual(
      'G06-T03 stream 快照返回归档边界',
      b2SnapshotRoom?.archived_head_seq,
      u2Room.room.archived_head_seq,
    );
    check(
      'G06-T03 stream 快照返回 dissolved_at',
      typeof b2SnapshotRoom?.dissolved_at === 'string' &&
        b2SnapshotRoom.dissolved_at === u2Room.room.dissolved_at,
      b2SnapshotRoom,
    );
    for (const marker of ['report', 'complete', 'fail'] as const) {
      const dissolveError = await expectToolError(
        `G06-T03 解散取消的 claimed 投递 ${marker} 返回 room_dissolved`,
        callTool(b2Conn.client, `network_delivery_${marker}`, {
          request_id: newRequestId(`g06_t03_delivery_${marker}`),
          delivery_id: b2Claimed?.delivery_id,
          attempt: b2Claimed?.attempt,
          claim_id: b2Claimed?.claim_id,
          ...(marker === 'report'
            ? { status: '解散后上报' }
            : marker === 'fail'
              ? { error: '解散后失败' }
              : {}),
        }),
        'CONFLICT',
      );
      checkEqual(
        `G06-T03 解散取消的 ${marker} 原因标明 room_dissolved`,
        (dissolveError.body.details as Record<string, unknown>)?.reason,
        'room_dissolved',
      );
    }
    await expectToolError(
      'G06-T03 解散后不能发送消息',
      callTool(u2Conn.client, 'network_message_send', {
        request_id: newRequestId('g06_t03_send'),
        client_message_id: `cm_${crypto.randomUUID()}`,
        room_id: room3,
        body: '解散后写入',
      }),
      'CONFLICT',
    );
    const u2Draft = await uploadTestFile(u2Conn.token, {
      name: 'g06-u2-draft.txt',
      mimeType: 'text/plain',
      body: 'u2 draft',
    });
    await expectToolError(
      'G06-T03 解散后不能绑定文件',
      callTool(u2Conn.client, 'network_room_file_bind', {
        request_id: newRequestId('g06_t03_u2_bind'),
        room_id: room3,
        file_id: u2Draft.fileId,
      }),
      'CONFLICT',
    );
    await expectToolError(
      'G06-T03 解散后不能创建邀请',
      callTool(u1Conn.client, 'network_room_invite_create', {
        request_id: newRequestId('g06_t03_invite'),
        room_id: room3,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'G06-T03 解散后不能变更角色',
      callTool(u1Conn.client, 'network_room_role_set', {
        request_id: newRequestId('g06_t03_role'),
        room_id: room3,
        actor_id: u2.actor_id,
        role: 'admin',
        expected_role_revision: 1,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      'G06-T03 解散后不能修改策略',
      callTool(u1Conn.client, 'network_room_policy_set', {
        request_id: newRequestId('g06_t03_policy'),
        room_id: room3,
        member_message_policy: 'members',
        expected_policy_revision: 1,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      'G06-T03 解散后不能发起 owner 转移',
      callTool(u1Conn.client, 'network_room_owner_transfer_propose', {
        request_id: newRequestId('g06_t03_transfer2'),
        room_id: room3,
        target_actor_id: u2.actor_id,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      'G06-T03 重复解散被拒绝',
      callTool(u1Conn.client, 'network_room_dissolve', {
        request_id: newRequestId('g06_t03_dissolve2'),
        room_id: room3,
      }),
      'CONFLICT',
    );

    // 已移除者无归档资格。
    await expectToolError('G06-T03 已移除者不能读取归档', readRoom(b1Conn, room3), 'NOT_MEMBER');
    await expectToolError(
      'G06-T03 已移除者不能读取归档历史',
      callTool(b1Conn.client, 'network_history_list', { room_id: room3, limit: 10 }),
      'NOT_MEMBER',
    );
    checkEqual(
      'G06-T03 已移除者旧文件票据 404',
      b1ArchiveUrl ? (await fetch(b1ArchiveUrl)).status : 0,
      404,
    );

    // 合法成员只读归档：历史、文件新票据。
    const u2History = await callTool<HistoryPage>(u2Conn.client, 'network_history_list', {
      room_id: room3,
      limit: 50,
    });
    check(
      'G06-T03 合法成员仍可读取解散前历史',
      u2History.items.some((item) => item.preview.includes('解散前仍可读的历史')),
    );
    check(
      'G06-T03 历史快照不超过归档边界',
      Number(u2History.snapshot) <= Number(u2Room.room.archived_head_seq),
      { snapshot: u2History.snapshot, archived: u2Room.room.archived_head_seq },
    );
    checkEqual('G06-T03 解散不推进消息 head', u2History.head_seq, headBeforeDissolve);
    const u2FilesAfter = await callTool<FileListView>(u2Conn.client, 'network_room_file_list', {
      room_id: room3,
    });
    const u2ArchiveUrl = u2FilesAfter.items.find((item) => item.file_id === archiveFile.fileId)
      ?.download_url;
    check(
      'G06-T03 解散归档文件不提供删除能力',
      u2FilesAfter.items
        .filter((item) => item.file_id === archiveFile.fileId)
        .every((item) => item.can_delete === false),
      u2FilesAfter.items,
    );
    check('G06-T03 合法成员可重新获取归档文件票据', Boolean(u2ArchiveUrl));
    checkEqual(
      'G06-T03 合法成员归档文件仍可下载',
      u2ArchiveUrl ? (await fetch(u2ArchiveUrl)).status : 0,
      200,
    );

    // 保留成果与审计。
    const audit = await callTool<{ items: { action: string }[] }>(
      u1Conn.client,
      'network_room_role_history',
      { room_id: room3, limit: 100 },
    );
    check('G06-T03 保留 room_dissolved 审计', audit.items.some((item) => item.action === 'room_dissolved'));

    // 解散后旧定向邀请不能加入。
    await expectToolError(
      'G06-T03 解散后旧邀请不能加入',
      callTool(u3Conn.client, 'network_room_invite_respond', {
        request_id: newRequestId('g06_t03_join'),
        invitation_id: directInvite.invitation.invitation_id,
        action: 'accept',
      }),
      'CONFLICT',
    );

    // ---------- G06-T05：owner 独自一人也不得产生无主群 ----------
    console.log('  G06-T05 owner 独自退群拒绝与解散后旧邀请失效');
    const g5 = await createGroup(
      'G06-T05 owner 独自一人',
      [u2],
      [{ connection: u2Conn, identity: u2 }],
    );
    const room5 = g5.roomId;
    await removeMember(u1Conn, room5, u2.actor_id);
    const alonePreview = await callTool<LeavePreview>(u1Conn.client, 'network_room_leave_preview', {
      room_id: room5,
    });
    checkEqual('G06-T05 owner 独自一人 preview 不允许退群', alonePreview.can_leave, false);
    checkEqual(
      'G06-T05 owner 独自一人 preview 要求先转移',
      alonePreview.owner_transfer_required,
      true,
    );
    checkEqual('G06-T05 owner 独自一人 preview 允许解散', alonePreview.can_dissolve, true);
    const aloneLeave = await expectToolError(
      'G06-T05 owner 独自一人直接退群返回 CONFLICT',
      callTool(u1Conn.client, 'network_room_leave', {
        request_id: newRequestId('g06_t05_owner_leave'),
        room_id: room5,
        confirm_in_flight: true,
      }),
      'CONFLICT',
    );
    checkEqual(
      'G06-T05 拒绝原因标明 owner_transfer_required',
      (aloneLeave.body.details as Record<string, unknown>)?.reason,
      'owner_transfer_required',
    );
    const afterAloneLeave = await readRoom(u1Conn, room5);
    checkEqual('G06-T05 拒绝后 owner 仍在位', afterAloneLeave.room.owner_id, u1.actor_id);
    checkEqual('G06-T05 拒绝后群仍为 active', afterAloneLeave.room.status, 'active');

    const invite5 = await callTool<{ invitation: { invitation_id: string } }>(
      u1Conn.client,
      'network_room_invite_create',
      {
        request_id: newRequestId('g06_t05_direct'),
        room_id: room5,
        target_actor_id: u3.actor_id,
      },
    );
    const link5 = await callTool<{
      invitation: { invitation_id: string };
      invite_key: string;
    }>(u1Conn.client, 'network_room_invite_create', {
      request_id: newRequestId('g06_t05_link'),
      room_id: room5,
    });
    const dissolve5 = await callTool<RoomView & { dissolve: DissolveSummary }>(
      u1Conn.client,
      'network_room_dissolve',
      {
        request_id: newRequestId('g06_t05_dissolve'),
        room_id: room5,
        reason: 'G06-T05 owner 独自解散',
      },
    );
    checkEqual('G06-T05 解散后返回只读归档', dissolve5.room.status, 'dissolved');
    checkEqual('G06-T05 解散后 read_only', dissolve5.room.read_only, true);
    checkEqual('G06-T05 解散后不能再次解散', dissolve5.room.can_dissolve, false);
    await expectToolError(
      'G06-T05 解散后旧定向邀请不能加入',
      callTool(u3Conn.client, 'network_room_invite_respond', {
        request_id: newRequestId('g06_t05_direct_accept'),
        invitation_id: invite5.invitation.invitation_id,
        action: 'accept',
      }),
      'CONFLICT',
    );
    await expectToolError(
      'G06-T05 解散后旧邀请链接不能加入',
      callTool(u3Conn.client, 'network_room_invite_respond', {
        request_id: newRequestId('g06_t05_link_accept'),
        invitation_id: link5.invitation.invitation_id,
        invite_key: link5.invite_key,
        action: 'accept',
      }),
      'CONFLICT',
    );
    const archiveRead = await callTool<HistoryPage>(u1Conn.client, 'network_history_list', {
      room_id: room5,
      limit: 10,
    });
    checkEqual('G06-T05 解散归档仍可读', archiveRead.head_seq, afterAloneLeave.room.head_seq);
    checkEqual('G06-T05 解散归档只读', (await readRoom(u1Conn, room5)).room.read_only, true);

    // ---------- G06-T04：失权/解散事件钩子与媒体依赖缺口 ----------
    console.log('  G06-T04 失权/解散事件钩子');
    const sync = await callTool<SyncPage>(u2Conn.client, 'network_sync', {
      scope: `room:${room3}`,
      limit: 100,
    });
    const removedEvent = sync.items.find(
      (item) => item.type === 'member_removed' && item.ref_id === b1.actor_id,
    );
    const dissolvedEvent = sync.items.find((item) => item.type === 'room_dissolved');
    check('G06-T04 存在 member_removed 事件', Boolean(removedEvent));
    checkEqual('G06-T04 member_removed 携带媒体撤权钩子', removedEvent?.metadata.media_revoke, true);
    check('G06-T04 存在 room_dissolved 事件', Boolean(dissolvedEvent));
    checkEqual('G06-T04 room_dissolved 携带媒体撤权钩子', dissolvedEvent?.metadata.media_revoke, true);
    check('G06-T04 解散事件不再包含旧任务摘要', !('cancelled_task_ids' in (dissolvedEvent?.metadata ?? {})));
    console.log(
      '  · G06-T04 媒体终止未验证：M09 通话模块尚未实现；本任务只提供上述事件钩子，不能声称已终止媒体发布/订阅。',
    );
  } finally {
    for (const connection of [u1Conn, u2Conn, u3Conn, b1Conn, b2Conn]) {
      await connection.close();
    }
  }
}
