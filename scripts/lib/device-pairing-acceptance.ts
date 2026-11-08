/**
 * Q02-T01/T02：安全设备配对、设备列表与单设备撤销。
 *
 * T01：两设备配对后同一 actor、不同 credential；撤销一台后另一台仍可用，
 * 设备列表显示 current/label/platform/last_seen。
 * T02：过期、重放、第三设备抢扫、未批准、已撤销挑战、尝试超限均失败；
 * challenge/token 明文不回放，redeem 从不返回 token。
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
  openRawListen,
  rawRpc,
  sleep,
  waitUntil,
  type McpConnection,
} from './harness';
import { registerIdentity, type Identity } from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';

interface PairingCreated {
  pairing_id: string;
  challenge: string;
  pair_url: string;
  expires_at: string;
  created_at: string;
}

interface PairingView {
  pairing_id: string;
  status: 'pending' | 'approved' | 'redeemed' | 'expired' | 'cancelled';
  actor_id: string;
  device_id: string | null;
  device_label: string;
  platform: string;
  confirm_code: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  redeemed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  attempts: number;
  max_attempts: number;
  created_by_current_device: boolean;
}

interface PairingJoinResult {
  pairing: PairingView;
  actor: { actor_id: string; name: string; kind: 'human' | 'agent' };
}

interface PairingListResult {
  items: PairingView[];
  pending_count: number;
}

interface PairingRedeemResult extends Identity {
  paired: true;
  device_id: string;
  pairing_id: string;
  token?: string;
}

interface DeviceView {
  device_id: string;
  label: string;
  platform: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  current: boolean;
  active_credentials: number;
  total_credentials: number;
}

interface DeviceListResult {
  items: DeviceView[];
  current_device_id: string | null;
}

function errorReason(error: { body: Record<string, unknown> }): unknown {
  const details = error.body.details as Record<string, unknown> | undefined;
  return details?.reason;
}

async function createPairing(
  connection: McpConnection,
  options: { requestId?: string; expiresInMs?: number; label?: string } = {},
): Promise<PairingCreated> {
  return callTool<PairingCreated>(connection.client, 'network_device_pairing_create', {
    request_id: options.requestId ?? newRequestId('pair_create'),
    ...(options.expiresInMs !== undefined ? { expires_in_ms: options.expiresInMs } : {}),
    device_label: options.label ?? '桌面验收设备',
    platform: 'macOS',
  });
}

async function joinPairing(
  connection: McpConnection,
  challenge: string,
  deviceId: string,
  options: { requestId?: string; label?: string } = {},
): Promise<PairingJoinResult> {
  return callTool<PairingJoinResult>(connection.client, 'network_device_pairing_join', {
    request_id: options.requestId ?? newRequestId('pair_join'),
    challenge,
    device_id: deviceId,
    device_label: options.label ?? '新手机',
    platform: 'iOS',
  });
}

async function approvePairing(
  connection: McpConnection,
  pairingId: string,
): Promise<{ pairing: PairingView }> {
  return callTool<{ pairing: PairingView }>(connection.client, 'network_device_pairing_approve', {
    request_id: newRequestId('pair_ok'),
    pairing_id: pairingId,
  });
}

async function cancelPairing(
  connection: McpConnection,
  pairingId: string,
  reason = '验收拒绝',
): Promise<{ pairing: PairingView }> {
  return callTool<{ pairing: PairingView }>(connection.client, 'network_device_pairing_cancel', {
    request_id: newRequestId('pair_cancel'),
    pairing_id: pairingId,
    reason,
  });
}

async function redeemPairing(
  connection: McpConnection,
  challenge: string,
  deviceId: string,
  requestId?: string,
): Promise<PairingRedeemResult> {
  return callTool<PairingRedeemResult>(connection.client, 'network_device_pairing_redeem', {
    request_id: requestId ?? newRequestId('pair_redeem'),
    challenge,
    device_id: deviceId,
  });
}

async function listPairings(connection: McpConnection): Promise<PairingListResult> {
  return callTool<PairingListResult>(connection.client, 'network_device_pairing_list', {
    limit: 50,
  });
}

async function listDevices(connection: McpConnection): Promise<DeviceListResult> {
  return callTool<DeviceListResult>(connection.client, 'network_device_list', {});
}

export async function runDevicePairingAcceptance(): Promise<void> {
  console.log('Q02-T01/T02 设备配对与撤销');
  const humanToken = newToken();
  const human = await connectClient(humanToken);
  const newDeviceAToken = newToken();
  const newDeviceA = await connectClient(newDeviceAToken);
  const newDeviceB = await connectClient(newToken());
  const extra: McpConnection[] = [];
  try {
    const identity = await registerIdentity(human, { kind: 'human', name: 'Q02 配对人类' });

    // T01: 两设备配对，同一 actor、不同 credential。
    const created = await createPairing(human);
    check('T01 create 返回 12 位挑战', /^[0-9A-HJKMNP-TV-Z]{12}$/u.test(created.challenge), created);
    checkEqual(
      'T01 二维码只包含 /pair#c= 挑战',
      created.pair_url,
      `${baseUrl()}/pair#c=${encodeURIComponent(created.challenge)}`,
    );
    check(
      'T01 create 响应不含当前 token',
      !JSON.stringify(created).includes(humanToken),
      created,
    );
    checkEqual('T01 create 不返回 token 字段', 'token' in created, false);

    const joined = await joinPairing(newDeviceA, created.challenge, 'device-phone-a', {
      label: '验收手机 A',
    });
    checkEqual('T01 join 绑定到同一 actor', joined.actor.actor_id, identity.actor_id);
    checkEqual('T01 join 后状态 pending', joined.pairing.status, 'pending');
    checkEqual('T01 join 绑定设备标识', joined.pairing.device_id, 'device-phone-a');
    check('T01 join 返回确认码', Boolean(joined.pairing.confirm_code), joined.pairing.confirm_code);
    checkEqual('T01 join 不返回 token', 'token' in joined, false);

    const pendingList = await listPairings(human);
    const pending = pendingList.items.find((item) => item.pairing_id === created.pairing_id);
    checkEqual('T01 已登录设备看到 pending 请求', pending?.status, 'pending');
    checkEqual('T01 两端确认码一致', pending?.confirm_code, joined.pairing.confirm_code);
    checkEqual('T01 列表标记由当前设备创建', pending?.created_by_current_device, true);
    checkEqual('T01 pending_count 为 1', pendingList.pending_count, 1);

    const early = await expectToolError(
      'T01 未批准 redeem 失败',
      redeemPairing(newDeviceA, created.challenge, 'device-phone-a'),
      'PAIRING_INVALID',
    );
    checkEqual('T01 未批准错误说明 not_approved', errorReason(early), 'not_approved');

    const approved = await approvePairing(human, created.pairing_id);
    checkEqual('T01 approve 后状态 approved', approved.pairing.status, 'approved');

    const redeemRequestId = newRequestId('pair_redeem');
    const redeemed = await redeemPairing(
      newDeviceA,
      created.challenge,
      'device-phone-a',
      redeemRequestId,
    );
    checkEqual('T01 redeem 返回同一 actor', redeemed.actor_id, identity.actor_id);
    checkEqual('T01 redeem 返回 paired', redeemed.paired, true);
    checkEqual('T01 redeem 绑定设备', redeemed.device_id, 'device-phone-a');
    checkEqual('T01 redeem 不返回 token', 'token' in redeemed, false);
    const meA = await callTool<Identity>(newDeviceA.client, 'network_me', {});
    checkEqual('T01 新设备 network_me 为同一 actor', meA.actor_id, identity.actor_id);

    const replay = await redeemPairing(
      newDeviceA,
      created.challenge,
      'device-phone-a',
      redeemRequestId,
    );
    checkEqual('T01 同一 request_id 重放返回同一 actor', replay.actor_id, identity.actor_id);
    checkEqual('T01 重放仍不返回 token', 'token' in replay, false);

    const devices = await listDevices(human);
    checkEqual('T01 设备列表包含两台设备', devices.items.length, 2);
    const desktop = devices.items.find((item) => item.current);
    const phone = devices.items.find((item) => item.device_id === 'device-phone-a');
    check('T01 当前设备被标记', Boolean(desktop), devices.items);
    checkEqual('T01 新设备不是 current', phone?.current, false);
    checkEqual('T01 新设备名称', phone?.label, '验收手机 A');
    checkEqual('T01 新设备平台', phone?.platform, 'iOS');
    check('T01 当前设备 last_seen 非空', Boolean(desktop?.last_seen_at), desktop);
    check('T01 新设备 last_seen 非空', Boolean(phone?.last_seen_at), phone);
    checkEqual('T01 新设备有有效 credential', phone?.active_credentials, 1);
    checkEqual('T01 设备列表不返回 token', JSON.stringify(devices).includes(humanToken), false);

    // 撤销 B：只撤销 B 的 credential 与 stream，A 保持可用。
    // 使用原始 listen 显式指定 subscription id，避免同一 actor 的 SDK 客户端 id 冲突。
    const streamA = await openRawListen(humanToken, 'q02_pair_stream_a', [STREAM_URI]);
    const streamB = await openRawListen(newDeviceAToken, 'q02_pair_stream_b', [STREAM_URI]);
    await streamA.waitForFrame(
      (frame) => frame.includes('notifications/subscriptions/acknowledged'),
      'T01 A stream ack',
    );
    await streamB.waitForFrame(
      (frame) => frame.includes('notifications/subscriptions/acknowledged'),
      'T01 B stream ack',
    );
    await sleep(200);
    const revoked = await callTool<{
      device_id: string;
      revoked_credentials: number;
      already_revoked: boolean;
    }>(human.client, 'network_device_revoke', {
      request_id: newRequestId('device_revoke'),
      device_id: 'device-phone-a',
    });
    checkEqual('T01 撤销返回设备标识', revoked.device_id, 'device-phone-a');
    checkEqual('T01 只撤销一个有效 credential', revoked.revoked_credentials, 1);
    checkEqual('T01 首次撤销不是 already_revoked', revoked.already_revoked, false);
    await streamB.waitForFrame(
      (frame) => frame.includes('"resultType":"complete"'),
      'T01 被撤销设备的 stream 收到 complete',
      5_000,
    );
    checkEqual(
      'T01 被撤销设备的 stream 被服务端关闭',
      streamB.frames.some((frame) => frame.includes('"resultType":"complete"')),
      true,
    );
    await sleep(500);
    checkEqual(
      'T01 另一台设备的 stream 保持打开',
      streamA.frames.some((frame) => frame.includes('"resultType":"complete"')),
      false,
    );
    await streamA.close();
    await streamB.close();

    const revokedCall = await rawRpc(
      'tools/call',
      { name: 'network_me', arguments: {} },
      { token: newDeviceAToken },
    );
    checkEqual('T01 被撤销设备调用工具返回 401', revokedCall.status, 401);
    const revokedCode = (
      revokedCall.body.error as { data?: { code?: string } } | undefined
    )?.data?.code;
    checkEqual('T01 被撤销设备错误码 CREDENTIAL_INVALID', revokedCode, 'CREDENTIAL_INVALID');
    const meDesktop = await callTool<Identity>(human.client, 'network_me', {});
    checkEqual('T01 未撤销设备仍可用', meDesktop.actor_id, identity.actor_id);

    const devicesAfter = await listDevices(human);
    const phoneAfter = devicesAfter.items.find((item) => item.device_id === 'device-phone-a');
    checkEqual('T01 撤销后设备状态 revoked', phoneAfter?.status, 'revoked');
    checkEqual('T01 撤销后无有效 credential', phoneAfter?.active_credentials, 0);
    check('T01 撤销后 revoked_at 非空', Boolean(phoneAfter?.revoked_at), phoneAfter);
    const repeat = await callTool<{ already_revoked: boolean; revoked_credentials: number }>(
      human.client,
      'network_device_revoke',
      { request_id: newRequestId('device_revoke'), device_id: 'device-phone-a' },
    );
    checkEqual('T01 重复撤销幂等', repeat.already_revoked, true);
    checkEqual('T01 重复撤销不再撤销 credential', repeat.revoked_credentials, 0);

    // T02: 过期。
    const expiring = await createPairing(human, { expiresInMs: 1_200, label: '短时挑战' });
    await sleep(1_500);
    const expired = await expectToolError(
      'T02 过期挑战 join 失败',
      joinPairing(newDeviceB, expiring.challenge, 'device-phone-b'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 过期原因 expired', errorReason(expired), 'expired');

    // T02: 重放 create 不返回挑战明文。
    const createRequestId = newRequestId('pair_create');
    const firstCreate = await createPairing(human, { requestId: createRequestId });
    const replayCreate = await expectToolError(
      'T02 create 重放不返回挑战',
      createPairing(human, { requestId: createRequestId }),
      'TOKEN_NOT_REPLAYABLE',
    );
    check(
      'T02 TOKEN_NOT_REPLAYABLE 不包含挑战',
      !JSON.stringify(replayCreate.body).includes(firstCreate.challenge),
      replayCreate.body,
    );

    // T02: 第三设备抢扫与未批准。
    const challenge2 = await createPairing(human, { label: '第三设备测试' });
    const joinedB = await joinPairing(newDeviceB, challenge2.challenge, 'device-phone-b');
    const intruder = await connectClient(newToken());
    extra.push(intruder);
    const stealJoin = await expectToolError(
      'T02 第三设备抢绑失败',
      joinPairing(intruder, challenge2.challenge, 'device-evil'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 抢绑原因是 device_mismatch', errorReason(stealJoin), 'device_mismatch');
    const notApproved = await expectToolError(
      'T02 批准前 redeem 失败',
      redeemPairing(newDeviceB, challenge2.challenge, 'device-phone-b'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 批准前原因是 not_approved', errorReason(notApproved), 'not_approved');
    await approvePairing(human, challenge2.pairing_id);
    const stealRedeem = await expectToolError(
      'T02 第三设备用不同 token 兑换失败',
      redeemPairing(intruder, challenge2.challenge, 'device-evil'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 兑换失败原因是 device_mismatch', errorReason(stealRedeem), 'device_mismatch');

    // 第三设备抢绑消耗了 1 次，B 仍可兑换。
    const redeemB = await redeemPairing(newDeviceB, challenge2.challenge, 'device-phone-b');
    checkEqual('T02 已绑定设备兑换成功', redeemB.actor_id, identity.actor_id);
    const reused = await expectToolError(
      'T02 已兑换挑战不能再次兑换',
      redeemPairing(intruder, challenge2.challenge, 'device-phone-b'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 重放使用原因 already_redeemed', errorReason(reused), 'already_redeemed');
    const replayBody = JSON.stringify(reused.body);
    check('T02 已兑换错误不返回 token', !replayBody.includes(humanToken), reused.body);

    // T02: 已撤销挑战（每次配对使用新的未注册设备连接）。
    const deviceC = await connectClient(newToken());
    const deviceOwner = await connectClient(newToken());
    extra.push(deviceC, deviceOwner);
    const challenge3 = await createPairing(human, { label: '撤销挑战' });
    const joinedC = await joinPairing(deviceC, challenge3.challenge, 'device-phone-c');
    checkEqual('T02 第三个挑战 join 成功', joinedC.pairing.status, 'pending');
    const cancelled = await cancelPairing(human, challenge3.pairing_id);
    checkEqual('T02 cancel 后状态 cancelled', cancelled.pairing.status, 'cancelled');
    const cancelledRedeem = await expectToolError(
      'T02 已撤销挑战 redeem 失败',
      redeemPairing(deviceC, challenge3.challenge, 'device-phone-c'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 已撤销原因 cancelled', errorReason(cancelledRedeem), 'cancelled');
    const cancelledApprove = await expectToolError(
      'T02 已撤销挑战不能批准',
      approvePairing(human, challenge3.pairing_id),
      'PAIRING_INVALID',
    );
    checkEqual('T02 已撤销批准原因 cancelled', errorReason(cancelledApprove), 'cancelled');

    // T02: 尝试超限。挑战绑定 owner 后，intruder 连续 5 次用不同 request_id 抢绑。
    const challenge4 = await createPairing(human, { label: '尝试上限' });
    await joinPairing(deviceOwner, challenge4.challenge, 'device-limit-owner');
    let lastAttempt = 0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failure = await expectToolError(
        `T02 第 ${attempt} 次错误设备尝试失败`,
        joinPairing(intruder, challenge4.challenge, `device-limit-${attempt}`, {
          requestId: newRequestId('pair_attempt'),
        }),
        'PAIRING_INVALID',
      );
      lastAttempt = attempt;
      if (attempt === 5) {
        checkEqual('T02 第五次错误尝试报告超限', errorReason(failure), 'attempts_exceeded');
      }
    }
    checkEqual('T02 错误尝试次数', lastAttempt, 5);
    const exhausted = await expectToolError(
      'T02 尝试超限后绑定设备也不能兑换',
      redeemPairing(deviceOwner, challenge4.challenge, 'device-limit-owner'),
      'PAIRING_INVALID',
    );
    checkEqual('T02 超限后原因 attempts_exceeded', errorReason(exhausted), 'attempts_exceeded');
    const listAfterExhausted = await listPairings(human);
    const exhaustedRow = listAfterExhausted.items.find(
      (item) => item.pairing_id === challenge4.pairing_id,
    );
    checkEqual('T02 超限挑战状态 cancelled', exhaustedRow?.status, 'cancelled');
    check(
      'T02 超限记录 attempts 达到上限',
      Number(exhaustedRow?.attempts) >= Number(exhaustedRow?.max_attempts),
      exhaustedRow,
    );

    // T02: 挑战本身不进入设备列表/配对列表输出之外的持久秘密。
    check(
      'T02 配对列表不含挑战明文',
      !JSON.stringify(await listPairings(human)).includes(challenge4.challenge),
    );

    await waitUntil('T02 设备列表包含已配对的新设备', async () => {
      const current = await listDevices(human);
      return current.items.some((item) => item.device_id === 'device-phone-b');
    });
  } finally {
    await Promise.all([newDeviceA.close(), newDeviceB.close(), human.close(), ...extra.map((c) => c.close())]);
  }
}
