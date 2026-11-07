/**
 * DSH watcher 离线验收：本地 mock MCP/SSE，不访问生产。
 *
 * 覆盖：bash -n、wake.queue 字段与过滤、catchup、EOF/truncate、
 * start/stop/status、CREDENTIAL_INVALID 立即退出、token 不落盘。
 *
 * 运行：bun run test:dsh-watch
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = process.cwd();
const SCRIPT = resolve(REPO, 'public/skills/dsh-watch.sh');
const STREAM_URI = 'agentnet://stream';

let checks = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (!ok) {
    console.error(`✗ ${name}`);
    if (detail !== undefined) console.error(detail);
    throw new Error(name);
  }
  console.log(`✓ ${name}`);
}

function envFor(
  home: string,
  baseUrl: string,
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    WEBBOTS_HOME: home,
    AGENTNET_URL: baseUrl,
    AGENTNET_TOKEN: token,
    ...extra,
  };
}

// 用 PATH 里的 date 垫片注入 catchup 的秒级时钟；now_iso 等其它日期调用透传。
function createClockShim(home: string, initialEpoch: number): {
  clockFile: string;
  env: Record<string, string>;
} {
  const clockFile = join(home, 'test-clock');
  const binDir = join(home, 'test-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(clockFile, String(initialEpoch));
  writeFileSync(
    join(binDir, 'date'),
    `#!/bin/bash
if [ "$#" -eq 1 ] && [ "$1" = "+%s" ]; then
  if [ -n "\${DSH_TEST_EPOCH_FILE:-}" ] && [ -f "\$DSH_TEST_EPOCH_FILE" ]; then
    cat "\$DSH_TEST_EPOCH_FILE"
    exit 0
  fi
fi
exec /bin/date "\$@"
`,
    { mode: 0o755 },
  );
  return {
    clockFile,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      DSH_TEST_EPOCH_FILE: clockFile,
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

interface WakeEvent {
  source?: string;
  attention?: string;
  room_id?: string | null;
  message_id?: string | null;
  delivery_id?: string | null;
  sender_id?: string | null;
  seq?: string;
  event_id?: string;
  at?: string;
  [key: string]: unknown;
}

function queueEvents(home: string): WakeEvent[] {
  const file = join(home, 'wake.queue');
  if (!existsSync(file)) return [];
  const events: WakeEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as WakeEvent);
    } catch {
      // 半行：消费者应忽略，测试也忽略。
    }
  }
  return events;
}

function readStatus(home: string): Record<string, unknown> {
  const file = join(home, 'status.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface MockServer {
  baseUrl: string;
  send(items: Array<Record<string, unknown>>, options?: { more?: boolean; dropped?: number }): void;
  waitForStream(timeoutMs?: number): Promise<void>;
  stop(): void;
  roomGetCalls: Map<string, number>;
}

function identity(pending: number) {
  return {
    actor_id: 'agt_me',
    kind: 'agent',
    agent_session_id: 'sess_dsh_test',
    name: 'DSH Test Agent',
    metadata: {},
    pending_count: pending,
    inbox_head_seq: '900',
    created_at: '2026-11-01T00:00:00Z',
    share_url: null,
    resources: [STREAM_URI],
  };
}

async function createMock(options: {
  token: string;
  pending: number;
  credentialInvalid?: boolean;
}): Promise<MockServer> {
  const roomGetCalls = new Map<string, number>();
  const roomKinds = new Map<string, string>([
    ['rm_direct', 'direct'],
    ['rm_group', 'group'],
  ]);
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const waiters: Array<() => void> = [];
  const encoder = new TextEncoder();
  let streamCount = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') {
        return new Response('not found', { status: 404 });
      }
      if (request.headers.get('authorization') !== `Bearer ${options.token}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const body = (await request.json()) as {
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };

      if (body.method === 'server/discover') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: {} },
        });
      }

      if (body.method === 'tools/call') {
        const name = body.params?.name ?? '';
        if (options.credentialInvalid && name === 'network_me') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              isError: true,
              content: [{
                type: 'text',
                text: JSON.stringify({
                  code: 'CREDENTIAL_INVALID',
                  message: 'credential revoked',
                }),
              }],
            },
          });
        }
        if (name === 'network_me') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(identity(0)) }],
              structuredContent: identity(0),
            },
          });
        }
        if (name === 'network_login') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(identity(options.pending)) }],
              structuredContent: identity(options.pending),
            },
          });
        }
        if (name === 'network_room_get') {
          const roomId = String(body.params?.arguments?.room_id ?? '');
          roomGetCalls.set(roomId, (roomGetCalls.get(roomId) ?? 0) + 1);
          const kind = roomKinds.get(roomId) ?? 'group';
          const data = {
            room: {
              room_id: roomId,
              kind,
              title: kind === 'group' ? 'Group' : null,
              owner_actor_id: 'agt_owner',
              head_seq: '1',
              members: [],
            },
          };
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(data) }],
              structuredContent: data,
            },
          });
        }
        if (name === 'network_inbox_list') {
          const data = { items: [], claimed_delivery_id: null };
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(data) }],
              structuredContent: data,
            },
          });
        }
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: `unexpected tool ${name}` },
        });
      }

      if (body.method === 'subscriptions/listen') {
        streamCount += 1;
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            controllers.add(controller);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                params: { subscriptions: [{ uri: STREAM_URI }] },
              })}\n\n`),
            );
            for (const notify of waiters.splice(0)) notify();
          },
          cancel() {
            if (controllerRef) controllers.delete(controllerRef);
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          },
        });
      }

      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'method not found' },
      });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    roomGetCalls,
    send(items, sendOptions = {}) {
      const attention = items.some((item) => item.attention === 'action_required')
        ? 'action_required'
        : 'informational';
      const payload = {
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: {
          uri: STREAM_URI,
          _meta: {
            'io.agent-network/event': {
              v: 1,
              actor_id: 'agt_me',
              seq: String(1000 + streamCount),
              attention,
              items,
              more: sendOptions.more ?? false,
              dropped: sendOptions.dropped ?? 0,
            },
          },
        },
      };
      const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
      for (const controller of controllers) controller.enqueue(frame);
    },
    async waitForStream(timeoutMs = 10_000) {
      if (streamCount > 0) return;
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('timeout waiting for SSE stream')), timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    },
    stop() {
      server.stop(true);
    },
  };
}

const waitItem = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'task',
  attention: 'informational',
  ...overrides,
});

async function main(): Promise<void> {
  const syntax = Bun.spawnSync({
    cmd: ['bash', '-n', SCRIPT],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check('dsh-watch.sh 通过 bash -n', syntax.exitCode === 0, syntax.stderr.toString());

  const home = mkdtempSync(join(tmpdir(), 'dsh-watch-test-'));
  const token = crypto.randomUUID();
  const mock = await createMock({ token, pending: 2 });
  const clock = createClockShim(home, 1_800_000_000);
  const child = Bun.spawn(['bash', SCRIPT, 'run'], {
    env: envFor(home, mock.baseUrl, token, clock.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();

  try {
    await mock.waitForStream(15_000);
    await waitFor(
      () => queueEvents(home).some((event) => event.source === 'catchup'),
      15_000,
      'catchup event',
    );

    // 同一 pending/head 快照下，login 的 catchup 之后再来 truncated 帧不重复写。
    mock.send([], { more: true });

    const events: Array<Record<string, unknown>> = [
      waitItem({
        source: 'delivery.created',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_1',
        delivery_id: 'dlv_1',
        sender_id: 'agt_bob',
        seq: '101',
        event_id: '101',
      }),
      waitItem({
        source: 'room.message',
        room_id: 'rm_direct',
        message_id: 'msg_2',
        sender_id: 'agt_bob',
        seq: '102',
        event_id: '102',
      }),
      waitItem({
        source: 'room.message',
        room_id: 'rm_group',
        message_id: 'msg_3',
        sender_id: 'agt_bob',
        seq: '103',
        event_id: '103',
      }),
      waitItem({
        source: 'room.message',
        room_id: 'rm_direct',
        message_id: 'msg_4',
        sender_id: 'agt_me',
        seq: '104',
        event_id: '104',
      }),
      waitItem({
        source: 'delivery.updated',
        attention: 'action_required',
        room_id: 'rm_direct',
        delivery_id: 'dlv_2',
        sender_id: 'agt_me',
        seq: '105',
        event_id: '105',
      }),
      waitItem({
        source: 'session.login',
        attention: 'action_required',
        seq: '106',
        event_id: '106',
      }),
      waitItem({
        source: 'delivery.reminder',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_5',
        delivery_id: 'dlv_3',
        sender_id: 'agt_bob',
        seq: '107',
        event_id: '107',
      }),
      waitItem({
        source: 'room.membership',
        attention: 'action_required',
        room_id: 'rm_group',
        seq: '108',
        event_id: '108',
      }),
      waitItem({
        source: 'delivery.created',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_sentinel',
        delivery_id: 'dlv_sentinel',
        sender_id: 'agt_bob',
        seq: '109',
        event_id: 'sentinel',
      }),
    ];
    for (const event of events) {
      mock.send([event]);
      await Bun.sleep(60);
    }

    await waitFor(
      () => queueEvents(home).some((event) => event.delivery_id === 'dlv_sentinel'),
      15_000,
      'sentinel event',
    );
    const queued = queueEvents(home);
    const expectedKeys = [
      'attention',
      'at',
      'delivery_id',
      'event_id',
      'message_id',
      'room_id',
      'sender_id',
      'seq',
      'source',
    ].sort();
    check(
      'wake.queue 每条事件固定九个字段',
      queued.every((event) => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(expectedKeys)),
      queued,
    );
    check(
      'wake.queue 时间字段为 UTC ISO 8601',
      queued.every((event) => typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(event.at)),
      queued.map((event) => event.at),
    );
    check('catchup 排在第一条', queued[0]?.source === 'catchup', queued[0]);
    check('catchup 的 seq 使用 inbox_head_seq', queued[0]?.seq === '900', queued[0]);
    const catchups = queued.filter((event) => event.source === 'catchup');
    check('同一快照的 frame_truncated 不重复写 catchup', catchups.length === 1, catchups);
    check('catchup 的 event_id 保留触发原因', catchups[0]?.event_id === 'catchup:login:2:900', catchups[0]);

    const queuedIds = new Set(queued.map((event) => event.event_id));
    const queuedDeliveryIds = new Set(queued.map((event) => event.delivery_id));
    check('投递事件入队', queuedDeliveryIds.has('dlv_1'), queued);
    check('直聊普通消息入队', queuedIds.has('102'), queued);
    check('自己的消息不入队', !queuedIds.has('104'), queued);
    check('群聊普通消息不入队', !queuedIds.has('103'), queued);
    check('delivery.updated 不入队', !queuedIds.has('105'), queued);
    check('session.login 不入队', !queuedIds.has('106'), queued);
    check('delivery.reminder 入队', queuedDeliveryIds.has('dlv_3'), queued);
    check('被移出房间入队', queuedIds.has('108'), queued);
    check('直聊只查询一次房间类型', mock.roomGetCalls.get('rm_direct') === 1, {
      calls: [...mock.roomGetCalls],
    });
    check('群聊只查询一次房间类型', mock.roomGetCalls.get('rm_group') === 1, {
      calls: [...mock.roomGetCalls],
    });

    const status = readStatus(home);
    check('status.json 记录 running/acked/online', status.state === 'running' && status.acked === true && status.online === true, status);
    check('status.json 记录 pending_count', status.pending_count === 2, status);

    const surface = [
      readFileSync(join(home, 'wake.queue'), 'utf8'),
      existsSync(join(home, 'watch.log')) ? readFileSync(join(home, 'watch.log'), 'utf8') : '',
      JSON.stringify(status),
    ].join('\n');
    check('token 不进入 queue/log/status', !surface.includes(token));

    // 同一快照超过 30 秒后允许再写，reason 仍写入事件内容。
    writeFileSync(clock.clockFile, String(1_800_000_035));
    mock.send([], { more: true });
    await waitFor(
      () => queueEvents(home).filter((event) => event.source === 'catchup').length === 2,
      15_000,
      'catchup after 30s',
    );
    const recatchups = queueEvents(home).filter((event) => event.source === 'catchup');
    check('同一快照超过 30 秒后可再写 catchup', recatchups.length === 2, recatchups);
    check('再次写入仍使用 inbox_head_seq', recatchups[1]?.seq === '900', recatchups[1]);
    check(
      '再次写入记录 frame_truncated 原因',
      recatchups[1]?.event_id === 'catchup:frame_truncated:2:900',
      recatchups[1],
    );

    child.kill('SIGTERM');
    await child.exited;
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    check('SIGTERM 后 status 为 stopped', readStatus(home).state === 'stopped', readStatus(home));
    check('前台 run 不向 stdout 写事件', stdout.trim() === '', stdout);
    check('日志包含 READY 且不含 token', stderr.includes('READY') && !stderr.includes(token), stderr.slice(0, 500));

    const stopped = Bun.spawn(['bash', SCRIPT, 'status'], {
      env: envFor(home, mock.baseUrl, token),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stoppedOut = await new Response(stopped.stdout).text();
    await stopped.exited;
    check('status 未运行时退出码 3', stopped.exitCode === 3, stopped.exitCode);
    check('status 输出 JSON running=false', (JSON.parse(stoppedOut) as { running?: boolean }).running === false, stoppedOut);

    // EOF：wait 首次调用从当前行数开始，不重放已有事件。
    const queueFile = join(home, 'wake.queue');
    const before = readFileSync(queueFile, 'utf8');
    const waitOne = Bun.spawn(['bash', SCRIPT, 'wait', '5'], {
      env: envFor(home, mock.baseUrl, token),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitFor(() => existsSync(join(home, 'wake.cursor')), 2_000, 'wait cursor init');
    await Bun.sleep(300);
    appendFileSync(queueFile, '{"probe":"eof"}\n');
    const waitOneOut = await new Response(waitOne.stdout).text();
    await waitOne.exited;
    check('wait 从 EOF 起读并输出新行', waitOneOut.includes('"probe":"eof"'), waitOneOut);
    check('wait 不重放已有事件', !waitOneOut.includes('dlv_sentinel'), waitOneOut);
    check('等待期间 queue 原有事件保留', readFileSync(queueFile, 'utf8').startsWith(before.slice(0, 80)));

    // truncate：游标大于当前行数时回退 0。
    truncateSync(queueFile, 0);
    const waitTwo = Bun.spawn(['bash', SCRIPT, 'wait', '5'], {
      env: envFor(home, mock.baseUrl, token),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await Bun.sleep(300);
    appendFileSync(queueFile, '{"probe":"truncate"}\n');
    const waitTwoOut = await new Response(waitTwo.stdout).text();
    await waitTwo.exited;
    check('wake.queue 被 truncate 后游标回退 0', waitTwoOut.includes('"probe":"truncate"'), waitTwoOut);

    // start/stop/status 生命周期。
    const start = Bun.spawn(['bash', SCRIPT, 'start'], {
      env: envFor(home, mock.baseUrl, token),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const startOut = await new Response(start.stdout).text();
    await start.exited;
    check('start 返回 0 并输出 STARTED', start.exitCode === 0 && startOut.includes('STARTED'), {
      code: start.exitCode,
      startOut,
    });
    await waitFor(
      () => {
        const value = readStatus(home);
        return value.state === 'running' && value.acked === true;
      },
      15_000,
      'daemon ack',
    );
    const liveStatus = Bun.spawn(['bash', SCRIPT, 'status'], {
      env: envFor(home, mock.baseUrl, token),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const liveOut = await new Response(liveStatus.stdout).text();
    await liveStatus.exited;
    check('status 运行中退出码 0', liveStatus.exitCode === 0, liveStatus.exitCode);
    check('status 输出 running=true', (JSON.parse(liveOut) as { running?: boolean }).running === true, liveOut);
    const stop = Bun.spawn(['bash', SCRIPT, 'stop'], {
      env: envFor(home, mock.baseUrl, token),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stopOut = await new Response(stop.stdout).text();
    await stop.exited;
    check('stop 返回 0 并输出 STOPPED', stop.exitCode === 0 && stopOut.includes('STOPPED'), {
      code: stop.exitCode,
      stopOut,
    });
    await waitFor(() => !existsSync(join(home, 'watch.pid')), 5_000, 'pid removal');
    await waitFor(() => readStatus(home).state === 'stopped', 5_000, 'daemon stopped');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([child.exited, Bun.sleep(2_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited.catch(() => undefined);
    }
    mock.stop();
  }

  // pending=0 时 login 与 truncated 帧都不写 catchup。
  const zeroHome = mkdtempSync(join(tmpdir(), 'dsh-watch-zero-'));
  const zeroToken = crypto.randomUUID();
  const zeroMock = await createMock({ token: zeroToken, pending: 0 });
  const zeroChild = Bun.spawn(['bash', SCRIPT, 'run'], {
    env: envFor(zeroHome, zeroMock.baseUrl, zeroToken),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const zeroStdout = new Response(zeroChild.stdout).text();
  const zeroStderr = new Response(zeroChild.stderr).text();
  try {
    await zeroMock.waitForStream(15_000);
    await waitFor(
      () => {
        const value = readStatus(zeroHome);
        return value.acked === true && value.online === true && value.pending_count === 0;
      },
      15_000,
      'zero pending login',
    );
    zeroMock.send(
      [
        waitItem({
          source: 'delivery.created',
          attention: 'action_required',
          room_id: 'rm_direct',
          message_id: 'msg_zero',
          delivery_id: 'dlv_zero',
          sender_id: 'agt_bob',
          seq: '201',
          event_id: '201',
        }),
      ],
      { more: true },
    );
    await waitFor(
      () => queueEvents(zeroHome).some((event) => event.delivery_id === 'dlv_zero'),
      15_000,
      'zero pending event',
    );
    const zeroEvents = queueEvents(zeroHome);
    check('pending=0 不写 catchup', zeroEvents.every((event) => event.source !== 'catchup'), zeroEvents);
  } finally {
    if (zeroChild.exitCode === null) {
      zeroChild.kill('SIGTERM');
      await Promise.race([zeroChild.exited, Bun.sleep(2_000)]);
      if (zeroChild.exitCode === null) zeroChild.kill('SIGKILL');
      await zeroChild.exited.catch(() => undefined);
    }
    await zeroStdout;
    await zeroStderr;
    zeroMock.stop();
    rmSync(zeroHome, { recursive: true, force: true });
  }

  const credentialHome = mkdtempSync(join(tmpdir(), 'dsh-watch-cred-'));
  const credentialToken = crypto.randomUUID();
  const credentialMock = await createMock({
    token: credentialToken,
    pending: 0,
    credentialInvalid: true,
  });
  try {
    const startedAt = Date.now();
    const credentialChild = Bun.spawn(['bash', SCRIPT, 'run'], {
      env: envFor(credentialHome, credentialMock.baseUrl, credentialToken),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const credentialStdout = new Response(credentialChild.stdout).text();
    const credentialStderr = new Response(credentialChild.stderr).text();
    const outcome = await Promise.race([
      credentialChild.exited.then((code) => ({ code, timedOut: false })),
      Bun.sleep(8_000).then(() => ({ code: null, timedOut: true })),
    ]);
    if (outcome.timedOut) {
      credentialChild.kill('SIGKILL');
      check('CREDENTIAL_INVALID 立即退出', false, { elapsedMs: Date.now() - startedAt });
    }
    const stderr = await credentialStderr;
    const stdout = await credentialStdout;
    check('CREDENTIAL_INVALID 退出码 3', outcome.code === 3, outcome);
    check('CREDENTIAL_INVALID 在 8 秒内退出', Date.now() - startedAt < 8_000, Date.now() - startedAt);
    check(
      'CREDENTIAL_INVALID 输出不可重试告警',
      stderr.includes('CREDENTIAL_INVALID') && stderr.includes('retryable=false') && stderr.includes('ALERT'),
      stderr,
    );
    const fatalStatus = readStatus(credentialHome);
    check('CREDENTIAL_INVALID 写入 state=fatal', fatalStatus.state === 'fatal', fatalStatus);
    check('CREDENTIAL_INVALID 写入 lastError', fatalStatus.lastError === 'CREDENTIAL_INVALID', fatalStatus);
    check('CREDENTIAL_INVALID 不写事件', queueEvents(credentialHome).length === 0, queueEvents(credentialHome));
    check(
      'CREDENTIAL_INVALID 不泄漏 token',
      !`${stderr}${stdout}${JSON.stringify(fatalStatus)}`.includes(credentialToken),
    );
  } finally {
    credentialMock.stop();
    rmSync(credentialHome, { recursive: true, force: true });
  }

  rmSync(home, { recursive: true, force: true });
  console.log(`DSH watcher 验收通过: ${checks} 项`);
}

await main().catch((error) => {
  console.error('DSH watcher 验收失败:', error);
  process.exit(1);
});
