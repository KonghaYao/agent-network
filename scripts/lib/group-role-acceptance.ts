/**
 * G03 群主管理员成员权限端到端验收（T01–T03）。
 *
 * T01：普通成员直接调用管理工具被拒绝；管理员不能转移 owner、任免管理员
 * 或移除 owner；owner 任免管理员后可移除普通成员。
 * T02：撤销管理员与其移除成员并发时按事务提交序裁决，无半提交；
 * 过期 expected_role_revision 返回 VERSION_CONFLICT。
 * T03：网页（raw JSON-RPC）与 MCP 客户端对同一身份授权结果一致；
 * 管理员 Agent 仍不能重发或改名其他 Agent 的凭据。
 */

import {
  acceptGroupInvites,
  befriend,
  registerIdentity,
  type Identity,
} from './acceptance-helpers';
import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  rawRpc,
  ToolError,
  type McpConnection,
} from './harness';

interface MemberActionsView {
  can_remove: boolean;
  can_set_admin: boolean;
  can_revoke_admin: boolean;
  can_transfer_owner: boolean;
}

interface GroupMemberView {
  actor_id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  role_revision: number;
  kind: string;
  actions: MemberActionsView;
}

interface GroupRoomView {
  room: {
    room_id: string;
    kind: string;
    owner_id: string | null;
    head_seq: string;
    my_role: 'owner' | 'admin' | 'member';
    my_role_revision: number;
    policy_revision: number;
    policies: {
      member_message: 'members' | 'owner_admin';
      member_invite: 'members' | 'owner_admin';
      member_task: 'members' | 'owner_admin';
    };
    announcement: string;
    announcement_revision: number;
    capabilities: Record<string, boolean>;
  };
  members: GroupMemberView[];
}

interface RoleHistoryView {
  items: {
    audit_id: string;
    action: string;
    target_actor_id: string | null;
    target_name: string | null;
    previous_role: string | null;
    new_role: string | null;
    resulting_revision: number;
    changed_by: string;
    request_id: string;
  }[];
  next_cursor: string | null;
  has_more: boolean;
}

interface AgentCreateView {
  actor_id: string;
  token: string;
  mcp_url: string;
}

interface RawToolResult<T> {
  isError?: boolean;
  structuredContent?: T;
  content?: { type: string; text?: string }[];
}

