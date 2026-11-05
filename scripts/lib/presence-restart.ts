/**
 * 上下线时间线的重启/崩溃恢复验收。
 *
 * 自托管独立 Bun 实例与临时 DATA_DIR：
 * 1. online 状态被 SIGKILL 后，启动扫描写 inferred 下线；
 * 2. 已持久化 pending 在正常 SIGTERM 后仍能恢复并写 observed 下线。
 */

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  openSubscription,
  rawRpc,
  sleep,
  waitUntil,
} from './harness';

const GRACE_MS = 1_200;

interface PresenceItem {
  transition?: string;
  occurred_at?: string;
  time_basis?: string;
  presence_event_id?: string;
}

interface TimelinePage {
  timeline_items?: (PresenceItem & { kind: string })[];
}

interface ServerProcess {
  kill(signal?: string | number): void;
  exited: Promise<number>;
}

async function rawTool<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  const result = response.body.result as
    | {
        isError?: boolean;
        structuredContent?: T;
        content?: { type: string; text?: string }[];
      }
    | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果: ${JSON.stringify(response.body)}`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) {
    let detail: { code?: string; message?: string } = {};
    if (text) {
      try {
        detail = JSON.parse(text) as { code?: string; message?: string };
      } catch {
        detail = { message: text };
      }
    }
    throw new Error(`${detail.code ?? 'UNKNOWN'}: ${detail.message ?? ''}`);
  }
  if (result.structuredContent) return result.structuredContent;
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function waitForHealth(base: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // 服务尚未监听
    }
    await sleep(100);
  }
  throw new Error(`重启验收实例未在 10s 内就绪: ${base}`);
}

async function startServer(dataDir: string): Promise<{
  base: string;
  proc: ServerProcess;
}> {
  const port = 18940 + Math.floor(Math.random() * 40);
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(['bun', resolve(import.meta.dir, '../../src/bun/main.ts')], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: base,
      AGENT_PRESENCE_GRACE_MS: String(GRACE_MS),
      AGENT_PRESENCE_ACTIVITY_TTL_MS: String(GRACE_MS),
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
      AGENT_PRESENCE_SWEEP_MS: '150',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  try {
    await waitForHealth(base);
  } catch (error) {
    proc.kill('SIGKILL');
    await proc.exited.catch(() => undefined);
    throw error;
  }
  return { base, proc: proc as unknown as ServerProcess };
}

async function stopServer(proc: ServerProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  proc.kill(signal);
  await proc.exited.catch(() => undefined);
}

async function timeline(token: string, roomId: string): Promise<{ presence: PresenceItem[] }> {
  const page = await rawTool<TimelinePage>(token, 'network_history_list', {
    room_id: roomId,
    view: 'timeline',
    limit: 100,
  });
  return {
    presence: (page.timeline_items ?? []).filter(
      (item) => item.kind === 'presence' && typeof item.occurred_at === 'string',
    ),
  };
}

export async function runPresenceRestartAcceptance(): Promise<void> {
  console.log('  上下线重启恢复');
  const previousBase = process.env.AGENTNET_URL;
  const dataDir = `/tmp/agentnet-presence-restart-${process.pid}-${Date.now()}`;
  let server: { base: string; proc: ServerProcess } | null = null;
  try {
    server = await startServer(dataDir);
    process.env.AGENTNET_URL = server.base;

    const humanToken = crypto.randomUUID();
    const human = await rawTool<{ actor_id: string }>(humanToken, 'network_register', {
      request_id: requestId('restart_human'),
      kind: 'human',
      name: 'Restart Human',
    });
    const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const agentIdentity = await rawTool<{ actor_id: string }>(agentToken, 'network_register', {
      request_id: requestId('restart_agent'),
      kind: 'agent',
      name: 'Restart Agent',
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const roomDetail = await rawTool<{ room: { room_id: string; head_seq: string } }>(
      humanToken,
      'network_room_create',
      {
        request_id: requestId('restart_room'),
        kind: 'direct',
        members: [agentIdentity.actor_id],
      },
    );

    await rawTool(humanToken, 'network_message_send', {
      request_id: requestId('restart_msg'),
      client_message_id: crypto.randomUUID(),
      room_id: roomDetail.room.room_id,
      body: 'restart fixture message',
    });
    const headBefore = (
      await rawTool<{ room: { head_seq: string } }>(humanToken, 'network_room_get', {
        room_id: roomDetail.room.room_id,
      })
    ).room.head_seq;

    const connection = await connectClient(agentToken);
    await openSubscription(connection.client, ['agentnet://stream']);
    await callTool(connection.client, 'network_login', {});
    await waitUntil(
      '重启前写入上线',
      async () => (await timeline(humanToken, roomDetail.room.room_id)).presence.some(
        (item) => item.transition === 'online',
      ),
      5_000,
    );
    await stopServer(server.proc, 'SIGKILL');
    void connection.close().catch(() => undefined);
    const restartAt = Date.now();
    server = await startServer(dataDir);
    process.env.AGENTNET_URL = server.base;

    await waitUntil(
      'SIGKILL 后写 inferred 下线',
      async () => (await timeline(humanToken, roomDetail.room.room_id)).presence.some(
        (item) => item.transition === 'offline' && item.time_basis === 'inferred',
      ),
      GRACE_MS + 6_000,
    );
    const crashed = await timeline(humanToken, roomDetail.room.room_id);
    const inferred = crashed.presence.find(
      (item) => item.transition === 'offline' && item.time_basis === 'inferred',
    );
    checkEqual('崩溃恢复写一条 inferred 下线', inferred?.time_basis, 'inferred');
    check(
      '崩溃恢复时间取最后活动 + TTL，不晚于重启观察 + TTL',
      Number(inferred?.occurred_at) <= restartAt + GRACE_MS + 1_000 &&
        Number(inferred?.occurred_at) >= restartAt - (GRACE_MS + 8_000),
      { occurred_at: inferred?.occurred_at, restartAt, ttl: GRACE_MS },
    );
    checkEqual(
      '崩溃恢复不伪造上线',
      crashed.presence.filter((item) => item.transition === 'online').length,
      1,
    );

    // pending 持久化：重连上线 -> 断开 -> 正常 SIGTERM（flush）-> 重启确认 observed 下线。
    const second = await connectClient(agentToken);
    await openSubscription(second.client, ['agentnet://stream']);
    await callTool(second.client, 'network_login', {});
    await waitUntil(
      'pending 场景重新上线',
      async () => (await timeline(humanToken, roomDetail.room.room_id)).presence.filter(
        (item) => item.transition === 'online',
      ).length === 2,
      5_000,
    );
    const closeAt = Date.now();
    await second.close();
    await sleep(300);
    await stopServer(server.proc, 'SIGTERM');
    server = await startServer(dataDir);
    process.env.AGENTNET_URL = server.base;

    await waitUntil(
      'pending 重启后确认 observed 下线',
      async () => (await timeline(humanToken, roomDetail.room.room_id)).presence.filter(
        (item) => item.transition === 'offline',
      ).length === 2,
      GRACE_MS + 6_000,
    );
    const pendingPage = await timeline(humanToken, roomDetail.room.room_id);
    const observed = pendingPage.presence
      .filter((item) => item.transition === 'offline')
      .sort((left, right) => Number(left.occurred_at) - Number(right.occurred_at))
      .at(-1);
    checkEqual('pending 重启后 basis 为 inferred', observed?.time_basis, 'inferred');
    check(
      'pending 重启后 occurred_at 为可用性过期点附近',
      Math.abs(Number(observed?.occurred_at) - closeAt) < GRACE_MS + 3_000,
      { occurred_at: observed?.occurred_at, closeAt, ttl: GRACE_MS },
    );

    const headAfter = (
      await rawTool<{ room: { head_seq: string } }>(humanToken, 'network_room_get', {
        room_id: roomDetail.room.room_id,
      })
    ).room.head_seq;
    checkEqual('重启恢复不改变房间 head', headAfter, headBefore);
    checkEqual(
      '重启恢复只产生上下线，不新增消息',
      (
        await rawTool<{ items: unknown[] }>(humanToken, 'network_history_list', {
          room_id: roomDetail.room.room_id,
          limit: 100,
        })
      ).items.length,
      1,
    );
  } finally {
    if (server) {
      server.proc.kill('SIGKILL');
      await server.proc.exited.catch(() => undefined);
    }
    await rm(dataDir, { recursive: true, force: true });
    if (previousBase === undefined) delete process.env.AGENTNET_URL;
    else process.env.AGENTNET_URL = previousBase;
  }

  console.log(`  重启恢复断言通过（累计 ${checksPassed()} 项）`);
}
