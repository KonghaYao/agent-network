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

interface TaskAssignmentView {
  assignment_id: string;
  assignment_version: number;
  owner_actor_id: string;
  status: string;
}

interface TaskView {
  task_id: string;
  room_id: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  owner_name: string | null;
  assignment: TaskAssignmentView | null;
  delivery_ids: string[];
}

interface TaskResult {
  task: TaskView;
}

interface TransferView {
  transfer_id: string;
  status: string;
}

interface TransferProposal {
  transfer: TransferView;
  task: TaskView;
}

interface InFlightTaskView {
  task_id: string;
  title: string;
  status: string;
  owner_actor_id: string | null;
  owner_name: string | null;
  assignment_id: string | null;
  assignment_status: string | null;
  assignment_version: number | null;
}

interface LeavePreview {
  room_id: string;
  in_flight_tasks: InFlightTaskView[];
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
  cancelled_tasks: number;
  cancelled_task_ids: string[];
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
  items: { file_id: string; download_url: string; public_url: string }[];
}

async function readRoom(connection: McpConnection, roomId: string): Promise<RoomView> {
  return callTool<RoomView>(connection.client, 'network_room_get', { room_id: roomId });
}

async function createTask(
  connection: McpConnection,
  roomId: string,
  assignee: string,
  reviewer: string,
  title: string,
): Promise<TaskView> {
  const result = await callTool<TaskResult>(connection.client, 'network_task_create', {
    request_id: newRequestId('g06_task'),
    room_id: roomId,
    title,
    assignee_actor_id: assignee,
    reviewer_actor_id: reviewer,
  });
  return result.task;
}

