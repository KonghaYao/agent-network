/**
 * G07 群历史边界与重新加入端到端验收（T01–T02）。
 *
 * T01：新成员默认只能读取当前加入后的消息；已知 message_id、文件 URL、
 * 引用、房间摘要、sync 与任务上下文都不能绕过边界。
 * T02：重新加入产生新代次；旧历史/文件/时间线游标返回 CURSOR_EXPIRED，
 * 旧签名 URL 立即失效，新代次只获得新加入后的内容。
 *
 * 搜索、收藏与转发属于尚未实现的任务（M04/M05/M08）；这里用房间摘要、
 * sync 与任务上下文覆盖现有入口，不把不存在的工具写成已验证。
 */

import { acceptGroupInvites } from './acceptance-helpers';
import { callTool, check, checkEqual, expectToolError, newRequestId } from './harness';
import {
  HISTORY_MARKER,
  POST_MARKER,
  TASK_MARKER,
  addTask,
  assertAuthorization,
  bindFile,
  checkHistoryInsideBoundary,
  createActor,
  createRoom,
  detailAuthorization,
  expectFileUrlGone,
  history,
  listFiles,
  makeFriends,
  roomDetail,
  sendMessage,
  taskPage,
  timeline,
  type FileResultView,
  type RoomListView,
  type SyncView,
} from './group-history-helpers';

