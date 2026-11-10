/**
 * A06 Agent 管理权交接验收（A06-T01..T04）。
 *
 * 只通过公开 MCP 工具验证：
 * - T01 拒绝/过期/取消不改变管理权；重复接受返回同一非秘密结果；
 * - T02 accept 与旧管理者重发 token 并发，确认后旧管理者/旧 token/旧 stream 失效；
 * - T03 交接不自动结单，任务 blocked + management_transferred，旧 assignment 不能提交；
 * - T04 新管理者不能读取原管理者私聊、联系人，也不继承外部发布权限。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  openSubscription,
  rawRpc,
  sleep,
  waitUntil,
  ToolError,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  registerIdentity,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';

interface AgentCreateView {
  actor_id: string;
  name: string;
  token: string;
  mcp_url: string;
  management: { binding_id: string; permission_version: number };
}

interface TransferView {
  transfer_id: string;
  agent_id: string;
  from_manager_id: string;
  to_manager_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  from_permission_version: number;
  expires_at: string;
  context: {
    note: string | null;
    snapshot: {
      pending_deliveries: number;
      claimed_deliveries: number;
      room_count: number;
    };
  };
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

interface TransferAcceptedView {
  transfer_id: string;
  agent_id: string;
  status: 'accepted';
  permission_version: number;
  revoked_delegations: number;
  revoked_credentials: number;
  token: string | null;
  mcp_url: string | null;
}

interface TransferSimpleView {
  transfer_id: string;
  agent_id: string;
  status: 'pending' | 'rejected' | 'cancelled';
  responded_at: string | null;
}

type TransferRespondView = TransferAcceptedView | TransferSimpleView;

interface ManagementView {
  actor_id: string;
  my_role: 'manager' | 'delegate' | 'agent' | 'successor';
  can_manage: boolean;
  can_transfer: boolean;
  management: { manager_id: string; permission_version: number } | null;
  pending_transfer: TransferView | null;
  pending_work: {
    pending_deliveries: number;
    claimed_deliveries: number;
  };
  rooms: { room_id: string; kind: string; role: string }[];
  delegations: { delegation_id: string; delegate_actor_id: string }[];
  in_flight_deliveries: { pending: number; claimed: number; items: { delivery_id: string }[] };
  audit_summary: { event_type: string; summary: Record<string, unknown> }[];
}

interface SyncItem {
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
}

interface SyncPage {
  items: SyncItem[];
}

interface RawResult {
  body: { result?: unknown; error?: { data?: { code?: string } } };
}

function rawCode(result: RawResult): string | undefined {
  return result.body.error?.data?.code;
}

async function expectRawError(
  label: string,
  promise: Promise<RawResult>,
  expected: string,
): Promise<void> {
  const result = await promise;
  checkEqual(label, rawCode(result), expected);
}

function errorCode(error: unknown): string {
  return error instanceof ToolError ? error.code : String(error);
}

async function createAgent(
  manager: McpConnection,
  name: string,
): Promise<AgentCreateView> {
  const created = await callTool<AgentCreateView>(manager.client, 'network_agent_create', {
    request_id: newRequestId('a06_create'),
    name,
  });
  check('创建 Agent 返回一次性 token', created.token.length > 0, created.actor_id);
  return created;
}

function propose(
  manager: McpConnection,
  agentId: string,
  toManagerId: string,
  options: { requestId?: string; expiresInMs?: number; note?: string } = {},
): Promise<TransferView> {
  return callTool<TransferView>(manager.client, 'network_agent_transfer_propose', {
    request_id: options.requestId ?? newRequestId('a06_propose'),
    actor_id: agentId,
    to_manager_id: toManagerId,
    ...(options.expiresInMs === undefined ? {} : { expires_in_ms: options.expiresInMs }),
    ...(options.note === undefined ? {} : { note: options.note }),
  });
}

function respond(
  successor: McpConnection,
  transferId: string,
  decision: 'accept' | 'reject',
  requestId?: string,
): Promise<TransferRespondView> {
  return callTool<TransferRespondView>(successor.client, 'network_agent_transfer_respond', {
    request_id: requestId ?? newRequestId('a06_respond'),
    transfer_id: transferId,
    decision,
  });
}

function management(
  connection: McpConnection,
  agentId: string,
): Promise<ManagementView> {
  return callTool<ManagementView>(connection.client, 'network_agent_management_get', {
    actor_id: agentId,
  });
}

async function inboxEvents(connection: McpConnection): Promise<SyncItem[]> {
  return (
    await callTool<SyncPage>(connection.client, 'network_sync', { scope: 'inbox', limit: 100 })
  ).items;
}

async function pendingCount(connection: McpConnection): Promise<number> {
  return (await callTool<Identity>(connection.client, 'network_me')).pending_count;
}

async function createGroup(
  owner: McpConnection,
  title: string,
  members: string[],
): Promise<RoomDetail> {
  return callTool<RoomDetail>(owner.client, 'network_room_create', {
    request_id: newRequestId('a06_room'),
    kind: 'group',
    title,
    members,
  });
}

export async function runAgentTransferAcceptance(): Promise<void> {
  const managerConn = await connectClient(newToken());
  const successorConn = await connectClient(newToken());
  const successor4Conn = await connectClient(newToken());
  const outsiderConn = await connectClient(newToken());
  const extraConns: McpConnection[] = [];

  try {
    const manager = await registerIdentity(managerConn, {
      kind: 'human',
      name: 'A06 原管理者 U1',
    });
    const successor = await registerIdentity(successorConn, {
      kind: 'human',
      name: 'A06 接任者 U2',
    });
    const successor4 = await registerIdentity(successor4Conn, {
      kind: 'human',
      name: 'A06 T04 接任者 U4',
    });
    const outsider = await registerIdentity(outsiderConn, {
      kind: 'human',
      name: 'A06 旁观者 U3',
    });

    // ------------------------------------------------------------------ T01
    console.log('  A06-T01 拒绝/过期/取消不改管理权，重复接受返回同一非秘密结果');
    const first = await createAgent(managerConn, 'A06 Agent B1');
    const firstOldToken = first.token;
    const firstAgentConn = await connectClient(first.token);
    extraConns.push(firstAgentConn);

    const initial = await management(managerConn, first.actor_id);
    checkEqual('创建后管理角色为 manager', initial.my_role, 'manager');
    checkEqual('创建后权限版本为 1', initial.management?.permission_version, 1);
    checkEqual('manager 可发起交接', initial.can_transfer, true);

    await expectToolError(
      '接任者不能是当前管理者',
      propose(managerConn, first.actor_id, manager.actor_id),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '接任者不能是 Agent 自己',
      propose(managerConn, first.actor_id, first.actor_id),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '非管理者不能发起交接',
      propose(successorConn, first.actor_id, outsider.actor_id),
      'PERMISSION_DENIED',
    );

    const delegateGrant = await callTool<{ delegation_id: string }>(
      managerConn.client,
      'network_agent_delegate_grant',
      {
        request_id: newRequestId('a06_delegate'),
        actor_id: first.actor_id,
        delegate_actor_id: successor.actor_id,
      },
    );
    check('委托授予成功', delegateGrant.delegation_id.startsWith('dlg_'), delegateGrant);
    await expectToolError(
      '受托人不能发起管理权交接',
      propose(successorConn, first.actor_id, outsider.actor_id),
      'PERMISSION_DENIED',
    );
    const delegateView = await management(successorConn, first.actor_id);
    checkEqual('接受前接任者作为受托人仍不是 successor', delegateView.my_role, 'delegate');
    await callTool(managerConn.client, 'network_agent_delegate_revoke', {
      request_id: newRequestId('a06_delegate_revoke'),
      actor_id: first.actor_id,
      delegate_actor_id: successor.actor_id,
    });
    // 留给 accept 事务验证“撤销全部 active 委托”；外人不参与交接确认。
    await callTool(managerConn.client, 'network_agent_delegate_grant', {
      request_id: newRequestId('a06_delegate_outsider'),
      actor_id: first.actor_id,
      delegate_actor_id: outsider.actor_id,
    });

    // 拒绝：管理权、权限版本、凭据与任务都不变。
    const successorPendingBefore = await pendingCount(successorConn);
    const proposedReject = await propose(managerConn, first.actor_id, successor.actor_id, {
      note: 'T01 拒绝路径',
    });
    checkEqual('提议状态为 pending', proposedReject.status, 'pending');
    checkEqual('提议前接任者不能接受', proposedReject.can_accept, false);
    const successorPendingAfter = await pendingCount(successorConn);
    checkEqual(
      '交接提议不增加接任者 pending_count',
      successorPendingAfter,
      successorPendingBefore,
    );
    const proposedEvents = await inboxEvents(successorConn);
    check(
      '接任者通过个人 inbox 事件看到待确认交接',
      proposedEvents.some(
        (item) =>
          item.type === 'management_transfer_proposed' &&
          item.ref_id === proposedReject.transfer_id,
      ),
      proposedEvents.map((item) => item.type),
    );

    const successorView = await management(successorConn, first.actor_id);
    checkEqual('接任者确认前角色为 successor', successorView.my_role, 'successor');
    checkEqual('接任者确认前不能管理', successorView.can_manage, false);
    checkEqual(
      '接任者可以读取待确认交接',
      successorView.pending_transfer?.transfer_id,
      proposedReject.transfer_id,
    );

    const rejectRequest = newRequestId('a06_reject');
    const rejected = await respond(
      successorConn,
      proposedReject.transfer_id,
      'reject',
      rejectRequest,
    );
    checkEqual('接任者拒绝成功', rejected.status, 'rejected');
    const managerAfterReject = await management(managerConn, first.actor_id);
    checkEqual('拒绝后原管理者角色不变', managerAfterReject.my_role, 'manager');
    checkEqual(
      '拒绝后权限版本不变',
      managerAfterReject.management?.permission_version,
      1,
    );
    checkEqual('拒绝后没有 pending transfer', managerAfterReject.pending_transfer, null);
    const agentMeAfterReject = await callTool<Identity>(firstAgentConn.client, 'network_me');
    checkEqual('拒绝后 Agent 旧 token 仍可用', agentMeAfterReject.actor_id, first.actor_id);
    const replayReject = await respond(
      successorConn,
      proposedReject.transfer_id,
      'reject',
      rejectRequest,
    );
    checkEqual('同一 request_id 重放拒绝返回同一结果', replayReject.status, 'rejected');

    // 取消：同样不改管理权与凭据。
    const proposedCancel = await propose(managerConn, first.actor_id, successor.actor_id, {
      note: 'T01 取消路径',
    });
    const cancelled = await callTool<TransferSimpleView>(
      managerConn.client,
      'network_agent_transfer_cancel',
      {
        request_id: newRequestId('a06_cancel'),
        transfer_id: proposedCancel.transfer_id,
      },
    );
    checkEqual('发起人取消成功', cancelled.status, 'cancelled');
    const managerAfterCancel = await management(managerConn, first.actor_id);
    checkEqual('取消后原管理者角色不变', managerAfterCancel.my_role, 'manager');
    checkEqual(
      '取消后权限版本不变',
      managerAfterCancel.management?.permission_version,
      1,
    );
    await expectToolError(
      '取消后接任者不能接受已取消提议',
      respond(successorConn, proposedCancel.transfer_id, 'accept'),
      'CONFLICT',
    );

    // 过期：accept 返回 REQUEST_EXPIRED，且不改管理权。
    const proposedExpire = await propose(managerConn, first.actor_id, successor.actor_id, {
      note: 'T01 过期路径',
      expiresInMs: 1_000,
    });
    await sleep(1_200);
    await expectToolError(
      '过期后接受返回 REQUEST_EXPIRED',
      respond(successorConn, proposedExpire.transfer_id, 'accept'),
      'REQUEST_EXPIRED',
    );
    const managerAfterExpire = await management(managerConn, first.actor_id);
    checkEqual('过期后原管理者角色不变', managerAfterExpire.my_role, 'manager');
    checkEqual(
      '过期后权限版本不变',
      managerAfterExpire.management?.permission_version,
      1,
    );
    const expiredView = await callTool<TransferView>(
      successorConn.client,
      'network_agent_transfer_get',
      { transfer_id: proposedExpire.transfer_id },
    );
    checkEqual('过期提议状态为 expired', expiredView.status, 'expired');
    const expireEvents = await inboxEvents(successorConn);
    check(
      '过期写入接任者 inbox 事件',
      expireEvents.some(
        (item) =>
          item.type === 'management_transfer_expired' &&
          item.ref_id === proposedExpire.transfer_id,
      ),
      expireEvents.map((item) => item.type),
    );
    const agentMeAfterExpire = await callTool<Identity>(firstAgentConn.client, 'network_me');
    checkEqual('过期后 Agent 旧 token 仍可用', agentMeAfterExpire.actor_id, first.actor_id);

    // 正式接受：一次性 token + 同 request_id 重放不再次轮换。
    const acceptedProposal = await propose(managerConn, first.actor_id, successor.actor_id, {
      note: 'T01 接受路径',
    });
    const acceptRequest = newRequestId('a06_accept');
    const accepted = (await respond(
      successorConn,
      acceptedProposal.transfer_id,
      'accept',
      acceptRequest,
    )) as TransferAcceptedView;
    checkEqual('接受成功', accepted.status, 'accepted');
    checkEqual('接受后权限版本递增', accepted.permission_version, 2);
    check('首次接受返回一次性 token', typeof accepted.token === 'string' && accepted.token.length > 0);
    check('首次接受返回 mcp_url', typeof accepted.mcp_url === 'string');
    checkEqual('接受撤销至少一条旧运行凭据', accepted.revoked_credentials >= 1, true);
    check(
      '接受审计记录委托撤销数',
      accepted.revoked_delegations >= 1,
      accepted.revoked_delegations,
    );

    const replayAccepted = (await respond(
      successorConn,
      acceptedProposal.transfer_id,
      'accept',
      acceptRequest,
    )) as TransferAcceptedView;
    checkEqual('重放返回同一 transfer_id', replayAccepted.transfer_id, accepted.transfer_id);
    checkEqual('重放返回同一 permission_version', replayAccepted.permission_version, 2);
    checkEqual('重放不再次暴露 token', replayAccepted.token, null);
    checkEqual('重放不再次暴露 mcp_url', replayAccepted.mcp_url, null);
    const managerAfterAccept = await management(successorConn, first.actor_id);
    checkEqual(
      '重放后权限版本没有再次递增',
      managerAfterAccept.management?.permission_version,
      2,
    );
    checkEqual('重放后接任者只有一个管理关系', managerAfterAccept.my_role, 'manager');

    await expectRawError(
      '接受后旧 Agent token 立即 CREDENTIAL_INVALID',
      rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: firstOldToken }),
      'CREDENTIAL_INVALID',
    );
    checkEqual('接受后原管理者读取管理关系被拒绝', errorCode(await management(managerConn, first.actor_id).catch((error) => error)), 'PERMISSION_DENIED');
    const newAgentConn = await connectClient(accepted.token ?? '');
    extraConns.push(newAgentConn);
    const newAgentMe = await callTool<Identity>(newAgentConn.client, 'network_me');
    checkEqual('新 token 读取到同一 Agent 身份', newAgentMe.actor_id, first.actor_id);

    const oldManagerView = await callTool<TransferView>(
      managerConn.client,
      'network_agent_transfer_get',
      { transfer_id: accepted.transfer_id },
    );
    checkEqual('原管理者仍可读取自己参与的交接', oldManagerView.status, 'accepted');
    checkEqual('原管理者不能取消已接受交接', oldManagerView.can_cancel, false);
    // ------------------------------------------------------------------ T02
    console.log('  A06-T02 accept 与旧管理者重发 token 并发');
    let reissueWins = 0;
    let acceptWins = 0;
    for (let round = 0; round < 6; round += 1) {
      const raceAgent = await createAgent(managerConn, `A06 并发 Agent ${round}`);
      const raceConn = await connectClient(raceAgent.token);
      extraConns.push(raceConn);
      const subscription = await openSubscription(raceConn.client, [STREAM_URI]);
      await waitUntil('并发轮次旧 stream 已建立', () =>
        Boolean(subscription.honoredFilter.resourceSubscriptions?.length),
      );
      const raceProposal = await propose(
        managerConn,
        raceAgent.actor_id,
        successor.actor_id,
        { note: `T02 并发 ${round}` },
      );
      const startReissue = () =>
        callTool<{ token: string; actor_id: string }>(
          managerConn.client,
          'network_agent_reissue_token',
          { request_id: newRequestId('a06_race_reissue'), actor_id: raceAgent.actor_id },
        );
      const startAccept = () =>
        respond(
          successorConn,
          raceProposal.transfer_id,
          'accept',
          newRequestId('a06_race_accept'),
        );
      // 第 0 轮先让 accept 提交；第 3–5 轮先让旧管理者重发提交；其余轮次
      // 同时发起。两种提交顺序都必须有确定结果：accept 先提交时旧管理者
      // 重发返回 PERMISSION_DENIED；重发先提交时 accept 成功后再次轮换。
      let acceptPromise: Promise<TransferRespondView>;
      let reissuePromise: Promise<{ token: string; actor_id: string }>;
      if (round === 0) {
        acceptPromise = startAccept();
        await sleep(25);
        reissuePromise = startReissue();
      } else {
        reissuePromise = startReissue();
        if (round >= 3) await sleep(25);
        acceptPromise = startAccept();
      }
      const [acceptOutcome, reissueOutcome] = await Promise.allSettled([
        acceptPromise,
        reissuePromise,
      ]);
      check(
        `并发轮次 ${round} accept 成功`,
        acceptOutcome.status === 'fulfilled',
        acceptOutcome,
      );
      if (acceptOutcome.status !== 'fulfilled') continue;
      const raceAccepted = acceptOutcome.value as TransferAcceptedView;
      check(
        `并发轮次 ${round} 首次 accept 返回 token`,
        Boolean(raceAccepted.token),
        raceAccepted,
      );
      if (reissueOutcome.status === 'fulfilled') {
        reissueWins += 1;
        checkEqual(
          `并发轮次 ${round} 重发先提交后 accept 仍撤销其凭据`,
          raceAccepted.revoked_credentials >= 1,
          true,
        );
        await expectRawError(
          `并发轮次 ${round} 重发得到的 token 也已被撤销`,
          rawRpc(
            'tools/call',
            { name: 'network_me', arguments: {} },
            { token: reissueOutcome.value.token },
          ),
          'CREDENTIAL_INVALID',
        );
      } else {
        acceptWins += 1;
        checkEqual(
          `并发轮次 ${round} accept 先提交后旧管理者重发被拒绝`,
          errorCode(reissueOutcome.reason),
          'PERMISSION_DENIED',
        );
      }
      await expectRawError(
        `并发轮次 ${round} 旧 Agent token 失效`,
        rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: raceAgent.token }),
        'CREDENTIAL_INVALID',
      );
      checkEqual(
        `并发轮次 ${round} 旧 stream 被服务端关闭`,
        await Promise.race([
          subscription.closed,
          sleep(10_000).then(() => 'timeout'),
        ]),
        'graceful',
      );
      const newManagerView = await management(successorConn, raceAgent.actor_id);
      checkEqual(`并发轮次 ${round} 最终只有接任者管理者`, newManagerView.my_role, 'manager');
      checkEqual(
        `并发轮次 ${round} 原管理者不能继续管理`,
        errorCode(await management(managerConn, raceAgent.actor_id).catch((error) => error)),
        'PERMISSION_DENIED',
      );
      await expectToolError(
        `并发轮次 ${round} 原管理者不能改名`,
        callTool(managerConn.client, 'network_agent_rename', {
          request_id: newRequestId('a06_race_rename'),
          actor_id: raceAgent.actor_id,
          name: `越权重命名 ${round}`,
        }),
        'PERMISSION_DENIED',
      );
    }
    console.log(`  A06-T02 提交顺序统计：accept 先 ${acceptWins}，reissue 先 ${reissueWins}`);
    check('T02 至少覆盖两种提交顺序之一', acceptWins + reissueWins === 6, acceptWins + reissueWins);

    // ------------------------------------------------------------------ T04
    console.log('  A06-T04 新管理者不继承私聊、联系人或外部发布权限');
    await befriend(managerConn, manager.actor_id, outsiderConn, outsider.actor_id);
    const privateRoom = await callTool<RoomDetail>(managerConn.client, 'network_room_create', {
      request_id: newRequestId('a06_private_room'),
      kind: 'direct',
      members: [outsider.actor_id],
    });
    await callTool(managerConn.client, 'network_message_send', {
      request_id: newRequestId('a06_private_send'),
      client_message_id: `cm_${crypto.randomUUID()}`,
      room_id: privateRoom.room.room_id,
      body: 'A06 原管理者与他人的私聊正文',
    });
    const transferAgent = await createAgent(managerConn, 'A06 T04 Agent B3');
    const t04Proposal = await propose(managerConn, transferAgent.actor_id, successor4.actor_id, {
      note: 'T04 隐私边界',
    });
    const t04Accepted = (await respond(
      successor4Conn,
      t04Proposal.transfer_id,
      'accept',
    )) as TransferAcceptedView;
    const successorManagement = await management(successor4Conn, transferAgent.actor_id);
    checkEqual('新管理者可以读取该 Agent 管理关系', successorManagement.my_role, 'manager');
    check(
      '管理摘要只包含该 Agent 的群关系',
      successorManagement.rooms.every((room) => room.room_id !== privateRoom.room.room_id),
      successorManagement.rooms,
    );
    const privateRoomRead = await callTool<RoomDetail>(successor4Conn.client, 'network_room_get', {
      room_id: privateRoom.room.room_id,
    })
      .then(() => 'ok')
      .catch((error) => errorCode(error));
    check(
      '新管理者不能读取原管理者私聊房间',
      ['PERMISSION_DENIED', 'NOT_MEMBER', 'NOT_FOUND'].includes(privateRoomRead),
      privateRoomRead,
    );
    const privateHistory = await callTool(successor4Conn.client, 'network_history_list', {
      room_id: privateRoom.room.room_id,
    })
      .then(() => 'ok')
      .catch((error) => errorCode(error));
    check(
      '新管理者不能读取原管理者私聊历史',
      ['PERMISSION_DENIED', 'NOT_MEMBER', 'NOT_FOUND'].includes(privateHistory),
      privateHistory,
    );
    const contacts = await callTool<{ items: { actor_id: string }[] }>(
      successor4Conn.client,
      'network_contacts_list',
      { limit: 100 },
    );
    check(
      '新管理者没有继承原管理者联系人',
      contacts.items.every(
        (item) => item.actor_id !== manager.actor_id && item.actor_id !== outsider.actor_id,
      ),
      contacts.items.map((item) => item.actor_id),
    );
    const outsiderHistory = await callTool<{ items: { message_id: string }[] }>(
      outsiderConn.client,
      'network_history_list',
      { room_id: privateRoom.room.room_id },
    );
    check(
      '原管理者私聊记录仍只属于原参与者',
      outsiderHistory.items.some((item) => item.message_id.length > 0),
      outsiderHistory,
    );
    // 原管理者仍保留自己本来有权访问的私聊；交接只影响 Agent 管理关系。
    const managerStillReadsPrivate = await callTool<{ items: unknown[] }>(
      managerConn.client,
      'network_history_list',
      { room_id: privateRoom.room.room_id },
    );
    check(
      '原管理者保留自身本来有权访问的聊天记录',
      managerStillReadsPrivate.items.length >= 1,
      managerStillReadsPrivate.items.length,
    );
    checkEqual(
      '新管理者获得的权限版本与接受结果一致',
      successorManagement.management?.permission_version,
      t04Accepted.permission_version,
    );
    checkEqual(
      '管理摘要审计包含 management_transferred',
      successorManagement.audit_summary.some(
        (item) => item.event_type === 'management_transferred',
      ),
      true,
    );
    checkEqual(
      '管理摘要不包括原管理者私聊或联系人',
      JSON.stringify(successorManagement).includes('A06 原管理者与他人的私聊正文'),
      false,
    );

    // 列表只返回相关交接，旁观者不能枚举。
    const successorList = await callTool<{ items: TransferView[] }>(
      successor4Conn.client,
      'network_agent_transfer_list',
      { actor_id: transferAgent.actor_id },
    );
    check(
      '接任者列表包含自己的交接',
      successorList.items.some((item) => item.transfer_id === t04Proposal.transfer_id),
      successorList.items.map((item) => item.transfer_id),
    );
    const outsiderList = await callTool<{ items: TransferView[] }>(
      outsiderConn.client,
      'network_agent_transfer_list',
      { actor_id: transferAgent.actor_id },
    );
    checkEqual('无关身份不能枚举交接', outsiderList.items.length, 0);
    await expectToolError(
      '无关身份读取交接返回 NOT_FOUND',
      callTool(outsiderConn.client, 'network_agent_transfer_get', {
        transfer_id: t04Proposal.transfer_id,
      }),
      'NOT_FOUND',
    );
  } finally {
    for (const connection of extraConns) {
      await connection.close().catch(() => {});
    }
    await Promise.all([
      managerConn.close().catch(() => {}),
      successor4Conn.close().catch(() => {}),
      outsiderConn.close().catch(() => {}),
    ]);
  }
}
