/**
 * G01 建群与批量选人端到端验收（T01–T02）。
 *
 * T01：U1 与自有 B1、需确认的 U2 建群后，B1 active、U2 invited；
 * U2 只能通过自己的邀请列表看到 pending，接受后才成为 active。
 * T02：重复 request_id 收敛为同一群且不重复写邀请；99 人时两个邀请
 * 并发接受只有一个成功，另一个保持 pending 并返回 ROOM_FULL。
 *
 * T03（移动端选人/取消/失败保留选择/成功刷新）在 verify-web 中断言。
 */

import { acceptGroupInvites, befriend, registerIdentity } from './acceptance-helpers';
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

interface InvitationView {
  invitation_id: string;
  room_id: string;
  room_title: string;
  inviter_id: string;
  inviter_name: string;
  target_actor_id: string | null;
  kind: 'direct' | 'link';
  status: string;
  expires_at: string;
  created_at: string;
  can_respond: boolean;
}

interface InvitationPageView {
  items: InvitationView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface GroupMemberView {
  actor_id: string;
  kind: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  role_revision?: number;
  joined_seq?: string;
}

interface InvitedMemberView {
  invitation_id: string;
  actor_id: string;
  kind: string;
  name: string;
  invited_by: string;
  invited_at: string;
  expires_at: string;
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
  invited: InvitedMemberView[];
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

interface RespondView {
  invitation_id: string;
  room_id: string;
  status: 'accepted' | 'rejected';
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

export async function runGroupInviteAcceptance(): Promise<void> {
  const u1Connection = await connectClient(newToken());
  const u2Connection = await connectClient(newToken());
  const strangerConnection = await connectClient(newToken());
  const u1 = await registerIdentity(u1Connection, { kind: 'human', name: 'G01 U1' });
  const u2 = await registerIdentity(u2Connection, { kind: 'human', name: 'G01 U2' });
  const stranger = await registerIdentity(strangerConnection, {
    kind: 'human',
    name: 'G01 非好友',
  });
  await befriend(u1Connection, u1.actor_id, u2Connection, u2.actor_id);
  const b1 = await createManagedAgent(u1Connection, 'G01 自有 Agent B1');

  const createRequestId = newRequestId('g01_room');
  const created = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: createRequestId,
    kind: 'group',
    title: 'G01 混合成员群',
    members: [b1.actor_id, u2.actor_id],
  });
  const roomId = created.room.room_id;

  checkEqual('G01-T01 自有 Agent 直接 active', created.room.member_count, 2);
  checkEqual(
    'G01-T01 有效成员只有创建者与自有 Agent',
    memberIds(created).join(','),
    [u1.actor_id, b1.actor_id].sort().join(','),
  );
  checkEqual('G01-T01 创建者是 owner', created.room.owner_id, u1.actor_id);
  checkEqual('G01-T01 需确认成员进入 invited', created.invited.length, 1);
  checkEqual('G01-T01 invited 目标是 U2', created.invited[0]?.actor_id, u2.actor_id);
  check(
    'G01-T01 邀请不是成员',
    !created.members.some((member) => member.actor_id === u2.actor_id),
  );
  const resultByActor = new Map(
    (created.results ?? []).map((result) => [result.actor_id, result] as const),
  );
  checkEqual(
    'G01-T02 逐对象结果：自有 Agent active',
    resultByActor.get(b1.actor_id)?.status,
    'active',
  );
  checkEqual(
    'G01-T02 逐对象结果：需确认成员 invited',
    resultByActor.get(u2.actor_id)?.status,
    'invited',
  );