async function acceptTask(connection: McpConnection, task: TaskView): Promise<TaskView> {
  const result = await callTool<TaskResult>(connection.client, 'network_task_accept', {
    request_id: newRequestId('g06_accept'),
    task_id: task.task_id,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    expected_revision: task.revision,
  });
  return result.task;
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (await callTool<TaskResult>(connection.client, 'network_task_get', { task_id: taskId }))
    .task;
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

    const t1 = await createTask(u1Conn, room1, b1.actor_id, u1.actor_id, 'G06-T01 被移除任务');
    await callTool(b1Conn.client, 'network_login', {});
    const b1Inbox = await callTool<InboxPage>(b1Conn.client, 'network_inbox_list', {
      state: 'pending',
    });
    const offerDelivery = b1Inbox.items.find(
      (item) => item.room_id === room1 && item.state === 'pending',
    );
    check('G06-T01 B1 收到任务 offer 投递', Boolean(offerDelivery));
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
    const acceptedT1 = await acceptTask(b1Conn, t1);
    checkEqual('G06-T01 B1 接受任务', acceptedT1.status, 'in_progress');

    await removeMember(u1Conn, room1, b1.actor_id);
    const t1After = await getTask(u1Conn, t1.task_id);
    checkEqual('G06-T01 移除后任务进入 blocked', t1After.status, 'blocked');
    checkEqual('G06-T01 移除后任务没有负责人', t1After.owner_actor_id, null);
    checkEqual('G06-T01 移除后不再有 active assignment', t1After.assignment, null);

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
    await expectToolError(
      'G06-T01 被移除者不能提交旧任务',
      callTool(b1Conn.client, 'network_task_submit', {
        request_id: newRequestId('g06_submit'),
        task_id: t1.task_id,
        summary: '迟到提交',
        evidence: ['late'],
      }),
      'NOT_FOUND',
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

    // B2 退群：预览列出在途任务；未确认时拒绝，确认后撤销。
    const t2 = await createTask(u1Conn, room1, b2.actor_id, u1.actor_id, 'G06-T01 退群任务');
    const acceptedT2 = await acceptTask(b2Conn, t2);
    const preview = await callTool<LeavePreview>(b2Conn.client, 'network_room_leave_preview', {
      room_id: room1,
    });
    check(
      'G06-T01 退群预览列出在途任务与状态/负责人',
      preview.in_flight_tasks.some(
        (task) =>
          task.task_id === acceptedT2.task_id &&
          task.status === 'in_progress' &&
          task.owner_actor_id === b2.actor_id,
      ),
    );
    const leaveError = await expectToolError(
      'G06-T01 未确认在途任务时退群被拒绝',
      callTool(b2Conn.client, 'network_room_leave', {
        request_id: newRequestId('g06_leave_unconfirmed'),
        room_id: room1,
      }),
      'CONFLICT',
    );
    checkEqual('G06-T01 拒绝原因标明在途工作', (leaveError.body.details as Record<string, unknown>)?.reason, 'in_flight_work');
    const leaveResult = await callTool<{
      left: true;
      in_flight_tasks: InFlightTaskView[];
    }>(b2Conn.client, 'network_room_leave', {
      request_id: newRequestId('g06_leave'),
      room_id: room1,
      confirm_in_flight: true,
    });
    check(
      'G06-T01 确认退群返回被撤销的在途任务',
      leaveResult.in_flight_tasks.some((task) => task.task_id === acceptedT2.task_id),
    );
    const t2After = await getTask(u1Conn, acceptedT2.task_id);
    checkEqual('G06-T01 退群后任务进入 blocked', t2After.status, 'blocked');
    await expectToolError('G06-T01 退群后不能读取房间', readRoom(b2Conn, room1), 'NOT_MEMBER');

    // ---------- G06-T02：移除 × D04 接任并发 ----------
    console.log('  G06-T02 移除与接任并发');
    const g2 = await createGroup(
      'G06-T02 并发验收群',
      [b1, b2],
      [
        { connection: b1Conn, identity: b1 },
        { connection: b2Conn, identity: b2 },
      ],
    );
    const room2 = g2.roomId;

    const proposeTransfer = async (task: TaskView): Promise<TransferProposal> =>
      callTool<TransferProposal>(u1Conn.client, 'network_task_transfer_propose', {
        request_id: newRequestId('g06_propose'),
        task_id: task.task_id,
        to_actor_id: b2.actor_id,
        expected_revision: task.revision,
      });

    const raceOutcomes: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const task = await createTask(u1Conn, room2, b1.actor_id, u1.actor_id, `G06-T02 并发 ${index}`);
      const accepted = await acceptTask(b1Conn, task);
      const proposal = await proposeTransfer(accepted);
      const [removeResult, acceptResult] = await Promise.allSettled([
        callTool(u1Conn.client, 'network_room_members_update', {
          request_id: newRequestId('g06_t02_remove'),
          room_id: room2,
          remove: [b1.actor_id],
        }),
        callTool(b2Conn.client, 'network_task_transfer_accept', {
          request_id: newRequestId('g06_t02_accept'),
          transfer_id: proposal.transfer.transfer_id,
        }),
      ]);
      const current = await getTask(u1Conn, accepted.task_id);
      if (current.owner_actor_id === b2.actor_id) {
        check(
          `G06-T02 #${index} 接任先提交时保留唯一新负责人`,
          current.status === 'in_progress' || current.status === 'blocked',
          current,
        );
        checkEqual(`G06-T02 #${index} 新 assignment 属于 B2`, current.assignment?.owner_actor_id, b2.actor_id);
        raceOutcomes.push('transfer_won');
      } else {
        check(
          `G06-T02 #${index} 移除先提交时任务明确 blocked`,
          current.status === 'blocked' && current.owner_actor_id === null && current.assignment === null,
          current,
        );
        if (acceptResult.status === 'rejected') {
          check(
            `G06-T02 #${index} 迟到接受失败`,
            isRejection(acceptResult.reason, ['CONFLICT', 'ASSIGNMENT_STALE', 'VERSION_CONFLICT', 'NOT_MEMBER']),
            acceptResult.reason,
          );
        }
        raceOutcomes.push('remove_won');
      }
      check(
        `G06-T02 #${index} 绝不保留两个有效执行版本`,
        current.owner_actor_id !== b1.actor_id,
        current,
      );
      check(`G06-T02 #${index} 移除事务成功`, removeResult.status === 'fulfilled', removeResult);
      await addMember(u1Conn, room2, b1.actor_id);
    }
    check(
      'G06-T02 并发每一轮都只留下唯一负责人或 blocked',
      raceOutcomes.length === 10,
      raceOutcomes,
    );
    console.log(`  · G06-T02 实际提交顺序: transfer_won=${raceOutcomes.filter((item) => item === 'transfer_won').length}, remove_won=${raceOutcomes.filter((item) => item === 'remove_won').length}`);

    // 确定性：移除先提交后，旧提议不能接受。
    const lateTask = await createTask(u1Conn, room2, b1.actor_id, u1.actor_id, 'G06-T02 迟到接受');
    const lateAccepted = await acceptTask(b1Conn, lateTask);
    const lateTransfer = await proposeTransfer(lateAccepted);
    await removeMember(u1Conn, room2, b1.actor_id);
    await expectToolError(
      'G06-T02 移除后旧接任提议不能接受',
      callTool(b2Conn.client, 'network_task_transfer_accept', {
        request_id: newRequestId('g06_t02_late'),
        transfer_id: lateTransfer.transfer.transfer_id,
      }),
      'CONFLICT',
    );
    const lateAfter = await getTask(u1Conn, lateAccepted.task_id);
    checkEqual('G06-T02 迟到接受后仍明确 blocked', lateAfter.status, 'blocked');
    await addMember(u1Conn, room2, b1.actor_id);

    // 确定性：接任先提交后，移除旧负责人不改变新指派。
    const keptTask = await createTask(u1Conn, room2, b1.actor_id, u1.actor_id, 'G06-T02 接任保留');
    const keptAccepted = await acceptTask(b1Conn, keptTask);
    const keptTransfer = await proposeTransfer(keptAccepted);
    await callTool(b2Conn.client, 'network_task_transfer_accept', {
      request_id: newRequestId('g06_t02_keep_accept'),
      transfer_id: keptTransfer.transfer.transfer_id,
    });
    await removeMember(u1Conn, room2, b1.actor_id);
    const keptAfter = await getTask(u1Conn, keptAccepted.task_id);
    checkEqual('G06-T02 先接任则保留 B2 负责人', keptAfter.owner_actor_id, b2.actor_id);
    checkEqual('G06-T02 先接任则 assignment 属于 B2', keptAfter.assignment?.owner_actor_id, b2.actor_id);
    check('G06-T02 先接任则任务仍在执行阶段', ['in_progress', 'blocked'].includes(keptAfter.status));

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

    const t3a = await createTask(u1Conn, room3, b1.actor_id, u1.actor_id, 'G06-T03 执行中任务');
    const t3aAccepted = await acceptTask(b1Conn, t3a);
    const t3b = await createTask(u1Conn, room3, b2.actor_id, u1.actor_id, 'G06-T03 待执行任务');
    const t3c = await createTask(u1Conn, room3, u1.actor_id, u2.actor_id, 'G06-T03 未指派任务');
    void t3c;
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

    // 群主不能带着其他成员直接退群。
    await expectToolError(
      'G06-T03 群主离群前必须转移或解散',
      callTool(u1Conn.client, 'network_room_leave', {
        request_id: newRequestId('g06_t03_owner_leave'),
        room_id: room3,
      }),
      'CONFLICT',
    );

    // 先移除 B1：B1 失去归档资格；B1 的任务被 blocked。
    await removeMember(u1Conn, room3, b1.actor_id);
    const t3aAfterRemove = await getTask(u1Conn, t3aAccepted.task_id);
    checkEqual('G06-T03 移除 B1 后任务 blocked', t3aAfterRemove.status, 'blocked');

    const headBeforeDissolve = (await readRoom(u1Conn, room3)).room.head_seq;

    const dissolve = await callTool<RoomView & { dissolve: DissolveSummary }>(
      u1Conn.client,
      'network_room_dissolve',
      {
        request_id: newRequestId('g06_dissolve'),
        room_id: room3,
        reason: 'G06 验收解散',
      },
    );
    check('G06-T03 解散取消至少一个未结束任务', dissolve.dissolve.cancelled_tasks >= 1, dissolve.dissolve);
    check('G06-T03 解散撤销邀请链接', dissolve.dissolve.revoked_invitations >= 1, dissolve.dissolve);
    check('G06-T03 解散撤销 pending 交接', dissolve.dissolve.cancelled_transfers >= 1, dissolve.dissolve);
    checkEqual('G06-T03 解散返回房间状态', dissolve.room.status, 'dissolved');
    checkEqual('G06-T03 解散后 read_only', dissolve.room.read_only, true);
    checkEqual('G06-T03 解散后不能再次解散', dissolve.room.can_dissolve, false);

    const u2Room = await readRoom(u2Conn, room3);
    check('G06-T03 合法成员保留归档边界', Number(u2Room.room.archived_head_seq) > 0);
    checkEqual('G06-T03 归档能力全部关闭', u2Room.room.capabilities.send_message, false);
    checkEqual('G06-T03 归档 read_only', u2Room.room.read_only, true);
    checkEqual('G06-T03 归档成员可退出', u2Room.room.can_leave, true);
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
    await expectToolError(
      'G06-T03 解散后不能创建任务',
      callTool(u2Conn.client, 'network_task_create', {
        request_id: newRequestId('g06_t03_task'),
        room_id: room3,
        title: '解散后任务',
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
    check('G06-T03 合法成员可重新获取归档文件票据', Boolean(u2ArchiveUrl));
    checkEqual(
      'G06-T03 合法成员归档文件仍可下载',
      u2ArchiveUrl ? (await fetch(u2ArchiveUrl)).status : 0,
      200,
    );

    // 所有未结束任务都已取消，保留成果审计。
    const taskList = await callTool<{ tasks: TaskView[] }>(u1Conn.client, 'network_task_list', {
      room_id: room3,
      limit: 100,
    });
    check(
      'G06-T03 解散后所有任务均为 cancelled',
      taskList.tasks.every((task) => task.status === 'cancelled'),
      taskList.tasks.map((task) => [task.task_id, task.status]),
    );
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
    check('G06-T04 解散事件包含取消任务摘要', Array.isArray(dissolvedEvent?.metadata.cancelled_task_ids));
    console.log(
      '  · G06-T04 媒体终止未验证：M09 通话模块尚未实现；本任务只提供上述事件钩子，不能声称已终止媒体发布/订阅。',
    );
  } finally {
    for (const connection of [u1Conn, u2Conn, u3Conn, b1Conn, b2Conn]) {
      await connection.close();
    }
  }
}
