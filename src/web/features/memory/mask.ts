const HIDDEN = '[已隐藏]';

/**
 * 记忆正文默认掩码：凭据、常见密钥前缀与带 token 的 URL 在详情打开时
 * 不能直接进入 DOM。只有用户点击「查看原文」后才渲染原始文本。
 */
export function maskSecrets(value: string): string {
  if (!value) return value;
  return (
    value
      // 查询参数中的 token/api_key/secret。
      .replace(/([?&](?:token|access_token|api_token|api_key|apikey|secret|key)=)[^&#\s]+/giu, `$1${HIDDEN}`)
      // 裸 key=value 形式，常见于粘贴的配置片段。
      .replace(
        /\b(token|access_token|api_token|api_key|apikey|secret)=([^\s&#]+)/giu,
        `$1=${HIDDEN}`,
      )
      // Bearer 凭据（含 JWT 等长串）；先于 Authorization 头处理，
      // 避免头规则只吃掉 “Bearer” 而把后面的短 token 留在正文里。
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/giu, `Bearer ${HIDDEN}`)
      // JSON/带引号的头值。
      .replace(
        /(["']?(?:authorization|x-api-key|api[_-]?key)["']?\s*[:=]\s*["'])(?!Bearer\b)[^"'\n]+(["'])/giu,
        `$1${HIDDEN}$2`,
      )
      // Authorization / x-api-key 头；值已经是 Bearer 时交给上一条规则。
      .replace(
        /\b(authorization|x-api-key|api[_-]?key)\b(\s*[:=]\s*)(?!Bearer\b)(?:(?:Basic|Digest|Negotiate)\s+)?[^\s,;}"]+/giu,
        `$1$2${HIDDEN}`,
      )
      // OpenAI 等 sk- 前缀密钥。
      .replace(/\bsk-[A-Za-z0-9_-]{4,}/gu, `sk-${HIDDEN}`)
      // 无前缀的长 token；比正常英文单词长得多，避免误伤普通文本。
      .replace(/\b[A-Za-z0-9_~+/=-]{32,}\b/gu, HIDDEN)
  );
}