  const replay = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: createRequestId,
    kind: 'group',
    title: 'G01 混合成员群',
    members: [b1.actor_id, u2.actor_id],
  });
  checkEqual('G01-T02 重复 request_id 收敛同一群', replay.room.room_id, roomId);
  checkEqual('G01-T02 重复提交不新增成员', replay.room.member_count, 2);
  checkEqual('G01-T02 重复提交不新增邀请', replay.invited.length, 1);

  // 预检解释：混入非好友时整次建群不提交，逐对象结果说明谁不合格。
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

  const u2Rooms = await callTool<RoomPageView>(u2Connection.client, 'network_rooms_list', {
    limit: 50,
  });
  check(
    'G01-T01 邀请中成员不出现在房间列表',
    !u2Rooms.items.some((item) => item.room_id === roomId),
  );
  await expectToolError(
    'G01-T01 邀请中成员不能读取房间',
    callTool(u2Connection.client, 'network_room_get', { room_id: roomId }),
    'NOT_MEMBER',
  );

  const invitations = await callTool<InvitationPageView>(
    u2Connection.client,
    'network_room_invite_get',
    { limit: 20 },
  );
  const pending = invitations.items.find((item) => item.room_id === roomId);
  check('G01-T01 U2 能读取自己的 pending 邀请', Boolean(pending));
  checkEqual('G01-T01 邀请状态为 pending', pending?.status, 'pending');
  checkEqual('G01-T01 邀请人正确', pending?.inviter_id, u1.actor_id);
  checkEqual('G01-T01 邀请可响应', pending?.can_respond, true);
  checkEqual('G01-T01 邀请携带群名', pending?.room_title, 'G01 混合成员群');
  if (!pending) throw new Error('缺少 U2 的 pending 邀请');

  // 邀请接受不制造聊天未读：先把邀请人追到当前 head，再接受。
  const u1BeforeAccept = await callTool<GroupDetailView>(u1Connection.client, 'network_room_get', {
    room_id: roomId,
  });
  await callTool(u1Connection.client, 'network_room_mark_read', {
    room_id: roomId,
    through_seq: u1BeforeAccept.room.head_seq,
  });
  const u1Read = await callTool<GroupDetailView>(u1Connection.client, 'network_room_get', {
    room_id: roomId,
  });
  const headBeforeAccept = u1Read.room.head_seq;
  const readBeforeAccept = u1Read.room.my_last_read_seq;
  checkEqual('G01-T01 接受前邀请人无未读', readBeforeAccept, headBeforeAccept);

  const accepted = await callTool<RespondView>(u2Connection.client, 'network_room_invite_respond', {
    request_id: newRequestId('g01_accept'),
    invitation_id: pending.invitation_id,
    action: 'accept',
  });
  checkEqual('G01-T01 接受邀请返回 accepted', accepted.status, 'accepted');

  const u2Detail = await callTool<GroupDetailView>(u2Connection.client, 'network_room_get', {
    room_id: roomId,
  });
  checkEqual('G01-T01 接受后成为第 3 名 active 成员', u2Detail.room.member_count, 3);
  checkEqual('G01-T01 接受后角色为 member', u2Detail.room.my_role, 'member');

  const u1Detail = await callTool<GroupDetailView>(u1Connection.client, 'network_room_get', {
    room_id: roomId,
  });
  checkEqual('G01-T01 接受后邀请列表清空', u1Detail.invited.length, 0);
  check(
    'G01-T01 接受后 U2 出现在有效成员中',
    u1Detail.members.some((member) => member.actor_id === u2.actor_id),
  );
  checkEqual('G01-T01 接受邀请不推进邀请人 head_seq', u1Detail.room.head_seq, headBeforeAccept);
  checkEqual(
    'G01-T01 接受邀请不改变邀请人已读位置',
    u1Detail.room.my_last_read_seq,
    readBeforeAccept,
  );
  checkEqual(
    'G01-T01 接受邀请不制造邀请人未读',
    u1Detail.room.my_last_read_seq,
    u1Detail.room.head_seq,
  );
  const u2JoinedSeq = u1Detail.members.find((member) => member.actor_id === u2.actor_id)
    ?.joined_seq;
  check(
    'G01-T01 新成员 joined_seq 记录接受事件且高于消息 head',
    Number(u2JoinedSeq) > Number(headBeforeAccept),
    { joined_seq: u2JoinedSeq, head_seq: headBeforeAccept },
  );

  const after = await callTool<InvitationPageView>(u2Connection.client, 'network_room_invite_get', {
    invitation_id: pending.invitation_id,
  });
  checkEqual('G01-T01 邀请状态落库为 accepted', after.items[0]?.status, 'accepted');
  checkEqual('G01-T01 已接受邀请不能再响应', after.items[0]?.can_respond, false);
  await expectToolError(
    'G01-T01 重复接受返回 CONFLICT',
    callTool(u2Connection.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_accept'),
      invitation_id: pending.invitation_id,
      action: 'accept',
    }),
    'CONFLICT',
  );

  // ---- G01-T04：直接加人/移除后旧邀请不能重入 ----
  const lifecycleConn = await connectClient(newToken());
  const lifecycleOwner = await registerIdentity(lifecycleConn, {
    kind: 'human',
    name: 'G01 生命周期 owner',
  });
  await befriend(lifecycleConn, lifecycleOwner.actor_id, u2Connection, u2.actor_id);
  await befriend(lifecycleConn, lifecycleOwner.actor_id, strangerConnection, stranger.actor_id);

  const staleGroup = await callTool<GroupDetailView>(lifecycleConn.client, 'network_room_create', {
    request_id: newRequestId('g01_stale'),
    kind: 'group',
    title: 'G01 旧邀请重入',
    members: [u2.actor_id],
  });
  const staleInvitation = staleGroup.invited[0];
  check('G01-T04 旧邀请初始为 pending', Boolean(staleInvitation?.invitation_id));
  if (!staleInvitation) throw new Error('缺少旧邀请');

  const staleDirectAdd = await callTool<GroupDetailView>(
    lifecycleConn.client,
    'network_room_members_update',
    {
      request_id: newRequestId('g01_stale_add'),
      room_id: staleGroup.room.room_id,
      add: [u2.actor_id],
    },
  );
  check(
    'G01-T04 直接加人后 U2 为 active',
    staleDirectAdd.members.some((member) => member.actor_id === u2.actor_id),
  );
  checkEqual('G01-T04 直接加人消耗 pending 邀请', staleDirectAdd.invited.length, 0);
  const consumed = await callTool<InvitationPageView>(
    u2Connection.client,
    'network_room_invite_get',
    { invitation_id: staleInvitation.invitation_id },
  );
  checkEqual('G01-T04 被直接加入的旧邀请已撤销', consumed.items[0]?.status, 'revoked');

  await callTool(lifecycleConn.client, 'network_room_members_update', {
    request_id: newRequestId('g01_stale_remove'),
    room_id: staleGroup.room.room_id,
    remove: [u2.actor_id],
  });
  const afterRemove = await callTool<GroupDetailView>(lifecycleConn.client, 'network_room_get', {
    room_id: staleGroup.room.room_id,
  });
  check(
    'G01-T04 移除后 U2 不再是 active',
    !afterRemove.members.some((member) => member.actor_id === u2.actor_id),
  );
  await expectToolError(
    'G01-T04 移除后旧邀请不能重新接受',
    callTool(u2Connection.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_stale_accept'),
      invitation_id: staleInvitation.invitation_id,
      action: 'accept',
    }),
    'CONFLICT',
  );
  await expectToolError(
    'G01-T04 旧邀请重入失败后仍非成员',
    callTool(u2Connection.client, 'network_room_get', {
      room_id: staleGroup.room.room_id,
    }),
    'NOT_MEMBER',
  );

  // ---- G01-T05：接受邀请在事务内复核拉黑 ----
  const blockedGroup = await callTool<GroupDetailView>(lifecycleConn.client, 'network_room_create', {
    request_id: newRequestId('g01_blocked_invite'),
    kind: 'group',
    title: 'G01 接受邀请拉黑复核',
    members: [stranger.actor_id],
  });
  const blockedInvitation = blockedGroup.invited[0];
  if (!blockedInvitation) throw new Error('缺少拉黑复核邀请');
  await callTool(lifecycleConn.client, 'network_contact_block', {
    request_id: newRequestId('g01_block'),
    actor_id: stranger.actor_id,
  });
  await expectToolError(
    'G01-T05 接受邀请在事务内复核拉黑',
    callTool(strangerConnection.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_blocked_accept'),
      invitation_id: blockedInvitation.invitation_id,
      action: 'accept',
    }),
    'BLOCKED',
  );
  const blockedAfter = await callTool<InvitationPageView>(
    strangerConnection.client,
    'network_room_invite_get',
    { invitation_id: blockedInvitation.invitation_id },
  );
  checkEqual('G01-T05 拉黑拒绝后邀请保持 pending', blockedAfter.items[0]?.status, 'pending');

  // ---- G01-T02：100 人上限边界并发接受 ----
  // 显式加人受 A05 限额约束（每身份 10 分钟 60 次），因此由群主与协管
  // 管理员分两段填充：群主 60 人，管理员 20 人，最终仍停在 99 + 2 邀请。
  const capUaConnection = await connectClient(newToken());
  const capUbConnection = await connectClient(newToken());
  const capAdminConnection = await connectClient(newToken());
  const capUa = await registerIdentity(capUaConnection, { kind: 'human', name: 'G01 上限 A' });
  const capUb = await registerIdentity(capUbConnection, { kind: 'human', name: 'G01 上限 B' });
  const capAdmin = await registerIdentity(capAdminConnection, {
    kind: 'human',
    name: 'G01 上限协管',
  });
  await befriend(u1Connection, u1.actor_id, capUaConnection, capUa.actor_id);
  await befriend(u1Connection, u1.actor_id, capUbConnection, capUb.actor_id);
  await befriend(u1Connection, u1.actor_id, capAdminConnection, capAdmin.actor_id);

  const seedAgents = await createFillerAgents(u1Connection, 17);
  const capGroup = await callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
    request_id: newRequestId('g01_cap'),
    kind: 'group',
    title: 'G01 上限群',
    members: [
      ...seedAgents,
      capAdmin.actor_id,
      capUa.actor_id,
      capUb.actor_id,
    ],
  });
  const capRoomId = capGroup.room.room_id;
  checkEqual('G01-T02 上限群初始 active 为创建者与自有 Agent', capGroup.room.member_count, 18);
  checkEqual('G01-T02 三名待确认成员', capGroup.invited.length, 3);
  await acceptGroupInvites(capAdminConnection, capRoomId);

  const ownerFillers = await createFillerAgents(u1Connection, 60);
  const ownerFilled = await addMembers(u1Connection, capRoomId, ownerFillers);
  checkEqual('G01-T02 群主加满 60 次后为 79 人', ownerFilled.room.member_count, 79);
  const adminRow = ownerFilled.members.find((member) => member.actor_id === capAdmin.actor_id);
  await callTool(u1Connection.client, 'network_room_role_set', {
    request_id: newRequestId('g01_cap_admin'),
    room_id: capRoomId,
    actor_id: capAdmin.actor_id,
    role: 'admin',
    expected_role_revision: adminRow?.role_revision ?? 1,
  });
  const adminFillers = await createFillerAgents(capAdminConnection, 20);
  const filled = await addMembers(capAdminConnection, capRoomId, adminFillers);
  checkEqual('G01-T02 加入填充成员后达到 99 人', filled.room.member_count, 99);

  const capInvitations = await Promise.all(
    [capUaConnection, capUbConnection].map((connection) =>
      callTool<InvitationPageView>(connection.client, 'network_room_invite_get', {
        limit: 20,
      }),
    ),
  );
  const invitationA = capInvitations[0]?.items.find((item) => item.room_id === capRoomId);
  const invitationB = capInvitations[1]?.items.find((item) => item.room_id === capRoomId);
  if (!invitationA || !invitationB) throw new Error('上限群缺少邀请');

  const results = await Promise.allSettled([
    callTool<RespondView>(capUaConnection.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_cap_accept'),
      invitation_id: invitationA.invitation_id,
      action: 'accept',
    }),
    callTool<RespondView>(capUbConnection.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_cap_accept'),
      invitation_id: invitationB.invitation_id,
      action: 'accept',
    }),
  ]);
  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const failed = results.filter((result) => result.status === 'rejected');
  checkEqual('G01-T02 并发接受只成功一个', succeeded.length, 1);
  checkEqual('G01-T02 并发接受另一个失败', failed.length, 1);
  const failure = failed[0] as PromiseRejectedResult | undefined;
  const failureCode =
    failure && failure.reason && typeof failure.reason === 'object'
      ? (failure.reason as { code?: string }).code
      : undefined;
  checkEqual('G01-T02 失败原因是 ROOM_FULL', failureCode, 'ROOM_FULL');

  const capped = await callTool<GroupDetailView>(u1Connection.client, 'network_room_get', {
    room_id: capRoomId,
  });
  checkEqual('G01-T02 群成员恰好 100 人', capped.room.member_count, 100);
  checkEqual('G01-T02 失败的邀请仍为 pending', capped.invited.length, 1);

  // ---- 空群邀请撤销：owner 独自一人也不能退群，必须解散后撤销遗留邀请 ----
  const orphanOwnerConn = await connectClient(newToken());
  const orphanConn = await connectClient(newToken());
  const orphanOwner = await registerIdentity(orphanOwnerConn, {
    kind: 'human',
    name: 'G01 解散 owner',
  });
  const orphanTarget = await registerIdentity(orphanConn, {
    kind: 'human',
    name: 'G01 解散后的待确认成员',
  });
  await befriend(orphanOwnerConn, orphanOwner.actor_id, orphanConn, orphanTarget.actor_id);
  const orphanGroup = await callTool<GroupDetailView>(orphanOwnerConn.client, 'network_room_create', {
    request_id: newRequestId('g01_orphan'),
    kind: 'group',
    title: 'G01 空群邀请撤销',
    members: [orphanTarget.actor_id],
  });
  const orphanRoomId = orphanGroup.room.room_id;
  checkEqual('G01-T02 空群建群时目标为 invited', orphanGroup.invited.length, 1);
  await expectToolError(
    'G01-T02 owner 独自一人时退群被拒绝',
    callTool(orphanOwnerConn.client, 'network_room_leave', {
      request_id: newRequestId('g01_orphan_leave'),
      room_id: orphanRoomId,
      confirm_in_flight: true,
    }),
    'CONFLICT',
  );
  const orphanLink = await callTool<{ invitation: { invitation_id: string }; invite_key: string }>(
    orphanOwnerConn.client,
    'network_room_invite_create',
    { request_id: newRequestId('g01_orphan_link'), room_id: orphanRoomId },
  );
  const orphanDissolve = await callTool<GroupDetailView & { dissolve: { revoked_invitations: number } }>(
    orphanOwnerConn.client,
    'network_room_dissolve',
    {
      request_id: newRequestId('g01_orphan_dissolve'),
      room_id: orphanRoomId,
      reason: 'G01 空群解散',
    },
  );
  checkEqual('G01-T02 owner 独自解散后为只读归档', orphanDissolve.room.status, 'dissolved');
  checkEqual('G01-T02 解散后 read_only', orphanDissolve.room.read_only, true);
  check(
    'G01-T02 解散撤销遗留邀请与链接',
    orphanDissolve.dissolve.revoked_invitations >= 2,
    orphanDissolve.dissolve,
  );
  const orphanInvites = await callTool<InvitationPageView>(
    orphanConn.client,
    'network_room_invite_get',
    { limit: 20 },
  );
  const orphanInvitation = orphanInvites.items.find((item) => item.room_id === orphanRoomId);
  checkEqual('G01-T02 解散后遗留定向邀请被撤销', orphanInvitation?.status, 'revoked');
  await expectToolError(
    'G01-T02 已撤销邀请不能接受',
    callTool(orphanConn.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_orphan_accept'),
      invitation_id: orphanInvitation?.invitation_id ?? '',
      action: 'accept',
    }),
    'CONFLICT',
  );
  await expectToolError(
    'G01-T02 解散后旧邀请链接不能加入',
    callTool(orphanConn.client, 'network_room_invite_respond', {
      request_id: newRequestId('g01_orphan_link_accept'),
      invitation_id: orphanLink.invitation.invitation_id,
      invite_key: orphanLink.invite_key,
      action: 'accept',
    }),
    'CONFLICT',
  );

  // ---- G01-T06：接受邀请不消耗自己的主动邀请窗口 ----
  // 旧实现把接受也记成 changed_by=接受者 的 member_added，接受 60 次后
  // 自己主动加第一个好友会命中 RATE_LIMITED。这里先接受 60 个邀请，
  // 再创建自己的群并直接添加好友，必须仍然允许。
  const rateConn = await connectClient(newToken());
  const rateFriendConn = await connectClient(newToken());
  const rateUser = await registerIdentity(rateConn, {
    kind: 'human',
    name: 'G01 接受限额用户',
  });
  const rateFriend = await registerIdentity(rateFriendConn, {
    kind: 'human',
    name: 'G01 接受限额好友',
  });
  await befriend(rateConn, rateUser.actor_id, rateFriendConn, rateFriend.actor_id);
  await befriend(u1Connection, u1.actor_id, rateConn, rateUser.actor_id);

  const rateInvitationIds: string[] = [];
  for (let offset = 0; offset < 60; offset += 10) {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        callTool<GroupDetailView>(u1Connection.client, 'network_room_create', {
          request_id: newRequestId('g01_rate_room'),
          kind: 'group',
          title: `G01 接受限额 ${offset + index + 1}`,
          members: [rateUser.actor_id],
        }),
      ),
    );
    for (const group of created) {
      const invitation = group.invited[0];
      if (!invitation) throw new Error('接受限额群缺少邀请');
      rateInvitationIds.push(invitation.invitation_id);
    }
  }
  for (let offset = 0; offset < rateInvitationIds.length; offset += 10) {
    await Promise.all(
      rateInvitationIds.slice(offset, offset + 10).map((invitationId) =>
        callTool<RespondView>(rateConn.client, 'network_room_invite_respond', {
          request_id: newRequestId('g01_rate_accept'),
          invitation_id: invitationId,
          action: 'accept',
        }),
      ),
    );
  }
  checkEqual('G01-T06 接受 60 个邀请全部成功', rateInvitationIds.length, 60);

  const rateGroup = await callTool<GroupDetailView>(rateConn.client, 'network_room_create', {
    request_id: newRequestId('g01_rate_own'),
    kind: 'group',
    title: 'G01 接受邀请后的首个群',
    members: [rateFriend.actor_id],
  });
  checkEqual('G01-T06 自己建群的首个好友仍为 pending', rateGroup.invited.length, 1);
  const rateAdded = await callTool<GroupDetailView>(
    rateConn.client,
    'network_room_members_update',
    {
      request_id: newRequestId('g01_rate_add'),
      room_id: rateGroup.room.room_id,
      add: [rateFriend.actor_id],
    },
  );
  checkEqual('G01-T06 接受大量邀请后仍能主动添加第一个好友', rateAdded.room.member_count, 2);
  checkEqual('G01-T06 主动添加消耗自己群里的 pending 邀请', rateAdded.invited.length, 0);

  await Promise.all([
    u1Connection.close(),
    u2Connection.close(),
    strangerConnection.close(),
    lifecycleConn.close(),
    capUaConnection.close(),
    capUbConnection.close(),
    capAdminConnection.close(),
    orphanOwnerConn.close(),
    orphanConn.close(),
    rateConn.close(),
    rateFriendConn.close(),
  ]);
}
