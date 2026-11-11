/**
 * G01 建群与拉人入群端到端验收。
 *
 * 产品规则：人拉人直接入群，不需要被添加人接受。
 * - 建群、`network_room_members_update` 与 `network_room_invite_create`
 *   指定目标时，合格目标立即成为 active 成员。
 * - 不再生成 pending 定向邀请；升级前的遗留行仍可读取/响应（见 G02 链接路径）。
 * - 权限、拉黑、好友/Agent 例外、容量与群状态校验保留。
 *
 * T03（移动端选人/取消/失败保留选择/成功刷新）在 verify-web 中断言。
 */

import { befriend, registerIdentity } from './acceptance-helpers';
import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  type McpConnection,
} from './harness';

interface AgentCreateView {
  actor_id: string;
  token: string;
}

interface InvitationPageView {
  items: {
    invitation_id: string;
    room_id: string;
    status: string;
    can_respond: boolean;
  }[];
}

interface GroupMemberView {
  actor_id: string;
  kind: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  role_revision?: number;
  joined_seq?: string;
  status?: string;
}

interface GroupDetailView {
  room: {
    room_id: string;
    kind: string;
    owner_id: string | null;
    title: string;
    member_count: number;
    my_role: string;
    head_seq: string;
    my_last_read_seq: string;
    status?: string;
    read_only?: boolean;
  };
  members: GroupMemberView[];
  invited: {
    invitation_id: string;
    actor_id: string;
    kind: string;
    name: string;
  }[];
  results?: {
    actor_id: string;
    name: string;
    status: 'active' | 'invited' | 'failed';
    code: string | null;
    message: string | null;
  }[];
}

interface RoomPageView {
  items: { room_id: string; title: string; member_count: number }[];
}

interface InviteCreateView {
  invitation: {
    invitation_id: string;
    status: string;
  } | null;
  invite_key: string | null;
  share_url: string | null;
  member: {
    actor_id: string;
    kind: 'human' | 'agent';
    name: string;
    role: 'owner' | 'admin' | 'member';
    status: 'active';
  } | null;
}