async function rawTool<T>(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  const result = response.body.result as RawToolResult<T> | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果: ${JSON.stringify(response.body)}`);
  if (result.isError) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(`工具 ${name} 返回错误: ${text ?? JSON.stringify(result)}`);
  }
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`工具 ${name} 没有结构化结果`);
  return JSON.parse(text) as T;
}

async function rawToolErrorCode(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  const result = response.body.result as RawToolResult<unknown> | undefined;
  if (!result?.isError) return undefined;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as { code?: string };
    return body.code;
  } catch {
    return undefined;
  }
}

async function roomOf(connection: McpConnection, roomId: string): Promise<GroupRoomView> {
  return callTool<GroupRoomView>(connection.client, 'network_room_get', { room_id: roomId });
}

/** 退群后不再是成员时返回 null，便于并发后从任一方读取最终状态。 */
async function roomOfIfMember(
  connection: McpConnection,
  roomId: string,
): Promise<GroupRoomView | null> {
  try {
    return await roomOf(connection, roomId);
  } catch (error) {
    if (error instanceof ToolError && error.code === 'NOT_MEMBER') return null;
    throw error;
  }
}

async function leaveRoom(
  connection: McpConnection,
  roomId: string,
): Promise<{ room_id: string; left: true }> {
  return callTool<{ room_id: string; left: true }>(connection.client, 'network_room_leave', {
    request_id: newRequestId('g03_leave'),
    room_id: roomId,
  });
}

function memberOf(detail: GroupRoomView, actorId: string): GroupMemberView {
  const member = detail.members.find((item) => item.actor_id === actorId);
  if (!member) throw new Error(`成员 ${actorId} 不在房间成员列表中`);
  return member;
}

async function addMembers(
  connection: McpConnection,
  roomId: string,
  actorIds: string[],
  expectedRoleRevision?: number,
): Promise<GroupRoomView> {
  return callTool<GroupRoomView>(connection.client, 'network_room_members_update', {
    request_id: newRequestId('g03_add'),
    room_id: roomId,
    add: actorIds,
    ...(expectedRoleRevision === undefined
      ? {}
      : { expected_role_revision: expectedRoleRevision }),
  });
}

/** T04：owner 退群与并发加人必须在同一事务裁决，不能产生无 owner 的非空群。 */
async function runOwnerLeaveConcurrency(): Promise<void> {
  console.log('  G03-T04 owner 退群与并发加人');
  const ownerConn = await connectClient(newToken());
  const memberConn = await connectClient(newToken());
  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'G03 退群 owner' });
    const member = await registerIdentity(memberConn, { kind: 'human', name: 'G03 退群成员' });
    await befriend(ownerConn, owner.actor_id, memberConn, member.actor_id);

    const created = await callTool<GroupRoomView>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('g03_leave_room'),
      kind: 'group',
      members: [member.actor_id],
      title: 'G03 owner 退群确定性',
    });
    const roomId = created.room.room_id;
    await acceptGroupInvites(memberConn, roomId);
    await expectToolError(
      'G03 owner 有其他 active 成员时退群被拒绝',
      leaveRoom(ownerConn, roomId),
      'CONFLICT',
    );
    const afterRejection = await roomOf(ownerConn, roomId);
    checkEqual('G03 拒绝退群后 owner 仍在位', afterRejection.room.owner_id, owner.actor_id);
    checkEqual('G03 拒绝退群后 owner 角色未变', afterRejection.room.my_role, 'owner');
    check(
      'G03 拒绝退群后另一成员仍 active',
      afterRejection.members.some((item) => item.actor_id === member.actor_id),
      afterRejection.members,
    );

    // 最后一名 owner 退群仍然允许；随后任何一方都不能再向空群加人。
    const solo = await callTool<GroupRoomView>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('g03_solo_room'),
      kind: 'group',
      members: [member.actor_id],
      title: 'G03 owner 独自退群',
    });
    const soloRoomId = solo.room.room_id;
    // G01 起建群生成邀请；先接受为 active 成员，再验证 owner 移除后独自退群。
    await acceptGroupInvites(memberConn, soloRoomId);
    await callTool(ownerConn.client, 'network_room_members_update', {
      request_id: newRequestId('g03_solo_remove'),
      room_id: soloRoomId,
      remove: [member.actor_id],
    });
    await leaveRoom(ownerConn, soloRoomId);
    checkEqual(
      'G03 owner 是唯一 active 成员时允许退群',
      await roomOfIfMember(ownerConn, soloRoomId),
      null,
    );
    await expectToolError(
      'G03 owner 退群后不能向空群加人',
      addMembers(ownerConn, soloRoomId, [member.actor_id]),
      'NOT_MEMBER',
    );

    let bothSucceeded = 0;
    let nonEmptyWithoutOwner = 0;
    let emptyRooms = 0;
    let nonEmptyWithOwner = 0;
    for (let round = 0; round < 40; round += 1) {
      const room = await callTool<GroupRoomView>(ownerConn.client, 'network_room_create', {
        request_id: newRequestId('g03_race_room'),
        kind: 'group',
        members: [member.actor_id],
        title: `G03 owner 退群并发 ${round + 1}`,
      });
      const raceRoomId = room.room.room_id;
      await acceptGroupInvites(memberConn, raceRoomId);
      await callTool(ownerConn.client, 'network_room_members_update', {
        request_id: newRequestId('g03_race_remove'),
        room_id: raceRoomId,
        remove: [member.actor_id],
      });
      const [addOutcome, leaveOutcome] = await Promise.allSettled([
        callTool<GroupRoomView>(ownerConn.client, 'network_room_members_update', {
          request_id: newRequestId('g03_race_add'),
          room_id: raceRoomId,
          add: [member.actor_id],
        }),
        leaveRoom(ownerConn, raceRoomId),
      ]);
      const addSucceeded = addOutcome.status === 'fulfilled';
      const leaveSucceeded = leaveOutcome.status === 'fulfilled';
      if (addSucceeded && leaveSucceeded) bothSucceeded += 1;

      const detail =
        (await roomOfIfMember(ownerConn, raceRoomId)) ??
        (await roomOfIfMember(memberConn, raceRoomId));
      if (!detail) {
        emptyRooms += 1;
        check(`G03 第 ${round + 1} 轮空群时 add 未成功`, addSucceeded === false);
        continue;
      }
      const ownerRow = detail.members.find(
        (item) => item.actor_id === detail.room.owner_id && item.role === 'owner',
      );
      check(
        `G03 第 ${round + 1} 轮非空群仍有 owner`,
        detail.room.owner_id !== null && Boolean(ownerRow),
        { owner_id: detail.room.owner_id, members: detail.members },
      );
      if (!ownerRow) nonEmptyWithoutOwner += 1;
      else nonEmptyWithOwner += 1;
    }
    checkEqual('G03 40 轮 owner 退群与加人不能同时成功', bothSucceeded, 0);
    checkEqual('G03 40 轮没有“有成员但 owner 为空”', nonEmptyWithoutOwner, 0);
    console.log(
      `    owner 退群并发结果：空群 ${emptyRooms} 轮，保留 owner ${nonEmptyWithOwner} 轮`,
    );
  } finally {
    await ownerConn.close();
    await memberConn.close();
  }
}

export async function runGroupRoleAcceptance(): Promise<void> {
  const ownerConn = await connectClient(newToken());
  const adminConn = await connectClient(newToken());
  const memberConn = await connectClient(newToken());
  const outsiderConn = await connectClient(newToken());
  const agentConnections: McpConnection[] = [];
  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'G03 群主' });
    const adminTarget = await registerIdentity(adminConn, {
      kind: 'human',
      name: 'G03 候选管理员',
    });
    const plainMember = await registerIdentity(memberConn, {
      kind: 'human',
      name: 'G03 普通成员',
    });
    const outsider = await registerIdentity(outsiderConn, {
      kind: 'human',
      name: 'G03 群外成员',
    });
    await befriend(ownerConn, owner.actor_id, adminConn, adminTarget.actor_id);
    await befriend(ownerConn, owner.actor_id, memberConn, plainMember.actor_id);
    await befriend(ownerConn, owner.actor_id, outsiderConn, outsider.actor_id);

    const created = await callTool<GroupRoomView>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('g03_room'),
      kind: 'group',
      members: [adminTarget.actor_id, plainMember.actor_id],
      title: 'G03 权限验收群',
    });
    const roomId = created.room.room_id;
    await acceptGroupInvites(adminConn, roomId);
    await acceptGroupInvites(memberConn, roomId);
    // G01：建群响应只含当时的 active 成员；接受邀请后重新读取快照。
    const joined = await callTool<GroupRoomView>(ownerConn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual('G03 群主唯一且创建者为 owner', created.room.my_role, 'owner');
    checkEqual(
      'G03 默认策略：成员可发言/建任务，邀请仅 owner 或管理员',
      `${created.room.policies.member_message}/${created.room.policies.member_task}/${created.room.policies.member_invite}`,
      'members/members/owner_admin',
    );
    const plainMemberView = await callTool<GroupRoomView>(
      memberConn.client,
      'network_room_get',
      { room_id: roomId },
    );
    checkEqual(
      'G03 普通成员不能邀请、移除或任免管理员',
      plainMemberView.room.capabilities.invite_members === false &&
        plainMemberView.room.capabilities.remove_members === false &&
        plainMemberView.room.capabilities.manage_admins === false,
      true,
    );
    checkEqual(
      'G03 owner 视角可移除普通成员',
      memberOf(joined, plainMember.actor_id).actions.can_remove,
      true,
    );

    // ------------------------------------------------------------------ T01
    console.log('  G03-T01 普通成员越权与管理边界');
    const candidateRevision = memberOf(joined, adminTarget.actor_id).role_revision;
    await expectToolError(
      '普通成员不能任免管理员',
      callTool(memberConn.client, 'network_room_role_set', {
        request_id: newRequestId('g03_role'),
        room_id: roomId,
        actor_id: adminTarget.actor_id,
        role: 'admin',
        expected_role_revision: candidateRevision,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      '普通成员不能维护公告',
      callTool(memberConn.client, 'network_room_announcement_set', {
        request_id: newRequestId('g03_ann'),
        room_id: roomId,
        announcement: '普通成员越权公告',
        expected_announcement_revision: 1,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '普通成员不能移除成员',
      callTool(memberConn.client, 'network_room_members_update', {
        request_id: newRequestId('g03_remove'),
        room_id: roomId,
        remove: [adminTarget.actor_id],
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '普通成员不能邀请成员',
      callTool(memberConn.client, 'network_room_members_update', {
        request_id: newRequestId('g03_invite'),
        room_id: roomId,
        add: [outsider.actor_id],
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '普通成员不能修改群策略',
      callTool(memberConn.client, 'network_room_policy_set', {
        request_id: newRequestId('g03_policy'),
        room_id: roomId,
        member_invite_policy: 'members',
        expected_policy_revision: 1,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      '普通成员不能读取角色审计',
      callTool(memberConn.client, 'network_room_role_history', { room_id: roomId }),
      'PERMISSION_DENIED',
    );

    const appointPayload = {
      request_id: newRequestId('g03_appoint'),
      room_id: roomId,
      actor_id: adminTarget.actor_id,
      role: 'admin',
      expected_role_revision: candidateRevision,
    };
    const appointed = await callTool<GroupRoomView>(
      ownerConn.client,
      'network_room_role_set',
      appointPayload,
    );
    const appointedAdmin = memberOf(appointed, adminTarget.actor_id);
    checkEqual('owner 任命管理员成功', appointedAdmin.role, 'admin');
    checkEqual(
      '任命管理员推进角色版本',
      appointedAdmin.role_revision,
      candidateRevision + 1,
    );
    const replayedAppointment = await callTool<GroupRoomView>(
      ownerConn.client,
      'network_room_role_set',
      appointPayload,
    );
    checkEqual(
      '同一 request_id 重放返回同一任命结果且不重复推进版本',
      memberOf(replayedAppointment, adminTarget.actor_id).role_revision,
      candidateRevision + 1,
    );
    checkEqual(
      '管理员拥有移除/公告/审批能力',
      appointedAdmin.actions.can_remove &&
        appointed.room.capabilities.remove_members &&
        appointed.room.capabilities.manage_announcement &&
        appointed.room.capabilities.approve_joins,
      true,
    );

    await expectToolError(
      '管理员不能转移 owner',
      callTool(adminConn.client, 'network_room_owner_transfer', {
        request_id: newRequestId('g03_transfer'),
        room_id: roomId,
        target_actor_id: plainMember.actor_id,
        expected_role_revision: memberOf(appointed, plainMember.actor_id).role_revision,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      '管理员不能任免其他管理员',
      callTool(adminConn.client, 'network_room_role_set', {
        request_id: newRequestId('g03_promote'),
        room_id: roomId,
        actor_id: plainMember.actor_id,
        role: 'admin',
        expected_role_revision: memberOf(appointed, plainMember.actor_id).role_revision,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      '管理员不能修改群策略',
      callTool(adminConn.client, 'network_room_policy_set', {
        request_id: newRequestId('g03_admin_policy'),
        room_id: roomId,
        member_message_policy: 'owner_admin',
        expected_policy_revision: appointed.room.policy_revision,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      '管理员不能移除群主',
      callTool(adminConn.client, 'network_room_members_update', {
        request_id: newRequestId('g03_remove_owner'),
        room_id: roomId,
        remove: [owner.actor_id],
      }),
      'INVALID_ARGUMENT',
    );

    const adminRemoveRequestId = newRequestId('g03_admin_remove');
    const removedPayload = {
      request_id: adminRemoveRequestId,
      room_id: roomId,
      remove: [plainMember.actor_id],
      expected_role_revision: memberOf(appointed, plainMember.actor_id).role_revision,
    };
    const removed = await callTool<GroupRoomView>(
      adminConn.client,
      'network_room_members_update',
      removedPayload,
    );
    check(
      '管理员可以移除普通成员',
      !removed.members.some((member) => member.actor_id === plainMember.actor_id),
    );
    await expectToolError(
      '被移除成员不能继续读取房间',
      callTool(memberConn.client, 'network_room_get', { room_id: roomId }),
      'NOT_MEMBER',
    );

    const announcement = await callTool<GroupRoomView>(
      adminConn.client,
      'network_room_announcement_set',
      {
        request_id: newRequestId('g03_admin_ann'),
        room_id: roomId,
        announcement: 'G03 管理员公告',
        expected_announcement_revision: appointed.room.announcement_revision,
      },
    );
    checkEqual('管理员可以维护公告', announcement.room.announcement, 'G03 管理员公告');
    checkEqual(
      '公告更新推进公告版本',
      announcement.room.announcement_revision,
      appointed.room.announcement_revision + 1,
    );

    const history = await callTool<RoleHistoryView>(
      adminConn.client,
      'network_room_role_history',
      { room_id: roomId },
    );
    check(
      '角色审计包含任命、移除与公告事件',
      ['admin_appointed', 'member_removed', 'announcement_updated'].every((action) =>
        history.items.some((item) => item.action === action),
      ),
      history.items.map((item) => item.action),
    );
    const appointmentAudit = history.items.find((item) => item.action === 'admin_appointed');
    checkEqual(
      '审计记录目标与结果版本',
      appointmentAudit?.target_actor_id === adminTarget.actor_id &&
        appointmentAudit?.new_role === 'admin' &&
        appointmentAudit?.resulting_revision === candidateRevision + 1,
      true,
    );

    // 撤销管理员后重放旧移除请求：授权预检先于幂等重放，必须拒绝。
    const revoked = await callTool<GroupRoomView>(ownerConn.client, 'network_room_role_set', {
      request_id: newRequestId('g03_revoke'),
      room_id: roomId,
      actor_id: adminTarget.actor_id,
      role: 'member',
      expected_role_revision: appointedAdmin.role_revision,
    });
    checkEqual('owner 撤销管理员', memberOf(revoked, adminTarget.actor_id).role, 'member');
    await expectToolError(
      '撤销管理员后重放旧的移除请求被拒绝',
      callTool(adminConn.client, 'network_room_members_update', removedPayload),
      'PERMISSION_DENIED',
    );
    await addMembers(ownerConn, roomId, [outsider.actor_id, plainMember.actor_id]);

    // ------------------------------------------------------------------ T02
    console.log('  G03-T02 并发裁决与版本冲突');
    const beforeRace = await roomOf(ownerConn, roomId);
    const adminRevisionBeforeRace = memberOf(beforeRace, adminTarget.actor_id).role_revision;
    const outsiderRevisionBeforeRace = memberOf(beforeRace, outsider.actor_id).role_revision;
    const promoteRequest = newRequestId('g03_race_promote');
    const promoteRace = await callTool<GroupRoomView>(
      ownerConn.client,
      'network_room_role_set',
      {
        request_id: promoteRequest,
        room_id: roomId,
        actor_id: adminTarget.actor_id,
        role: 'admin',
        expected_role_revision: adminRevisionBeforeRace,
      },
    );
    checkEqual(
      '并发用例准备：候选管理员恢复 admin',
      memberOf(promoteRace, adminTarget.actor_id).role,
      'admin',
    );
    const revokeRequest = newRequestId('g03_race_revoke');
    const removeRequest = newRequestId('g03_race_remove');
    const [revokeOutcome, removeOutcome] = await Promise.allSettled([
      callTool(ownerConn.client, 'network_room_role_set', {
        request_id: revokeRequest,
        room_id: roomId,
        actor_id: adminTarget.actor_id,
        role: 'member',
        expected_role_revision: memberOf(promoteRace, adminTarget.actor_id).role_revision,
      }),
      callTool(adminConn.client, 'network_room_members_update', {
        request_id: removeRequest,
        room_id: roomId,
        remove: [outsider.actor_id],
        expected_role_revision: outsiderRevisionBeforeRace,
      }),
    ]);
    checkEqual('并发撤销管理员成功', revokeOutcome.status, 'fulfilled');
    const afterRace = await roomOf(ownerConn, roomId);
    checkEqual(
      '并发结束后管理员角色按提交序收敛为 member',
      memberOf(afterRace, adminTarget.actor_id).role,
      'member',
    );
    const outsiderStillActive = afterRace.members.some(
      (member) => member.actor_id === outsider.actor_id,
    );
    if (removeOutcome.status === 'fulfilled') {
      check('并发移除成功时目标已离开', outsiderStillActive === false);
    } else {
      checkEqual('并发移除失败时返回权限错误', removeOutcome.reason?.code, 'PERMISSION_DENIED');
      check('并发移除失败时目标仍为 active，无半提交', outsiderStillActive);
    }
    const raceHistory = await callTool<RoleHistoryView>(
      ownerConn.client,
      'network_room_role_history',
      { room_id: roomId },
    );
    const removalAudits = raceHistory.items.filter(
      (item) => item.action === 'member_removed' && item.request_id === removeRequest,
    );
    checkEqual(
      '并发移除的审计与最终状态一致',
      removalAudits.length,
      removeOutcome.status === 'fulfilled' ? 1 : 0,
    );

    const staleDetail = await roomOf(ownerConn, roomId);
    const staleRevision = memberOf(staleDetail, adminTarget.actor_id).role_revision;
    await callTool(ownerConn.client, 'network_room_role_set', {
      request_id: newRequestId('g03_stale_first'),
      room_id: roomId,
      actor_id: adminTarget.actor_id,
      role: 'admin',
      expected_role_revision: staleRevision,
    });
    await expectToolError(
      '过期 expected_role_revision 返回 VERSION_CONFLICT',
      callTool(ownerConn.client, 'network_room_role_set', {
        request_id: newRequestId('g03_stale_second'),
        room_id: roomId,
        actor_id: adminTarget.actor_id,
        role: 'admin',
        expected_role_revision: staleRevision,
      }),
      'VERSION_CONFLICT',
    );

    // ------------------------------------------------------------------ T03
    console.log('  G03-T03 Web/MCP 一致与 Agent 权限隔离');
    const adminBeforeWeb = memberOf(await roomOf(ownerConn, roomId), adminTarget.actor_id);
    checkEqual('T03 准备：管理员仍是 admin', adminBeforeWeb.role, 'admin');
    const preWeb = await roomOf(ownerConn, roomId);
    const webAnnouncement = await rawTool<GroupRoomView>(
      adminConn.token,
      'network_room_announcement_set',
      {
        request_id: newRequestId('g03_web_ann'),
        room_id: roomId,
        announcement: 'G03 网页公告',
        expected_announcement_revision: preWeb.room.announcement_revision,
      },
    );
    checkEqual('网页路径与 MCP 使用同一公告结果', webAnnouncement.room.announcement, 'G03 网页公告');
    const viaMcp = await callTool<GroupRoomView>(adminConn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual(
      '网页写入的公告可被 MCP 客户端读取',
      viaMcp.room.announcement,
      'G03 网页公告',
    );
    const webHistory = await rawTool<RoleHistoryView>(
      adminConn.token,
      'network_room_role_history',
      { room_id: roomId },
    );
    const mcpHistory = await callTool<RoleHistoryView>(
      adminConn.client,
      'network_room_role_history',
      { room_id: roomId },
    );
    checkEqual(
      '同一身份两种路径首条审计相同',
      webHistory.items[0]?.audit_id,
      mcpHistory.items[0]?.audit_id,
    );
    checkEqual(
      '同一 identity 的网页路径与 MCP 审计条数一致',
      webHistory.items.length,
      mcpHistory.items.length,
    );

    const memberNow = memberOf(preWeb, plainMember.actor_id);
    const webDeniedArgs = {
      room_id: roomId,
      actor_id: adminTarget.actor_id,
      role: 'admin',
      expected_role_revision: memberNow.role_revision,
    };
    const webDenied = await rawToolErrorCode(memberConn.token, 'network_room_role_set', {
      request_id: newRequestId('g03_web_denied'),
      ...webDeniedArgs,
    });
    checkEqual('普通成员网页路径拒绝码为 NOT_OWNER', webDenied, 'NOT_OWNER');
    await expectToolError(
      '同一普通成员 MCP 路径拒绝码与网页一致',
      callTool(memberConn.client, 'network_room_role_set', {
        request_id: newRequestId('g03_mcp_denied'),
        ...webDeniedArgs,
      }),
      'NOT_OWNER',
    );

    // 管理员 Agent：群角色不授予 Agent 管理或凭据权限。
    const ownedAgent = await callTool<AgentCreateView>(ownerConn.client, 'network_agent_create', {
      request_id: newRequestId('g03_agent'),
      name: 'G03 管理员 Agent',
    });
    const ownedAgentConn = await connectClient(ownedAgent.token);
    agentConnections.push(ownedAgentConn);
    const ownedAgentIdentity = await callTool<Identity>(ownedAgentConn.client, 'network_me');
    checkEqual(
      'T03 Agent 以自己的凭据注册',
      ownedAgentIdentity.actor_id,
      ownedAgent.actor_id,
    );
    await befriend(ownerConn, owner.actor_id, ownedAgentConn, ownedAgent.actor_id);
    await addMembers(ownerConn, roomId, [ownedAgent.actor_id]);
    const currentAgent = memberOf(await roomOf(ownerConn, roomId), ownedAgent.actor_id);
    const promotedAgent = await callTool<GroupRoomView>(ownerConn.client, 'network_room_role_set', {
      request_id: newRequestId('g03_agent_admin'),
      room_id: roomId,
      actor_id: ownedAgent.actor_id,
      role: 'admin',
      expected_role_revision: currentAgent.role_revision,
    });
    checkEqual(
      'owner 可把 Agent 设为管理员',
      memberOf(promotedAgent, ownedAgent.actor_id).role,
      'admin',
    );
    const ownView = await callTool<GroupRoomView>(ownedAgentConn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual('Agent 管理员能力来自群角色', ownView.room.my_role, 'admin');
    checkEqual(
      'Agent 管理员可移除普通成员',
      ownView.room.capabilities.remove_members &&
        !ownView.room.capabilities.manage_admins &&
        !ownView.room.capabilities.transfer_owner,
      true,
    );

    const otherAgent = await callTool<AgentCreateView>(outsiderConn.client, 'network_agent_create', {
      request_id: newRequestId('g03_other_agent'),
      name: 'G03 他人 Agent',
    });
    await expectToolError(
      '管理员 Agent 不能重发他人 Agent 凭据',
      callTool(ownedAgentConn.client, 'network_agent_reissue_token', {
        request_id: newRequestId('g03_reissue'),
        actor_id: otherAgent.actor_id,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '管理员 Agent 不能改名他人 Agent',
      callTool(ownedAgentConn.client, 'network_agent_rename', {
        request_id: newRequestId('g03_rename'),
        actor_id: otherAgent.actor_id,
        name: 'G03 越权改名',
      }),
      'PERMISSION_DENIED',
    );
    const otherAgentView = await callTool<{
      actor_id: string;
      name: string;
      my_role: string;
      can_manage: boolean;
    }>(outsiderConn.client, 'network_agent_management_get', {
      actor_id: otherAgent.actor_id,
    });
    checkEqual(
      '群管理员身份不改变 Agent 管理归属',
      `${otherAgentView.name}/${otherAgentView.my_role}/${otherAgentView.can_manage}`,
      'G03 他人 Agent/manager/true',
    );
  } finally {
    await Promise.all([
      ownerConn.close(),
      adminConn.close(),
      memberConn.close(),
      outsiderConn.close(),
      ...agentConnections.map((connection) => connection.close()),
    ]);
  }

  await runOwnerLeaveConcurrency();
}
