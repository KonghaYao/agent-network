/**
 * 统一 actor stream 的协议逐帧验收。
 *
 * 与 verify-protocol.ts 的通用协议面分开，避免单文件超过行数上限。
 * 这里直接发原始 `subscriptions/listen`，验证自定义 SSE 的 ack、来源
 * `_meta`、keepalive、abort、错误分类与连接上限。
 */

import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  connectClient,
  openRawListen,
  rawRpc,
  readResourceJson,
  sleep,
  waitUntil,
} from './harness';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

function frameData(frame: string): Record<string, unknown> | null {
  const line = frame
    .split('\n')
    .find((item) => item.startsWith('data: '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function streamEnvelope(frame: string): Record<string, unknown> | null {
  const message = frameData(frame);
  const params = message?.params as Record<string, unknown> | undefined;
  const meta = params?._meta as Record<string, unknown> | undefined;
  const event = meta?.[STREAM_EVENT_META];
  return typeof event === 'object' && event !== null
    ? (event as Record<string, unknown>)
    : null;
}

function healthConnections(health: unknown): number | undefined {
  return (health as { stream?: { connections?: number } } | undefined)?.stream?.connections;
}

function healthActors(health: unknown): number | undefined {
  return (health as { stream?: { actors?: number } } | undefined)?.stream?.actors;
}

export async function runStreamProtocolChecks(
  token: string,
  actorId: string | undefined,
): Promise<void> {
  const streamConnection = await connectClient(token);
  try {
    const resourceList = await streamConnection.client.listResources();
    check(
      '资源列表包含 agentnet://stream',
      resourceList.resources.some((resource) => resource.uri === STREAM_URI),
      resourceList.resources.map((resource) => resource.uri),
    );
    const snapshot = await readResourceJson<Record<string, unknown>>(
      streamConnection.client,
      STREAM_URI,
    );
    checkEqual('stream 快照 stream_uri', snapshot.stream_uri, STREAM_URI);
    checkEqual('stream 快照 actor_id', snapshot.actor_id, actorId);
    checkEqual('stream 快照 kind', snapshot.kind, 'agent');
    checkEqual('未 login 的 Agent 快照 online 为 false', snapshot.online, false);
    check(
      'stream 快照包含 rooms 与 limits',
      Array.isArray(snapshot.rooms) && typeof snapshot.limits === 'object',
      snapshot,
    );

    const raw = await openRawListen(token, `listen:proto-${crypto.randomUUID()}`, [
      STREAM_URI,
    ]);
    try {
      check(
        'stream listen 返回 SSE charset',
        (raw.response.headers.get('content-type') ?? '').includes(
          'text/event-stream; charset=utf-8',
        ),
        raw.response.headers.get('content-type'),
      );
      checkEqual(
        'stream SSE 声明 no-transform',
        raw.response.headers.get('cache-control'),
        'no-cache, no-transform',
      );
      const ackFrame = await raw.waitForFrame(
        (frame) => frame.includes('notifications/subscriptions/acknowledged'),
        '等待统一 stream ack',
      );
      const ack = frameData(ackFrame);
      const ackParams = ack?.params as Record<string, unknown> | undefined;
      const ackNotifications = ackParams?.notifications as
        | { resourceSubscriptions?: string[] }
        | undefined;
      checkEqual(
        'stream ack 只覆盖 agentnet://stream',
        ackNotifications?.resourceSubscriptions?.[0],
        STREAM_URI,
      );
      const ackMeta = ackParams?._meta as Record<string, unknown> | undefined;
      check(
        'stream ack 携带 subscriptionId',
        typeof ackMeta?.['io.modelcontextprotocol/subscriptionId'] === 'string',
        ackMeta,
      );

      await callTool(streamConnection.client, 'network_login');
      const loginFrame = await raw.waitForFrame(
        (frame) => {
          const items = streamEnvelope(frame)?.items;
          return (
            Array.isArray(items) &&
            items.some(
              (item) => (item as { source?: string }).source === 'session.login',
            )
          );
        },
        '等待 session.login 帧',
      );
      const loginEnvelope = streamEnvelope(loginFrame) as {
        v?: number;
        actor_id?: string;
        items?: { source?: string; attention?: string; pending_count?: number }[];
      };
      checkEqual('stream 通知信封版本为 1', loginEnvelope.v, 1);
      checkEqual('stream 通知 actor_id 为接收者', loginEnvelope.actor_id, actorId);
      checkEqual('login 帧来源为 session.login', loginEnvelope.items?.[0]?.source, 'session.login');
      check(
        'login 帧带 pending_count',
        typeof loginEnvelope.items?.[0]?.pending_count === 'number',
        loginEnvelope.items?.[0],
      );
      const snapshotAfterLogin = await readResourceJson<Record<string, unknown>>(
        streamConnection.client,
        STREAM_URI,
      );
      checkEqual('登录后 stream 快照 online 为 true', snapshotAfterLogin.online, true);

      const keepalive = await raw.waitForFrame(
        (frame) => frame.includes(': keepalive'),
        '等待 SSE keepalive',
        8_000,
      );
      check('stream 定期发送 keepalive 注释帧', keepalive.includes(': keepalive'));
      const envelopes = raw.frames
        .map((frame) => streamEnvelope(frame))
        .filter((item): item is Record<string, unknown> => item !== null);
      const maxEnvelopeBytes = Math.max(
        0,
        ...envelopes.map((item) => new TextEncoder().encode(JSON.stringify(item)).length),
      );
      check('stream 信封不超过 1 KiB', maxEnvelopeBytes <= 1024, { maxEnvelopeBytes });
      const rawText = raw.text();
      check(
        'stream 帧不包含正文/preview/claim_id/error',
        !rawText.includes('"preview"') &&
          !rawText.includes('"body"') &&
          !rawText.includes('"claim_id"') &&
          !rawText.includes('"error"'),
      );
      check(
        'stream 帧为单行 data',
        raw.frames
          .filter((frame) => frame.startsWith('event: message'))
          .every(
            (frame) =>
              frame.split('\n').filter((line) => line.startsWith('data: ')).length === 1,
          ),
      );
    } finally {
      await raw.close();
    }
    await waitUntil(
      'stream abort 后连接数归零',
      async () => healthConnections(await fetch(`${baseUrl()}/health`).then((r) => r.json())) === 0,
      5_000,
    );

    const mixed = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI, 'agentnet://me'] } },
      { token },
    );
    const mixedError = mixed.body.error as Record<string, unknown> | undefined;
    checkEqual('stream 与其他 URI 混订被拒绝', mixedError?.code, -32602);
    checkEqual(
      'stream 混订错误码为 INVALID_ARGUMENT',
      (mixedError?.data as Record<string, unknown> | undefined)?.code,
      'INVALID_ARGUMENT',
    );

    const duplicated = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI, STREAM_URI] } },
      { token },
    );
    checkEqual(
      'stream 重复 URI 被拒绝',
      (
        (duplicated.body.error as Record<string, unknown> | undefined)?.data as
          | Record<string, unknown>
          | undefined
      )?.code,
      'INVALID_ARGUMENT',
    );

    // cutover：旧 URI 已删除，必须显式 INVALID_ARGUMENT，不能降级或回退。
    const legacyUris = [
      'agentnet://me',
      'agentnet://actors/act_legacy/inbox',
      'agentnet://rooms/rm_legacy/head',
    ];
    for (const uri of legacyUris) {
      const legacyListen = await rawRpc(
        'subscriptions/listen',
        { notifications: { resourceSubscriptions: [uri] } },
        { token },
      );
      const legacyError = legacyListen.body.error as Record<string, unknown> | undefined;
      checkEqual(`旧 URI ${uri} 订阅返回 -32602`, legacyError?.code, -32602);
      checkEqual(
        `旧 URI ${uri} 错误码为 INVALID_ARGUMENT`,
        (legacyError?.data as Record<string, unknown> | undefined)?.code,
        'INVALID_ARGUMENT',
      );
      const legacyRead = await rawRpc('resources/read', { uri }, { token });
      const legacyReadError = legacyRead.body.error as Record<string, unknown> | undefined;
      checkEqual(`旧 URI ${uri} 读取返回 -32602`, legacyReadError?.code, -32602);
      checkEqual(
        `旧 URI ${uri} 读取错误码为 INVALID_ARGUMENT`,
        (legacyReadError?.data as Record<string, unknown> | undefined)?.code,
        'INVALID_ARGUMENT',
      );
    }

    const noMeta = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI] } },
      { token, protocolVersion: null },
    );
    const noMetaError = noMeta.body.error as Record<string, unknown> | undefined;
    checkEqual('缺少 modern _meta 的 stream listen 被拒绝', noMetaError?.code, -32602);
    checkEqual(
      '缺少 modern _meta 的错误码为 INVALID_ARGUMENT',
      (noMetaError?.data as Record<string, unknown> | undefined)?.code,
      'INVALID_ARGUMENT',
    );

    const versionMismatch = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI] } },
      { token, versionHeader: '2025-06-18' },
    );
    checkEqual('stream listen header/body 版本不一致返回 400', versionMismatch.status, 400);
    const mismatchError = versionMismatch.body.error as Record<string, unknown> | undefined;
    checkEqual('stream listen 版本不一致错误码为 -32020', mismatchError?.code, -32020);
    checkEqual(
      'stream listen 版本不一致带上 header/body 明细',
      (
        (mismatchError?.data as Record<string, unknown> | undefined)?.mismatch as
          | Record<string, unknown>
          | undefined
      )?.header,
      '2025-06-18',
    );

    const missingVersionHeader = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI] } },
      { token, versionHeader: null },
    );
    checkEqual('stream listen 缺少协议头返回 400', missingVersionHeader.status, 400);
    checkEqual(
      'stream listen 缺少协议头错误码为 -32020',
      (missingVersionHeader.body.error as Record<string, unknown> | undefined)?.code,
      -32020,
    );

    const emptySubscriptions = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [] } },
      { token },
    );
    const emptyError = emptySubscriptions.body.error as Record<string, unknown> | undefined;
    checkEqual('空 resourceSubscriptions 被拒绝', emptyError?.code, -32602);
    checkEqual(
      '空 resourceSubscriptions 错误码为 INVALID_ARGUMENT',
      (emptyError?.data as Record<string, unknown> | undefined)?.code,
      'INVALID_ARGUMENT',
    );

    const duplicateId = `listen:dup-${crypto.randomUUID()}`;
    const first = await openRawListen(token, duplicateId, [STREAM_URI]);
    const second = await openRawListen(token, duplicateId, [STREAM_URI]);
    try {
      await first.waitForFrame(
        (frame) => frame.includes('notifications/subscriptions/acknowledged'),
        '等待首个重复 id stream ack',
      );
      await waitUntil('重复 subscription id 返回错误', () => second.errorBody() !== null, 5_000);
      const duplicateError = second.errorBody()?.error as Record<string, unknown> | undefined;
      checkEqual('重复 subscription id 被拒绝', duplicateError?.code, -32602);
      checkEqual(
        '重复 subscription id 错误码为 INVALID_ARGUMENT',
        (duplicateError?.data as Record<string, unknown> | undefined)?.code,
        'INVALID_ARGUMENT',
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }

    const capStreams = [];
    for (let index = 0; index < 4; index += 1) {
      const cap = await openRawListen(
        token,
        `listen:cap-${index}-${crypto.randomUUID()}`,
        [STREAM_URI],
      );
      await cap.waitForFrame(
        (frame) => frame.includes('notifications/subscriptions/acknowledged'),
        `等待第 ${index + 1} 条 stream ack`,
      );
      capStreams.push(cap);
    }
    try {
      const fifth = await rawRpc(
        'subscriptions/listen',
        { notifications: { resourceSubscriptions: [STREAM_URI] } },
        { token },
      );
      const fifthError = fifth.body.error as Record<string, unknown> | undefined;
      checkEqual('第五条 stream 连接被拒绝', fifthError?.code, -32602);
      checkEqual(
        '连接上限错误码为 RATE_LIMITED',
        (fifthError?.data as Record<string, unknown> | undefined)?.code,
        'RATE_LIMITED',
      );
      const health = await fetch(`${baseUrl()}/health`).then((r) => r.json());
      checkEqual('每个 actor 最多 4 条物理连接', healthConnections(health), 4);
    } finally {
      await Promise.all(capStreams.map((stream) => stream.close()));
    }
    await sleep(250);
    const afterClose = await fetch(`${baseUrl()}/health`).then((r) => r.json());
    checkEqual('关闭全部 stream 后连接数归零', healthConnections(afterClose), 0);
    checkEqual('关闭全部 stream 后 actors 归零', healthActors(afterClose), 0);
  } finally {
    await streamConnection.close();
  }
}
