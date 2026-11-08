/**
 * G07 群策略、并发授权快照与管理记录验收（T03）。
 *
 * 覆盖：默认 @所有人 仅群主/管理员、策略版本冲突、历史收紧后的材料失权、
 * 任务误验收拦截、普通成员摘要与 owner/admin 详细审计的分离，以及策略
 * 修改与房间/历史/文件/任务读取并发时的单响应授权一致性。
 */

import { acceptGroupInvites } from './acceptance-helpers';
import { callTool, check, checkEqual, expectToolError, newRequestId } from './harness';
import {
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
  setPolicy,
  taskPage,
  type FilePageView,
  type FileResultView,
  type GroupDetailView,
  type HistoryPageView,
  type NoticePageView,
  type PolicySetView,
  type RoleHistoryView,
  type TaskPageView,
  type TaskView,
} from './group-history-helpers';

export async function runGroupPolicyAcceptance(options: { hasDrive: boolean }): Promise<void> {
  const owner = await createActor('G07 策略群主', 'human');
  const member = await createActor('G07 策略成员', 'human');
  const agent = await createActor('G07 策略 Agent', 'agent');
  await makeFriends(owner, member);
  await makeFriends(owner, agent);
  try {
    const roomId = await createRoom(
      owner.connection,
      [member.actor.actor_id],
      'G07 策略并发群',
    );
    const preJoinMessage = await sendMessage(owner.connection, roomId, 'G07 策略加入前消息');
    const materialTaskId = await addTask(owner.connection, roomId, 'G07 材料任务');
    let materialFile: FileResultView | null = options.hasDrive
      ? await bindFile(owner, roomId, 'g07-material.txt', 'G07 材料任务')
      : null;
    await acceptGroupInvites(member.connection, roomId);
    // unclaimed Agent 直接加入，但必须晚于 preJoin 消息与材料任务。
    await callTool(owner.connection.client, 'network_room_members_update', {
      request_id: newRequestId('g07_policy_add_agent'),
      room_id: roomId,
      add: [agent.actor.actor_id],
    });

    await expectToolError(
      'G07-T03 默认普通成员不能 @所有人',
      sendMessage(member.connection, roomId, '@所有人 默认权限检查'),
      'PERMISSION_DENIED',
    );
    const ownerMention = await sendMessage(owner.connection, roomId, '@所有人 群主提醒');
    checkEqual('G07-T03 @所有人 不创建批量投递', ownerMention.delivery_ids.length, 0);

    let policyDetail = await roomDetail(owner.connection, roomId);
    checkEqual(
      'G07-T03 默认历史策略为 from_join',
      policyDetail.room.policies.member_history,
      'from_join',
    );
    checkEqual('G07-T03 默认入群审批为 open', policyDetail.room.policies.member_join, 'open');
    checkEqual(
      'G07-T03 默认资料编辑仅 owner/admin',
      policyDetail.room.policies.member_profile,
      'owner_admin',
    );
    checkEqual(
      'G07-T03 默认 @所有人仅 owner/admin',
      policyDetail.room.policies.member_mention_all,
      'owner_admin',
    );
    const memberPolicyDetail = await roomDetail(member.connection, roomId);
    checkEqual(
      'G07-T03 普通成员 @所有人 能力为 false',
      memberPolicyDetail.room.capabilities.mention_all,
      false,
    );

    const fullResult = await setPolicy(
      owner.connection,
      roomId,
      policyDetail.room.policy_revision,
      { member_history_policy: 'full' },
    );
    checkEqual('G07-T03 群主可显式开启全历史', fullResult.room.policies.member_history, 'full');
    check(
      'G07-T03 开启全历史提示影响',
      typeof fullResult.policy_impact?.message === 'string' &&
        fullResult.policy_impact!.message.includes('全历史'),
      fullResult.policy_impact,
    );
    checkEqual('G07-T03 开启全历史不报告材料失权', fullResult.policy_impact?.material_loss, false);

    const fullMemberDetail = await roomDetail(member.connection, roomId);
    checkEqual('G07-T03 全历史下边界为 0', fullMemberDetail.room.history_from_seq, '0');
    const fullMemberHistory = await history(member.connection, roomId);
    check(
      'G07-T03 全历史下新成员可见加入前消息',
      fullMemberHistory.items.some(
        (item) => item.message_id === preJoinMessage.message.message_id,
      ),
      fullMemberHistory.items,
    );
    const fullAgentTasks = await taskPage(agent.connection, roomId);
    check(
      'G07-T03 全历史下 Agent 可见加入前任务',
      fullAgentTasks.tasks.some((task) => task.task_id === materialTaskId),
      fullAgentTasks.tasks,
    );
    if (options.hasDrive && materialFile) {
      const fullFile = await callTool<FileResultView>(
        member.connection.client,
        'network_room_file_get',
        { room_id: roomId, file_id: materialFile.file.file_id },
      );
      checkEqual(
        'G07-T03 全历史下新成员可读加入前文件',
        (await fetch(fullFile.file.preview_url)).status,
        200,
      );
      materialFile = fullFile;
    }

    await expectToolError(
      'G07-T03 过期策略版本返回 VERSION_CONFLICT',
      setPolicy(owner.connection, roomId, policyDetail.room.policy_revision, {
        member_message_policy: 'members',
      }),
      'VERSION_CONFLICT',
    );

    policyDetail = await roomDetail(owner.connection, roomId);
    const configured = await setPolicy(
      owner.connection,
      roomId,
      policyDetail.room.policy_revision,
      {
        member_join_policy: 'approval',
        member_profile_policy: 'members',
        member_mention_all_policy: 'members',
      },
    );
    checkEqual('G07-T03 入群审批策略持久化', configured.room.policies.member_join, 'approval');
    checkEqual('G07-T03 资料编辑策略持久化', configured.room.policies.member_profile, 'members');
    const configuredMember = await roomDetail(member.connection, roomId);
    checkEqual(
      'G07-T03 普通成员获得 @所有人 能力',
      configuredMember.room.capabilities.mention_all,
      true,
    );
    const memberMention = await sendMessage(member.connection, roomId, '@所有人 普通成员提醒');
    checkEqual('G07-T03 放开后普通成员 @所有人 不批量投递', memberMention.delivery_ids.length, 0);

    policyDetail = await roomDetail(owner.connection, roomId);
    await setPolicy(owner.connection, roomId, policyDetail.room.policy_revision, {
      member_mention_all_policy: 'owner_admin',
    });
    await expectToolError(
      'G07-T03 收回 @所有人 后普通成员立即被拒绝',
      sendMessage(member.connection, roomId, '@所有人 再次检查'),
      'PERMISSION_DENIED',
    );

    // 全历史下 Agent 领取加入前任务，随后收紧历史，完成必须被拒绝。
    const claimed = await callTool<{ task: TaskView }>(
      agent.connection.client,
      'network_task_claim',
      { request_id: newRequestId('g07_claim_material'), task_id: materialTaskId },
    );
    checkEqual('G07-T03 Agent 在全历史下领取任务', claimed.task.status, 'in_progress');

    policyDetail = await roomDetail(owner.connection, roomId);
    const narrowed = await setPolicy(
      owner.connection,
      roomId,
      policyDetail.room.policy_revision,
      { member_history_policy: 'from_join' },
    );
    checkEqual(
      'G07-T03 收紧后策略为 from_join',
      narrowed.room.policies.member_history,
      'from_join',
    );
    checkEqual('G07-T03 收紧报告材料失权', narrowed.policy_impact?.material_loss, true);
    check(
      'G07-T03 收紧报告隐藏任务',
      (narrowed.policy_impact?.hidden_tasks ?? 0) >= 1,
      narrowed.policy_impact,
    );
    if (options.hasDrive) {
      check(
        'G07-T03 收紧报告隐藏文件',
        (narrowed.policy_impact?.hidden_files ?? 0) >= 1,
        narrowed.policy_impact,
      );
    }

    const narrowedDetail = await roomDetail(member.connection, roomId);
    const narrowedAuth = detailAuthorization(narrowedDetail);
    check(
      'G07-T03 收紧后边界回到加入序号',
      Number(narrowedAuth.history_from_seq) > 0,
      narrowedAuth,
    );
    const narrowedHistory = await history(member.connection, roomId);
    check(
      'G07-T03 收紧后加入前消息不可见',
      !narrowedHistory.items.some(
        (item) => item.message_id === preJoinMessage.message.message_id,
      ),
      narrowedHistory.items,
    );
    assertAuthorization(
      'G07-T03 收紧后历史与 room_get 授权一致',
      narrowedHistory.authorization,
      narrowedAuth,
    );
    await expectToolError(
      'G07-T03 收紧后按 ID 直读加入前消息返回 NOT_FOUND',
      callTool(member.connection.client, 'network_message_read', {
        message_id: preJoinMessage.message.message_id,
      }),
      'NOT_FOUND',
    );
    await expectToolError(
      'G07-T03 材料失权后按 ID 读取任务返回 NOT_FOUND',
      callTool(agent.connection.client, 'network_task_get', {
        task_id: materialTaskId,
      }),
      'NOT_FOUND',
    );
    const narrowedTasks = await taskPage(agent.connection, roomId);
    check(
      'G07-T03 材料失权后任务列表不可见',
      !narrowedTasks.tasks.some((task) => task.task_id === materialTaskId),
      narrowedTasks.tasks,
    );
    checkHistoryInsideBoundary('G07-T03 收紧后历史', narrowedHistory);
    if (options.hasDrive && materialFile) {
      await expectToolError(
        'G07-T03 收紧后文件按 ID 读取返回 FILE_UNAVAILABLE',
        callTool(member.connection.client, 'network_room_file_get', {
          room_id: roomId,
          file_id: materialFile.file.file_id,
        }),
        'FILE_UNAVAILABLE',
      );
      await expectFileUrlGone('G07-T03 收紧后旧文件票据失效', materialFile.file.preview_url);
      const narrowedFiles = await listFiles(member.connection, roomId);
      assertAuthorization(
        'G07-T03 文件列表授权与 room_get 一致',
        narrowedFiles.authorization,
        narrowedAuth,
      );
      check(
        'G07-T03 收紧后文件列表不含加入前文件',
        !narrowedFiles.items.some((item) => item.file_id === materialFile!.file.file_id),
        narrowedFiles.items,
      );
    }

    // 普通成员只看到影响自身/公告/策略的摘要；详细记录仅群主/管理员可读。
    const notices = await callTool<NoticePageView>(
      member.connection.client,
      'network_room_notice_list',
      { room_id: roomId, limit: 100 },
    );
    check(
      'G07-T03 普通成员可见策略摘要',
      notices.items.some((item) => item.action === 'policy_updated'),
      notices.items.map((item) => item.action),
    );
    check(
      'G07-T03 普通成员可见影响自己的成员事件',
      notices.items.some(
        (item) => item.action === 'member_added' && item.target_actor_id === member.actor.actor_id,
      ),
      notices.items,
    );
    check(
      'G07-T03 普通成员摘要不含内部 detail/request_id',
      notices.items.every(
        (item) =>
          !('detail' in item) &&
          !('request_id' in item) &&
          !JSON.stringify(item).includes(preJoinMessage.message.message_id),
      ),
      notices.items,
    );
    await expectToolError(
      'G07-T03 普通成员不能读取详细管理审计',
      callTool(member.connection.client, 'network_room_role_history', {
        room_id: roomId,
        limit: 100,
      }),
      'PERMISSION_DENIED',
    );
    const ownerAudit = await callTool<RoleHistoryView>(
      owner.connection.client,
      'network_room_role_history',
      { room_id: roomId, limit: 100 },
    );
    check(
      'G07-T03 群主可读取详细管理审计',
      ownerAudit.items.some((item) => item.action === 'policy_updated'),
      ownerAudit.items.map((item) => item.action),
    );
    const auditText = JSON.stringify(ownerAudit);
    check(
      'G07-T03 管理审计不包含消息正文',
      !auditText.includes('G07 策略加入前消息') && !auditText.includes('G07 材料任务'),
      auditText.slice(0, 400),
    );

    // 并发：策略开启全历史与多入口读取交错，每个响应内部使用同一授权快照。
    const beforeConcurrent = await roomDetail(owner.connection, roomId);
    const startRevision = beforeConcurrent.room.policy_revision;
    const reads: Promise<
      | { kind: 'history'; page: HistoryPageView }
      | { kind: 'room'; detail: GroupDetailView }
      | { kind: 'files'; page: FilePageView }
      | { kind: 'tasks'; page: TaskPageView }
    >[] = [];
    for (let index = 0; index < 6; index += 1) {
      reads.push(
        history(member.connection, roomId).then((page) => ({ kind: 'history', page })),
      );
    }
    for (let index = 0; index < 3; index += 1) {
      reads.push(
        roomDetail(member.connection, roomId).then((detail) => ({ kind: 'room', detail })),
      );
      reads.push(
        taskPage(agent.connection, roomId).then((page) => ({ kind: 'tasks', page })),
      );
      if (options.hasDrive) {
        reads.push(
          listFiles(member.connection, roomId).then((page) => ({ kind: 'files', page })),
        );
      }
    }
    const policyPromise: Promise<PolicySetView> = setPolicy(
      owner.connection,
      roomId,
      startRevision,
      { member_history_policy: 'full' },
    );
    const readsPromise = Promise.allSettled(reads);
    const policyOutcome = await policyPromise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    const settledReads = await readsPromise;
    check('G07-T03 并发策略写入成功', policyOutcome.status === 'fulfilled', policyOutcome);

    for (const outcome of settledReads) {
      if (outcome.status !== 'fulfilled') {
        throw new Error(`G07-T03 并发读取失败: ${String(outcome.reason)}`);
      }
      const result = outcome.value;
      const auth =
        result.kind === 'history' || result.kind === 'files' || result.kind === 'tasks'
          ? result.page.authorization
          : detailAuthorization(result.detail);
      check(
        'G07-T03 并发读取使用提交前或提交后的同一版本',
        auth.policy_revision === startRevision || auth.policy_revision === startRevision + 1,
        auth,
      );
      const full = auth.history_from_seq === '0';
      if (result.kind === 'history') {
        checkHistoryInsideBoundary('G07-T03 并发历史', result.page);
        checkEqual(
          'G07-T03 并发历史包含加入前消息与全历史一致',
          result.page.items.some(
            (item) => item.message_id === preJoinMessage.message.message_id,
          ),
          full,
        );
      } else if (result.kind === 'room') {
        checkEqual(
          'G07-T03 并发 room_get 边界与快照一致',
          result.detail.room.history_from_seq,
          auth.history_from_seq,
        );
        checkEqual(
          'G07-T03 并发 room_get 代次与快照一致',
          String(result.detail.room.my_member_generation),
          auth.member_generation,
        );
        checkEqual(
          'G07-T03 并发 room_get 策略与边界一致',
          result.detail.room.policies.member_history === 'full',
          full,
        );
      } else if (result.kind === 'files' && options.hasDrive && materialFile) {
        checkEqual(
          'G07-T03 并发文件入口与全历史一致',
          result.page.items.some((item) => item.file_id === materialFile!.file.file_id),
          full,
        );
      } else if (result.kind === 'tasks') {
        checkEqual(
          'G07-T03 并发任务入口与全历史一致',
          result.page.tasks.some((task) => task.task_id === materialTaskId),
          full,
        );
      }
    }

    const afterConcurrent = await roomDetail(member.connection, roomId);
    const finalAuth = detailAuthorization(afterConcurrent);
    const finalHistory = await history(member.connection, roomId);
    assertAuthorization('G07-T03 最终历史与 room_get 一致', finalHistory.authorization, finalAuth);
    const finalAgentDetail = await roomDetail(agent.connection, roomId);
    const finalTasks = await taskPage(agent.connection, roomId);
    assertAuthorization(
      'G07-T03 最终任务与 Agent 自身快照一致',
      finalTasks.authorization,
      detailAuthorization(finalAgentDetail),
    );
    if (options.hasDrive) {
      const finalFiles = await listFiles(member.connection, roomId);
      assertAuthorization('G07-T03 最终文件与 room_get 一致', finalFiles.authorization, finalAuth);
    }
  } finally {
    await Promise.all([
      owner.connection.close(),
      member.connection.close(),
      agent.connection.close(),
    ]);
  }
}
