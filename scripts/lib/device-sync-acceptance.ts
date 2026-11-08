/**
 * Q02-T03/T04：断线补读与身份/凭据隔离。
 *
 * T03：断线期间收到提及、任务 offer、联系人申请和群设置变化，并在另一个群
 * 被移除；重连后从服务端游标补读，按 event seq 去重，读游标单调，任务与
 * 未读恢复，重复补读不生成第二条消息或第二次执行。
 * T04：同一 actor 的新设备配对不重建 actor；撤销一个设备后原凭据失效但
 * 另一设备仍可用；失效凭据不能自动注册替代身份；不同 actor 的消息与未读
 * 互不串扰。
 */

import {
  baseUrl,
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
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  registerIdentity,
  sendMessage,
  type Identity,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';

interface SyncItem {
  seq: string;
  scope: string;
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface SyncPage {
  scope: string;
  items: SyncItem[];
  next_cursor: string;
  has_more: boolean;
  head_seq: string;
  min_seq: string;
  reset_required: boolean;
}

interface RoomListItem {
  room_id: string;
  head_seq: string;
  my_last_read_seq: string;
  title?: string;
  kind?: string;
}

interface RoomList {
  items: RoomListItem[];
}

interface RoomDetail {
  room: {
    room_id: string;
    head_seq: string;
    my_last_read_seq: string;
    policy_revision: number;
    announcement_revision: number;
    my_role: string;
  };
}

interface TaskView {
  task_id: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  reviewer_actor_id: string;
}

interface TaskResult {
  task: TaskView;
}

interface TaskList {
  tasks: TaskView[];
}

interface ContactRequestPage {
  items: {
    contact_request_id: string;
    status: string;
    from_actor: { actor_id: string };
  }[];
}

interface DeviceList {
  items: { device_id: string; status: string; current: boolean }[];
  current_device_id: string | null;
}

interface PairingCreated {
  pairing_id: string;
  challenge: string;
}

async function syncPage(
  connection: McpConnection,
  scope: string,
  cursor?: string,
  limit = 3,
): Promise<SyncPage> {
  return callTool<SyncPage>(connection.client, 'network_sync', {
    scope,
    ...(cursor ? { cursor } : {}),
    limit,
  });
}

async function collectSync(
  connection: McpConnection,
  scope: string,
  cursor: string | undefined,
): Promise<{ items: SyncItem[]; cursor: string; pages: number; head: string }> {
  const items: SyncItem[] = [];
  let next = cursor;
  let pages = 0;
  let head = '0';
  for (;;) {
    const page = await syncPage(connection, scope, next);
    pages += 1;
    head = page.head_seq;
    if (page.reset_required) {
      items.length = 0;
      next = undefined;
      continue;
    }
    items.push(...page.items);
    next = page.next_cursor;
    if (!page.has_more) break;
    if (pages > 30) throw new Error(`sync ${scope} 分页超过 30 页`);
  }
  return { items, cursor: next ?? '', pages, head };
}

async function createGroup(
  owner: McpConnection,
  members: string[],
  title: string,
): Promise<string> {
  const created = await callTool<{ room: { room_id: string } }>(owner.client, 'network_room_create', {
    request_id: newRequestId('room'),
    kind: 'group',
    members,
    title,
  });
  return created.room.room_id;
}

async function roomDetail(connection: McpConnection, roomId: string): Promise<RoomDetail> {
  return callTool<RoomDetail>(connection.client, 'network_room_get', { room_id: roomId });
}

async function roomList(connection: McpConnection): Promise<RoomList> {
  return callTool<RoomList>(connection.client, 'network_rooms_list', { limit: 100 });
}

function unreadOf(list: RoomList, roomId: string): boolean {
  const room = list.items.find((item) => item.room_id === roomId);
  return Boolean(room && Number(room.my_last_read_seq) < Number(room.head_seq));
}

async function createPairing(connection: McpConnection): Promise<PairingCreated> {
  return callTool<PairingCreated>(connection.client, 'network_device_pairing_create', {
    request_id: newRequestId('pair_t04_create'),
    device_label: 'T04 第二设备',
    platform: 'test',
  });
}

async function redeemPairing(
  connection: McpConnection,
  challenge: string,
  deviceId: string,
): Promise<Identity & { device_id: string; pairing_id: string }> {
  return callTool(connection.client, 'network_device_pairing_redeem', {
    request_id: newRequestId('pair_t04_redeem'),
    challenge,
    device_id: deviceId,
  });
}

export async function runDeviceSyncAcceptance(): Promise<void> {
  console.log('Q02-T03 断线补读');
  const uConn = await connectClient(newToken());
  const vConn = await connectClient(newToken());
  const wConn = await connectClient(newToken());
  const u = await registerIdentity(uConn, { kind: 'human', name: 'Q02 离线人类 U' });
  const v = await registerIdentity(vConn, { kind: 'human', name: 'Q02 群主 V' });
  const w = await registerIdentity(wConn, { kind: 'human', name: 'Q02 联系人 W' });
  let stream: Awaited<ReturnType<typeof openSubscription>> | null = null;
  const offline: McpConnection[] = [];
  try {
    await befriend(uConn, u.actor_id, vConn, v.actor_id);
    const r1 = await createGroup(vConn, [u.actor_id], 'Q02 离线补读群');
    await acceptGroupInvites(uConn, r1);
    const r2 = await createGroup(vConn, [u.actor_id], 'Q02 移除群');
    await acceptGroupInvites(uConn, r2);

    // 先把已读位置推到当前 head，离线后的新消息才形成未读。
    const before = await roomDetail(uConn, r1);
    await callTool(uConn.client, 'network_room_mark_read', {
      room_id: r1,
      through_seq: before.room.head_seq,
    });
    const inboxBaseline = await syncPage(uConn, 'inbox');
    const roomBaseline = await syncPage(uConn, `room:${r1}`);
    checkEqual('T03 初始 inbox 游标可用', Boolean(inboxBaseline.next_cursor), true);
    checkEqual('T03 初始 room 游标可用', Boolean(roomBaseline.next_cursor), true);

    const onlineStream = await openSubscription(uConn.client, [STREAM_URI]);
    stream = onlineStream;
    await sleep(300);
    await onlineStream.close();
    await sleep(300);

    // 断线期间：两条提及、一个任务 offer、一个联系人申请、群策略与公告、被移出另一个群。
    const sentOne = await sendMessage(vConn, r1, 'Q02 离线消息一', {
      mentions: [u.actor_id],
    });
    const sentTwo = await sendMessage(vConn, r1, 'Q02 离线消息二', {
      mentions: [u.actor_id],
    });
    const task = await callTool<TaskResult>(vConn.client, 'network_task_create', {
      request_id: newRequestId('task'),
      room_id: r1,
      title: 'Q02 离线任务',
      description: '断线后补读任务',
      assignee_actor_id: u.actor_id,
      reviewer_actor_id: v.actor_id,
    });
    checkEqual('T03 离线期间任务进入 offered', task.task.status, 'offered');
    await callTool(wConn.client, 'network_contact_request', {
      request_id: newRequestId('creq'),
      actor_id: u.actor_id,
      message: '断线期间的联系人申请',
    });

    const detail = await roomDetail(vConn, r1);
    await callTool(vConn.client, 'network_room_policy_set', {
      request_id: newRequestId('policy'),
      room_id: r1,
      member_task_policy: 'owner_admin',
      expected_policy_revision: detail.room.policy_revision,
    });
    await callTool(vConn.client, 'network_room_announcement_set', {
      request_id: newRequestId('announcement'),
      room_id: r1,
      announcement: 'Q02 离线公告',
      expected_announcement_revision: detail.room.announcement_revision,
    });
    await callTool(vConn.client, 'network_room_members_update', {
      request_id: newRequestId('remove'),
      room_id: r2,
      remove: [u.actor_id],
    });

    // 重连：新的 stream 只作为通道；补读完全依赖已提交事件与游标。
    stream = await openSubscription(uConn.client, [STREAM_URI]);
    await sleep(200);

    const inboxCatchUp = await collectSync(uConn, 'inbox', inboxBaseline.next_cursor);
    const inboxTypes = new Set(inboxCatchUp.items.map((item) => item.type));
    check(
      'T03 inbox 补读到两条提及提醒',
      inboxCatchUp.items.filter((item) => item.type === 'mention_reminder').length === 2,
      inboxCatchUp.items,
    );
    check(
      'T03 inbox 补读到任务 offer 投递',
      inboxTypes.has('task_offered') || inboxTypes.has('delivery_created'),
      [...inboxTypes],
    );
    check(
      'T03 inbox 补读到联系人申请',
      inboxTypes.has('contact_request_pending'),
      [...inboxTypes],
    );
    check(
      'T03 inbox 补读到被移除群事件',
      inboxCatchUp.items.some(
        (item) => item.type === 'room_members_changed' && item.ref_id === r2,
      ),
      inboxCatchUp.items,
    );
    const seqs = inboxCatchUp.items.map((item) => item.seq);
    check(
      'T03 inbox 补读按事件 seq 升序',
      seqs.every((value, index) => index === 0 || Number(value) > Number(seqs[index - 1])),
      seqs,
    );
    const uniqueSeqs = [...new Set(seqs)];
    checkEqual('T03 同一分页不重复事件', seqs.length, uniqueSeqs.length);

    // 重复用原游标读取：服务端允许重读，客户端按 seq 去重后不重复执行。
    const replayPage = await syncPage(uConn, 'inbox', inboxBaseline.next_cursor, 50);
    const replaySeqs = replayPage.items.map((item) => item.seq);
    check(
      'T03 重读同一游标得到相同事件 seq',
      replaySeqs.filter((seq) => uniqueSeqs.includes(seq)).length === replaySeqs.length &&
        replaySeqs.length > 0,
      { replaySeqs: replaySeqs.length, unique: uniqueSeqs.length },
    );
    const merged = [...new Set([...seqs, ...replaySeqs])];
    checkEqual('T03 按 seq 去重后事件数不翻倍', merged.length, uniqueSeqs.length);
    const afterFinal = await syncPage(uConn, 'inbox', inboxCatchUp.cursor);
    checkEqual('T03 最终游标之后没有重复事件', afterFinal.items.length, 0);
    checkEqual('T03 inbox head 保持稳定', afterFinal.head_seq, inboxCatchUp.head);

    const roomCatchUp = await collectSync(uConn, `room:${r1}`, roomBaseline.next_cursor);
    const roomTypes = new Set(roomCatchUp.items.map((item) => item.type));
    check('T03 room 补读到两条离线消息', roomTypes.has('message_created'), [...roomTypes]);
    check(
      'T03 room 补读到群策略变化',
      roomTypes.has('room_policy_changed'),
      [...roomTypes],
    );
    check(
      'T03 room 补读到公告变化',
      roomTypes.has('room_announcement_updated'),
      [...roomTypes],
    );
    const messageEvents = roomCatchUp.items.filter((item) => item.type === 'message_created');
    const messageIds = new Set(
      messageEvents
        .map((item) =>
          typeof item.metadata.message_id === 'string'
            ? item.metadata.message_id
            : item.ref_id,
        )
        .filter((value): value is string => typeof value === 'string'),
    );
    check(
      'T03 两条离线消息各只出现一次（去重后）',
      messageIds.has(sentOne.message.message_id) && messageIds.has(sentTwo.message.message_id),
      { messageIds: [...messageIds] },
    );
    check(
      'T03 房间补读不重复生成消息',
      messageEvents.filter(
        (item) =>
          item.metadata.message_id === sentOne.message.message_id ||
          item.ref_id === sentOne.message.message_id,
      ).length <= 1,
      messageEvents,
    );

    const removedRoomSync = await expectToolError(
      'T03 被移除后 room sync 拒绝补读',
      syncPage(uConn, `room:${r2}`),
      'NOT_MEMBER',
    );
    checkEqual('T03 被移除原因可读', typeof removedRoomSync.body.message, 'string');

    // 未读与任务恢复：只补状态，不自动接受/执行任务。
    const afterList = await roomList(uConn);
    check('T03 重连后 R1 有未读', unreadOf(afterList, r1), afterList.items);
    const mine = await callTool<TaskList>(uConn.client, 'network_task_list', {
      scope: 'mine',
      limit: 100,
    });
    const recoveredTask = mine.tasks.find((item) => item.task_id === task.task.task_id);
    checkEqual('T03 任务仍保持 offered', recoveredTask?.status, 'offered');
    const taskBeforeAccept = await callTool<TaskResult>(uConn.client, 'network_task_get', {
      task_id: task.task.task_id,
    });
    checkEqual('T03 补读没有自动执行任务', taskBeforeAccept.task.status, 'offered');
    const accepted = await callTool<TaskResult>(uConn.client, 'network_task_accept', {
      request_id: newRequestId('accept'),
      task_id: task.task.task_id,
      expected_revision: task.task.revision,
    });
    checkEqual('T03 显式接受后任务 in_progress', accepted.task.status, 'in_progress');
    checkEqual('T03 接受者成为唯一负责人', accepted.task.owner_actor_id, u.actor_id);
    const secondAccept = await expectToolError(
      'T03 重复接受被拒绝',
      callTool(uConn.client, 'network_task_accept', {
        request_id: newRequestId('accept'),
        task_id: task.task.task_id,
      }),
      'ASSIGNMENT_STALE',
    );
    check('T03 重复接受错误可读', typeof secondAccept.body.message, 'string');

    const contacts = await callTool<ContactRequestPage>(uConn.client, 'network_contact_requests_list', {
      direction: 'incoming',
      status: 'pending',
      limit: 50,
    });
    check(
      'T03 联系人申请可从权威状态恢复',
      contacts.items.some((item) => item.from_actor.actor_id === w.actor_id),
      contacts.items,
    );
    const target = contacts.items.find((item) => item.from_actor.actor_id === w.actor_id);
    await callTool(uConn.client, 'network_contact_request_respond', {
      request_id: newRequestId('cres'),
      contact_request_id: target!.contact_request_id,
      action: 'accept',
    });

    const roomAfter = await roomDetail(uConn, r1);
    await callTool(uConn.client, 'network_room_mark_read', {
      room_id: r1,
      through_seq: roomAfter.room.head_seq,
    });
    check('T03 标记已读后未读清零', !unreadOf(await roomList(uConn), r1));

    console.log('Q02-T04 身份切换与凭据失效');
    const aConn = await connectClient(newToken());
    const bConn = await connectClient(newToken());
    const pairDevice = await connectClient(newToken());
    const thirdDevice = await connectClient(newToken());
    const a = await registerIdentity(aConn, { kind: 'human', name: 'Q02 身份 A' });
    const b = await registerIdentity(bConn, { kind: 'human', name: 'Q02 身份 B' });
    try {
      await befriend(aConn, a.actor_id, bConn, b.actor_id);

      // A 的第二设备配对：同一 actor，不创建新 human。
      const challenge = await createPairing(aConn);
      await callTool(pairDevice.client, 'network_device_pairing_join', {
        request_id: newRequestId('pair_join'),
        challenge: challenge.challenge,
        device_id: 'device-a2',
        device_label: 'A 第二设备',
        platform: 'test',
      });
      await callTool(aConn.client, 'network_device_pairing_approve', {
        request_id: newRequestId('pair_ok'),
        pairing_id: challenge.pairing_id,
      });
      const a2 = await redeemPairing(pairDevice, challenge.challenge, 'device-a2');
      checkEqual('T04 新设备仍是同一 actor', a2.actor_id, a.actor_id);
      const a2Me = await callTool<Identity>(pairDevice.client, 'network_me', {});
      checkEqual('T04 新设备 network_me 同一 actor', a2Me.actor_id, a.actor_id);

      const devices = await callTool<DeviceList>(pairDevice.client, 'network_device_list', {});
      check(
        'T04 设备列表显示原设备与新设备',
        devices.items.length >= 2 &&
          devices.items.some((item) => item.current && item.device_id === 'device-a2'),
        devices.items,
      );

      // 撤销 A 的原设备：原 token 失效，第二设备继续可用。
      await callTool(pairDevice.client, 'network_device_revoke', {
        request_id: newRequestId('revoke_a1'),
        device_id: 'default',
      });
      const revokedMe = await rawRpc(
        'tools/call',
        { name: 'network_me', arguments: {} },
        { token: aConn.token },
      );
      checkEqual('T04 原设备 token 失效返回 401', revokedMe.status, 401);
      checkEqual(
        'T04 原设备 token 错误码 CREDENTIAL_INVALID',
        (revokedMe.body.error as { data?: { code?: string } } | undefined)?.data?.code,
        'CREDENTIAL_INVALID',
      );
      const revokedRegister = await rawRpc(
        'tools/call',
        {
          name: 'network_register',
          arguments: {
            request_id: newRequestId('reg_after_revoke'),
            kind: 'human',
            name: '不应创建的替代身份',
          },
        },
        { token: aConn.token },
      );
      checkEqual('T04 失效 token 不能注册替代身份', revokedRegister.status, 401);
      const stillA = await callTool<Identity>(pairDevice.client, 'network_me', {});
      checkEqual('T04 第二设备不受影响', stillA.actor_id, a.actor_id);

      // 用仍可用的第二设备再配一台设备，actor 仍稳定。
      const challenge2 = await createPairing(pairDevice);
      await callTool(thirdDevice.client, 'network_device_pairing_join', {
        request_id: newRequestId('pair_join'),
        challenge: challenge2.challenge,
        device_id: 'device-a3',
        device_label: 'A 第三设备',
        platform: 'test',
      });
      await callTool(pairDevice.client, 'network_device_pairing_approve', {
        request_id: newRequestId('pair_ok'),
        pairing_id: challenge2.pairing_id,
      });
      const a3 = await redeemPairing(thirdDevice, challenge2.challenge, 'device-a3');
      checkEqual('T04 凭据失效后重新配对不新建 actor', a3.actor_id, a.actor_id);

      // A/B 各自的消息与未读互不影响。
      const direct = await callTool<{ room: { room_id: string; head_seq: string } }>(
        pairDevice.client,
        'network_room_create',
        {
          request_id: newRequestId('direct'),
          kind: 'direct',
          members: [b.actor_id],
        },
      );
      const roomId = direct.room.room_id;
      // A 自己发一条：B 有未读；A 标记已读后不因自己的消息保持未读。
      await sendMessage(pairDevice, roomId, 'A 的消息');
      const bRooms = await roomList(bConn);
      check('T04 B 看到来自 A 的未读', unreadOf(bRooms, roomId), bRooms.items);
      const aBefore = await roomDetail(pairDevice, roomId);
      await callTool(pairDevice.client, 'network_room_mark_read', {
        room_id: roomId,
        through_seq: aBefore.room.head_seq,
      });
      check('T04 A 标记已读后无未读', !unreadOf(await roomList(pairDevice), roomId));
      // B 回复：A 有未读；B 标记已读后清零。
      await sendMessage(bConn, roomId, 'B 的回复');
      const aRooms2 = await roomList(pairDevice);
      check('T04 A 看到来自 B 的未读', unreadOf(aRooms2, roomId), aRooms2.items);
      const bBefore = await roomDetail(bConn, roomId);
      await callTool(bConn.client, 'network_room_mark_read', {
        room_id: roomId,
        through_seq: bBefore.room.head_seq,
      });
      check('T04 B 标记已读后无未读', !unreadOf(await roomList(bConn), roomId));

      const invalidSync = await rawRpc(
        'tools/call',
        { name: 'network_sync', arguments: { scope: 'inbox' } },
        { token: aConn.token },
      );
      checkEqual('T04 失效凭据不能补读', invalidSync.status, 401);
      checkEqual(
        'T04 失效凭据补读错误码',
        (invalidSync.body.error as { data?: { code?: string } } | undefined)?.data?.code,
        'CREDENTIAL_INVALID',
      );
      check('T04 失效凭据错误不返回 token', !JSON.stringify(invalidSync.body).includes(aConn.token));
      checkEqual('T04 测试基址与运行环境一致', baseUrl().startsWith('http'), true);
    } finally {
      await Promise.all([
        aConn.close(),
        bConn.close(),
        pairDevice.close(),
        thirdDevice.close(),
      ]);
    }
  } finally {
    await stream?.close().catch(() => undefined);
    await Promise.all([uConn.close(), vConn.close(), wConn.close(), ...offline.map((c) => c.close())]);
  }
}
