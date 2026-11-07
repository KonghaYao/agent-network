/**
 * 网页监控面板端到端验收：同一 human 跨设备持久化、成员隔离与清除同步。
 *
 * 创建独立 fixture，不复用 acceptance 主流程的房间；只通过公开工具调用，
 * 因此本地与远端部署都能运行。
 */

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
import { befriend, registerIdentity, type RoomDetail } from './acceptance-helpers';

interface MonitorResult {
  monitor: { room_id: string; url: string; updated_at: string } | null;
}

export async function runRoomMonitorAcceptance(): Promise<void> {
  console.log('· 网页监控面板');
  const aToken = newToken();
  const bToken = newToken();
  const agentToken = newToken();
  let aDevice1: McpConnection | null = await connectClient(aToken);
  const bConnection = await connectClient(bToken);
  const agentConnection = await connectClient(agentToken);
  let aDevice2: McpConnection | null = null;

  try {
    const humanA = await registerIdentity(aDevice1, { kind: 'human', name: '监控验收人类 A' });
    const humanB = await registerIdentity(bConnection, { kind: 'human', name: '监控验收人类 B' });
    const agent = await registerIdentity(agentConnection, {
      kind: 'agent',
      name: '监控验收 Agent',
      sessionId: `sess_${crypto.randomUUID()}`,
    });
    check('监控验收身份注册成功', Boolean(humanA.actor_id && humanB.actor_id && agent.actor_id));
    const device1 = aDevice1;

    await befriend(device1, humanA.actor_id, bConnection, humanB.actor_id);
    await befriend(device1, humanA.actor_id, agentConnection, agent.actor_id);
    const group = await callTool<RoomDetail>(device1.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      title: '网页监控验收群',
      members: [humanB.actor_id, agent.actor_id],
    });
    const roomId = group.room.room_id;
    const headBefore = group.room.head_seq;

    const initial = await callTool<MonitorResult>(device1.client, 'network_room_monitor_get', {
      room_id: roomId,
    });
    checkEqual('监控验收初始无配置', initial.monitor, null);

    const url = 'https://monitor.example/panel?token=acceptance-value';
    const setResult = await callTool<MonitorResult>(device1.client, 'network_room_monitor_set', {
      request_id: newRequestId('monitor'),
      room_id: roomId,
      url,
    });
    checkEqual('设备 1 保存 URL', setResult.monitor?.url, url);

    // 同一 token 的新连接代表另一台设备，而不是新 actor。
    await aDevice1.close();
    aDevice1 = null;
    aDevice2 = await connectClient(aToken);
    const fromDevice2 = await callTool<MonitorResult>(aDevice2.client, 'network_room_monitor_get', {
      room_id: roomId,
    });
    checkEqual('设备 2 用同一 token 读回同一 URL', fromDevice2.monitor?.url, url);

    const bView = await callTool<MonitorResult>(bConnection.client, 'network_room_monitor_get', {
      room_id: roomId,
    });
    checkEqual('同房间成员 B 看不到 A 的 URL', bView.monitor, null);
    const bSet = await callTool<MonitorResult>(bConnection.client, 'network_room_monitor_set', {
      request_id: newRequestId('monitor'),
      room_id: roomId,
      url: 'https://b-monitor.example/',
    });
    checkEqual('成员 B 保存自己的 URL', bSet.monitor?.url, 'https://b-monitor.example/');
    const aStillOwn = await callTool<MonitorResult>(aDevice2.client, 'network_room_monitor_get', {
      room_id: roomId,
    });
    checkEqual('成员 B 的写入不覆盖 A', aStillOwn.monitor?.url, url);

    await expectToolError(
      'Agent 读取监控配置返回 INVALID_ARGUMENT',
      callTool(agentConnection.client, 'network_room_monitor_get', { room_id: roomId }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'Agent 写入监控配置返回 INVALID_ARGUMENT',
      callTool(agentConnection.client, 'network_room_monitor_set', {
        request_id: newRequestId('monitor'),
        room_id: roomId,
        url: 'https://agent-monitor.example/',
      }),
      'INVALID_ARGUMENT',
    );

    const clear = await callTool<MonitorResult>(aDevice2.client, 'network_room_monitor_set', {
      request_id: newRequestId('monitor'),
      room_id: roomId,
      url: null,
    });
    checkEqual('设备 2 清除配置', clear.monitor, null);
    const afterClear = await callTool<MonitorResult>(aDevice2.client, 'network_room_monitor_get', {
      room_id: roomId,
    });
    checkEqual('清除后设备 2 读到 null', afterClear.monitor, null);
    const bAfterAClear = await callTool<MonitorResult>(bConnection.client, 'network_room_monitor_get', {
      room_id: roomId,
    });
    checkEqual('A 的清除不影响 B 自己的配置', bAfterAClear.monitor?.url, 'https://b-monitor.example/');

    const roomAfter = await callTool<RoomDetail>(aDevice2.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual('监控配置不改变房间 head_seq', roomAfter.room.head_seq, headBefore);

    const meAfter = await callTool<{ pending_count: number }>(aDevice2.client, 'network_me');
    check('监控配置不产生 pending', meAfter.pending_count === 0, meAfter.pending_count);
  } finally {
    await Promise.all([
      aDevice1 ? aDevice1.close() : Promise.resolve(),
      aDevice2 ? aDevice2.close() : Promise.resolve(),
      bConnection.close(),
      agentConnection.close(),
    ]);
  }
}
