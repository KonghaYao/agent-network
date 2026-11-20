/**
 * 配对二维码解析。
 *
 * 只接受当前部署同源、路径严格为 `/pair`、无 query、fragment 严格为
 * 单个 `#c=<12 位 Crockford 挑战>` 的完整 URL。解析只解码一次，随后按
 * 精确字符集校验；不会把多余参数或非法字符“过滤”成合法挑战。
 */

/** 12 位短码字符集：去掉易混淆的 I/L/O/U。 */
export const PAIRING_CHALLENGE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/u;

export type PairingQrFailureReason =
  | 'invalid-url'
  | 'cross-origin'
  | 'wrong-path'
  | 'query'
  | 'missing-challenge'
  | 'invalid-challenge';

export type PairingQrResult =
  | { ok: true; challenge: string }
  | { ok: false; reason: PairingQrFailureReason; message: string };

export function isPairingChallenge(value: string): boolean {
  return PAIRING_CHALLENGE_PATTERN.test(value);
}

/** 从地址栏 fragment 读取原始挑战；只读取 `#c=`，不在这里做短码规范化。 */
export function pairingChallengeFromHash(hash: string): string {
  if (!hash.startsWith('#c=')) return '';
  try {
    return decodeURIComponent(hash.slice(3));
  } catch {
    return '';
  }
}

function failure(reason: PairingQrFailureReason, message: string): PairingQrResult {
  return { ok: false, reason, message };
}

export function parsePairingQr(rawValue: string, expectedOrigin: string): PairingQrResult {
  const text = String(rawValue || '').trim();
  if (!text) return failure('invalid-url', '二维码中没有链接内容。');

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return failure('invalid-url', '二维码不是完整网址，请重新扫描电脑上的配对二维码。');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return failure('invalid-url', '二维码不是网页链接。');
  }
  if (url.username !== '' || url.password !== '') {
    return failure('invalid-url', '二维码链接包含账号信息，已拒绝。');
  }

  let origin: string;
  try {
    origin = new URL(expectedOrigin).origin;
  } catch {
    return failure('cross-origin', '无法核对当前部署地址，请刷新页面后重试。');
  }
  if (url.origin !== origin) {
    return failure('cross-origin', '二维码来自其他站点，请扫描本机已登录电脑显示的码。');
  }
  if (url.pathname !== '/pair') {
    return failure('wrong-path', '二维码不是配对页链接，请重新扫描。');
  }
  if (url.search !== '') {
    return failure('query', '二维码链接包含多余参数，请让电脑重新生成。');
  }
  if (!url.hash.startsWith('#c=')) {
    return failure('missing-challenge', '二维码缺少配对挑战，请让电脑重新生成。');
  }

  const encoded = url.hash.slice(3);
  if (encoded === '' || encoded.includes('&') || encoded.includes('#')) {
    return failure('invalid-challenge', '配对挑战格式不正确，请让电脑重新生成。');
  }
  let challenge: string;
  try {
    challenge = decodeURIComponent(encoded);
  } catch {
    return failure('invalid-challenge', '配对挑战编码不完整，请让电脑重新生成。');
  }
  if (!isPairingChallenge(challenge)) {
    return failure('invalid-challenge', '配对挑战必须是 12 位且不含 I/L/O/U，请让电脑重新生成。');
  }
  return { ok: true, challenge };
}
