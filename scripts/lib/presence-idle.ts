/**
 * 空闲页面 presence 通知回归。
 *
 * 人类建立统一 stream 后不再发起任何工具调用；关闭 Agent 的最后一条连接，
 * 断言 sweep 确认下线后立即 drain outbox，人类在预算内收到 room.presence。
 * 修复前只有 60 秒定时 drain，该断言会超时失败。
 */

import { rm } from 'node:fs/promises';
import { Database } from 'bun:sqlite';

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  sleep,
  type McpConnection,
} from './harness';
import { befriend, registerIdentity } from './acceptance-helpers';
import { startTestServer } from './test-server';

const STREAM_URI = 'agentnet://stream';
const STREAM_META = 'io.agent-network/event';
const GRACE_MS = 1_200;
const NOTIFY_BUDGET_MS = 10_000;

interface StreamItemView {
  source?: string;
  kind?: string;
  room_id?: string;
  transition?: string;
}

interface ServerProcess {
  kill(signal?: string | number): void;
  exited: Promise<number>;
}

function streamItemsOf(event: { params: Record<string, unknown> }): StreamItemView[] {
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_META] as { items?: StreamItemView[] } | undefined;
  return payload?.items ?? [];
}

/**
 * 等请求触碰产生的在线状态自然过期。
 *
 * A03 的建联会让 Agent 在房间出现前先被记为 online；先等回 offline，才能让
 * 后续 login 产生本房间的上线事件与 room.presence 通知。
 */
async function waitAgentOffline(dataDir: string, agentId: string): Promise<void> {
  const db = new Database(`${dataDir}/agent-network.sqlite`, { readonly: true });
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = db
        .prepare('SELECT phase FROM agent_presence_state WHERE actor_id = ?')
        .get(agentId) as { phase?: string } | null;
      if (row?.phase === 'offline') return;
      if (Date.now() > deadline) {
        throw new Error(`等待 Agent 离线超时: ${JSON.stringify(row)}`);
      }
      await sleep(100);
    }
  } finally {
    db.close();
  }
}

async function startServer(dataDir: string): Promise<{ base: string; proc: ServerProcess }> {
  const server = await startTestServer({
    dataDir,
    tag: 'presence-idle',
    env: {
      PUBLIC_ORIGIN: undefined,
      AGENT_PRESENCE_GRACE_MS: String(GRACE_MS),
      AGENT_PRESENCE_ACTIVITY_TTL_MS: String(GRACE_MS),
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
      AGENT_PRESENCE_SWEEP_MS: '150',
    },
  });
  return { base: server.base, proc: server.proc };
}

export async function runPresenceIdleNotificationCheck(): Promise<void> {
  console.log('  空闲页面上下线通知');
  const previousBase = process.env.AGENTNET_URL;
  const dataDir = `/tmp/agentnet-presence-idle-${process.pid}-${Date.now()}`;
  let server: { base: string; proc: ServerProcess } | null = null;
  let human: McpConnection | null = null;
  let agent: McpConnection | null = null;
  try {
    server = await startServer(dataDir);
    process.env.AGENTNET_URL = server.base;

    human = await connectClient(newToken());
    const humanIdentity = await registerIdentity(human, { kind: 'human', name: 'Idle Presence Human' });
    const created = await callTool<{ actor_id: string; token: string }>(
      human.client,
      'network_agent_create',
      { request_id: newRequestId('idle_agent'), name: 'Idle Presence Agent' },
    );
    agent = await connectClient(created.token);
    const agentIdentity = { actor_id: created.actor_id };
    await befriend(human, humanIdentity.actor_id, agent, agentIdentity.actor_id);
    await waitAgentOffline(dataDir, agentIdentity.actor_id);
    const detail = await callTool<{ room: { room_id: string } }>(
      human.client,
      'network_room_create',
      {
        request_id: newRequestId('idle_room'),
        kind: 'direct',
        members: [agentIdentity.actor_id],
      },
    );
    const roomId = detail.room.room_id;

    const collector = notificationCollector(human.client);
    const humanSubscription = await openSubscription(human.client, [STREAM_URI]);
    const agentSubscription = await openSubscription(agent.client, [STREAM_URI]);
    try {
      await callTool(agent.client, 'network_login', {});
      await collector.waitFor(
        (event) =>
          streamItemsOf(event).some(
            (item) =>
              item.source === 'room.presence' &&
              item.transition === 'online' &&
              item.room_id === roomId,
          ),
        '空闲页面收到上线通知',
        10_000,
      );
      collector.reset();

      // 从这里开始不再调用任何工具，只等待人类 SSE。
      const closeAt = Date.now();
      await agentSubscription.close();
      const offline = await collector.waitFor(
        (event) =>
          streamItemsOf(event).some(
            (item) =>
              item.source === 'room.presence' &&
              item.transition === 'offline' &&
              item.room_id === roomId,
          ),
        '空闲页面等待下线通知',
        NOTIFY_BUDGET_MS,
      );
      const elapsed = Date.now() - closeAt;
      const offlineItem = streamItemsOf(offline).find(
        (item) =>
          item.source === 'room.presence' &&
          item.transition === 'offline' &&
          item.room_id === roomId,
      ) as StreamItemView;
      check('空闲页面在预算内收到下线通知', elapsed < NOTIFY_BUDGET_MS, {
        elapsed,
        budget: NOTIFY_BUDGET_MS,
      });
      checkEqual('空闲下线通知 kind', offlineItem.kind, 'presence');
      checkEqual('空闲下线通知 transition', offlineItem.transition, 'offline');
      console.log(`  · 空闲下线通知延迟 ${elapsed}ms（无任何工具调用）`);
    } finally {
      await agentSubscription.close().catch(() => undefined);
      await humanSubscription.close().catch(() => undefined);
    }
  } finally {
    await human?.close().catch(() => undefined);
    await agent?.close().catch(() => undefined);
    if (server) {
      server.proc.kill('SIGKILL');
      await server.proc.exited.catch(() => undefined);
    }
    await rm(dataDir, { recursive: true, force: true });
    if (previousBase === undefined) delete process.env.AGENTNET_URL;
    else process.env.AGENTNET_URL = previousBase;
  }
}
