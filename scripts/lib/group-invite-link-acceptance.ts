/**
 * G02 邀请链接 / 二维码与入群审批端到端验收（T01–T04）。
 *
 * T01：过期、撤销、次数用尽的链接在多台设备上都失败；撤销后旧二维码
 *      无法恢复，链接列表永远不返回明文 key。
 * T02：两个 pending 申请并发抢同一次邀请名额，恰好一个批准成功，
 *      used_count 与成员写入一致。
 * T03：邀请码不能当 Bearer 凭据登录邀请人，打开者确认前不能读取群消息。
 * T04：被移出成员不能复用旧链接；管理员重新定向邀请并审批后才能加入，
 *      历史边界从本次加入开始。
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
  rawRpc,
  sleep,
  type McpConnection,
} from './harness';

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
  revision: number;
  max_uses: number;
  used_count: number;
  member_count: number;
  requires_approval: boolean;
  next_step: string;
  join_request_status: string | null;
  can_respond: boolean;
  join_request_id?: string | null;
}

interface InvitationPageView {
  items: InvitationView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface InviteCreateView {
  invitation: InvitationView;
  invite_key: string | null;
  share_url: string | null;
}

interface MemberView {
  actor_id: string;
  role: 'owner' | 'admin' | 'member';
  role_revision: number;
  member_generation: number;
  joined_seq: string;
}

interface RoomDetailView {
  room: {
    room_id: string;
    kind: string;
    title: string;
    member_count: number;
    my_role: string;
    my_member_generation: number;
    history_from_seq: string;
    policy_revision: number;
    head_seq: string;
    policies: { member_join: 'open' | 'approval' };
    capabilities: { approve_joins: boolean; invite_members: boolean };
  };
  members: MemberView[];
  invited: { invitation_id: string; actor_id: string }[];
}

interface JoinRequestView {
  join_request_id: string;
  invitation_id: string;
  room_id: string;
  invitation_kind: 'direct' | 'link';
  applicant: { actor_id: string; kind: string; name: string };
  status: string;
  message: string;
  revision: number;
  expires_at: string;
  can_approve: boolean;
  can_reject: boolean;
}

interface JoinRequestPageView {
  items: JoinRequestView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface JoinRespondView {
  join_request_id: string;
  invitation_id: string;
  room_id: string;
  status: 'approved' | 'rejected';
}

interface RespondView {
  invitation_id: string;
  room_id: string;
  status: 'accepted' | 'rejected' | 'requested';
  join_request_id?: string | null;
}

interface AgentCreateView {
  actor_id: string;
  token: string;
}

interface HistoryView {
  items: { message_id: string; preview: string; created_seq: string }[];
  head_seq: string;
}

async function createManagedAgent(
  manager: McpConnection,
  name: string,
): Promise<AgentCreateView> {
  return callTool<AgentCreateView>(manager.client, 'network_agent_create', {
    request_id: newRequestId('g02_agent'),
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
}

async function createGroup(
  owner: McpConnection,
  title: string,
  memberIds: string[],
): Promise<RoomDetailView> {
  return callTool<RoomDetailView>(owner.client, 'network_room_create', {
    request_id: newRequestId('g02_room'),
    kind: 'group',
    title,
    members: memberIds,
  });
}

async function createLink(
  owner: McpConnection,
  roomId: string,
  options: { maxUses?: number; expiresInMs?: number } = {},
): Promise<InviteCreateView> {
  const created = await callTool<InviteCreateView>(
    owner.client,
    'network_room_invite_create',
    {
      request_id: newRequestId('g02_link'),
      room_id: roomId,
      ...(options.maxUses === undefined ? {} : { max_uses: options.maxUses }),
      ...(options.expiresInMs === undefined ? {} : { expires_in_ms: options.expiresInMs }),
    },
  );
  check('G02 创建链接返回明文 key 与分享 URL', Boolean(created.invite_key && created.share_url));
  checkEqual(
    'G02 分享 URL 指向 /j/<key>',
    created.share_url?.endsWith(`/j/${created.invite_key}`),
    true,
  );
  return created;
}

async function preview(
  connection: McpConnection,
  inviteKey: string,
): Promise<InvitationView> {
  const page = await callTool<InvitationPageView>(
    connection.client,
    'network_room_invite_get',
    { invite_key: inviteKey, limit: 1 },
  );
  const item = page.items[0];
  if (!item) throw new Error('链接预览为空');
  return item;
}

async function acceptLink(
  connection: McpConnection,
  invitationId: string,
  inviteKey: string,
): Promise<RespondView> {
  return callTool<RespondView>(connection.client, 'network_room_invite_respond', {
    request_id: newRequestId('g02_accept'),
    invitation_id: invitationId,
    invite_key: inviteKey,
    action: 'accept',
  });
}

async function roomDetail(
  connection: McpConnection,
  roomId: string,
): Promise<RoomDetailView> {
  return callTool<RoomDetailView>(connection.client, 'network_room_get', { room_id: roomId });
}

async function history(connection: McpConnection, roomId: string): Promise<HistoryView> {
  return callTool<HistoryView>(connection.client, 'network_history_list', {
    room_id: roomId,
    limit: 100,
  });
}

function requestCode(body: Record<string, unknown>): string | null {
  const result = body.result as
    | { isError?: boolean; content?: { type: string; text?: string }[] }
    | undefined;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { code?: string };
      if (parsed.code) return parsed.code;
    } catch {
      return null;
    }
  }
  const error = body.error as { data?: { code?: string } } | undefined;
  return error?.data?.code ?? null;
}

/** T01：失效链接在多设备上一致失败，且明文 key 不能从服务端恢复。 */
async function runT01(): Promise<void> {
  const ownerConn = await connectClient(newToken());
  const deviceA = await connectClient(newToken());
  const deviceB = await connectClient(newToken());
  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'G02 T01 群主' });
    const userA = await registerIdentity(deviceA, { kind: 'human', name: 'G02 T01 设备 A' });
    await registerIdentity(deviceB, { kind: 'human', name: 'G02 T01 设备 B' });
    const seedAgent = await createManagedAgent(ownerConn, 'G02 T01 群内 Agent');
    const group = await createGroup(ownerConn, 'G02 T01 失效链接', [seedAgent.actor_id]);
    const roomId = group.room.room_id;

    // 过期链接：两台设备都只能看到 expired，确认时统一 REQUEST_EXPIRED。
    const expiring = await createLink(ownerConn, roomId, { expiresInMs: 1_000 });
    await sleep(1_200);
    for (const [label, device] of [
      ['设备 A', deviceA],
      ['设备 B', deviceB],
    ] as const) {
      const item = await preview(device, expiring.invite_key!);
      checkEqual(`G02-T01 ${label} 看到链接已过期`, item.status, 'expired');
      checkEqual(`G02-T01 ${label} 过期链接不可确认`, item.can_respond, false);
      checkEqual(`G02-T01 ${label} 过期链接 next_step=invalid`, item.next_step, 'invalid');
      await expectToolError(
        `G02-T01 ${label} 确认过期链接返回 REQUEST_EXPIRED`,
        acceptLink(device, expiring.invitation.invitation_id, expiring.invite_key!),
        'REQUEST_EXPIRED',
      );
    }

    // 撤销链接：撤销后两台设备都失效，旧 key 不能恢复成新链接。
    const revoked = await createLink(ownerConn, roomId, { maxUses: 5 });
    await callTool(ownerConn.client, 'network_room_invite_revoke', {
      request_id: newRequestId('g02_revoke'),
      invitation_id: revoked.invitation.invitation_id,
      expected_revision: revoked.invitation.revision,
    });
    for (const [label, device] of [
      ['设备 A', deviceA],
      ['设备 B', deviceB],
    ] as const) {
      const item = await preview(device, revoked.invite_key!);
      checkEqual(`G02-T01 ${label} 看到链接已撤销`, item.status, 'revoked');
      checkEqual(`G02-T01 ${label} 撤销链接不可确认`, item.can_respond, false);
      await expectToolError(
        `G02-T01 ${label} 确认撤销链接返回 CONFLICT`,
        acceptLink(device, revoked.invitation.invitation_id, revoked.invite_key!),
        'CONFLICT',
      );
    }
    const linkRows = await callTool<InvitationPageView>(
      ownerConn.client,
      'network_room_invite_get',
      { room_id: roomId, limit: 50 },
    );
    const revokedRow = linkRows.items.find(
      (item) => item.invitation_id === revoked.invitation.invitation_id,
    );
    checkEqual('G02-T01 群链接列表保留撤销状态', revokedRow?.status, 'revoked');
    check(
      'G02-T01 链接列表不返回明文 key 或分享 URL',
      !('invite_key' in (revokedRow ?? {})) && !('share_url' in (revokedRow ?? {})),
      revokedRow,
    );
    const replacement = await createLink(ownerConn, roomId, { maxUses: 5 });
    check(
      'G02-T01 新链接 key 与旧二维码 key 不同',
      replacement.invite_key !== revoked.invite_key,
    );
    checkEqual(
      'G02-T01 旧二维码撤销后仍然失效',
      (await preview(deviceA, revoked.invite_key!)).status,
      'revoked',
    );

    // 次数用尽：首个用户成功加入后，第二台设备统一 INVITE_EXHAUSTED。
    const singleUse = await createLink(ownerConn, roomId, { maxUses: 1 });
    const joined = await acceptLink(
      deviceA,
      singleUse.invitation.invitation_id,
      singleUse.invite_key!,
    );
    checkEqual('G02-T01 首次加入返回 accepted', joined.status, 'accepted');
    const exhausted = await preview(deviceB, singleUse.invite_key!);
    checkEqual('G02-T01 第二台设备看到次数用尽', exhausted.status, 'exhausted');
    checkEqual('G02-T01 次数用尽链接不可确认', exhausted.can_respond, false);
    await expectToolError(
      'G02-T01 确认次数用尽链接返回 INVITE_EXHAUSTED',
      acceptLink(deviceB, singleUse.invitation.invitation_id, singleUse.invite_key!),
      'INVITE_EXHAUSTED',
    );
    const finalDetail = await roomDetail(ownerConn, roomId);
    checkEqual('G02-T01 只有一名打开者成为成员', finalDetail.room.member_count, 3);
    check(
      'G02-T01 成功的打开者进入成员列表',
      finalDetail.members.some((member) => member.actor_id === userA.actor_id),
    );

    // 链接不进入个人定向邀请列表，避免把共享链接误当成个人邀请。
    const personal = await callTool<InvitationPageView>(deviceB.client, 'network_room_invite_get', {
      limit: 50,
    });
    check(
      'G02-T01 链接不进入个人定向邀请列表',
      !personal.items.some((item) => item.room_id === roomId),
    );
  } finally {
    await Promise.all([ownerConn.close(), deviceA.close(), deviceB.close()]);
  }
}

