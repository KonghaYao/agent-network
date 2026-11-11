/**
 * MCP Events 端到端验收。
 *
 * 启动独立 WeBots 实例 + 自签 HTTPS receiver，验证能力、challenge、
 * 签名、过滤、重试、授权撤销、重启、重放与日志脱敏。
 *
 * 运行：bun run test:events
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Client } from '@modelcontextprotocol/client';

import {
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  newRequestId,
  newToken,
  rawRpc,
  sleep,
} from './lib/harness';
import {
  acceptGroupInvites,
  befriend,
  registerIdentity,
  sendMessage,
  type Delivery,
  type Identity,
  type RoomDetail,
} from './lib/acceptance-helpers';
import { runEventsAcceptance } from './lib/events-acceptance';
import {
  ensureTestCertificate,
  removeTestData,
  signatureCandidates,
  startTestReceiver,
  startTestServer,
  verifyAnyWebhookSignature,
  verifyWebhookSignature,
  type ReceiverRequest,
  type TestReceiver,
  type TestServer,
} from './lib/events-harness';
import { runEventsValidationChecks } from './lib/events-validation';
import { runEventsClientChecks } from './lib/events-client-check';
import { runEventsFileLogChecks } from './lib/events-file-log-check';
import { runEventsRuntimeChecks } from './lib/events-runtime-check';

const EVENT_NAME = 'agentnet.message.created';
const SERVER_PORT = Number(process.env.EVENTS_TEST_PORT ?? 18890);
const DATA_DIR =
  process.env.EVENTS_TEST_DATA_DIR ??
  join(tmpdir(), `an-events-${crypto.randomUUID().replaceAll('-', '')}`);

interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: string | null;
  truncated: boolean;
}

interface EventPayload {
  eventId: string;
  name: string;
  timestamp: string;
  cursor: string;
  data: Record<string, unknown>;
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${Buffer.from(bytes).toString('base64')}`;
}

function payloadOf(request: ReceiverRequest): EventPayload {
  return JSON.parse(request.body) as EventPayload;
}

async function rpcError(
  label: string,
  response: Awaited<ReturnType<typeof rawRpc>>,
  code: number,
): Promise<Record<string, unknown> | undefined> {
  const error = response.body.error as
    | { code?: number; data?: Record<string, unknown> }
    | undefined;
  checkEqual(label, error?.code, code);
  return error?.data;
}

async function subscribe(
  token: string,
  input: {
    url: string;
    secret: string;
    arguments?: Record<string, unknown>;
    cursor?: string | null;
    ttlMs?: number | null;
  },
): Promise<SubscribeResult> {
  const response = await rawRpc(
    'events/subscribe',
    {
      name: EVENT_NAME,
      arguments: input.arguments ?? {},
      delivery: { mode: 'webhook', url: input.url, secret: input.secret },
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    },
    { token },
  );
  checkEqual('events/subscribe HTTP 200', response.status, 200);
  check('events/subscribe 无错误', response.body.error === undefined, response.body.error);
  return response.body.result as SubscribeResult;
}

async function poke(client: Client): Promise<void> {
  await callTool(client, 'network_me');
}

async function runNoEventWindow(receiver: TestReceiver, client: Client): Promise<void> {
  await sleep(500);
  await poke(client);
  await sleep(500);
}

function countEvents(receiver: TestReceiver, predicate: (request: ReceiverRequest) => boolean): number {
  return receiver.requests.filter((request) => !request.isVerification && predicate(request)).length;
}

async function main(): Promise<void> {
  console.log(`MCP Events 验收: http://127.0.0.1:${SERVER_PORT}`);

  const certificate = await ensureTestCertificate(join(DATA_DIR, 'certs'));
  const receiver = startTestReceiver({ certificate });
  let server: TestServer | null = null;
  const db = { current: null as Database | null };

  try {
    await runEventsRuntimeChecks(certificate);
    const encryptionKey = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString('base64');
    server = await startTestServer({ port: SERVER_PORT, dataDir: DATA_DIR, encryptionKey });
    process.env.AGENTNET_URL = `http://127.0.0.1:${SERVER_PORT}`;
    db.current = new Database(server.dbPath);
    db.current.exec('PRAGMA busy_timeout = 5000');
    const database = db.current;

    const tokenA = newToken();
    const tokenB = newToken();
    const tokenC = newToken();
    let agentA = await connectClient(tokenA);
    let agentB = await connectClient(tokenB);
    let agentC = await connectClient(tokenC);

    const a = await registerIdentity(agentA, {
      kind: 'agent',
      name: 'Events A',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const b = await registerIdentity(agentB, {
      kind: 'agent',
      name: 'Events B',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const c = await registerIdentity(agentC, {
      kind: 'agent',
      name: 'Events C',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    void c;

    await befriend(agentA, a.actor_id, agentB, b.actor_id);
    await befriend(agentB, b.actor_id, agentC, c.actor_id);
    const roomAB = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [b.actor_id],
      })
    ).room.room_id;
    const roomBC = (
      await callTool<RoomDetail>(agentB.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [c.actor_id],
      })
    ).room.room_id;

    // 测试实例以 DRIVE_DISABLED=1 启动：自动归档没有 Drive 绑定可注册，
    // 含合法 fileId 的消息仍必须正常提交，不能因为解析到链接而失败。
    const driveDisabledFileId = `f_${'d'.repeat(22)}`;
    const driveDisabledSent = await sendMessage(
      agentA,
      roomAB,
      `drive disabled /f/${driveDisabledFileId}`,
    );
    check(
      'DRIVE_DISABLED 下含文件链接的消息仍成功',
      Boolean(driveDisabledSent.message.message_id),
    );

    // ---------- 能力 / 目录 ----------
    const discover = await rawRpc('server/discover');
    const discoverResult = discover.body.result as
      | { supportedVersions?: string[]; capabilities?: Record<string, unknown> }
      | undefined;
    const capabilities = discoverResult?.capabilities as
      | { events?: unknown; extensions?: Record<string, unknown> }
      | undefined;
    check('server/discover 声明顶层 events', capabilities?.events !== undefined, capabilities);
    check(
      'events 不在 extensions 中',
      capabilities?.extensions?.events === undefined,
      capabilities?.extensions,
    );
    checkEqual(
      'supportedVersions 仅 2026-07-28',
      JSON.stringify(discoverResult?.supportedVersions),
      '["2026-07-28"]',
    );

    const list = await rawRpc('events/list');
    const listResult = list.body.result as
      | { events?: Record<string, unknown>[]; resultType?: string; _meta?: unknown }
      | undefined;
    check('events/list 返回事件目录', Array.isArray(listResult?.events), listResult);
    checkEqual('events/list 只有一个事件', listResult?.events?.length, 1);
    const definition = listResult?.events?.[0] ?? {};
    checkEqual('事件名正确', definition.name, EVENT_NAME);
    checkEqual('delivery 只有 webhook', JSON.stringify(definition.delivery), '["webhook"]');
    const inputSchema = definition.inputSchema as Record<string, unknown>;
    const payloadSchema = definition.payloadSchema as Record<string, unknown>;
    checkEqual('inputSchema additionalProperties:false', inputSchema.additionalProperties, false);
    checkEqual('payloadSchema additionalProperties:false', payloadSchema.additionalProperties, false);
    checkEqual('events/list 保留 resultType', listResult?.resultType, 'complete');
    console.log(
      `  · events/list wire shape keys: result=${Object.keys(listResult ?? {}).join(',')}`,
    );

    const legacy = await rawRpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'legacy-events-check', version: '0.1.0' },
      },
      { protocolVersion: null, versionHeader: '2025-06-18' },
    );
    checkEqual('legacy initialize 仍返回 400', legacy.status, 400);

    // ---------- 参数 / 授权 ----------
    const secret1 = newSecret();
    await runEventsValidationChecks({
      token: tokenA,
      roomBC,
      receiver,
      secret: secret1,
    });

    // ---------- 多地址回退 / 文件日志单元 ----------
    await runEventsClientChecks({ receiver });
    runEventsFileLogChecks();

    // ---------- challenge / 订阅 ----------
    const mainUrl = receiver.url('/callback', '?main=1');
    const mainSub = await subscribe(tokenB, {
      url: mainUrl,
      secret: secret1,
      arguments: { room_id: roomAB },
      cursor: null,
      ttlMs: 3_600_000,
    });
    check('订阅 id 以 sub_ 开头', mainSub.id.startsWith('sub_'), mainSub.id);
    check('返回有限 refreshBefore', Date.parse(mainSub.refreshBefore) > Date.now());
    checkEqual('新订阅 truncated=false', mainSub.truncated, false);
    checkEqual('新订阅响应 cursor=null', mainSub.cursor, null);
    check(
      '订阅响应包含约定业务字段',
      ['cursor', 'id', 'refreshBefore', 'truncated'].every((key) => key in mainSub),
    );
    checkEqual(
      '订阅响应没有额外业务字段',
      Object.keys(mainSub).filter(
        (key) => !['_meta', 'cursor', 'id', 'refreshBefore', 'resultType', 'truncated'].includes(key),
      ).length,
      0,
    );

    const verification = await receiver.waitForRequest(
      (request) => request.isVerification && request.query.includes('main=1'),
      '等待 challenge',
    );
    checkEqual('challenge webhook-id 以 msg_ 开头', verification.headers.get('webhook-id')?.startsWith('msg_'), true);
    checkEqual('challenge 带 X-MCP-Subscription-Id', verification.subscriptionId, mainSub.id);
    check('challenge 签名合法', verifyWebhookSignature(secret1, verification));
    check('错误 secret 无法验证 challenge 签名', !verifyWebhookSignature(newSecret(), verification));
    check(
      '篡改 challenge body 后签名失效',
      !verifyWebhookSignature(secret1, { ...verification, body: `${verification.body} ` }),
    );
    const challengeBody = JSON.parse(verification.body) as { type?: string; challenge?: string };
    checkEqual('challenge envelope type', challengeBody.type, 'verification');
    check('challenge 是 base64url', /^[A-Za-z0-9_-]{20,}$/u.test(challengeBody.challenge ?? ''));

    const verificationCount = receiver.verificationRequests().length;
    const refreshSame = await subscribe(tokenB, {
      url: mainUrl,
      secret: secret1,
      arguments: { room_id: roomAB },
    });
    checkEqual('相同订阅 key 返回同一 id', refreshSame.id, mainSub.id);
    checkEqual('验证缓存期内不重复 challenge', receiver.verificationRequests().length, verificationCount);

    const actionSub = await subscribe(tokenB, {
      url: mainUrl,
      secret: secret1,
      arguments: { room_id: roomAB, attention: 'action_required' },
    });
    check('不同 arguments 产生不同订阅 id', actionSub.id !== mainSub.id);
    checkEqual('相同 actor+URL 不重复 challenge', receiver.verificationRequests().length, verificationCount);

    // ---------- ChatGPT 兼容字段 / 幂等 ----------
    const compatUrl = receiver.url('/callback', '?compat=1');
    const compatResponse = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: null,
        delivery: {
          mode: 'webhook',
          url: compatUrl,
          secret: secret1,
          signature_version: 'v1',
        },
        cursor: null,
        // ChatGPT 的 task/connector 层可能附带未知字段；服务端必须忽略而不是拒绝。
        connector_id: 'connector_test2',
        event: EVENT_NAME,
        params: { source: 'chatgpt' },
      },
      { token: tokenB },
    );
    checkEqual('兼容字段 subscribe HTTP 200', compatResponse.status, 200);
    check('兼容字段不被拒绝', compatResponse.body.error === undefined, compatResponse.body.error);
    const compatSub = compatResponse.body.result as SubscribeResult;
    checkEqual('未知顶层字段不影响订阅', compatSub.id.startsWith('sub_'), true);
    checkEqual('arguments:null 新订阅 cursor=null', compatSub.cursor, null);
    checkEqual('arguments:null 新订阅 truncated=false', compatSub.truncated, false);
    check(
      '无 ttlMs 使用默认有限 TTL',
      Number.isFinite(Date.parse(compatSub.refreshBefore)) &&
        Date.parse(compatSub.refreshBefore) - Date.now() <= 24 * 60 * 60_000 + 2_000,
      compatSub.refreshBefore,
    );

    const compatSame = await subscribe(tokenB, {
      url: compatUrl,
      secret: secret1,
      arguments: {},
    });
    checkEqual('arguments:null 与 {} 是同一订阅', compatSame.id, compatSub.id);

    const orderUrl = receiver.url('/callback', '?order=1');
    const orderA = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: { room_id: roomAB, attention: 'action_required' },
        delivery: { mode: 'webhook', url: orderUrl, secret: secret1 },
      },
      { token: tokenB },
    );
    const orderB = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: { attention: 'action_required', room_id: roomAB },
        delivery: { mode: 'webhook', url: orderUrl, secret: secret1 },
      },
      { token: tokenB },
    );
    checkEqual(
      'arguments 键顺序不产生新订阅',
      (orderA.body.result as SubscribeResult).id,
      (orderB.body.result as SubscribeResult).id,
    );

    const unknownArgUrl = receiver.url('/callback', '?unknownarg=1');
    const unknownArgA = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: { room_id: roomAB, future_filter: 'ignored' },
        delivery: { mode: 'webhook', url: unknownArgUrl, secret: secret1 },
      },
      { token: tokenB },
    );
    const unknownArgB = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: { room_id: roomAB },
        delivery: { mode: 'webhook', url: unknownArgUrl, secret: secret1 },
      },
      { token: tokenB },
    );
    check('未知 arguments 字段不被拒绝', unknownArgA.body.error === undefined, unknownArgA.body.error);
    checkEqual(
      '未知 arguments 字段不改变订阅身份',
      (unknownArgA.body.result as SubscribeResult).id,
      (unknownArgB.body.result as SubscribeResult).id,
    );

    const shortTtl = await subscribe(tokenB, {
      url: receiver.url('/callback', '?ttl=min'),
      secret: secret1,
      arguments: { room_id: roomAB },
      ttlMs: 1,
    });
    check(
      'ttlMs 过小被 clamp 到 5min',
      Date.parse(shortTtl.refreshBefore) - Date.now() <= 5 * 60_000 + 2_000,
      shortTtl.refreshBefore,
    );

    const noExpiry = await subscribe(tokenB, {
      url: receiver.url('/callback', '?ttl=null'),
      secret: secret1,
      arguments: { room_id: roomAB },
      ttlMs: null,
    });
    check(
      'ttlMs:null 仍返回有限 refreshBefore',
      Number.isFinite(Date.parse(noExpiry.refreshBefore)) &&
        Date.parse(noExpiry.refreshBefore) - Date.now() <= 7 * 24 * 60 * 60_000 + 2_000,
      noExpiry.refreshBefore,
    );

    const badChallenge = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/verify-bad'), secret: secret1 },
      },
      { token: tokenB },
    );
    const badChallengeError = badChallenge.body.error as
      | { code?: number; data?: Record<string, unknown> }
      | undefined;
    checkEqual('错误 challenge 返回 -32015', badChallengeError?.code, -32015);
    checkEqual('错误 challenge reason', badChallengeError?.data?.reason, 'challenge_failed');
    checkEqual(
      '错误 challenge detail=challenge_mismatch',
      badChallengeError?.data?.detail,
      'challenge_mismatch',
    );

    const verifyMalformed = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/verify-malformed'), secret: secret1 },
      },
      { token: tokenB },
    );
    const verifyMalformedError = verifyMalformed.body.error as
      | { code?: number; data?: Record<string, unknown> }
      | undefined;
    checkEqual('非 JSON challenge 返回 -32015', verifyMalformedError?.code, -32015);
    checkEqual('非 JSON challenge reason', verifyMalformedError?.data?.reason, 'challenge_failed');
    checkEqual(
      '非 JSON challenge detail=challenge_malformed',
      verifyMalformedError?.data?.detail,
      'challenge_malformed',
    );

    const verifyRedirect = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/verify-redirect'), secret: secret1 },
      },
      { token: tokenB },
    );
    const verifyRedirectError = verifyRedirect.body.error as
      | { code?: number; data?: Record<string, unknown> }
      | undefined;
    checkEqual('验证端点 302 返回 -32015', verifyRedirectError?.code, -32015);
    checkEqual('验证端点 302 detail=http_status', verifyRedirectError?.data?.detail, 'http_status');
    checkEqual('验证端点 302 status=302', verifyRedirectError?.data?.status, 302);
    check(
      '验证不跟随重定向',
      !receiver.requests.some((request) => request.path === '/redirect-target'),
    );

    const verify500 = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/verify-500'), secret: secret1 },
      },
      { token: tokenB },
    );
    const verify500Error = verify500.body.error as
      | { code?: number; data?: Record<string, unknown> }
      | undefined;
    checkEqual('验证端点 500 返回 -32015', verify500Error?.code, -32015);
    checkEqual('验证端点 500 reason', verify500Error?.data?.reason, 'http_5xx');
    checkEqual('验证端点 500 detail=http_status', verify500Error?.data?.detail, 'http_status');
    checkEqual('验证端点 500 status=500', verify500Error?.data?.status, 500);

    const verifySlow = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/verify-slow'), secret: secret1 },
      },
      { token: tokenB },
    );
    const verifySlowError = verifySlow.body.error as
      | { code?: number; data?: Record<string, unknown> }
      | undefined;
    checkEqual('验证超时返回 -32015', verifySlowError?.code, -32015);
    checkEqual('验证超时 reason', verifySlowError?.data?.reason, 'timeout');
    checkEqual('验证超时 detail=timeout', verifySlowError?.data?.detail, 'timeout');
    checkEqual('验证超时 data.attempts', verifySlowError?.data?.attempts, 1);
    checkEqual('验证超时 data.error_code', verifySlowError?.data?.error_code, 'ETIMEDOUT');

    // ---------- 核心闭环（subscribe → message → webhook → claim → complete） ----------
    await runEventsAcceptance({ receiver, secret: secret1 });

    // ---------- 事件投递 / 过滤 ----------
    const bodyMarker = `events-secret-body-${crypto.randomUUID()}`;
    const firstSent = await sendMessage(agentA, roomAB, bodyMarker);
    const firstEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === mainSub.id &&
        payloadOf(request).data.message_id === firstSent.message.message_id,
      '等待主订阅事件',
    );
    const firstPayload = payloadOf(firstEvent);
    checkEqual('事件名正确', firstPayload.name, EVENT_NAME);
    checkEqual('事件 data.room_id', firstPayload.data.room_id, roomAB);
    checkEqual('事件 data.sender_id', firstPayload.data.sender_id, a.actor_id);
    checkEqual('事件 attention=informational', firstPayload.data.attention, 'informational');
    check('无 delivery 时不带 delivery_id', firstPayload.data.delivery_id === undefined);
    checkEqual('事件 cursor=event_seq', firstPayload.cursor, firstPayload.data.event_seq);
    check('事件 body 不含正文', !firstEvent.body.includes(bodyMarker));
    check(
      '事件 body 不含 token/secret',
      !firstEvent.body.includes(tokenA) &&
        !firstEvent.body.includes(tokenB) &&
        !firstEvent.body.includes(secret1) &&
        !firstEvent.body.includes('whsec_'),
    );
    checkEqual(
      'payload 只含标识与状态字段',
      JSON.stringify(Object.keys(firstPayload.data).sort()),
      JSON.stringify(
        [
          'attention',
          'created_at',
          'created_seq',
          'event_id',
          'event_seq',
          'message_id',
          'room_id',
          'room_kind',
          'sender_id',
        ].sort(),
      ),
    );
    check('事件签名合法', verifyWebhookSignature(secret1, firstEvent));
    checkEqual('webhook-id 等于 eventId', firstEvent.headers.get('webhook-id'), firstPayload.eventId);
    check(
      'webhook-timestamp 为 Unix 秒',
      /^\d{10}$/u.test(firstEvent.headers.get('webhook-timestamp') ?? ''),
      firstEvent.headers.get('webhook-timestamp'),
    );
    check('payload 远小于 256 KiB', firstEvent.body.length < 256 * 1024);

    // 自身消息不回推。
    const selfUrl = receiver.url('/callback', '?self=1');
    const selfSub = await subscribe(tokenA, { url: selfUrl, secret: secret1, arguments: { room_id: roomAB } });
    const selfSent = await sendMessage(agentA, roomAB, 'self-message');
    await sleep(300);
    await poke(agentA.client);
    await sleep(400);
    checkEqual(
      '发送者不收到自己的消息',
      countEvents(receiver, (request) => request.subscriptionId === selfSub.id),
      0,
    );
    check('自身消息事件未出现', !receiver.events('/callback').some((request) => payloadOf(request).data.message_id === selfSent.message.message_id && request.subscriptionId === selfSub.id));

    // room 过滤。
    const cSent = await sendMessage(agentC, roomBC, 'other-room-message');
    await sleep(300);
    await poke(agentB.client);
    await sleep(400);
    check(
      'room_id 过滤不投递其他房间',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === mainSub.id &&
          payloadOf(request).data.message_id === cSent.message.message_id,
      ),
    );

    // room_id/attention 缺省不限制。
    const globalSub = await subscribe(tokenB, {
      url: receiver.url('/callback', '?global=1'),
      secret: secret1,
    });
    const globalSent = await sendMessage(agentC, roomBC, 'global-room-message');
    const globalEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === globalSub.id &&
        payloadOf(request).data.message_id === globalSent.message.message_id,
      '等待无 room 过滤事件',
    );
    checkEqual(
      '未提供 room_id 时接收所有所在房间',
      payloadOf(globalEvent).data.room_id,
      roomBC,
    );
    checkEqual(
      'attention 缺省接收 informational',
      payloadOf(globalEvent).data.attention,
      'informational',
    );

    // ---------- 群聊：不带 room_id 的订阅与 direct 硬过滤 ----------
    const groupAB = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'group',
        members: [b.actor_id],
        title: 'Events 群聊',
      })
    ).room.room_id;
    // G01：非管理者好友先收到定向邀请；成为 active 成员后才能被 invoke 投递。
    await acceptGroupInvites(agentB, groupAB);

    // 订阅建立前的旧群聊待办：新订阅不会补发，但 inbox/sync 必须能补读。
    const groupBefore = await sendMessage(agentA, groupAB, 'group-before-subscribe', {
      invoke: [b.actor_id],
    });
    const groupActionSub = await subscribe(tokenB, {
      url: receiver.url('/callback', '?group-action=1'),
      secret: secret1,
      arguments: { attention: 'action_required' },
    });

    const activeInbox = await callTool<{
      items: { delivery_id: string; message_id: string; room_id: string }[];
    }>(agentB.client, 'network_inbox_list', {});
    const activeGroupItem = activeInbox.items.find(
      (item) => item.delivery_id === groupBefore.delivery_ids[0],
    );
    check(
      'inbox 默认 active 能补读订阅前的群聊待办',
      activeGroupItem !== undefined && activeGroupItem.room_id === groupAB,
      activeInbox.items,
    );
    const groupSync = await callTool<{
      items: { type: string; ref_id: string | null }[];
      scope: string;
    }>(agentB.client, 'network_sync', { scope: 'inbox', limit: 200 });
    check(
      'inbox sync 能看到订阅前的群聊待办',
      groupSync.items.some(
        (item) => item.type === 'delivery_created' && item.ref_id === groupBefore.delivery_ids[0],
      ),
      groupSync.items,
    );

    const groupAfter = await sendMessage(agentA, groupAB, 'group-after-subscribe', {
      invoke: [b.actor_id],
    });
    const groupEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === groupActionSub.id &&
        payloadOf(request).data.message_id === groupAfter.message.message_id,
      '等待群聊 action_required 事件',
    );
    const groupPayload = payloadOf(groupEvent);
    checkEqual('群聊事件 room_kind=group', groupPayload.data.room_kind, 'group');
    checkEqual('群聊事件带 delivery_id', groupPayload.data.delivery_id, groupAfter.delivery_ids[0]);
    checkEqual('群聊事件 attention=action_required', groupPayload.data.attention, 'action_required');
    checkEqual('群聊事件 delivery_state=pending', groupPayload.data.delivery_state, 'pending');
    // 新事件已到达说明扫描已越过旧 groupBefore；旧待办仍不应被补发。
    check(
      '新订阅不重放订阅前的群聊事件',
      countEvents(
        receiver,
        (request) =>
          request.subscriptionId === groupActionSub.id &&
          payloadOf(request).data.message_id === groupBefore.message.message_id,
      ) === 0,
    );

    const directOnlySub = await subscribe(tokenB, {
      url: receiver.url('/callback', '?direct-only=1'),
      secret: secret1,
      arguments: { room_id: roomAB, attention: 'action_required' },
    });
    const groupForDirect = await sendMessage(agentA, groupAB, 'group-hidden-from-direct', {
      invoke: [b.actor_id],
    });
    // 同一订阅的后续 direct 事件到达，证明扫描已越过群聊事件 seq。
    const directControl = await sendMessage(agentA, roomAB, 'direct-control-after-group', {
      invoke: [b.actor_id],
    });
    await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === directOnlySub.id &&
        payloadOf(request).data.message_id === directControl.message.message_id,
      '等待 direct 订阅的控制事件',
    );
    check(
      '带 room_id 的单聊订阅收不到群聊事件',
      countEvents(
        receiver,
        (request) =>
          request.subscriptionId === directOnlySub.id &&
          payloadOf(request).data.message_id === groupForDirect.message.message_id,
      ) === 0,
    );

    // ---------- 离线投递：无 SSE、无 network_login ----------
    const tokenD = newToken();
    const agentD = await connectClient(tokenD);
    const d = await registerIdentity(agentD, {
      kind: 'agent',
      name: 'Events D Offline',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await befriend(agentA, a.actor_id, agentD, d.actor_id);
    const roomAD = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [d.actor_id],
      })
    ).room.room_id;
    await agentD.close();
    const offlineSub = await subscribe(tokenD, {
      url: receiver.url('/callback', '?offline=1'),
      secret: secret1,
      arguments: { room_id: roomAD },
    });
    const offlineDetail = await callTool<RoomDetail>(agentA.client, 'network_room_get', {
      room_id: roomAD,
    });
    checkEqual(
      '无 SSE 但近期请求的 Agent 显示在线',
      offlineDetail.members.find((member) => member.actor_id === d.actor_id)?.online,
      true,
    );
    const offlineSent = await sendMessage(agentA, roomAD, 'offline-message', {
      invoke: [d.actor_id],
    });
    const offlineEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === offlineSub.id &&
        payloadOf(request).data.message_id === offlineSent.message.message_id,
      '等待离线投递',
    );
    checkEqual(
      '无 SSE 且未 login 仍投递',
      payloadOf(offlineEvent).data.message_id,
      offlineSent.message.message_id,
    );
    checkEqual(
      '离线投递 attention=action_required',
      payloadOf(offlineEvent).data.attention,
      'action_required',
    );
    checkEqual(
      '离线投递携带 delivery_id',
      payloadOf(offlineEvent).data.delivery_id,
      offlineSent.delivery_ids[0],
    );

    // attention 过滤 + pending delivery。
    const invoked = await sendMessage(agentA, roomAB, 'invoke-b', { invoke: [b.actor_id] });
    const actionEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === actionSub.id &&
        payloadOf(request).data.message_id === invoked.message.message_id,
      '等待 action_required 事件',
    );
    const actionPayload = payloadOf(actionEvent);
    checkEqual('pending delivery 提升为 action_required', actionPayload.data.attention, 'action_required');
    checkEqual('事件带 delivery_id', actionPayload.data.delivery_id, invoked.delivery_ids[0]);
    checkEqual('事件带 delivery_state=pending', actionPayload.data.delivery_state, 'pending');

    const plainSent = await sendMessage(agentA, roomAB, 'plain-after-action');
    await sleep(300);
    await poke(agentB.client);
    await sleep(400);
    check(
      'attention:action_required 不投递普通消息',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === actionSub.id &&
          payloadOf(request).data.message_id === plainSent.message.message_id,
      ),
    );

    // 已 claimed 的 delivery 应降为 informational。
    const infoSub = await subscribe(tokenB, {
      url: receiver.url('/callback', '?info=1'),
      secret: secret1,
      arguments: { room_id: roomAB, attention: 'informational' },
    });
    const syntheticMessageId = `msg_syn_${crypto.randomUUID().replaceAll('-', '')}`;
    const syntheticEventKey = `evt_syn_${crypto.randomUUID().replaceAll('-', '')}`;
    const syntheticAt = Date.now();
    database
      .prepare(
        `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         VALUES ('room', ?, 'message_created', ?, ?, ?, ?)`,
      )
      .run(roomAB, syntheticMessageId, JSON.stringify({ sender_id: a.actor_id }), syntheticEventKey, syntheticAt);
    const syntheticSeq = (
      database
        .prepare('SELECT event_seq FROM events WHERE event_key = ?')
        .get(syntheticEventKey) as { event_seq: number }
    ).event_seq;
    database.prepare('UPDATE rooms SET head_seq = MAX(head_seq, ?) WHERE room_id = ?').run(syntheticSeq, roomAB);
    database
      .prepare(
        `INSERT INTO deliveries (delivery_id, recipient_id, message_id, room_id, state, attempt, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
      )
      .run(
        `dlv_syn_${crypto.randomUUID().replaceAll('-', '')}`,
        b.actor_id,
        syntheticMessageId,
        roomAB,
        syntheticSeq,
        syntheticAt,
        syntheticAt,
      );
    const trigger = await sendMessage(agentA, roomAB, 'trigger-scan');
    await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === infoSub.id &&
        payloadOf(request).data.message_id === syntheticMessageId,
      '等待 claimed delivery 的 informational 事件',
    );
    const infoEvent = receiver.events('/callback').find(
      (request) =>
        request.subscriptionId === infoSub.id &&
        payloadOf(request).data.message_id === syntheticMessageId,
    )!;
    const infoPayload = payloadOf(infoEvent);
    checkEqual('claimed delivery attention=informational', infoPayload.data.attention, 'informational');
    checkEqual('claimed delivery 仍带 delivery_state', infoPayload.data.delivery_state, 'claimed');
    check(
      'action_required 过滤不投递 claimed 事件',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === actionSub.id &&
          payloadOf(request).data.message_id === syntheticMessageId,
      ),
    );
    void trigger;

    // 重复扫描/刷新不重复投递。
    const firstEventId = firstPayload.eventId;
    const before = countEvents(receiver, (request) => payloadOf(request).eventId === firstEventId);
    await poke(agentB.client);
    await poke(agentB.client);
    await sleep(400);
    checkEqual(
      '重复 tick 不重复投递同一 eventId',
      countEvents(receiver, (request) => payloadOf(request).eventId === firstEventId),
      before,
    );

    // ---------- 重试 / 410 / 413 / 超时 ----------
    const retryUrl = receiver.url('/fail-once', '?r=1');
    await subscribe(tokenB, { url: retryUrl, secret: secret1, arguments: { room_id: roomAB } });
    const retrySent = await sendMessage(agentA, roomAB, 'retry-body');
    const firstAttempt = await receiver.waitForEvent(
      (request) =>
        request.path === '/fail-once' &&
        payloadOf(request).data.message_id === retrySent.message.message_id,
      '等待第一次 500',
    );
    await sleep(1_500);
    await poke(agentB.client);
    const secondAttempt = await receiver.waitForEvent(
      (request) =>
        request.path === '/fail-once' &&
        payloadOf(request).data.message_id === retrySent.message.message_id &&
        request.at > firstAttempt.at,
      '等待重试成功',
    );
    checkEqual('重试保留同一 eventId', payloadOf(secondAttempt).eventId, payloadOf(firstAttempt).eventId);
    check('重试签名仍合法', verifyWebhookSignature(secret1, secondAttempt));
    if (secondAttempt.headers.get('webhook-timestamp') !== firstAttempt.headers.get('webhook-timestamp')) {
      check(
        '重试重新签名',
        secondAttempt.headers.get('webhook-signature') !== firstAttempt.headers.get('webhook-signature'),
      );
    }

    const goneUrl = receiver.url('/gone', '?g=1');
    await subscribe(tokenB, { url: goneUrl, secret: secret1, arguments: { room_id: roomAB } });
    const goneSent = await sendMessage(agentA, roomAB, 'gone-body');
    await receiver.waitForEvent(
      (request) =>
        request.path === '/gone' &&
        payloadOf(request).data.message_id === goneSent.message.message_id,
      '等待 410',
    );
    await sleep(1_500);
    await poke(agentB.client);
    await sleep(400);
    checkEqual(
      '410 不重试',
      countEvents(
        receiver,
        (request) =>
          request.path === '/gone' &&
          payloadOf(request).data.message_id === goneSent.message.message_id,
      ),
      1,
    );

    const largeUrl = receiver.url('/too-large', '?l=1');
    await subscribe(tokenB, { url: largeUrl, secret: secret1, arguments: { room_id: roomAB } });
    const largeSent = await sendMessage(agentA, roomAB, 'large-body');
    await receiver.waitForEvent(
      (request) =>
        request.path === '/too-large' &&
        payloadOf(request).data.message_id === largeSent.message.message_id,
      '等待 413',
    );
    await sleep(1_500);
    await poke(agentB.client);
    await sleep(400);
    checkEqual(
      '413 不重试',
      countEvents(
        receiver,
        (request) =>
          request.path === '/too-large' &&
          payloadOf(request).data.message_id === largeSent.message.message_id,
      ),
      1,
    );

    const slowUrl = receiver.url('/slow', '?s=1');
    const slowSub = await subscribe(tokenB, { url: slowUrl, secret: secret1, arguments: { room_id: roomAB } });
    const slowSent = await sendMessage(agentA, roomAB, 'slow-body');
    await receiver.waitForEvent(
      (request) =>
        request.path === '/slow' &&
        payloadOf(request).data.message_id === slowSent.message.message_id,
      '等待超时的第一次尝试',
    );
    await sleep(1_500);
    await poke(agentB.client);
    await receiver.waitForEvent(
      (request) =>
        request.path === '/slow' &&
        payloadOf(request).data.message_id === slowSent.message.message_id &&
        request.at > receiver.events('/slow')[0]!.at,
      '等待超时重试',
    );
    check('超时后仍保留同一订阅', slowSub.id.startsWith('sub_'));

    // 连续失败暂停 + 刷新恢复（保留 pending）。
    const failingUrl = receiver.url('/always-500', '?f=1');
    const failingSub = await subscribe(tokenB, { url: failingUrl, secret: secret1, arguments: { room_id: roomAB } });
    database
      .prepare('UPDATE mcp_event_subscriptions SET consecutive_failures = 19 WHERE subscription_id = ?')
      .run(failingSub.id);
    const failingSent = await sendMessage(agentA, roomAB, 'failure-body');
    await receiver.waitForEvent(
      (request) =>
        request.path === '/always-500' &&
        payloadOf(request).data.message_id === failingSent.message.message_id,
      '等待失败投递',
    );
    await sleep(1_500);
    await poke(agentB.client);
    await sleep(400);
    const failingRow = database
      .prepare('SELECT active, consecutive_failures FROM mcp_event_subscriptions WHERE subscription_id = ?')
      .get(failingSub.id) as { active: number; consecutive_failures: number };
    checkEqual('连续失败达到阈值后 active=0', failingRow.active, 0);
    const resumed = await subscribe(tokenB, { url: failingUrl, secret: secret1, arguments: { room_id: roomAB } });
    checkEqual('刷新恢复同一订阅', resumed.id, failingSub.id);
    const resumedRow = database
      .prepare('SELECT active, consecutive_failures FROM mcp_event_subscriptions WHERE subscription_id = ?')
      .get(failingSub.id) as { active: number; consecutive_failures: number };
    checkEqual('刷新后 active=1', resumedRow.active, 1);
    checkEqual('刷新后失败计数清零', resumedRow.consecutive_failures, 0);

    // ---------- 授权撤销 / 成员移除 / 过期 ----------
    const tokenR = newToken();
    const agentR = await connectClient(tokenR);
    const r = await registerIdentity(agentR, {
      kind: 'agent',
      name: 'Events R',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await befriend(agentA, a.actor_id, agentR, r.actor_id);
    const roomAR = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [r.actor_id],
      })
    ).room.room_id;
    const revokeSub = await subscribe(tokenR, {
      url: receiver.url('/callback', '?revoke=1'),
      secret: secret1,
      arguments: { room_id: roomAR },
    });
    database
      .prepare('UPDATE credentials SET revoked_at = ? WHERE actor_id = ?')
      .run(Date.now(), r.actor_id);
    const revokedSent = await sendMessage(agentA, roomAR, 'revoked-body');
    await runNoEventWindow(receiver, agentA.client);
    check(
      '凭据撤销后停止投递',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === revokeSub.id &&
          payloadOf(request).data.message_id === revokedSent.message.message_id,
      ),
    );
    const revokedRow = database
      .prepare('SELECT active, last_error FROM mcp_event_subscriptions WHERE subscription_id = ?')
      .get(revokeSub.id) as { active: number; last_error: string | null };
    checkEqual('凭据撤销后订阅停用', revokedRow.active, 0);
    await agentR.close();

    const tokenM = newToken();
    const agentM = await connectClient(tokenM);
    const m = await registerIdentity(agentM, {
      kind: 'agent',
      name: 'Events M',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await befriend(agentA, a.actor_id, agentM, m.actor_id);
    const roomAM = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [m.actor_id],
      })
    ).room.room_id;
    const memberSub = await subscribe(tokenM, {
      url: receiver.url('/callback', '?member=1'),
      secret: secret1,
      arguments: { room_id: roomAM },
    });
    database
      .prepare("UPDATE room_members SET status = 'removed' WHERE room_id = ? AND actor_id = ?")
      .run(roomAM, m.actor_id);
    const removedSent = await sendMessage(agentA, roomAM, 'removed-body');
    await runNoEventWindow(receiver, agentA.client);
    check(
      '成员移除后停止投递',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === memberSub.id &&
          payloadOf(request).data.message_id === removedSent.message.message_id,
      ),
    );
    const memberRow = database
      .prepare('SELECT active FROM mcp_event_subscriptions WHERE subscription_id = ?')
      .get(memberSub.id) as { active: number };
    checkEqual('成员移除后订阅停用', memberRow.active, 0);
    await agentM.close();

    // 过期订阅不投递（maintenance 停用前也不会被 dispatcher 选中）。
    database
      .prepare('UPDATE mcp_event_subscriptions SET refresh_before = ? WHERE subscription_id = ?')
      .run(Date.now() - 1_000, mainSub.id);
    const expiredSent = await sendMessage(agentA, roomAB, 'expired-body');
    await runNoEventWindow(receiver, agentA.client);
    check(
      '过期订阅不投递',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === mainSub.id &&
          payloadOf(request).data.message_id === expiredSent.message.message_id,
      ),
    );
    database
      .prepare('UPDATE mcp_event_subscriptions SET refresh_before = ? WHERE subscription_id = ?')
      .run(Date.now() + 3_600_000, mainSub.id);

    // unsubscribe 幂等 + 停止投递。
    await rawRpc(
      'events/unsubscribe',
      {
        name: EVENT_NAME,
        arguments: { room_id: roomAB, attention: 'action_required' },
        delivery: { mode: 'webhook', url: mainUrl },
      },
      { token: tokenB },
    );
    const unsubscribedSent = await sendMessage(agentA, roomAB, 'after-unsubscribe', {
      invoke: [b.actor_id],
    });
    await runNoEventWindow(receiver, agentB.client);
    check(
      'unsubscribe 后停止投递',
      !receiver.events('/callback').some(
        (request) =>
          request.subscriptionId === actionSub.id &&
          payloadOf(request).data.message_id === unsubscribedSent.message.message_id,
      ),
    );
    const repeatedUnsubscribe = await rawRpc(
      'events/unsubscribe',
      {
        name: EVENT_NAME,
        arguments: { room_id: roomAB, attention: 'action_required' },
        delivery: { mode: 'webhook', url: mainUrl },
      },
      { token: tokenB },
    );
    checkEqual('重复 unsubscribe 仍返回 200', repeatedUnsubscribe.status, 200);
    check('重复 unsubscribe 幂等返回空结果', repeatedUnsubscribe.body.error === undefined);
    await rpcError(
      'unsubscribe 未知事件名返回 -32023',
      await rawRpc(
        'events/unsubscribe',
        {
          name: 'agentnet.unknown',
          arguments: {},
          delivery: { mode: 'webhook', url: mainUrl },
        },
        { token: tokenB },
      ),
      -32023,
    );

    // ---------- 重启 ----------
    await agentA.close();
    await agentB.close();
    await agentC.close();
    await server.stop();
    const restartPending = database.prepare(`SELECT delivery_id, event_id FROM mcp_event_deliveries
      WHERE subscription_id=? AND status='delivered' ORDER BY event_seq DESC LIMIT 1`)
      .get(mainSub.id) as { delivery_id: string; event_id: string };
    // 模拟进程退出时尚未 ACK 的持久队列；启动后不发任何 MCP 请求来帮助唤醒。
    database.prepare(`UPDATE mcp_event_deliveries SET status='pending',attempts=0,
      next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE delivery_id=?`)
      .run(Date.now(), restartPending.delivery_id);
    const beforeRestartCount = receiver.requests.filter((r) => r.eventId === restartPending.event_id).length;
    await server.restart();
    await receiver.waitForEvent((r) => r.eventId === restartPending.event_id &&
      receiver.requests.filter((item) => item.eventId === restartPending.event_id).length > beforeRestartCount,
    '重启无需 MCP 请求即可恢复积压');
    check('重启自动恢复已有积压', receiver.requests.filter((r) => r.eventId === restartPending.event_id).length > beforeRestartCount);
    agentA = await connectClient(tokenA);
    agentB = await connectClient(tokenB);
    agentC = await connectClient(tokenC);
    const afterRestart = await sendMessage(agentA, roomAB, 'after-restart');
    const restartEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === mainSub.id &&
        payloadOf(request).data.message_id === afterRestart.message.message_id,
      '重启后继续投递',
    );
    check('重启后订阅仍存在并投递', Boolean(restartEvent));

    // ---------- cursor 重放 / truncated ----------
    const tokenT = newToken();
    const agentT = await connectClient(tokenT);
    const t = await registerIdentity(agentT, {
      kind: 'agent',
      name: 'Events T',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await befriend(agentA, a.actor_id, agentT, t.actor_id);
    const roomAT = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [t.actor_id],
      })
    ).room.room_id;
    const replayUrl = receiver.url('/callback', '?replay=1');
    const replayArgs = { room_id: roomAT };
    const replayFirst = await subscribe(tokenT, {
      url: replayUrl,
      secret: secret1,
      arguments: replayArgs,
    });
    const roomHead = (
      database.prepare('SELECT head_seq FROM rooms WHERE room_id = ?').get(roomAT) as {
        head_seq: number;
      }
    ).head_seq;
    database.prepare('UPDATE rooms SET events_min_seq = ? WHERE room_id = ?').run(roomHead + 100, roomAT);
    database
      .prepare("DELETE FROM events WHERE scope_kind = 'room' AND scope_id = ?")
      .run(roomAT);
    database
      .prepare('UPDATE mcp_event_subscriptions SET refresh_before = ? WHERE subscription_id = ?')
      .run(Date.now() - 1_000, replayFirst.id);
    const replayed = await subscribe(tokenT, {
      url: replayUrl,
      secret: secret1,
      arguments: replayArgs,
      cursor: '1',
    });
    checkEqual('过期刷新按 cursor 重放', replayed.id, replayFirst.id);
    checkEqual('留存不足返回 truncated=true', replayed.truncated, true);
    check(
      'cursor clamp 到留存下界',
      Number(replayed.cursor) >= roomHead + 100,
      { cursor: replayed.cursor, roomHead },
    );
    await agentT.close();

    // ---------- secret 轮换双签 ----------
    const tokenG = newToken();
    const agentG = await connectClient(tokenG);
    const g = await registerIdentity(agentG, {
      kind: 'agent',
      name: 'Events G',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await befriend(agentA, a.actor_id, agentG, g.actor_id);
    const roomAG = (
      await callTool<RoomDetail>(agentA.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'direct',
        members: [g.actor_id],
      })
    ).room.room_id;
    const rotateUrl = receiver.url('/callback', '?rotate=1');
    const secret2 = newSecret();
    const rotated = await subscribe(tokenG, {
      url: rotateUrl,
      secret: secret1,
      arguments: { room_id: roomAG },
    });
    const rotatedRefresh = await subscribe(tokenG, {
      url: rotateUrl,
      secret: secret2,
      arguments: { room_id: roomAG },
    });
    checkEqual('轮换 secret 仍是同一订阅', rotatedRefresh.id, rotated.id);
    const rotateSent = await sendMessage(agentA, roomAG, 'rotate-body');
    const rotateEvent = await receiver.waitForEvent(
      (request) =>
        request.subscriptionId === rotated.id &&
        payloadOf(request).data.message_id === rotateSent.message.message_id,
      '等待双签事件',
    );
    checkEqual('旧+新 secret 双签', signatureCandidates(rotateEvent).length, 2);
    check('旧 secret 签名可验证', verifyWebhookSignature(secret1, rotateEvent));
    check('新 secret 签名可验证', verifyWebhookSignature(secret2, rotateEvent));
    check('双签任一时有效', verifyAnyWebhookSignature([secret1, secret2], rotateEvent));
    await agentG.close();

    // ---------- 订阅上限 ----------
    const tokenL = newToken();
    const agentL = await connectClient(tokenL);
    const l = await registerIdentity(agentL, {
      kind: 'agent',
      name: 'Events L',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const credential = database
      .prepare('SELECT credential_id FROM credentials WHERE actor_id = ?')
      .get(l.actor_id) as { credential_id: string };
    const insertFake = database.prepare(
      `INSERT INTO mcp_event_subscriptions (
         subscription_id, actor_id, event_name, arguments_json, callback_url,
         callback_url_key, credential_id, secret_ciphertext, secret_nonce,
         previous_secret_ciphertext, previous_secret_nonce, previous_secret_expires_at,
         refresh_before, scanned_seq, last_scan_at, last_delivery_at, last_error,
         consecutive_failures, active, verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, '{}', ?, ?, ?, 'x', 'x', NULL, NULL, NULL, ?, 0, 0, NULL,
                 NULL, 0, 1, ?, ?, ?)`,
    );
    const fakeAt = Date.now();
    for (let index = 0; index < 20; index += 1) {
      const fakeId = `sub_fake_${index}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const fakeUrl = `https://fake.example/${fakeId}`;
      insertFake.run(
        fakeId,
        l.actor_id,
        EVENT_NAME,
        fakeUrl,
        fakeUrl,
        credential.credential_id,
        fakeAt + 3_600_000,
        fakeAt,
        fakeAt,
        fakeAt,
      );
    }
    const overLimit = await rawRpc(
      'events/subscribe',
      {
        name: EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/callback', '?limit=1'), secret: secret1 },
        cursor: null,
      },
      { token: tokenL },
    );
    const overLimitError = overLimit.body.error as
      | { code?: number; data?: Record<string, unknown> }
      | undefined;
    checkEqual('订阅数量超限返回 -32025', overLimitError?.code, -32025);
    checkEqual('订阅上限 data.limit', overLimitError?.data?.limit, 'subscriptions');
    checkEqual('订阅上限 data.max', overLimitError?.data?.max, 20);
    database.prepare("DELETE FROM mcp_event_subscriptions WHERE subscription_id LIKE 'sub_fake_%'").run();
    await agentL.close();

    // ---------- 日志脱敏 ----------
    const logs = server.logs();
    for (const [label, value] of [
      ['日志不含 secret', secret1],
      ['日志不含新 secret', secret2],
      ['日志不含 Agent A token', tokenA],
      ['日志不含 Agent B token', tokenB],
      ['日志不含正文', bodyMarker],
      ['日志不含 whsec_ 前缀', 'whsec_'],
    ] as const) {
      check(label, !logs.includes(value));
    }
    check(
      '日志不含签名',
      !logs.includes('webhook-signature') || !logs.includes('v1,'),
      logs.slice(0, 200),
    );
    for (const stage of [
      '"stage":"inbound"',
      '"stage":"validate"',
      '"stage":"verification.ok"',
      '"stage":"subscribe.persist"',
      '"stage":"delivery.result"',
    ]) {
      check(`阶段日志包含 ${stage}`, logs.includes(stage));
    }
    check('阶段日志包含 request_id', /"request_id":/u.test(logs));
    check('阶段日志只记录 callback host', logs.includes('"callback_host":"127.0.0.1"'));
    check('阶段日志不含完整 callback URL', !logs.includes('https://127.0.0.1:'));

    // ---------- 文件日志落盘 ----------
    const eventLogFile = join(DATA_DIR, 'logs', 'events.log');
    check('文件日志已落盘', existsSync(eventLogFile));
    const fileLogs = existsSync(eventLogFile) ? readFileSync(eventLogFile, 'utf8') : '';
    check('文件日志包含 verification.ok', fileLogs.includes('"stage":"verification.ok"'));
    check(
      '文件日志包含地址尝试失败记录',
      fileLogs.includes('"stage":"verification.attempt_failed"') &&
        fileLogs.includes('"address_family":4'),
    );
    check('文件日志包含 errno 分类', fileLogs.includes('"error_code":"ETIMEDOUT"'));
    for (const [label, value] of [
      ['文件日志不含 secret', secret1],
      ['文件日志不含新 secret', secret2],
      ['文件日志不含 Agent A token', tokenA],
      ['文件日志不含 Agent B token', tokenB],
      ['文件日志不含正文', bodyMarker],
      ['文件日志不含 whsec_ 前缀', 'whsec_'],
      ['文件日志不含完整 callback URL', 'https://127.0.0.1:'],
    ] as const) {
      check(label, !fileLogs.includes(value));
    }

    console.log(`MCP Events 验收通过: ${checksPassed()} 项`);
  } finally {
    await server?.stop();
    receiver.stop();
    db.current?.close();
    if (process.env.EVENTS_TEST_KEEP_DATA !== '1') removeTestData(DATA_DIR);
  }
}

main().catch((error) => {
  console.error('MCP Events 验收失败', error);
  process.exit(1);
});