export async function runGroupHistoryAcceptance(options: { hasDrive: boolean }): Promise<void> {
  const owner = await createActor('G07 群主', 'human');
  const member = await createActor('G07 成员', 'human');
  const agent = await createActor('G07 Agent', 'agent');
  await makeFriends(owner, member);
  await makeFriends(owner, agent);
  try {
    // ---- G07-T01：新成员不能绕过历史边界 ----
    const roomId = await createRoom(
      owner.connection,
      [member.actor.actor_id],
      'G07 历史边界群',
    );
    const beforeJoin = await sendMessage(owner.connection, roomId, HISTORY_MARKER);
    const beforeTaskId = await addTask(owner.connection, roomId, TASK_MARKER);
    const beforeFile = options.hasDrive
      ? await bindFile(owner, roomId, 'g07-before-join.txt', HISTORY_MARKER)
      : null;

    await acceptGroupInvites(member.connection, roomId);
    // unclaimed Agent 可被直接加入，但加入时刻仍必须晚于既有消息/任务，
    // 才能验证 G07 的成员代次边界。
    await callTool(owner.connection.client, 'network_room_members_update', {
      request_id: newRequestId('g07_add_agent'),
      room_id: roomId,
      add: [agent.actor.actor_id],
    });

    const memberDetail = await roomDetail(member.connection, roomId);
    checkEqual('G07-T01 新成员代次从 1 开始', memberDetail.room.my_member_generation, 1);
    check(
      'G07-T01 新成员历史下界大于 0',
      Number(memberDetail.room.history_from_seq) > 0,
      memberDetail.room.history_from_seq,
    );
    assertAuthorization(
      'G07-T01 room_get 与自身快照',
      detailAuthorization(memberDetail),
      {
        policy_revision: memberDetail.room.policy_revision,
        history_from_seq: memberDetail.room.history_from_seq,
        member_generation: String(memberDetail.room.my_member_generation),
      },
    );

    const memberHistory = await history(member.connection, roomId);
    check(
      'G07-T01 列表不包含加入前消息',
      !memberHistory.items.some((item) => item.message_id === beforeJoin.message.message_id),
      memberHistory.items,
    );
    checkHistoryInsideBoundary('G07-T01 历史', memberHistory);
    assertAuthorization(
      'G07-T01 历史与 room_get 授权一致',
      memberHistory.authorization,
      detailAuthorization(memberDetail),
    );

    await expectToolError(
      'G07-T01 已知 message_id 直读返回 NOT_FOUND',
      callTool(member.connection.client, 'network_message_read', {
        message_id: beforeJoin.message.message_id,
      }),
      'NOT_FOUND',
    );
    await expectToolError(
      'G07-T01 引用加入前消息返回 NOT_FOUND',
      sendMessage(member.connection, roomId, '引用加入前消息', {
        replyTo: beforeJoin.message.message_id,
      }),
      'NOT_FOUND',
    );

    const memberRooms = await callTool<RoomListView>(member.connection.client, 'network_rooms_list', {
      limit: 50,
    });
    const memberRoomRow = memberRooms.items.find((item) => item.room_id === roomId);
    check(
      'G07-T01 房间摘要不泄露加入前最后消息',
      !memberRoomRow?.last_message ||
        !memberRoomRow.last_message.preview.includes(HISTORY_MARKER),
      memberRoomRow?.last_message,
    );

    const memberSync = await callTool<SyncView>(member.connection.client, 'network_sync', {
      scope: `room:${roomId}`,
    });
    check(
      'G07-T01 sync 不补发加入前消息事件',
      !memberSync.items.some((item) => item.ref_id === beforeJoin.message.message_id),
      memberSync.items,
    );

    const agentDetail = await roomDetail(agent.connection, roomId);
    const memberTasks = await taskPage(agent.connection, roomId);
    check(
      'G07-T01 任务列表不包含加入前任务',
      !memberTasks.tasks.some((task) => task.task_id === beforeTaskId),
      memberTasks.tasks,
    );
    assertAuthorization(
      'G07-T01 任务列表授权与 Agent 自身快照一致',
      memberTasks.authorization,
      detailAuthorization(agentDetail),
    );
    await expectToolError(
      'G07-T01 领取加入前任务返回 NOT_FOUND',
      callTool(agent.connection.client, 'network_task_claim', {
        request_id: newRequestId('g07_claim'),
        task_id: beforeTaskId,
      }),
      'NOT_FOUND',
    );

    if (options.hasDrive && beforeFile) {
      const memberFiles = await listFiles(member.connection, roomId);
      check(
        'G07-T01 文件列表不包含加入前文件',
        !memberFiles.items.some((item) => item.file_id === beforeFile.file.file_id),
        memberFiles.items,
      );
      assertAuthorization(
        'G07-T01 文件列表授权与 room_get 一致',
        memberFiles.authorization,
        detailAuthorization(memberDetail),
      );
      await expectToolError(
        'G07-T01 按 ID 读取加入前文件返回 FILE_UNAVAILABLE',
        callTool(member.connection.client, 'network_room_file_get', {
          room_id: roomId,
          file_id: beforeFile.file.file_id,
        }),
        'FILE_UNAVAILABLE',
      );
      await expectFileUrlGone('G07-T01 裸文件 URL 不可读', beforeFile.file.public_url);
    }

    const ownerHistory = await history(owner.connection, roomId);
    check(
      'G07-T01 群主仍可见加入前消息',
      ownerHistory.items.some((item) => item.message_id === beforeJoin.message.message_id),
      ownerHistory.items,
    );

    // ---- G07-T02：重新加入使用新代次，旧游标、旧票据失效 ----
    const postJoin1 = await sendMessage(owner.connection, roomId, `${POST_MARKER} 1`);
    await sendMessage(owner.connection, roomId, `${POST_MARKER} 2`);
    const memberHistoryPage = await history(member.connection, roomId, { limit: 1 });
    check('G07-T02 加入后消息可读', memberHistoryPage.items.length > 0);
    check(
      'G07-T02 获得历史游标',
      typeof memberHistoryPage.next_cursor === 'string',
      memberHistoryPage.next_cursor,
    );
    const oldHistoryCursor = memberHistoryPage.next_cursor as string;

    const memberTimeline = await timeline(member.connection, roomId);
    check(
      'G07-T02 获得时间线游标',
      memberTimeline.timeline_resume_cursor.length > 0,
      memberTimeline.timeline_resume_cursor,
    );

    let firstFile: FileResultView | null = null;
    let secondFile: FileResultView | null = null;
    let oldFileCursor: string | null = null;
    if (options.hasDrive) {
      firstFile = await bindFile(owner, roomId, 'g07-gen1-a.txt', POST_MARKER);
      secondFile = await bindFile(owner, roomId, 'g07-gen1-b.txt', POST_MARKER);
      const memberFirst = await callTool<FileResultView>(
        member.connection.client,
        'network_room_file_get',
        { room_id: roomId, file_id: firstFile.file.file_id },
      );
      checkEqual(
        'G07-T02 加入后文件可下载',
        (await fetch(memberFirst.file.preview_url)).status,
        200,
      );
      firstFile = memberFirst;
      secondFile = await callTool<FileResultView>(
        member.connection.client,
        'network_room_file_get',
        { room_id: roomId, file_id: secondFile.file.file_id },
      );
      const memberFilePage = await listFiles(member.connection, roomId, 1);
      check(
        'G07-T02 获得文件游标',
        typeof memberFilePage.next_cursor === 'string',
        memberFilePage.next_cursor,
      );
      oldFileCursor = memberFilePage.next_cursor as string;
    }

    const memberJoinedSeq = memberDetail.members.find(
      (item) => item.actor_id === member.actor.actor_id,
    )?.joined_seq;
    await callTool(owner.connection.client, 'network_room_members_update', {
      request_id: newRequestId('g07_remove'),
      room_id: roomId,
      remove: [member.actor.actor_id],
    });
    await expectToolError(
      'G07-T02 移除后不能再读取房间',
      roomDetail(member.connection, roomId),
      'NOT_MEMBER',
    );
    await expectToolError(
      'G07-T02 移除后不能读取管理摘要',
      callTool(member.connection.client, 'network_room_notice_list', { room_id: roomId }),
      'NOT_MEMBER',
    );
    if (firstFile) {
      await expectFileUrlGone('G07-T02 移除后旧签名 URL 立即失效', firstFile.file.preview_url);
    }
    await callTool(owner.connection.client, 'network_room_members_update', {
      request_id: newRequestId('g07_readd'),
      room_id: roomId,
      add: [member.actor.actor_id],
    });

    const rejoinDetail = await roomDetail(member.connection, roomId);
    checkEqual('G07-T02 重新加入代次递增到 2', rejoinDetail.room.my_member_generation, 2);
    check(
      'G07-T02 重新加入记录新的 joined_seq',
      Number(
        rejoinDetail.members.find((item) => item.actor_id === member.actor.actor_id)?.joined_seq,
      ) > Number(memberJoinedSeq),
      {
        before: memberJoinedSeq,
        after: rejoinDetail.members.find((item) => item.actor_id === member.actor.actor_id)
          ?.joined_seq,
      },
    );

    await expectToolError(
      'G07-T02 旧历史游标返回 CURSOR_EXPIRED',
      history(member.connection, roomId, { cursor: oldHistoryCursor }),
      'CURSOR_EXPIRED',
    );
    await expectToolError(
      'G07-T02 旧时间线游标返回 CURSOR_EXPIRED',
      callTool(member.connection.client, 'network_history_list', {
        room_id: roomId,
        view: 'timeline',
        cursor: memberTimeline.timeline_resume_cursor,
      }),
      'CURSOR_EXPIRED',
    );
    if (oldFileCursor) {
      await expectToolError(
        'G07-T02 旧文件游标返回 CURSOR_EXPIRED',
        callTool(member.connection.client, 'network_room_file_list', {
          room_id: roomId,
          cursor: oldFileCursor,
          limit: 1,
        }),
        'CURSOR_EXPIRED',
      );
    }

    const rejoinedHistory = await history(member.connection, roomId);
    check(
      'G07-T02 新代次看不到上一代次消息',
      !rejoinedHistory.items.some(
        (item) =>
          item.message_id === postJoin1.message.message_id ||
          item.message_id === beforeJoin.message.message_id,
      ),
      rejoinedHistory.items,
    );
    await expectToolError(
      'G07-T02 新代次直读旧消息返回 NOT_FOUND',
      callTool(member.connection.client, 'network_message_read', {
        message_id: postJoin1.message.message_id,
      }),
      'NOT_FOUND',
    );
    const rejoinedTasks = await taskPage(member.connection, roomId);
    check(
      'G07-T02 新代次任务列表不含上一代次任务',
      !rejoinedTasks.tasks.some((task) => task.task_id === beforeTaskId),
      rejoinedTasks.tasks,
    );
    if (options.hasDrive && firstFile && secondFile) {
      const rejoinedFiles = await listFiles(member.connection, roomId);
      check(
        'G07-T02 新代次文件列表不含上一代次文件',
        !rejoinedFiles.items.some(
          (item) =>
            item.file_id === firstFile!.file.file_id ||
            item.file_id === secondFile!.file.file_id,
        ),
        rejoinedFiles.items,
      );
    }

    if (options.hasDrive && firstFile && secondFile) {
      await expectToolError(
        'G07-T02 新代次读取旧文件返回 FILE_UNAVAILABLE',
        callTool(member.connection.client, 'network_room_file_get', {
          room_id: roomId,
          file_id: firstFile.file.file_id,
        }),
        'FILE_UNAVAILABLE',
      );
      await expectFileUrlGone('G07-T02 旧签名 URL 立即失效', firstFile.file.preview_url);
      await expectFileUrlGone('G07-T02 另一旧签名 URL 也失效', secondFile.file.preview_url);

      const freshFile = await bindFile(owner, roomId, 'g07-gen2.txt', 'G07 新代次文件');
      const freshMember = await callTool<FileResultView>(
        member.connection.client,
        'network_room_file_get',
        { room_id: roomId, file_id: freshFile.file.file_id },
      );
      checkEqual(
        'G07-T02 新代次可以读取新加入后的文件',
        (await fetch(freshMember.file.preview_url)).status,
        200,
      );
    }

    const freshMessage = await sendMessage(owner.connection, roomId, 'G07 新代次可读消息');
    const freshHistory = await history(member.connection, roomId);
    check(
      'G07-T02 新代次可以读取新加入后的消息',
      freshHistory.items.some((item) => item.message_id === freshMessage.message.message_id),
      freshHistory.items,
    );
  } finally {
    await Promise.all([
      owner.connection.close(),
      member.connection.close(),
      agent.connection.close(),
    ]);
  }
}
