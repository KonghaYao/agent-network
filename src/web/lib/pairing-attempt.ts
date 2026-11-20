/**
 * 配对尝试上下文。
 *
 * 同一挑战内的 join / redeem 请求 ID、设备信息和本地 token 只生成一次；
 * 网络不明或显式重试复用原值，避免同一码产生第二个申请或设备。只有
 * 新的挑战（重新扫码/换短码）才重建上下文。
 */

export interface PairingAttempt {
  challenge: string;
  token: string;
  joinRequestId: string;
  redeemRequestId: string;
  deviceId: string;
  deviceLabel: string;
  platform: string;
  joined: boolean;
}

export interface PairingAttemptFactory {
  token: string;
  joinRequestId: string;
  redeemRequestId: string;
  deviceId: string;
  deviceLabel: string;
  platform: string;
}

export function resolvePairingAttempt(
  current: PairingAttempt | null,
  challenge: string,
  create: () => PairingAttemptFactory,
): { attempt: PairingAttempt; reused: boolean } {
  if (current && current.challenge === challenge) {
    return { attempt: current, reused: true };
  }
  const values = create();
  return {
    attempt: {
      challenge,
      token: values.token,
      joinRequestId: values.joinRequestId,
      redeemRequestId: values.redeemRequestId,
      deviceId: values.deviceId,
      deviceLabel: values.deviceLabel,
      platform: values.platform,
      joined: false,
    },
    reused: false,
  };
}
