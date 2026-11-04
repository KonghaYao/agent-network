/** MCP Events 参数、授权与 SSRF 策略验收（不依赖真实 callback 投递）。 */

import { check, checkEqual, rawRpc } from './harness';
import { MCP_EVENT_NAME, type TestReceiver } from './events-harness';
import {
  CallbackTargetError,
  CallbackUrlError,
  isPublicAddress,
  normalizeCallbackUrl,
  resolveCallbackTarget,
} from '../../src/events/security';

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

export async function runEventsValidationChecks(input: {
  token: string;
  roomBC: string;
  receiver: TestReceiver;
  secret: string;
}): Promise<void> {
  const { token, roomBC, receiver, secret } = input;

  await rpcError(
    '未注册身份订阅返回 -32024',
    await rawRpc('events/subscribe', {
      name: MCP_EVENT_NAME,
      arguments: {},
      delivery: { mode: 'webhook', url: receiver.url(), secret },
    }),
    -32024,
  );

  await rpcError(
    '非成员 room_id 返回 -32024',
    await rawRpc(
      'events/subscribe',
      {
        name: MCP_EVENT_NAME,
        arguments: { room_id: roomBC },
        delivery: { mode: 'webhook', url: receiver.url('/callback', '?nonmember=1'), secret },
      },
      { token },
    ),
    -32024,
  );

  for (const [label, url] of [
    ['http URL 返回 -32602', 'http://127.0.0.1/callback'],
    ['带 userinfo 的 URL 返回 -32602', 'https://user:pass@127.0.0.1/callback'],
    ['带 fragment 的 URL 返回 -32602', 'https://127.0.0.1/callback#fragment'],
    ['超长 URL 返回 -32602', `https://127.0.0.1/${'a'.repeat(5000)}`],
  ] as const) {
    await rpcError(
      label,
      await rawRpc(
        'events/subscribe',
        { name: MCP_EVENT_NAME, arguments: {}, delivery: { mode: 'webhook', url, secret } },
        { token },
      ),
      -32602,
    );
  }

  for (const [label, invalidSecret] of [
    ['缺少 whsec_ 前缀返回 -32602', Buffer.from('x'.repeat(32)).toString('base64')],
    ['secret 过短返回 -32602', `whsec_${Buffer.from('short').toString('base64')}`],
    ['secret base64 非法返回 -32602', 'whsec_***'],
  ] as const) {
    await rpcError(
      label,
      await rawRpc(
        'events/subscribe',
        {
          name: MCP_EVENT_NAME,
          arguments: {},
          delivery: { mode: 'webhook', url: receiver.url('/callback', '?badsecret=1'), secret: invalidSecret },
        },
        { token },
      ),
      -32602,
    );
  }

  const invalidDelivery = await rawRpc(
    'events/subscribe',
    {
      name: MCP_EVENT_NAME,
      arguments: {},
      delivery: { mode: 'poll', url: receiver.url(), secret },
    },
    { token },
  );
  const deliveryError = invalidDelivery.body.error as
    | { code?: number; data?: Record<string, unknown> }
    | undefined;
  checkEqual('非 webhook mode 返回 -32026', deliveryError?.code, -32026);
  checkEqual('非 webhook mode data.feature', deliveryError?.data?.feature, 'deliveryMode');

  await rpcError(
    '负数 ttlMs 返回 -32602',
    await rawRpc(
      'events/subscribe',
      {
        name: MCP_EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/callback', '?ttl=bad'), secret },
        ttlMs: -1,
      },
      { token },
    ),
    -32602,
  );

  await rpcError(
    '非法 cursor 返回 -32602',
    await rawRpc(
      'events/subscribe',
      {
        name: MCP_EVENT_NAME,
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url('/callback', '?cursor=bad'), secret },
        cursor: 'abc',
      },
      { token },
    ),
    -32602,
  );

  await rpcError(
    '未知事件名返回 -32023',
    await rawRpc(
      'events/subscribe',
      {
        name: 'agentnet.unknown',
        arguments: {},
        delivery: { mode: 'webhook', url: receiver.url(), secret },
      },
      { token },
    ),
    -32023,
  );

  // SSRF 单元：只验证拒绝，不探测内部网络。
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
    check(`非公网地址被拒绝: ${address}`, !isPublicAddress(address));
  }
  check('公网地址被接受: 8.8.8.8', isPublicAddress('8.8.8.8'));
  try {
    await resolveCallbackTarget(new URL('https://127.0.0.1:1/callback'), {
      allowPrivateCallbacks: false,
      callbackAllowlist: null,
    });
    check('私网 callback 被拒绝', false);
  } catch (error) {
    check(
      '私网 callback 返回 blocked_address',
      error instanceof CallbackTargetError && error.reason === 'blocked_address',
    );
  }
  try {
    normalizeCallbackUrl('https://localhost/callback', {
      allowPrivateCallbacks: false,
      callbackAllowlist: null,
    });
    check('localhost hostname 被拒绝', false);
  } catch (error) {
    check(
      'localhost hostname 返回 private_address',
      error instanceof CallbackUrlError && error.reason === 'private_address',
    );
  }
}
