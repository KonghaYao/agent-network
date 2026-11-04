/**
 * MCP Events callback 客户端单元验收：
 * - 多地址解析、逐地址 SSRF 校验与 IPv4 优先顺序；
 * - IPv6 失败后回退 IPv4；
 * - 全部地址失败与超时的错误分类。
 *
 * 只使用本地自签 receiver 与注入的解析结果，不访问真实 callback。
 */

import { check, checkEqual } from './harness';
import type { TestReceiver } from './events-harness';
import {
  CallbackRequestError,
  postCallbackToTargets,
  type PostCallbackInput,
} from '../../src/events/client';
import {
  CallbackTargetError,
  resolveCallbackTargets,
  type CallbackTarget,
} from '../../src/events/security';

const rules = { allowPrivateCallbacks: true, callbackAllowlist: null } as const;

function inputFor(url: string, timeoutMs = 2_000): PostCallbackInput {
  return {
    url: new URL(url),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'verification', challenge: 'test-challenge' }),
    timeoutMs,
    maxResponseBytes: 4096,
    rules,
  };
}

async function closedPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = server.port ?? 0;
  server.stop(true);
  return port;
}

async function expectRequestError(
  label: string,
  promise: Promise<unknown>,
): Promise<CallbackRequestError> {
  try {
    await promise;
  } catch (error) {
    check(label, error instanceof CallbackRequestError);
    return error as CallbackRequestError;
  }
  check(`${label}（实际成功）`, false);
  return new CallbackRequestError('network_error', null, 'unreachable');
}

export async function runEventsClientChecks(input: { receiver: TestReceiver }): Promise<void> {
  const { receiver } = input;

  // 逐地址 SSRF 校验：私网候选被丢弃，公网候选保留；顺序稳定为 IPv4 优先。
  const mixed = await resolveCallbackTargets(
    new URL('https://callback.example/challenge'),
    { allowPrivateCallbacks: false, callbackAllowlist: null },
    async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '10.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1001', family: 6 },
    ],
  );
  checkEqual('解析保留全部公网地址', mixed.length, 4);
  checkEqual('IPv4 优先且保持解析顺序', mixed.map((item) => item.address).join(','), '8.8.8.8,1.1.1.1,2606:4700:4700::1111,2606:4700:4700::1001');
  check('私网候选不进入结果', mixed.every((item) => item.address !== '10.0.0.1'));

  const firstPrivate = await resolveCallbackTargets(
    new URL('https://callback.example/challenge'),
    { allowPrivateCallbacks: false, callbackAllowlist: null },
    async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ],
  );
  checkEqual('首个候选被拒不影响后续候选', firstPrivate[0]?.address, '8.8.8.8');

  try {
    await resolveCallbackTargets(
      new URL('https://callback.example/challenge'),
      { allowPrivateCallbacks: false, callbackAllowlist: null },
      async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
    );
    check('全部候选非公网时拒绝', false);
  } catch (error) {
    check(
      '全部候选非公网返回 blocked_address',
      error instanceof CallbackTargetError && error.reason === 'blocked_address',
    );
  }

  // 首个 IPv6 地址连接失败 → 回退 IPv4 成功。
  const fallbackUrl = `https://localhost:${receiver.port}/fallback-client-check`;
  const fallbackTargets: CallbackTarget[] = [
    { hostname: 'localhost', address: '::1', family: 6 },
    { hostname: 'localhost', address: '127.0.0.1', family: 4 },
  ];
  const fallback = await postCallbackToTargets(inputFor(fallbackUrl), fallbackTargets);
  checkEqual('IPv6 失败后回退 IPv4 成功', fallback.status, 200);
  check(
    '回退后 receiver 收到请求',
    receiver.requests.some((request) => request.path === '/fallback-client-check'),
  );

  // 全部地址连接失败：分类为 connection_refused 且保留每次 attempt。
  const port = await closedPort();
  const allFailed = await expectRequestError(
    '全部地址失败抛出 CallbackRequestError',
    postCallbackToTargets(inputFor(`https://127.0.0.1:${port}/closed`), [
      { hostname: '127.0.0.1', address: '127.0.0.1', family: 4 },
      { hostname: '127.0.0.1', address: '::1', family: 6 },
    ]),
  );
  checkEqual('全部地址失败 reason=connection_refused', allFailed.reason, 'connection_refused');
  checkEqual('全部地址失败保留 errno', allFailed.code, 'ECONNREFUSED');
  checkEqual('全部地址失败记录 attempt 数', allFailed.attemptCount, 2);
  checkEqual('attempt 顺序与目标一致', allFailed.attempts.map((item) => item.family).join(','), '4,6');

  // 单地址超时：总预算耗尽后分类为 timeout。
  const slowUrl = receiver.url('/verify-slow');
  const slow = await expectRequestError(
    '超时抛出 CallbackRequestError',
    postCallbackToTargets(inputFor(slowUrl, 150), [
      { hostname: '127.0.0.1', address: '127.0.0.1', family: 4 },
    ]),
  );
  checkEqual('超时 reason=timeout', slow.reason, 'timeout');
  checkEqual('超时保留 errno', slow.code, 'ETIMEDOUT');
  checkEqual('超时记录 attempt 数', slow.attemptCount, 1);
}
