/**
 * G05 群主转让确认端到端验收（T01–T03）。
 *
 * T01：提议不立刻换 owner；重复接受返回同一 owner；同一群第二个提议被拒绝；
 * 接受后才原子换主并把原 owner 降为成员。
 * T02：接受与取消并发只有一种合法结果；移除接任者使提议失效；目标角色漂移
 * 或 expected_version 过期返回冲突；已取消提议不能再接受。
 * T03：原 owner 转让后不能继续执行群主专属动作；所有设备收到同步事件；
 * 转让不创建 delivery、不增加 pending_count、不推进房间 head。
 *
 * 提议默认 24 小时有效期只断言返回窗口；当前没有测试时钟，真实过期只能由
 * 生产时间推进，报告中记录为剩余验证缺口。
 */

import type { McpSubscription } from '@modelcontextprotocol/client';

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openRawListen,
  openSubscription,
  sleep,
  ToolError,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  registerIdentity,
  type Identity,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

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

interface OwnerTransferView {
  transfer_id: string;
  room_id: string;
  from_owner_id: string;
  from_owner_name: string;
  to_actor_id: string;
  to_actor_name: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  version: number;
  expires_at: string;
  created_at: string;
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

interface GroupRoomView {
  room: {
    room_id: string;
    kind: string;
    owner_id: string | null;
    head_seq: string;
    my_last_read_seq: string;
    my_role: 'owner' | 'admin' | 'member';
    my_role_revision: number;
    policy_revision: number;
    announcement_revision: number;
    capabilities: Record<string, boolean>;
  };
  members: GroupMemberView[];
  owner_transfer: OwnerTransferView | null;
}

interface AuditItemView {
  action: string;
  target_actor_id: string | null;
  previous_role: string | null;
  new_role: string | null;
  changed_by: string;
  request_id: string;
  detail: Record<string, unknown>;
}

interface AuditPageView {
  items: AuditItemView[];
}

interface StreamItemView {
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  change?: string;
  subject_id?: string;
}

type Collector = ReturnType<typeof notificationCollector>;

function memberOf(view: GroupRoomView, actorId: string): GroupMemberView {
  const found = view.members.find((member) => member.actor_id === actorId);
  if (!found) {
    throw new Error(`成员 ${actorId} 不在房间 ${view.room.room_id} 中`);
  }
  return found;
}

function streamItems(collector: Collector, from: number): StreamItemView[] {
  const items: StreamItemView[] = [];
  for (const event of collector.events.slice(from)) {
    if (event.params.uri !== STREAM_URI) continue;
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
    if (payload?.items) items.push(...payload.items);
  }
  return items;
}

async function waitForItem(
  collector: Collector,
  from: number,
  predicate: (item: StreamItemView) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<StreamItemView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = streamItems(collector, from).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${label}: 等待 stream item 超时`);
    await sleep(100);
  }
}

async function readRoom(connection: McpConnection, roomId: string): Promise<GroupRoomView> {
  return callTool<GroupRoomView>(connection.client, 'network_room_get', { room_id: roomId });
}

async function pendingCount(connection: McpConnection): Promise<number> {
  return (await inbox(connection, 'pending')).pending_count;
}

export async function runOwnerTransferAcceptance(): Promise<void> {
  console.log('· G05 群主转让确认');
  const ownerConn = await connectClient(newToken());
  const ownerDeviceB = await connectClient(ownerConn.token);
  const targetConn = await connectClient(newToken());
  const rivalConn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];
  let ownerDeviceBListen: { close(): Promise<void> } | null = null;

  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'G05 原群主' });
    const target = await registerIdentity(targetConn, { kind: 'human', name: 'G05 接任者' });
    const rival = await registerIdentity(rivalConn, { kind: 'human', name: 'G05 另一候选人' });
    check(
      'G05 身份注册成功',
      Boolean(owner.actor_id && target.actor_id && rival.actor_id),
      { owner, target, rival },
    );
    await befriend(ownerConn, owner.actor_id, targetConn, target.actor_id);
    await befriend(ownerConn, owner.actor_id, rivalConn, rival.actor_id);

    const createGroup = async (title: string): Promise<string> => {
      const created = await callTool<GroupRoomView>(ownerConn.client, 'network_room_create', {
        request_id: newRequestId('g05_room'),
        kind: 'group',
        members: [target.actor_id, rival.actor_id],
        title,
      });
      const roomId = created.room.room_id;
      await acceptGroupInvites(targetConn, roomId);
      await acceptGroupInvites(rivalConn, roomId);
      return roomId;
    };

    const propose = (
      connection: McpConnection,
      roomId: string,
      targetActorId: string,
      expectedRoleRevision: number | undefined,
      requestId = newRequestId('g05_propose'),
    ): Promise<GroupRoomView> =>
      callTool<GroupRoomView>(connection.client, 'network_room_owner_transfer_propose', {
        request_id: requestId,
        room_id: roomId,
        target_actor_id: targetActorId,
        ...(expectedRoleRevision === undefined
          ? {}
          : { expected_role_revision: expectedRoleRevision }),
      });

    const respond = (
      connection: McpConnection,
      transferId: string,
      action: 'accept' | 'reject',
      expectedVersion: number,
      requestId = newRequestId('g05_respond'),
    ): Promise<GroupRoomView> =>
      callTool<GroupRoomView>(connection.client, 'network_room_owner_transfer_respond', {
        request_id: requestId,
        transfer_id: transferId,
        action,
        expected_version: expectedVersion,
      });

    const cancel = (
      connection: McpConnection,
      transferId: string,
      expectedVersion: number,
      requestId = newRequestId('g05_cancel'),
    ): Promise<GroupRoomView> =>
      callTool<GroupRoomView>(connection.client, 'network_room_owner_transfer_cancel', {
        request_id: requestId,
        transfer_id: transferId,
        expected_version: expectedVersion,
      });

    // ---------- G05-T01 提议、重复接受与竞争提议 ----------
    console.log('  G05-T01 提议、重复接受与竞争提议');
    const roomId = await createGroup('G05 转让确认');
    const ownerCollector = notificationCollector(ownerConn.client);
    const targetCollector = notificationCollector(targetConn.client);
    subscriptions.push(
      await openSubscription(ownerConn.client, [STREAM_URI]),
      await openSubscription(targetConn.client, [STREAM_URI]),
    );
    // SDK 的 listen 序号按客户端实例从 0 开始，同一 actor 的第二条连接会
    // 得到相同的 subscription id；第二设备改用原始 SSE 并显式指定唯一 id。
    const ownerDeviceBListenHandle = await openRawListen(
      ownerConn.token,
      'listen:g05-device-b',
      [STREAM_URI],
    );
    ownerDeviceBListen = ownerDeviceBListenHandle;

    const before = await readRoom(ownerConn, roomId);
    checkEqual('G05 初始没有待确认提议', before.owner_transfer, null);
    checkEqual('G05 初始 owner 不变', before.room.owner_id, owner.actor_id);
    checkEqual('G05 原 owner 具备转让能力', before.room.capabilities.transfer_owner, true);
    const headBefore = before.room.head_seq;
    const targetPendingBefore = await pendingCount(targetConn);

    const targetRevision = memberOf(before, target.actor_id).role_revision;
    const proposeRequestId = newRequestId('g05_propose');
    const proposed = await propose(
      ownerConn,
      roomId,
      target.actor_id,
      targetRevision,
      proposeRequestId,
    );
    const transfer = proposed.owner_transfer;
    check('G05 发起后返回 pending 提议', transfer?.status === 'pending', proposed);
    if (!transfer) throw new Error('G05 发起后没有返回 owner_transfer');
    checkEqual('G05 提议版本为 1', transfer.version, 1);
    checkEqual('G05 提议记录原 owner', transfer.from_owner_id, owner.actor_id);
    checkEqual('G05 提议记录目标', transfer.to_actor_id, target.actor_id);
    checkEqual('G05 原 owner 名称可读', transfer.from_owner_name, 'G05 原群主');
    checkEqual('G05 目标名称可读', transfer.to_actor_name, 'G05 接任者');
    checkEqual('G05 原 owner 可取消', transfer.can_cancel, true);
    checkEqual('G05 原 owner 不可接受', transfer.can_accept, false);
    const ttl = Number(transfer.expires_at) - Date.now();
    check(
      'G05 提议默认 24 小时有效',
      Number.isFinite(ttl) && ttl > 23 * 60 * 60_000 && ttl <= 25 * 60 * 60_000,
      ttl,
    );
    checkEqual('G05 接受前 rooms.owner_id 不变', proposed.room.owner_id, owner.actor_id);
    checkEqual('G05 接受前原 owner 仍是 owner', proposed.room.my_role, 'owner');
    checkEqual('G05 接受前目标仍是成员', memberOf(proposed, target.actor_id).role, 'member');

    const targetView = await readRoom(targetConn, roomId);
    checkEqual('G05 目标看到可接受', targetView.owner_transfer?.can_accept, true);
    checkEqual('G05 目标看到可拒绝', targetView.owner_transfer?.can_reject, true);
    checkEqual('G05 目标不能取消他人提议', targetView.owner_transfer?.can_cancel, false);

    await expectToolError(
      'G05 同一群第二个提议被拒绝',
      propose(ownerConn, roomId, rival.actor_id, memberOf(before, rival.actor_id).role_revision),
      'CONFLICT',
    );
    const replayedPropose = await propose(
      ownerConn,
      roomId,
      target.actor_id,
      targetRevision,
      proposeRequestId,
    );
    checkEqual(
      'G05 同一 request_id 重放返回同一提议',
      replayedPropose.owner_transfer?.transfer_id,
      transfer.transfer_id,
    );
    checkEqual('G05 重放不推进提议版本', replayedPropose.owner_transfer?.version, 1);
    await expectToolError(
      'G05 原 owner 不能以已发起提议为由离群',
      callTool(ownerConn.client, 'network_room_leave', {
        request_id: newRequestId('g05_leave'),
        room_id: roomId,
      }),
      'CONFLICT',
    );
    checkEqual(
      'G05 离群被拒后 owner 仍负责',
      (await readRoom(ownerConn, roomId)).room.owner_id,
      owner.actor_id,
    );

    const pendingItem = await waitForItem(
      ownerCollector,
      0,
      (item) => item.room_id === roomId && item.change === 'owner_transfer_pending',
      'G05 原 owner 待确认事件',
    );
    checkEqual('G05 待确认事件 source 为 room.membership', pendingItem.source, 'room.membership');
    checkEqual('G05 待确认事件 attention 为 informational', pendingItem.attention, 'informational');
    await ownerDeviceBListenHandle.waitForFrame(
      (frame) => frame.includes('owner_transfer_pending'),
      'G05 原 owner 第二设备待确认事件',
    );

    const acceptRequestId = newRequestId('g05_accept');
    const accepted = await respond(targetConn, transfer.transfer_id, 'accept', 1, acceptRequestId);
    checkEqual('G05 接受后 owner 变为目标', accepted.room.owner_id, target.actor_id);
    checkEqual('G05 接任者成为 owner', accepted.room.my_role, 'owner');
    checkEqual('G05 接受后不再有待确认提议', accepted.owner_transfer, null);
    const demotedView = await readRoom(ownerConn, roomId);
    checkEqual('G05 原 owner 降为普通成员', demotedView.room.my_role, 'member');
    check(
      'G05 原 owner 失去 owner 能力',
      demotedView.room.capabilities.transfer_owner === false &&
        demotedView.room.capabilities.manage_admins === false &&
        demotedView.room.capabilities.manage_policy === false,
      demotedView.room.capabilities,
    );

    const replayedAccept = await respond(
      targetConn,
      transfer.transfer_id,
      'accept',
      1,
      acceptRequestId,
    );
    checkEqual('G05 重复接受返回同一 owner', replayedAccept.room.owner_id, target.actor_id);
    await expectToolError(
      'G05 已接受后新 request_id 再接受被拒绝',
      respond(targetConn, transfer.transfer_id, 'accept', 1),
      'CONFLICT',
    );

    const ownerChanged = await waitForItem(
      targetCollector,
      0,
      (item) => item.room_id === roomId && item.change === 'owner_changed',
      'G05 接任者 owner_changed 事件',
    );
    checkEqual('G05 接任者收到 owner_changed', ownerChanged.source, 'room.membership');
    await waitForItem(
      ownerCollector,
      0,
      (item) => item.room_id === roomId && item.change === 'owner_changed',
      'G05 原 owner owner_changed 事件',
    );
    await ownerDeviceBListenHandle.waitForFrame(
      (frame) => frame.includes('owner_changed'),
      'G05 原 owner 第二设备 owner_changed 事件',
    );

    // ---------- G05-T03 转让后的权限与审计 ----------
    console.log('  G05-T03 转让后权限、审计与通知副作用');
    const oldOwnerView = await readRoom(ownerConn, roomId);
    checkEqual('G05 转让后原 owner 角色为 member', oldOwnerView.room.my_role, 'member');
    checkEqual('G05 原 owner 失去 manage_admins', oldOwnerView.room.capabilities.manage_admins, false);
    checkEqual('G05 原 owner 失去 manage_policy', oldOwnerView.room.capabilities.manage_policy, false);
    checkEqual('G05 原 owner 失去 transfer_owner', oldOwnerView.room.capabilities.transfer_owner, false);
    const rivalRow = memberOf(oldOwnerView, rival.actor_id);
    check(
      'G05 原 owner 没有成员管理动作',
      rivalRow.actions.can_set_admin === false &&
        rivalRow.actions.can_transfer_owner === false &&
        rivalRow.actions.can_remove === false,
      rivalRow.actions,
    );
    await expectToolError(
      'G05 原 owner 不能任命管理员',
      callTool(ownerConn.client, 'network_room_role_set', {
        request_id: newRequestId('g05_role'),
        room_id: roomId,
        actor_id: rival.actor_id,
        role: 'admin',
        expected_role_revision: rivalRow.role_revision,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      'G05 原 owner 不能修改群策略',
      callTool(ownerConn.client, 'network_room_policy_set', {
        request_id: newRequestId('g05_policy'),
        room_id: roomId,
        member_message_policy: 'owner_admin',
        expected_policy_revision: oldOwnerView.room.policy_revision,
      }),
      'NOT_OWNER',
    );
    await expectToolError(
      'G05 原 owner 不能发起新的转让',
      propose(ownerConn, roomId, rival.actor_id, rivalRow.role_revision),
      'NOT_OWNER',
    );
    await expectToolError(
      'G05 原 owner 不能修改公告',
      callTool(ownerConn.client, 'network_room_announcement_set', {
        request_id: newRequestId('g05_announcement'),
        room_id: roomId,
        announcement: '原 owner 不应写入',
        expected_announcement_revision: oldOwnerView.room.announcement_revision,
      }),
      'PERMISSION_DENIED',
    );

    const audit = await callTool<AuditPageView>(targetConn.client, 'network_room_role_history', {
      room_id: roomId,
      limit: 50,
    });
    const acceptedAudits = audit.items.filter((item) => item.action === 'owner_transfer_accepted');
    check(
      'G05 审计记录新 owner 角色变更',
      acceptedAudits.some(
        (item) => item.target_actor_id === target.actor_id && item.new_role === 'owner',
      ),
      acceptedAudits,
    );
    check(
      'G05 审计记录原 owner 降为成员',
      acceptedAudits.some(
        (item) => item.target_actor_id === owner.actor_id && item.new_role === 'member',
      ),
      acceptedAudits,
    );
    check(
      'G05 接受审计由接任者写入',
      acceptedAudits.every((item) => item.changed_by === target.actor_id),
      acceptedAudits,
    );
    check(
      'G05 审计保留同一 request_id 与 transfer_id',
      acceptedAudits.length >= 2 &&
        acceptedAudits.every((item) => item.request_id === acceptRequestId) &&
        acceptedAudits.every((item) => item.detail.transfer_id === transfer.transfer_id),
      acceptedAudits,
    );
    check(
      'G05 审计记录提议动作',
      audit.items.some(
        (item) =>
          item.action === 'owner_transfer_proposed' &&
          item.target_actor_id === target.actor_id,
      ),
      audit.items.filter((item) => item.action.startsWith('owner_transfer')),
    );

    checkEqual(
      'G05 转让不推进房间 head_seq',
      (await readRoom(targetConn, roomId)).room.head_seq,
      headBefore,
    );
    checkEqual(
      'G05 转让通知不增加待办 pending_count',
      await pendingCount(targetConn),
      targetPendingBefore,
    );

    // ---------- G05-T02 并发与失效 ----------
    console.log('  G05-T02 接受/取消并发、移除接任者与版本冲突');

    // 接受与取消并发：只能一个成功，最终状态与胜者一致。
    const raceRoomId = await createGroup('G05 接受取消竞态');
    const raceBefore = await readRoom(ownerConn, raceRoomId);
    const raceProposal = await propose(
      ownerConn,
      raceRoomId,
      target.actor_id,
      memberOf(raceBefore, target.actor_id).role_revision,
    );
    const raceTransfer = raceProposal.owner_transfer;
    if (!raceTransfer) throw new Error('G05 竞态群没有返回提议');
    const [acceptOutcome, cancelOutcome] = await Promise.allSettled([
      respond(targetConn, raceTransfer.transfer_id, 'accept', 1),
      cancel(ownerConn, raceTransfer.transfer_id, 1),
    ]);
    const fulfilled = [acceptOutcome, cancelOutcome].filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    checkEqual('G05 接受与取消只有一个成功', fulfilled.length, 1);
    const rejected = [acceptOutcome, cancelOutcome].filter(
      (outcome) => outcome.status === 'rejected',
    );
    const loser = rejected[0];
    const loserIsLegal =
      loser?.status === 'rejected' &&
      loser.reason instanceof ToolError &&
      (loser.reason.code === 'CONFLICT' || loser.reason.code === 'NOT_OWNER');
    check('G05 并发失败方返回冲突或失去 owner 权限', rejected.length === 1 && loserIsLegal, rejected);
    const raceFinal = await readRoom(targetConn, raceRoomId);
    checkEqual('G05 竞态后不再有 pending 提议', raceFinal.owner_transfer, null);
    if (acceptOutcome.status === 'fulfilled') {
      checkEqual('G05 接受胜出时 owner 为接任者', raceFinal.room.owner_id, target.actor_id);
      checkEqual('G05 接受胜出时原 owner 为成员', memberOf(raceFinal, owner.actor_id).role, 'member');
    } else {
      checkEqual('G05 取消胜出时 owner 不变', raceFinal.room.owner_id, owner.actor_id);
      checkEqual('G05 取消胜出时目标仍是成员', memberOf(raceFinal, target.actor_id).role, 'member');
      checkEqual('G05 取消胜出时原 owner 仍是 owner', raceFinal.room.my_role, 'owner');
    }

    // 移除接任者：提议立即失效，接受失败，新提议不被残留行阻塞。
    const removalRoomId = await createGroup('G05 移除接任者');
    const removalBefore = await readRoom(ownerConn, removalRoomId);
    const removalProposal = await propose(
      ownerConn,
      removalRoomId,
      target.actor_id,
      memberOf(removalBefore, target.actor_id).role_revision,
    );
    const removalTransfer = removalProposal.owner_transfer;
    if (!removalTransfer) throw new Error('G05 移除场景没有返回提议');
    const removed = await callTool<GroupRoomView>(ownerConn.client, 'network_room_members_update', {
      request_id: newRequestId('g05_remove'),
      room_id: removalRoomId,
      remove: [target.actor_id],
    });
    checkEqual('G05 移除接任者后房间隐藏提议', removed.owner_transfer, null);
    await expectToolError(
      'G05 被移除的目标不能接受提议',
      respond(targetConn, removalTransfer.transfer_id, 'accept', 1),
      'CONFLICT',
    );
    const nextProposal = await propose(
      ownerConn,
      removalRoomId,
      rival.actor_id,
      memberOf(removed, rival.actor_id).role_revision,
    );
    checkEqual(
      'G05 失效提议不阻挡新提议',
      nextProposal.owner_transfer?.to_actor_id,
      rival.actor_id,
    );
    const nextTransfer = nextProposal.owner_transfer;
    if (!nextTransfer) throw new Error('G05 新提议没有返回');
    await expectToolError(
      'G05 非目标不能接受新提议',
      respond(targetConn, nextTransfer.transfer_id, 'accept', 1),
      'NOT_FOUND',
    );
    const nextAccepted = await respond(rivalConn, nextTransfer.transfer_id, 'accept', 1);
    checkEqual(
      'G05 移除后接受新提议完成换主',
      nextAccepted.room.owner_id,
      rival.actor_id,
    );
    checkEqual(
      'G05 新提议接受后原 owner 为成员',
      memberOf(nextAccepted, owner.actor_id).role,
      'member',
    );

    // 目标角色漂移、expected_version 过期与已取消提议。
    const driftRoomId = await createGroup('G05 角色漂移');
    const driftBefore = await readRoom(ownerConn, driftRoomId);
    const driftRevision = memberOf(driftBefore, target.actor_id).role_revision;
    const driftProposal = await propose(ownerConn, driftRoomId, target.actor_id, driftRevision);
    const driftTransfer = driftProposal.owner_transfer;
    if (!driftTransfer) throw new Error('G05 漂移场景没有返回提议');
    await callTool(ownerConn.client, 'network_room_role_set', {
      request_id: newRequestId('g05_drift_role'),
      room_id: driftRoomId,
      actor_id: target.actor_id,
      role: 'admin',
      expected_role_revision: driftRevision,
    });
    await expectToolError(
      'G05 目标角色漂移后接受失败',
      respond(targetConn, driftTransfer.transfer_id, 'accept', 1),
      'VERSION_CONFLICT',
    );
    await expectToolError(
      'G05 过期 expected_version 被拒绝',
      respond(targetConn, driftTransfer.transfer_id, 'reject', 99),
      'CONFLICT',
    );
    const cancelled = await cancel(ownerConn, driftTransfer.transfer_id, 1);
    checkEqual('G05 取消后房间隐藏提议', cancelled.owner_transfer, null);
    await expectToolError(
      'G05 已取消提议不能再接受',
      respond(targetConn, driftTransfer.transfer_id, 'accept', 2),
      'CONFLICT',
    );
    const driftAfter = await readRoom(ownerConn, driftRoomId);
    const reproposed = await propose(
      ownerConn,
      driftRoomId,
      target.actor_id,
      memberOf(driftAfter, target.actor_id).role_revision,
    );
    const reproposedTransfer = reproposed.owner_transfer;
    if (!reproposedTransfer) throw new Error('G05 重新提议没有返回');
    const reaccepted = await respond(targetConn, reproposedTransfer.transfer_id, 'accept', 1);
    checkEqual('G05 重新提议可正常接受', reaccepted.room.owner_id, target.actor_id);
    checkEqual('G05 新提议接受后原 owner 为成员', memberOf(reaccepted, owner.actor_id).role, 'member');
  } finally {
    if (ownerDeviceBListen) {
      await ownerDeviceBListen.close().catch(() => undefined);
    }
    await Promise.all(
      subscriptions.map((subscription) => subscription.close().catch(() => undefined)),
    );
    await Promise.all([
      ownerConn.close(),
      ownerDeviceB.close(),
      targetConn.close(),
      rivalConn.close(),
    ]);
  }
}
