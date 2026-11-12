import { startServer, rawTool } from '../verify-web';
import { roomStreamItems } from '../../src/realtime/stream';
import { Database } from 'bun:sqlite';

const server = await startServer();
process.env.AGENTNET_URL = server.base;
const id = () => crypto.randomUUID();
const call = (token: string, name: string, args: Record<string, unknown> = {}) => rawTool<any>(token, name, args);
const ok = (condition: unknown, label: string) => { if (!condition) throw new Error(`失败：${label}`); console.log(`通过：${label}`); };
const fails = async (promise: Promise<unknown>, code: string, label: string) => {
  try { await promise; } catch (error) { ok(String(error).includes(code), label); return; }
  throw new Error(`失败：${label}（未拒绝）`);
};
try {
  const makeHuman = async (name: string) => {
    const token = `recall_${id().replaceAll('-', '')}`;
    const actor = await call(token, 'network_register', { request_id: id(), kind: 'human', name });
    return { token, ...actor };
  };
  const alice = await makeHuman('撤回测试甲');
  const bob = await makeHuman('撤回测试乙');
  const outsider = await makeHuman('撤回测试丙');
  for (const [a, b] of [[alice, bob], [alice, outsider], [bob, outsider]]) {
    const request = await call(a.token, 'network_contact_request', { request_id: id(), actor_id: b.actor_id });
    if (request.request) await call(b.token, 'network_contact_request_respond', { request_id: id(), contact_request_id: request.request.contact_request_id, action: 'accept' });
  }
  const detail = await call(alice.token, 'network_room_create', { request_id: id(), kind: 'group', title: '撤回测试群', members: [bob.actor_id] });
  for (const invitation of detail.invited ?? []) await call(bob.token, 'network_room_invite_respond', { request_id: id(), invitation_id: invitation.invitation_id, action: 'accept' });
  const roomId = detail.room.room_id;
  // 新建群默认 full；本用例验证重入后看不到旧消息，先显式收紧。
  await call(alice.token, 'network_room_policy_set', { request_id: id(), room_id: roomId, member_history_policy: 'from_join', expected_policy_revision: detail.room.policy_revision ?? 1 });
  const sendRequest = id();
  const clientMessageId = id();
  const message = await call(alice.token, 'network_message_send', { request_id: sendRequest, client_message_id: clientMessageId, room_id: roomId, body: '撤回前的私密内容', invoke: [] });
  const msgId = message.message.message_id;
  await fails(call(bob.token, 'network_message_recall', { request_id: id(), message_id: msgId }), 'PERMISSION_DENIED', '他人不能撤回消息');
  await fails(call(outsider.token, 'network_message_recall', { request_id: id(), message_id: msgId }), 'NOT_MEMBER', '非成员不能撤回消息');
  const recallRequest = id();
  const recalled = await call(alice.token, 'network_message_recall', { request_id: recallRequest, message_id: msgId });
  ok(recalled.recalled === true, '本人撤回普通消息');
  const replayed = await call(alice.token, 'network_message_recall', { request_id: recallRequest, message_id: msgId });
  ok(replayed.message_id === msgId, '同 request_id 撤回请求重放');
  const repeated = await call(alice.token, 'network_message_recall', { request_id: id(), message_id: msgId });
  ok(repeated.message_id === msgId, '重复撤回幂等');
  const history = await call(bob.token, 'network_history_list', { room_id: roomId });
  const preview = history.items.find((item: any) => item.message_id === msgId);
  ok(preview?.preview === '此消息已撤回' && preview.body_bytes === 0, '历史只返回撤回墓碑');
  const body = await call(bob.token, 'network_message_read', { message_id: msgId });
  ok(body.chunk === '' && body.body_bytes === 0, '正文读取为空');
  const status = await call(alice.token, 'network_message_send_status', { client_message_ids: [clientMessageId] });
  ok(status.items?.[0]?.found === true && status.items[0].message_id === msgId && status.items[0].recalled === true, '发送响应丢失对账仍可定位撤回消息');
  const sendReplay = await call(alice.token, 'network_message_send', { request_id: sendRequest, client_message_id: clientMessageId, room_id: roomId, body: '撤回前的私密内容', invoke: [] });
  ok(sendReplay.message.message_id === msgId && sendReplay.message.body_bytes === 0, '原发送 request_id 重放不恢复正文');
  const clientReplay = await call(alice.token, 'network_message_send', { request_id: id(), client_message_id: clientMessageId, room_id: roomId, body: '撤回前的私密内容', invoke: [] });
  ok(clientReplay.message.message_id === msgId, '原 client_message_id 与原文重放幂等');
  await fails(call(alice.token, 'network_message_send', { request_id: id(), client_message_id: clientMessageId, room_id: roomId, body: '改写正文', invoke: [] }), 'IDEMPOTENCY_CONFLICT', '撤回后仍拒绝 client_message_id 改写正文');
  const mapped = roomStreamItems({ outbox_id: 'o', topic: `room:${roomId}`, event_seq: 99, attempts: 0, created_at: 1,
    scope_kind: 'room', scope_id: roomId, event_type: 'message_recalled', ref_id: msgId,
    metadata: JSON.stringify({ room_id: roomId, message_id: msgId, sender_id: alice.actor_id }) },
    { room_id: roomId, message_id: msgId, sender_id: alice.actor_id }, [
      { actor_id: alice.actor_id, kind: 'human', status: 'active', role: 'owner', joined_seq: 1 },
      { actor_id: bob.actor_id, kind: 'human', status: 'active', role: 'member', joined_seq: 1 },
    ]);
  ok(mapped.length === 2 && mapped.every(({ item }) => item.source === 'room.message' && item.kind === 'message' && item.change === 'recalled' && item.attention === 'informational' && item.message_id === msgId), 'stream 以 recalled 变更通知成员（含发送者）');
  const synced = await call(bob.token, 'network_sync', { scope: `room:${roomId}` });
  ok(synced.items.some((item: any) => item.type === 'message_recalled' && item.ref_id === msgId), 'room sync 可补读撤回事件');
  await fails(call(alice.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: roomId, body: '回复撤回消息', reply_to: msgId, invoke: [] }), 'INVALID_ARGUMENT', '撤回消息不可作为回复目标');
  await fails(call(alice.token, 'network_message_recall', { request_id: id(), message_id: 'missing-message' }), 'NOT_FOUND', '未知消息返回 NOT_FOUND');
  const oldMessage = await call(alice.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: roomId, body: '超时消息', invoke: [] });
  const localDb = new Database(`${server.dataDir}/agent-network.sqlite`);
  localDb.exec('PRAGMA busy_timeout = 5000');
  localDb.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?').run(Date.now() - 121_000, oldMessage.message.message_id);
  localDb.close();
  await fails(call(alice.token, 'network_message_recall', { request_id: id(), message_id: oldMessage.message.message_id }), 'CONFLICT', '超过两分钟拒绝撤回');
  const beforeLeave = await call(bob.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: roomId, body: '退群前消息', invoke: [] });
  await call(bob.token, 'network_room_leave', { request_id: id(), room_id: roomId });
  const reinvited = await call(alice.token, 'network_room_members_update', { request_id: id(), room_id: roomId, add: [bob.actor_id] });
  for (const invitation of reinvited.invited ?? []) await call(bob.token, 'network_room_invite_respond', { request_id: id(), invitation_id: invitation.invitation_id, action: 'accept' });
  await fails(call(bob.token, 'network_message_recall', { request_id: id(), message_id: beforeLeave.message.message_id }), 'NOT_FOUND', '退群再加入后不可撤回加入前旧消息');
  const bobMessage = await call(bob.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: roomId, body: '策略后不可撤回', invoke: [] });
  const roomInfo = await call(alice.token, 'network_room_get', { room_id: roomId });
  const revision = roomInfo.room?.policy_revision ?? roomInfo.policy_revision;
  await call(alice.token, 'network_room_policy_set', { request_id: id(), room_id: roomId, member_message_policy: 'owner_admin', expected_policy_revision: revision });
  await fails(call(bob.token, 'network_message_recall', { request_id: id(), message_id: bobMessage.message.message_id }), 'PERMISSION_DENIED', '失去群发言权限后不能撤回');

  const raced = await call(alice.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: roomId, body: '并发撤回', invoke: [] });
  const concurrent = await Promise.all([
    call(alice.token, 'network_message_recall', { request_id: id(), message_id: raced.message.message_id }),
    call(alice.token, 'network_message_recall', { request_id: id(), message_id: raced.message.message_id }),
  ]);
  ok(concurrent.every((item) => item.recalled), '不同 request_id 并发撤回收敛');
  await fails(call(alice.token, 'network_message_recall', { request_id: recallRequest, message_id: raced.message.message_id }), 'IDEMPOTENCY_CONFLICT', '撤回 request_id 不能复用于其他消息');

  const agentCreate = await call(alice.token, 'network_agent_create', { request_id: id(), name: '撤回测试Agent' });
  const agentToken = agentCreate.token;
  const agentId = agentCreate.actor?.actor_id ?? agentCreate.actor_id;
  await call(alice.token, 'network_contact_add', { request_id: id(), actor_id: agentId });
  const agentRoom = await call(alice.token, 'network_room_create', { request_id: id(), kind: 'direct', members: [agentId] });
  const agentRoomId = agentRoom.room.room_id;
  const taskSource = await call(alice.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: roomId, body: '来源任务消息', invoke: [] });
  await call(alice.token, 'network_task_mark', { request_id: id(), room_id: roomId, message_id: taskSource.message.message_id });
  const recalledMarked = await call(alice.token, 'network_message_recall', { request_id: id(), message_id: taskSource.message.message_id });
  ok(recalledMarked.recalled, '已标记消息可以撤回');
  const delivered = await call(alice.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: agentRoomId, body: '投递消息', invoke: [agentId] });
  await fails(call(alice.token, 'network_message_recall', { request_id: id(), message_id: delivered.message.message_id }), 'CONFLICT', '含 delivery 消息拒绝撤回');
  const agentMessage = await call(agentToken, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: agentRoomId, body: 'Agent 普通消息', invoke: [] });
  await fails(call(agentToken, 'network_message_recall', { request_id: id(), message_id: agentMessage.message.message_id }), 'PERMISSION_DENIED', '非 human principal 不能撤回');
  await call(alice.token, 'network_room_dissolve', { request_id: id(), room_id: roomId });
  await fails(call(alice.token, 'network_message_recall', { request_id: id(), message_id: taskSource.message.message_id }), 'CONFLICT', '解散房间不可撤回');
  console.log('撤回回归通过');
} finally { await server.stop(); }
