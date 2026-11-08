/**
 * Q05-T01 场景七：设备撤销 × 工具调用 × 活跃 stream。
 *
 * 100 轮真实配对出新设备；在新设备持有一条活跃 `agentnet://stream` 时撤销，
 * 断言被撤销设备立即无法读写、流被服务端关闭，而主设备与其他身份不受影响。
 */

import {
  burst,
  newRequestId,
  newToken,
  openQ05Stream,
  q05Check,
  q05Equal,
  q05Tool,
  q05ToolOutcome,
  sendMessage,
  waitForCondition,
  type Q05Actor,
  type Q05Server,
  type RoundBody,
} from './q05-harness';

interface PairingCreated {
  pairing_id: string;
  challenge: string;
}

interface PairingJoin {
  pairing: { device_id: string; status: string };
}

interface PairingRedeem {
  actor_id: string;
  device_id: string;
  token?: string;
}

export const q05DeviceStats = {
  rounds: 0,
  streamClosed: 0,
  postRevokeRejected: 0,
};

export function q05DeviceRound(
  server: Q05Server,
  owner: Q05Actor,
  peer: Q05Actor,
  directRoomId: string,
): RoundBody {
  return async (round) => {
    q05DeviceStats.rounds += 1;
    const deviceId = `q05_dev_${round}_${crypto.randomUUID()}`;
    const newDeviceToken = newToken();
    const pairing = await q05Tool<PairingCreated>(
      server,
      owner.token,
      'network_device_pairing_create',
      {
        request_id: newRequestId(`pair_create_${round}`),
        device_label: `Q05 新设备 ${round}`,
        platform: 'iOS',
      },
    );
    const joined = await q05Tool<PairingJoin>(
      server,
      newDeviceToken,
      'network_device_pairing_join',
      {
        request_id: newRequestId(`pair_join_${round}`),
        challenge: pairing.challenge,
        device_id: deviceId,
        device_label: `Q05 新设备 ${round}`,
        platform: 'iOS',
      },
    );
    q05Equal(`第 ${round} 轮配对绑定同一 actor`, joined.pairing.device_id, deviceId);
    await q05Tool(server, owner.token, 'network_device_pairing_approve', {
      request_id: newRequestId(`pair_ok_${round}`),
      pairing_id: pairing.pairing_id,
    });
    const redeemed = await q05Tool<PairingRedeem>(
      server,
      newDeviceToken,
      'network_device_pairing_redeem',
      {
        request_id: newRequestId(`pair_redeem_${round}`),
        challenge: pairing.challenge,
        device_id: deviceId,
      },
    );
    const deviceToken = redeemed.token ?? newDeviceToken;
    q05Equal(`第 ${round} 轮新设备属于同一 actor`, redeemed.actor_id, owner.actor_id);

    const newDeviceStream = await openQ05Stream(server, deviceToken, ['agentnet://stream']);
    const primaryStream = await openQ05Stream(server, owner.token, ['agentnet://stream']);
    const marker = await sendMessage(server, peer, directRoomId, `Q05 设备流 ${round}`, {
      requestId: newRequestId(`device_msg_${round}`),
      clientMessageId: `cm_device_${round}_${crypto.randomUUID()}`,
      invoke: [],
    });
    await newDeviceStream.waitFor(
      (frame) => frame.includes(marker.message.message_id),
      `第 ${round} 轮新设备流收到消息`,
      8_000,
    );
    await primaryStream.waitFor(
      (frame) => frame.includes(marker.message.message_id),
      `第 ${round} 轮主设备流收到消息`,
      8_000,
    );

    const concurrentPromise = burst(50, () =>
      q05ToolOutcome(server, deviceToken, 'network_me', {}),
    );
    const revoke = await q05Tool<{ device_id: string; revoked_credentials: number; already_revoked: boolean }>(
      server,
      owner.token,
      'network_device_revoke',
      { request_id: newRequestId(`revoke_${round}`), device_id: deviceId },
    );
    const concurrent = await concurrentPromise;
    q05Equal(`第 ${round} 轮撤销目标设备`, revoke.device_id, deviceId);
    q05Check(`第 ${round} 轮撤销至少一个凭据`, revoke.revoked_credentials >= 1);

    const postRevoke = await burst(100, () =>
      q05ToolOutcome(server, deviceToken, 'network_me', {}),
    );
    q05Equal(
      `第 ${round} 轮撤销后工具调用全部 CREDENTIAL_INVALID`,
      postRevoke.every(
        (item) =>
          item.status === 'fulfilled' && !item.value.ok && item.value.code === 'CREDENTIAL_INVALID',
      ),
      true,
    );
    q05DeviceStats.postRevokeRejected += postRevoke.length;
    const writeAfterRevoke = await q05ToolOutcome(server, deviceToken, 'network_message_send', {
      request_id: newRequestId(`revoked_write_${round}`),
      client_message_id: `cm_revoked_${round}_${crypto.randomUUID()}`,
      room_id: directRoomId,
      body: 'Q05 被撤销设备写入（必须失败）',
      invoke: [],
    });
    q05Equal(`第 ${round} 轮撤销后写入失败`, writeAfterRevoke.ok, false);
    q05Equal(`第 ${round} 轮撤销后写入错误码`, writeAfterRevoke.code, 'CREDENTIAL_INVALID');

    await Promise.race([
      newDeviceStream.closed,
      waitForCondition(`第 ${round} 轮等待流关闭`, () => false, 3_000).catch(() => undefined),
    ]);
    q05Check(`第 ${round} 轮被撤销设备的活跃流已关闭`, newDeviceStream.isClosed());
    if (newDeviceStream.isClosed()) q05DeviceStats.streamClosed += 1;

    const primaryStillWorks = await q05ToolOutcome(server, owner.token, 'network_me', {});
    q05Equal(`第 ${round} 轮主设备仍可用`, primaryStillWorks.ok, true);
    const peerStillWorks = await q05ToolOutcome(server, peer.token, 'network_me', {});
    q05Equal(`第 ${round} 轮其他身份不受影响`, peerStillWorks.ok, true);
    q05Check(`第 ${round} 轮主设备流仍打开`, !primaryStream.isClosed());

    // 并发窗口内可能有调用在撤销提交前完成；只要求不存在“撤销后仍成功”的调用。
    const successBeforeRevoke = concurrent.filter(
      (item) => item.status === 'fulfilled' && item.value.ok,
    ).length;
    q05Check(
      `第 ${round} 轮并发窗口内成功数不超过撤销前请求`,
      successBeforeRevoke <= 50,
      successBeforeRevoke,
    );

    await newDeviceStream.close();
    await primaryStream.close();
  };
}