async function createManagedAgent(manager: McpConnection, name: string): Promise<AgentCreateView> {
  const agent = await callTool<AgentCreateView>(manager.client, 'network_agent_create', {
    request_id: newRequestId('g01_agent'),
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  const linked = await callTool<{ status: string }>(manager.client, 'network_contact_request', {
    request_id: newRequestId('g01_link'),
    actor_id: agent.actor_id,
  });
  if (linked.status !== 'accepted') {
    throw new Error(`自有 Agent 未自动建立关系: ${linked.status}`);
  }
  return agent;
}

async function createFillerAgents(
  owner: McpConnection,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const agent = await createManagedAgent(owner, `G01 填充 Agent ${index + 1}`);
    ids.push(agent.actor_id);
  }
  return ids;
}

async function addMembers(
  owner: McpConnection,
  roomId: string,
  actorIds: string[],
): Promise<GroupDetailView> {
  let detail: GroupDetailView | null = null;
  for (let offset = 0; offset < actorIds.length; offset += 20) {
    detail = await callTool<GroupDetailView>(owner.client, 'network_room_members_update', {
      request_id: newRequestId('g01_add'),
      room_id: roomId,
      add: actorIds.slice(offset, offset + 20),
    });
  }
  if (!detail) throw new Error('没有可添加的成员');
  return detail;
}

function memberIds(detail: GroupDetailView): string[] {
  return detail.members.map((member) => member.actor_id).sort();
}

function memberOf(detail: GroupDetailView, actorId: string): GroupMemberView {
  const member = detail.members.find((item) => item.actor_id === actorId);
  if (!member) throw new Error(`成员 ${actorId} 不在房间成员列表中`);
  return member;
}

export async function runGroupInviteAcceptance(): Promise<void> {
  const u1Connection = await connectClient(newToken());
  const u2Connection = await connectClient(newToken());
  const strangerConnection = await connectClient(newToken());
  const outsiderConnection = await connectClient(newToken());
  const u1 = await registerIdentity(u1Connection, { kind: 'human', name: 'G01 U1' });
  const u2 = await registerIdentity(u2Connection, { kind: 'human', name: 'G01 U2' });
  const stranger = await registerIdentity(strangerConnection, {
    kind: 'human',
    name: 'G01 非好友',
  });
  const outsider = await registerIdentity(outsiderConnection, {
    kind: 'human',
    name: 'G01 群外成员',
  });
  await befriend(u1Connection, u1.actor_id, u2Connection, u2.actor_id);
  const b1 = await createManagedAgent(u1Connection, 'G01 自有 Agent B1');

  // ---- T01：建群直接加入，目标无需接受 ----
  const createRequestId = newRequestId('g01_room');
  const created = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: createRequestId,
    kind: 'group',
    title: 'G01 直接入群',
    members: [b1.actor_id, u2.actor_id],
  });
  const roomId = created.room.room_id;

  checkEqual('G01-T01 建群后成员立即为 3 人', created.room.member_count, 3);
  checkEqual(
    'G01-T01 好友与自有 Agent 都直接 active',
    memberIds(created).join(','),
    [u1.actor_id, b1.actor_id, u2.actor_id].sort().join(','),
  );
  checkEqual('G01-T01 创建者是 owner', created.room.owner_id, u1.actor_id);
  checkEqual('G01-T01 不再生成待确认邀请', created.invited.length, 0);
  const resultByActor = new Map(
    (created.results ?? []).map((result) => [result.actor_id, result] as const),
  );
  checkEqual(
    'G01-T01 逐对象结果：自有 Agent active',
    resultByActor.get(b1.actor_id)?.status,
    'active',
  );
  checkEqual(
    'G01-T01 逐对象结果：好友 active',
    resultByActor.get(u2.actor_id)?.status,
    'active',
  );
  check(
    'G01-T01 逐对象结果不再返回 invited',
    (created.results ?? []).every((result) => result.status !== 'invited'),
    created.results,
  );

  const u2Rooms = await callTool<RoomPageView>(u2Connection.client, 'network_rooms_list', {
    limit: 50,
  });
  check(
    'G01-T01 被添加方立即出现在会话列表',
    u2Rooms.items.some((item) => item.room_id === roomId),
    u2Rooms.items,
  );
  const u2Detail = await callTool<GroupDetailView>(u2Connection.client, 'network_room_get', {
    room_id: roomId,
  });
  checkEqual('G01-T01 被添加方无需接受即可读房间', u2Detail.room.member_count, 3);
  checkEqual('G01-T01 被添加方角色为 member', u2Detail.room.my_role, 'member');
  check(
    'G01-T01 被添加方出现在成员列表',
    memberIds(u2Detail).includes(u2.actor_id),
    u2Detail.members,
  );

  const u2Invitations = await callTool<InvitationPageView>(
    u2Connection.client,
    'network_room_invite_get',
    { limit: 20 },
  );
  check(
    'G01-T01 直接加入不产生定向邀请',
    !u2Invitations.items.some((item) => item.room_id === roomId),
    u2Invitations.items,
  );

  const replay = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: createRequestId,
    kind: 'group',
    title: 'G01 直接入群',
    members: [b1.actor_id, u2.actor_id],
  });
  checkEqual('G01-T02 重复 request_id 收敛同一群', replay.room.room_id, roomId);
  checkEqual('G01-T02 重复提交不新增成员', replay.room.member_count, 3);
  checkEqual('G01-T02 重复提交不新增邀请', replay.invited.length, 0);

  // ---- T02：预检失败不创建半成品群 ----
  const rejected = await expectToolError(
    'G01-T02 非好友导致提交前整体拒绝',
    callTool(u1Connection.client, 'network_room_create', {
      request_id: newRequestId('g01_bad'),
      kind: 'group',
      title: 'G01 不合格群',
      members: [b1.actor_id, stranger.actor_id],
    }),
    'FRIEND_REQUIRED',
  );
  const rejectedResults = (
    rejected.body.details as
      | { results?: { actor_id: string; status: string; code: string | null }[] }
      | undefined
  )?.results;
  const rejectedByActor = new Map(
    (rejectedResults ?? []).map((result) => [result.actor_id, result] as const),
  );
  checkEqual(
    'G01-T02 预检结果保留合格候选',
    rejectedByActor.get(b1.actor_id)?.status,
    'active',
  );
  checkEqual(
    'G01-T02 预检结果标出非好友',
    rejectedByActor.get(stranger.actor_id)?.code,
    'FRIEND_REQUIRED',
  );
  const afterRejected = await callTool<RoomPageView>(u1Connection.client, 'network_rooms_list', {
    limit: 50,
  });
  check(
    'G01-T02 预检失败不创建半成品群',
    !afterRejected.items.some((item) => item.title === 'G01 不合格群'),
  );

  // ---- T03：权限与重复添加 ----
  await expectToolError(
    'G01-T03 普通成员默认不能加人',
    callTool(u2Connection.client, 'network_room_members_update', {
      request_id: newRequestId('g01_member_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    }),
    'PERMISSION_DENIED',
  );
  await expectToolError(
    'G01-T03 群外成员不能加人',
    callTool(outsiderConnection.client, 'network_room_members_update', {
      request_id: newRequestId('g01_outsider_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    }),
    'NOT_MEMBER',
  );
  await expectToolError(
    'G01-T03 群主不能加入非好友人类',
    callTool(u1Connection.client, 'network_room_members_update', {
      request_id: newRequestId('g01_stranger_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    }),
    'FRIEND_REQUIRED',
  );
  const duplicateAdd = await callTool<GroupDetailView>(
    u1Connection.client,
    'network_room_members_update',
    {
      request_id: newRequestId('g01_dup_add'),
      room_id: roomId,
      add: [u2.actor_id],
    },
  );
  checkEqual('G01-T03 重复添加不改变成员数', duplicateAdd.room.member_count, 3);

  // 管理员同样可以直接加人：先把 U2 设为 admin，再让 U2 添加自己的好友。
  await befriend(u2Connection, u2.actor_id, strangerConnection, stranger.actor_id);
  const u2Row = memberOf(created, u2.actor_id);
  await callTool(u1Connection.client, 'network_room_role_set', {
    request_id: newRequestId('g01_admin'),
    room_id: roomId,
    actor_id: u2.actor_id,
    role: 'admin',
    expected_role_revision: u2Row.role_revision ?? 1,
  });
  const adminAdded = await callTool<GroupDetailView>(
    u2Connection.client,
    'network_room_members_update',
    {
      request_id: newRequestId('g01_admin_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    },
  );
  checkEqual('G01-T03 管理员添加后立即 4 人', adminAdded.room.member_count, 4);
  const strangerDetail = await callTool<GroupDetailView>(
    strangerConnection.client,
    'network_room_get',
    { room_id: roomId },
  );
  checkEqual('G01-T03 被管理员添加的目标立即 active', strangerDetail.room.member_count, 4);

  // ---- T04：移除后重新添加立即恢复，历史边界从新加入开始 ----
  const beforeRemove = await callTool<GroupDetailView>(u1Connection.client, 'network_room_get', {
    room_id: roomId,
  });
  const oldJoinedSeq = memberOf(beforeRemove, stranger.actor_id).joined_seq;
  await callTool(u1Connection.client, 'network_room_members_update', {
    request_id: newRequestId('g01_remove'),
    room_id: roomId,
    remove: [stranger.actor_id],
  });
  await expectToolError(
    'G01-T04 移除后立即失去房间读取',
    callTool(strangerConnection.client, 'network_room_get', { room_id: roomId }),
    'NOT_MEMBER',
  );
  const reAdded = await callTool<GroupDetailView>(
    u2Connection.client,
    'network_room_members_update',
    {
      request_id: newRequestId('g01_re_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    },
  );
  const newJoinedSeq = memberOf(reAdded, stranger.actor_id).joined_seq;
  checkEqual('G01-T04 重新添加后立即 active', reAdded.room.member_count, 4);
  check(
    'G01-T04 重新加入从新的 joined_seq 开始',
    Number(newJoinedSeq) > Number(oldJoinedSeq),
    { old: oldJoinedSeq, next: newJoinedSeq },
  );
  const strangerAgain = await callTool<GroupDetailView>(
    strangerConnection.client,
    'network_room_get',
    { room_id: roomId },
  );
  checkEqual('G01-T04 重新加入无需接受', strangerAgain.room.my_role, 'member');

  // ---- T05：拉黑优先于好友关系，拉黑后两种加人入口都失败 ----
  await callTool(u1Connection.client, 'network_room_members_update', {
    request_id: newRequestId('g01_block_remove'),
    room_id: roomId,
    remove: [stranger.actor_id],
  });
  await callTool(u1Connection.client, 'network_contact_block', {
    request_id: newRequestId('g01_block'),
    actor_id: stranger.actor_id,
  });
  await expectToolError(
    'G01-T05 拉黑后成员添加返回 BLOCKED',
    callTool(u1Connection.client, 'network_room_members_update', {
      request_id: newRequestId('g01_blocked_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    }),
    'BLOCKED',
  );
  await expectToolError(
    'G01-T05 拉黑后定向添加工具返回 BLOCKED',
    callTool(u1Connection.client, 'network_room_invite_create', {
      request_id: newRequestId('g01_blocked_target'),
      room_id: roomId,
      target_actor_id: stranger.actor_id,
    }),
    'BLOCKED',
  );
  await callTool(u1Connection.client, 'network_contact_unblock', {
    request_id: newRequestId('g01_unblock'),
    actor_id: stranger.actor_id,
  });
  // 拉黑会结束好友关系，解除拉黑不会自动恢复；再次添加仍要求好友。
  await expectToolError(
    'G01-T05 解除拉黑不恢复好友关系，添加仍要求好友',
    callTool(u1Connection.client, 'network_room_members_update', {
      request_id: newRequestId('g01_unblocked_add'),
      room_id: roomId,
      add: [stranger.actor_id],
    }),
    'FRIEND_REQUIRED',
  );

  // ---- T06：network_room_invite_create 指定目标时直接入群 ----
  const targetGroup = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: newRequestId('g01_target_room'),
    kind: 'group',
    title: 'G01 定向添加',
    members: [b1.actor_id],
  });
  const targetRoomId = targetGroup.room.room_id;
  const targetRequestId = newRequestId('g01_target_add');
  const targeted = await callTool<InviteCreateView>(
    u1Connection.client,
    'network_room_invite_create',
    {
      request_id: targetRequestId,
      room_id: targetRoomId,
      target_actor_id: u2.actor_id,
    },
  );
  checkEqual('G01-T06 定向添加不创建邀请', targeted.invitation, null);
  checkEqual('G01-T06 定向添加不返回链接', targeted.invite_key, null);
  checkEqual('G01-T06 定向添加不返回分享 URL', targeted.share_url, null);
  checkEqual('G01-T06 定向添加返回 active 成员', targeted.member?.status, 'active');
  checkEqual('G01-T06 定向添加目标正确', targeted.member?.actor_id, u2.actor_id);
  const targetedDetail = await callTool<GroupDetailView>(u2Connection.client, 'network_room_get', {
    room_id: targetRoomId,
  });
  checkEqual('G01-T06 被添加方无需接受即可读取', targetedDetail.room.member_count, 3);
  const targetedReplay = await callTool<InviteCreateView>(
    u1Connection.client,
    'network_room_invite_create',
    {
      request_id: targetRequestId,
      room_id: targetRoomId,
      target_actor_id: u2.actor_id,
    },
  );
  checkEqual('G01-T06 重放返回同一成员结果', targetedReplay.member?.actor_id, u2.actor_id);
  await expectToolError(
    'G01-T06 重复定向添加已在群目标返回 CONFLICT',
    callTool(u1Connection.client, 'network_room_invite_create', {
      request_id: newRequestId('g01_target_again'),
      room_id: targetRoomId,
      target_actor_id: u2.actor_id,
    }),
    'CONFLICT',
  );
  await expectToolError(
    'G01-T06 定向添加自己返回 INVALID_ARGUMENT',
    callTool(u1Connection.client, 'network_room_invite_create', {
      request_id: newRequestId('g01_target_self'),
      room_id: targetRoomId,
      target_actor_id: u1.actor_id,
    }),
    'INVALID_ARGUMENT',
  );
  await expectToolError(
    'G01-T06 定向添加非好友返回 FRIEND_REQUIRED',
    callTool(u1Connection.client, 'network_room_invite_create', {
      request_id: newRequestId('g01_target_stranger'),
      room_id: targetRoomId,
      target_actor_id: outsider.actor_id,
    }),
    'FRIEND_REQUIRED',
  );
  await callTool(u1Connection.client, 'network_room_dissolve', {
    request_id: newRequestId('g01_target_dissolve'),
    room_id: targetRoomId,
    reason: 'G01 定向添加群解散',
  });
  await expectToolError(
    'G01-T06 解散后不能继续加人',
    callTool(u1Connection.client, 'network_room_invite_create', {
      request_id: newRequestId('g01_target_dissolved'),
      room_id: targetRoomId,
      target_actor_id: outsider.actor_id,
    }),
    'PERMISSION_DENIED',
  );

  // ---- T07：100 人容量负例 ----
  // 建群单次最多 20 个候选；显式加人受 A05 限额约束（每身份 10 分钟 60 次），
  // 因此拆成：建群 18 名 Agent + 2 名人类，群主补 60，管理员 A 补 18，
  // 再由管理员 A/B 分别尝试 +1 与 +1，验证上限只在 100 人处放行。
  const capAdminAConnection = await connectClient(newToken());
  const capAdminBConnection = await connectClient(newToken());
  const capAdminA = await registerIdentity(capAdminAConnection, {
    kind: 'human',
    name: 'G01 容量管理员 A',
  });
  const capAdminB = await registerIdentity(capAdminBConnection, {
    kind: 'human',
    name: 'G01 容量管理员 B',
  });
  await befriend(u1Connection, u1.actor_id, capAdminAConnection, capAdminA.actor_id);
  await befriend(u1Connection, u1.actor_id, capAdminBConnection, capAdminB.actor_id);

  const seedAgents = await createFillerAgents(u1Connection, 18);
  const capGroup = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: newRequestId('g01_cap'),
    kind: 'group',
    title: 'G01 容量群',
    members: [...seedAgents, capAdminA.actor_id, capAdminB.actor_id],
  });
  const capRoomId = capGroup.room.room_id;
  checkEqual('G01-T07 容量群初始 21 人', capGroup.room.member_count, 21);
  checkEqual('G01-T07 容量群没有待确认邀请', capGroup.invited.length, 0);

  const ownerFillers = await createFillerAgents(u1Connection, 60);
  const ownerFilled = await addMembers(u1Connection, capRoomId, ownerFillers);
  checkEqual('G01-T07 群主补到 81 人', ownerFilled.room.member_count, 81);

  const capAdminARow = memberOf(capGroup, capAdminA.actor_id);
  const capAdminBRow = memberOf(capGroup, capAdminB.actor_id);
  await callTool(u1Connection.client, 'network_room_role_set', {
    request_id: newRequestId('g01_cap_admin_a'),
    room_id: capRoomId,
    actor_id: capAdminA.actor_id,
    role: 'admin',
    expected_role_revision: capAdminARow.role_revision ?? 1,
  });
  await callTool(u1Connection.client, 'network_room_role_set', {
    request_id: newRequestId('g01_cap_admin_b'),
    room_id: capRoomId,
    actor_id: capAdminB.actor_id,
    role: 'admin',
    expected_role_revision: capAdminBRow.role_revision ?? 1,
  });

  const adminAFillers = await createFillerAgents(capAdminAConnection, 19);
  const adminFilled = await addMembers(
    capAdminAConnection,
    capRoomId,
    adminAFillers.slice(0, 18),
  );
  checkEqual('G01-T07 管理员补到 99 人', adminFilled.room.member_count, 99);

  const extraA = adminAFillers[18] as string;
  const extraB = await createManagedAgent(capAdminBConnection, 'G01 容量尾巴 B');
  const filled = await addMembers(capAdminAConnection, capRoomId, [extraA]);
  checkEqual('G01-T07 第 100 名成员可以加入', filled.room.member_count, 100);
  await expectToolError(
    'G01-T07 第 101 名成员返回 ROOM_FULL',
    callTool(capAdminBConnection.client, 'network_room_members_update', {
      request_id: newRequestId('g01_cap_full'),
      room_id: capRoomId,
      add: [extraB.actor_id],
    }),
    'ROOM_FULL',
  );
  const capped = await callTool<GroupDetailView>(u1Connection.client, 'network_room_get', {
    room_id: capRoomId,
  });
  checkEqual('G01-T07 群成员恰好 100 人', capped.room.member_count, 100);
  checkEqual('G01-T07 失败的添加不留下邀请', capped.invited.length, 0);

  await Promise.all([
    u1Connection.close(),
    u2Connection.close(),
    strangerConnection.close(),
    outsiderConnection.close(),
    capAdminAConnection.close(),
    capAdminBConnection.close(),
  ]);
}