/** T02：最后一次邀请名额并发审批，只有一个成功且计数一致。 */
async function runT02(): Promise<void> {
  const ownerConn = await connectClient(newToken());
  const applicantAConn = await connectClient(newToken());
  const applicantBConn = await connectClient(newToken());
  let adminConn: McpConnection | null = null;
  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'G02 T02 群主' });
    const applicantA = await registerIdentity(applicantAConn, {
      kind: 'human',
      name: 'G02 T02 申请人 A',
    });
    const applicantB = await registerIdentity(applicantBConn, {
      kind: 'human',
      name: 'G02 T02 申请人 B',
    });
    const adminAgent = await createManagedAgent(ownerConn, 'G02 T02 协管 Agent');
    adminConn = await connectClient(adminAgent.token);
    const group = await createGroup(ownerConn, 'G02 T02 并发审批', [adminAgent.actor_id]);
    const roomId = group.room.room_id;
    const adminMember = group.members.find((member) => member.actor_id === adminAgent.actor_id);
    await callTool(ownerConn.client, 'network_room_role_set', {
      request_id: newRequestId('g02_admin'),
      room_id: roomId,
      actor_id: adminAgent.actor_id,
      role: 'admin',
      expected_role_revision: adminMember?.role_revision ?? 1,
    });
    await callTool(ownerConn.client, 'network_room_policy_set', {
      request_id: newRequestId('g02_policy'),
      room_id: roomId,
      member_join_policy: 'approval',
      expected_policy_revision: group.room.policy_revision,
    });
    const link = await createLink(ownerConn, roomId, { maxUses: 1 });

    for (const [label, connection] of [
      ['申请人 A', applicantAConn],
      ['申请人 B', applicantBConn],
    ] as const) {
      const item = await preview(connection, link.invite_key!);
      checkEqual(`G02-T02 ${label} 确认前进入申请`, item.next_step, 'request');
      const requested = await acceptLink(
        connection,
        link.invitation.invitation_id,
        link.invite_key!,
      );
      checkEqual(`G02-T02 ${label} 返回 requested`, requested.status, 'requested');
      check(
        `G02-T02 ${label} 不直接成为成员`,
        !(await roomDetail(ownerConn, roomId)).members.some(
          (member) => member.actor_id === (label === '申请人 A' ? applicantA : applicantB).actor_id,
        ),
      );
    }
    await expectToolError(
      'G02-T02 申请未批准时不能读取房间',
      callTool(applicantAConn.client, 'network_room_get', { room_id: roomId }),
      'NOT_MEMBER',
    );

    const requests = await callTool<JoinRequestPageView>(
      ownerConn.client,
      'network_room_join_request_list',
      { room_id: roomId, status: 'pending', limit: 20 },
    );
    checkEqual('G02-T02 两名申请人进入待审批列表', requests.items.length, 2);
    checkEqual('G02-T02 pending 申请不占成员数', (await roomDetail(ownerConn, roomId)).room.member_count, 2);
    const requestA = requests.items.find(
      (item) => item.applicant.actor_id === applicantA.actor_id,
    );
    const requestB = requests.items.find(
      (item) => item.applicant.actor_id === applicantB.actor_id,
    );
    if (!requestA || !requestB) throw new Error('缺少待审批申请');

    const results = await Promise.allSettled([
      callTool<JoinRespondView>(ownerConn.client, 'network_room_join_request_respond', {
        request_id: newRequestId('g02_approve'),
        join_request_id: requestA.join_request_id,
        action: 'approve',
        expected_revision: requestA.revision,
      }),
      callTool<JoinRespondView>(adminConn.client, 'network_room_join_request_respond', {
        request_id: newRequestId('g02_approve'),
        join_request_id: requestB.join_request_id,
        action: 'approve',
        expected_revision: requestB.revision,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    checkEqual('G02-T02 并发批准只成功一个', fulfilled.length, 1);
    checkEqual('G02-T02 另一个批准失败', rejected.length, 1);
    const failure = rejected[0] as PromiseRejectedResult | undefined;
    checkEqual(
      'G02-T02 失败原因是邀请名额已变化',
      (failure?.reason as { code?: string } | undefined)?.code,
      'CONFLICT',
    );

    const after = await roomDetail(ownerConn, roomId);
    checkEqual('G02-T02 群成员只增加一人', after.room.member_count, 3);
    const linkRows = await callTool<InvitationPageView>(
      ownerConn.client,
      'network_room_invite_get',
      { room_id: roomId, limit: 50 },
    );
    const used = linkRows.items.find(
      (item) => item.invitation_id === link.invitation.invitation_id,
    );
    checkEqual('G02-T02 used_count 与成功批准数一致', used?.used_count, 1);
    checkEqual('G02-T02 max_uses 保持创建值', used?.max_uses, 1);
    checkEqual('G02-T02 邀请状态落库为 exhausted', used?.status, 'exhausted');
    const pendingRows = await callTool<JoinRequestPageView>(
      ownerConn.client,
      'network_room_join_request_list',
      { room_id: roomId, status: 'pending', limit: 20 },
    );
    checkEqual('G02-T02 失败的申请仍保持 pending 行', pendingRows.items.length, 1);
    checkEqual(
      'G02-T02 失败的申请按 exhausted 派生为 expired',
      pendingRows.items[0]?.status,
      'expired',
    );
    checkEqual('G02-T02 expired 申请不可再批准', pendingRows.items[0]?.can_approve, false);
  } finally {
    await Promise.all([
      ownerConn.close(),
      applicantAConn.close(),
      applicantBConn.close(),
      adminConn ? adminConn.close() : Promise.resolve(),
    ]);
  }
}

/** T03：邀请码不是身份凭据，确认前不泄露群消息。 */
async function runT03(): Promise<void> {
  const ownerConn = await connectClient(newToken());
  const openerConn = await connectClient(newToken());
  try {
    await registerIdentity(ownerConn, { kind: 'human', name: 'G02 T03 群主' });
    await registerIdentity(openerConn, { kind: 'human', name: 'G02 T03 打开者' });
    const seedAgent = await createManagedAgent(ownerConn, 'G02 T03 群内 Agent');
    const group = await createGroup(ownerConn, 'G02 T03 最小介绍', [seedAgent.actor_id]);
    const roomId = group.room.room_id;
    const marker = `加入前消息-${crypto.randomUUID().replaceAll('-', '')}`;
    const beforeJoin = await callTool<{ message: { message_id: string } }>(
      ownerConn.client,
      'network_message_send',
      {
        request_id: newRequestId('g02_before'),
        client_message_id: `cm_${crypto.randomUUID()}`,
        room_id: roomId,
        body: marker,
        invoke: [],
      },
    );
    const link = await createLink(ownerConn, roomId, { maxUses: 5 });

    // 邀请 key 当 Bearer：不能登录成邀请人。
    const asCredential = await rawRpc(
      'tools/call',
      { name: 'network_me', arguments: {} },
      { token: link.invite_key! },
    );
    checkEqual(
      'G02-T03 邀请码不能作为 Bearer 凭据',
      requestCode(asCredential.body),
      'CREDENTIAL_INVALID',
    );

    const item = await preview(openerConn, link.invite_key!);
    checkEqual('G02-T03 打开者先看到最小群介绍', item.room_title, 'G02 T03 最小介绍');
    checkEqual('G02-T03 预览声明需要确认', item.next_step, 'join');
    checkEqual('G02-T03 预览不返回消息正文', item.can_respond, true);
    check(
      'G02-T03 预览不包含消息、历史或凭据字段',
      !('messages' in item) &&
        !('history' in item) &&
        !('token' in item) &&
        !('token_hash' in item) &&
        !('invite_key' in item),
      Object.keys(item),
    );
    check(
      'G02-T03 预览正文不含加入前消息',
      !JSON.stringify(item).includes(marker),
    );
    await expectToolError(
      'G02-T03 确认前不能读取群历史',
      callTool(openerConn.client, 'network_history_list', { room_id: roomId, limit: 10 }),
      'NOT_MEMBER',
    );
    await expectToolError(
      'G02-T03 确认前不能读取房间详情',
      callTool(openerConn.client, 'network_room_get', { room_id: roomId }),
      'NOT_MEMBER',
    );
    await expectToolError(
      'G02-T03 只出示内部 invitation_id 不能加入链接',
      callTool(openerConn.client, 'network_room_invite_respond', {
        request_id: newRequestId('g02_no_key'),
        invitation_id: link.invitation.invitation_id,
        action: 'accept',
      }),
      'NOT_FOUND',
    );

    const joined = await acceptLink(
      openerConn,
      link.invitation.invitation_id,
      link.invite_key!,
    );
    checkEqual('G02-T03 确认后加入成功', joined.status, 'accepted');
    const afterJoin = await history(openerConn, roomId);
    check(
      'G02-T03 加入前消息不进入新成员历史',
      !afterJoin.items.some((entry) => entry.message_id === beforeJoin.message.message_id),
      afterJoin.items,
    );
  } finally {
    await Promise.all([ownerConn.close(), openerConn.close()]);
  }
}

/** T04：移出后旧链接失效；新定向邀请 + 审批才能重入。 */
async function runT04(): Promise<void> {
  const ownerConn = await connectClient(newToken());
  const targetConn = await connectClient(newToken());
  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'G02 T04 群主' });
    const target = await registerIdentity(targetConn, { kind: 'human', name: 'G02 T04 成员' });
    await befriend(ownerConn, owner.actor_id, targetConn, target.actor_id);
    const seedAgent = await createManagedAgent(ownerConn, 'G02 T04 群内 Agent');
    const group = await createGroup(ownerConn, 'G02 T04 移出重入', [seedAgent.actor_id]);
    const roomId = group.room.room_id;

    const direct = await callTool<InviteCreateView>(
      ownerConn.client,
      'network_room_invite_create',
      {
        request_id: newRequestId('g02_direct'),
        room_id: roomId,
        target_actor_id: target.actor_id,
      },
    );
    checkEqual('G02-T04 定向邀请不返回明文链接', direct.invite_key, null);
    const accepted = await callTool<RespondView>(
      targetConn.client,
      'network_room_invite_respond',
      {
        request_id: newRequestId('g02_direct_accept'),
        invitation_id: direct.invitation.invitation_id,
        action: 'accept',
      },
    );
    checkEqual('G02-T04 定向邀请首次加入成功', accepted.status, 'accepted');

    const kickMarker = `移出前消息-${crypto.randomUUID().replaceAll('-', '')}`;
    const beforeKick = await callTool<{ message: { message_id: string; created_seq: string } }>(
      ownerConn.client,
      'network_message_send',
      {
        request_id: newRequestId('g02_kick_before'),
        client_message_id: `cm_${crypto.randomUUID()}`,
        room_id: roomId,
        body: kickMarker,
        invoke: [],
      },
    );
    const sharedLink = await createLink(ownerConn, roomId, { maxUses: 5 });
    await callTool(ownerConn.client, 'network_room_members_update', {
      request_id: newRequestId('g02_kick'),
      room_id: roomId,
      remove: [target.actor_id],
    });
    await expectToolError(
      'G02-T04 移出后立即失去房间读取',
      callTool(targetConn.client, 'network_room_get', { room_id: roomId }),
      'NOT_MEMBER',
    );

    const oldLinkPreview = await preview(targetConn, sharedLink.invite_key!);
    checkEqual('G02-T04 旧链接标记为已移除', oldLinkPreview.next_step, 'removed');
    checkEqual('G02-T04 旧链接不可确认', oldLinkPreview.can_respond, false);
    await expectToolError(
      'G02-T04 移出后旧链接不能重新加入',
      acceptLink(targetConn, sharedLink.invitation.invitation_id, sharedLink.invite_key!),
      'CONFLICT',
    );
    await expectToolError(
      'G02-T04 已接受的旧定向邀请不能复用',
      callTool(targetConn.client, 'network_room_invite_respond', {
        request_id: newRequestId('g02_old_direct'),
        invitation_id: direct.invitation.invitation_id,
        action: 'accept',
      }),
      'CONFLICT',
    );

    // 重新审批：切换为 approval 后新建定向邀请，确认只创建申请。
    const beforePolicy = await roomDetail(ownerConn, roomId);
    await callTool(ownerConn.client, 'network_room_policy_set', {
      request_id: newRequestId('g02_rejoin_policy'),
      room_id: roomId,
      member_join_policy: 'approval',
      expected_policy_revision: beforePolicy.room.policy_revision,
    });
    const fresh = await callTool<InviteCreateView>(
      ownerConn.client,
      'network_room_invite_create',
      {
        request_id: newRequestId('g02_fresh_direct'),
        room_id: roomId,
        target_actor_id: target.actor_id,
      },
    );
    const requested = await callTool<RespondView>(
      targetConn.client,
      'network_room_invite_respond',
      {
        request_id: newRequestId('g02_rejoin_accept'),
        invitation_id: fresh.invitation.invitation_id,
        action: 'accept',
      },
    );
    checkEqual('G02-T04 新定向邀请进入审批', requested.status, 'requested');
    await expectToolError(
      'G02-T04 审批通过前仍不是成员',
      callTool(targetConn.client, 'network_room_get', { room_id: roomId }),
      'NOT_MEMBER',
    );
    const pending = await callTool<JoinRequestPageView>(
      ownerConn.client,
      'network_room_join_request_list',
      { room_id: roomId, status: 'pending', limit: 20 },
    );
    const rejoinRequest = pending.items.find(
      (item) => item.applicant.actor_id === target.actor_id,
    );
    check('G02-T04 审批列表出现重入申请', Boolean(rejoinRequest));
    if (!rejoinRequest) throw new Error('缺少重入申请');
    const approved = await callTool<JoinRespondView>(
      ownerConn.client,
      'network_room_join_request_respond',
      {
        request_id: newRequestId('g02_rejoin_approve'),
        join_request_id: rejoinRequest.join_request_id,
        action: 'approve',
        expected_revision: rejoinRequest.revision,
      },
    );
    checkEqual('G02-T04 管理员批准重入', approved.status, 'approved');

    const rejoined = await roomDetail(targetConn, roomId);
    check(
      'G02-T04 重入后成为 active 成员',
      rejoined.members.some((member) => member.actor_id === target.actor_id),
    );
    checkEqual('G02-T04 重入后成员代次递增', rejoined.room.my_member_generation, 2);
    const kickSeq = Number(beforeKick.message.created_seq);
    check(
      'G02-T04 历史下界从本次加入开始',
      Number(rejoined.room.history_from_seq) > kickSeq,
      { history_from_seq: rejoined.room.history_from_seq, kick_seq: kickSeq },
    );
    const afterRejoin = await history(targetConn, roomId);
    check(
      'G02-T04 重入后看不到移出前消息',
      !afterRejoin.items.some((entry) => entry.message_id === beforeKick.message.message_id),
      afterRejoin.items,
    );
    const postMarker = `重入后消息-${crypto.randomUUID().replaceAll('-', '')}`;
    const postJoin = await callTool<{ message: { message_id: string } }>(
      ownerConn.client,
      'network_message_send',
      {
        request_id: newRequestId('g02_rejoin_after'),
        client_message_id: `cm_${crypto.randomUUID()}`,
        room_id: roomId,
        body: postMarker,
        invoke: [],
      },
    );
    const freshHistory = await history(targetConn, roomId);
    check(
      'G02-T04 重入后能看到新消息',
      freshHistory.items.some((entry) => entry.message_id === postJoin.message.message_id),
      freshHistory.items,
    );
  } finally {
    await Promise.all([ownerConn.close(), targetConn.close()]);
  }
}

export async function runGroupInviteLinkAcceptance(): Promise<void> {
  console.log('· G02 邀请链接与入群审批');
  await runT01();
  await runT02();
  await runT03();
  await runT04();
}
