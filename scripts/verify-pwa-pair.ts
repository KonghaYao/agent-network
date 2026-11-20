/**
 * PWA 阶段 2b 单元验收：二维码 URL 校验、挑战解析、配对尝试去重、相机
 * 生命周期闸门，以及用仓库内生成的 QR 图片真实走一遍 `jsqr` 解码。
 *
 * 相机权限、原生 BarcodeDetector 与真实轨道停止由 Playwright 用例覆盖；
 * 真机相机指示与安装生命周期不在本脚本范围。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import jsQR from 'jsqr';
import { encode } from 'uqr';

import {
  pairingChallengeFromHash,
  parsePairingQr,
  type PairingQrResult,
} from '../src/web/lib/pairing-qr';
import { resolvePairingAttempt, type PairingAttempt } from '../src/web/lib/pairing-attempt';
import { ScannerLifecycle } from '../src/web/features/pairing/scanner-lifecycle';
import { check, checkEqual, checksPassed } from './lib/harness';

const REPO_ROOT = resolve(import.meta.dir, '..');
const ORIGIN = 'https://bots.example';
const CHALLENGE = 'ABCD1234EFGH';
const PAYLOAD = `${ORIGIN}/pair#c=${CHALLENGE}`;

function expectFailure(label: string, result: PairingQrResult, reason: string): void {
  check(`${label} 被拒绝`, result.ok === false, result);
  if (!result.ok) checkEqual(`${label} 原因`, result.reason, reason);
}

function verifyQrParser(): void {
  console.log('二维码 URL 校验');
  const valid = parsePairingQr(PAYLOAD, ORIGIN);
  check('同源 /pair 挑战通过', valid.ok === true, valid);
  if (valid.ok) checkEqual('挑战值', valid.challenge, CHALLENGE);

  const encoded = parsePairingQr(`${ORIGIN}/pair#c=ABCD%31%32%33%34EFGH`, ORIGIN);
  check('合法百分号编码只解码一次', encoded.ok === true && encoded.challenge === CHALLENGE, encoded);

  expectFailure('外域二维码', parsePairingQr('https://evil.example/pair#c=ABCD1234EFGH', ORIGIN), 'cross-origin');
  expectFailure('子路径', parsePairingQr(`${ORIGIN}/pair/extra#c=ABCD1234EFGH`, ORIGIN), 'wrong-path');
  expectFailure('会话路径', parsePairingQr(`${ORIGIN}/c/rm_1#c=ABCD1234EFGH`, ORIGIN), 'wrong-path');
  expectFailure('带 query', parsePairingQr(`${ORIGIN}/pair?scan=1#c=ABCD1234EFGH`, ORIGIN), 'query');
  expectFailure('缺少挑战', parsePairingQr(`${ORIGIN}/pair`, ORIGIN), 'missing-challenge');
  expectFailure('旧 #t= 链接', parsePairingQr(`${ORIGIN}/#t=token`, ORIGIN), 'wrong-path');
  expectFailure('相对 URL', parsePairingQr('/pair#c=ABCD1234EFGH', ORIGIN), 'invalid-url');
  expectFailure('非网页协议', parsePairingQr('javascript:alert(1)', ORIGIN), 'invalid-url');
  expectFailure(
    '带账号信息',
    parsePairingQr('https://user:pass@bots.example/pair#c=ABCD1234EFGH', ORIGIN),
    'invalid-url',
  );
  expectFailure(
    '多参数',
    parsePairingQr(`${ORIGIN}/pair#c=ABCD1234EFGH&x=1`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '重复 fragment',
    parsePairingQr(`${ORIGIN}/pair#c=ABCD1234EFGH#x`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '空挑战',
    parsePairingQr(`${ORIGIN}/pair#c=`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '小写挑战',
    parsePairingQr(`${ORIGIN}/pair#c=abcd1234efgh`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '含易混淆字符',
    parsePairingQr(`${ORIGIN}/pair#c=ABCD1234EFGI`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '长度不足',
    parsePairingQr(`${ORIGIN}/pair#c=ABCD1234EFG`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '长度超出',
    parsePairingQr(`${ORIGIN}/pair#c=ABCD1234EFGHJ`, ORIGIN),
    'invalid-challenge',
  );
  expectFailure(
    '畸形百分号',
    parsePairingQr(`${ORIGIN}/pair#c=%E0%A4%A`, ORIGIN),
    'invalid-challenge',
  );

  checkEqual('地址栏挑战解析', pairingChallengeFromHash('#c=ABCD1234EFGH'), CHALLENGE);
  checkEqual('地址栏非 c fragment', pairingChallengeFromHash('#t=token'), '');
  checkEqual('地址栏畸形百分号', pairingChallengeFromHash('#c=%E0%A4%A'), '');
}

function verifyAttemptReuse(): void {
  console.log('配对尝试去重');
  let joins = 0;
  let redeems = 0;
  const factory = () => ({
    token: `token-${joins + redeems}`,
    joinRequestId: `join-${(joins += 1)}`,
    redeemRequestId: `redeem-${(redeems += 1)}`,
    deviceId: 'device-1',
    deviceLabel: 'iPhone',
    platform: 'iPhone',
  });

  const first = resolvePairingAttempt(null, CHALLENGE, factory);
  check('新挑战创建尝试', first.reused === false);
  checkEqual('join id', first.attempt.joinRequestId, 'join-1');
  checkEqual('redeem id', first.attempt.redeemRequestId, 'redeem-1');

  const replay = resolvePairingAttempt(first.attempt, CHALLENGE, () => {
    throw new Error('同一挑战不应重新生成上下文');
  });
  check('同一挑战标记复用', replay.reused === true);
  check('同一挑战返回同一对象', replay.attempt === first.attempt);

  const other = resolvePairingAttempt(first.attempt, 'ZZZZ1234EFGH', factory);
  check('新挑战重建尝试', other.reused === false);
  check('新挑战分配新 join id', other.attempt.joinRequestId !== first.attempt.joinRequestId);
  check('新挑战重置 joined', other.attempt.joined === false);

  const joined: PairingAttempt = { ...first.attempt, joined: true };
  const retry = resolvePairingAttempt(joined, CHALLENGE, factory);
  check('已 join 的同一挑战保留 joined', retry.attempt.joined === true);
}

function verifyLifecycle(): void {
  console.log('相机生命周期闸门');
  const lifecycle = new ScannerLifecycle();
  const generation = lifecycle.begin();
  check('开始后当前 generation 有效', lifecycle.isCurrent(generation));
  check('首次识别成功', lifecycle.accept(generation));
  check('重复识别被丢弃', !lifecycle.accept(generation));
  check('识别后不再调度', !lifecycle.isCurrent(generation));

  const second = lifecycle.begin();
  check('新一次开始恢复调度', lifecycle.isCurrent(second));
  check('串行解码首次可进入', lifecycle.tryBeginDecode(second));
  check('解码中禁止并发', !lifecycle.tryBeginDecode(second));
  lifecycle.endDecode();
  check('解码结束后可继续', lifecycle.tryBeginDecode(second));

  lifecycle.stop();
  check('停止后旧 generation 失效', !lifecycle.isCurrent(second));
  check('停止后晚到结果被丢弃', !lifecycle.accept(second));
  check('停止后晚到权限不可调度', !lifecycle.tryBeginDecode(second));

  const third = lifecycle.begin();
  check('停止后重新开始获得新 generation', third > second && lifecycle.isCurrent(third));
}

function ppmToRgba(bytes: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } {
  let cursor = 0;
  const token = (): string => {
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      if (byte === 35) {
        while (cursor < bytes.length && bytes[cursor] !== 10) cursor += 1;
        continue;
      }
      if (byte !== undefined && byte <= 32) {
        cursor += 1;
        continue;
      }
      break;
    }
    const start = cursor;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      if (byte === undefined || byte <= 32) break;
      cursor += 1;
    }
    return new TextDecoder().decode(bytes.subarray(start, cursor));
  };

  const magic = token();
  if (magic !== 'P6') throw new Error(`QR fixture 不是 P6 PPM: ${magic}`);
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || max !== 255) {
    throw new Error('QR fixture 头无效');
  }
  while (cursor < bytes.length && (bytes[cursor] ?? 0) <= 32) cursor += 1;
  const pixelBytes = bytes.subarray(cursor);
  if (pixelBytes.length < width * height * 3) throw new Error('QR fixture 像素不足');

  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 3;
    const target = index * 4;
    data[target] = pixelBytes[source] ?? 0;
    data[target + 1] = pixelBytes[source + 1] ?? 0;
    data[target + 2] = pixelBytes[source + 2] ?? 0;
    data[target + 3] = 255;
  }
  return { data, width, height };
}

function rasterize(text: string): { data: Uint8ClampedArray; width: number; height: number } {
  const encoded = encode(text, { ecc: 'M', border: 4 });
  const scale = 4;
  const size = encoded.size * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = encoded.data[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
      const value = dark ? 0 : 255;
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

async function verifyDecoder(): Promise<void> {
  console.log('jsqr 解码');
  const fixture = ppmToRgba(
    new Uint8Array(await readFile(resolve(REPO_ROOT, 'tests/fixtures/pairing-qr.ppm'))),
  );
  const fromFixture = jsQR(fixture.data, fixture.width, fixture.height);
  checkEqual('仓库 QR 图片可被 jsqr 解码', fromFixture?.data, PAYLOAD);

  const generated = rasterize(PAYLOAD);
  const fromBytes = jsQR(generated.data, generated.width, generated.height);
  checkEqual('uqr 生成矩阵可被 jsqr 解码', fromBytes?.data, PAYLOAD);

  const parsed = parsePairingQr(fromFixture?.data ?? '', ORIGIN);
  check('解码结果通过 URL 校验', parsed.ok === true && parsed.challenge === CHALLENGE, parsed);
}

async function main(): Promise<void> {
  console.log('PWA 阶段 2b 配对单元验收');
  verifyQrParser();
  verifyAttemptReuse();
  verifyLifecycle();
  await verifyDecoder();
  console.log(`\nPWA 配对单元检查通过：${checksPassed()} 项`);
}

await main();
