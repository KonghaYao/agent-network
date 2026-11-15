const HIDDEN = '[已隐藏]';

/** 查询参数与裸 key=value 共用的敏感键名。 */
const SECRET_KEY = 'token|access_token|api_token|api_key|apikey|secret|password|passwd|pwd';
/** 查询参数额外接受裸 key；正文里 `key=` 太常见，不做全局匹配。 */
const QUERY_SECRET_KEY = `${SECRET_KEY}|key`;

/** 私钥块的 BEGIN/END 标记；RSA/EC/OPENSSH/ENCRYPTED 等前缀都命中。 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu;

/**
 * 记忆正文默认掩码：凭据、常见密钥前缀与带 token 的 URL 在详情打开时
 * 不能直接进入 DOM。只有用户点击「查看原文」后才渲染原始文本。
 */
export function maskSecrets(value: string): string {
  if (!value) return value;
  return (
    value
      // 查询参数中的 token/api_key/secret/password/key。
      .replace(new RegExp(`([?&](?:${QUERY_SECRET_KEY})=)[^&#\\s]+`, 'giu'), `$1${HIDDEN}`)
      // 裸 key=value 形式，常见于粘贴的配置片段。
      .replace(new RegExp(`\\b(${SECRET_KEY})=([^\\s&#]+)`, 'giu'), `$1=${HIDDEN}`)
      // Bearer 凭据（含 JWT 等长串）；先于 Authorization 头处理，
      // 避免头规则只吃掉 “Bearer” 而把后面的短 token 留在正文里。
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/giu, `Bearer ${HIDDEN}`)
      // JSON/带引号的头值。
      .replace(
        /(["']?(?:authorization|x-api-key|api[_-]?key|password|passwd|pwd|cookie|set-cookie)["']?\s*[:=]\s*["'])(?!Bearer\b)[^"'\n]+(["'])/giu,
        `$1${HIDDEN}$2`,
      )
      // Cookie / Set-Cookie 头：值可含空格、分号与等号，整行隐藏。
      .replace(/\b(set-cookie|cookie)\b(\s*[:=]\s*)[^\n]+/giu, `$1$2${HIDDEN}`)
      // 密码字段：值可能包含空格，隐藏到常见分隔符为止。
      .replace(/\b(password|passwd|pwd)\b(\s*[:=]\s*)[^\n,;}"']+/giu, `$1$2${HIDDEN}`)
      // 私钥块整体隐藏；只有 BEGIN 没有 END 时至少隐藏头部，
      // 剩余 base64 行交给下面的长 token 规则。
      .replace(PRIVATE_KEY_BLOCK, HIDDEN)
      .replace(PRIVATE_KEY_HEADER, `-----BEGIN PRIVATE KEY-----${HIDDEN}`)
      // Authorization / x-api-key 头；值已经是 Bearer 时交给上面规则。
      .replace(
        /\b(authorization|x-api-key|api[_-]?key)\b(\s*[:=]\s*)(?!Bearer\b)(?:(?:Basic|Digest|Negotiate)\s+)?[^\s,;}"]+/giu,
        `$1$2${HIDDEN}`,
      )
      // AWS access key id（AKIA/ASIA + 16 位大写字母数字）。
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, HIDDEN)
      // OpenAI 等 sk- 前缀密钥。
      .replace(/\bsk-[A-Za-z0-9_-]{4,}/gu, `sk-${HIDDEN}`)
      // 无前缀的长 token；比正常英文单词长得多，避免误伤普通文本。
      .replace(/\b[A-Za-z0-9_~+/=-]{32,}\b/gu, HIDDEN)
  );
}
