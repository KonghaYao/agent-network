import { FILE_ID_PATTERN } from '@peri-code/mcpp/files';

import { LIMITS } from './limits';

/**
 * 从消息正文提取同源 `/f/<fileId>` 链接。
 *
 * 只识别 PUBLIC_ORIGIN 下的绝对 URL 与以 `/` 开头的相对路径；外站绝对
 * URL、路径片段（`/f/<id>/extra`）、非法 fileId 与带 userinfo 的 URL 都
 * 忽略。query/hash 不属于 fileId，尾部标点不进入结果；按出现顺序去重，
 * 最多返回 `LIMITS.messageFileLinksMax` 个。
 */

const FILE_ID = new RegExp(FILE_ID_PATTERN, 'u');

/** 向后扫描 URL 前缀时视为分隔符的字符（Markdown/引号/括号/中文标点）。 */
const PREFIX_DELIMITERS = new Set([
  '"',
  "'",
  '`',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  ',',
  ';',
  '*',
  '|',
  '。',
  '，',
  '；',
  '：',
  '！',
  '？',
  '、',
  '）',
  '】',
  '》',
  '」',
  '』',
]);

const ABSOLUTE_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)$/u;
const TOKEN_AFTER = /^[A-Za-z0-9_-]$/u;

function isDelimiter(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char) || PREFIX_DELIMITERS.has(char);
}

function normalizedOrigin(publicOrigin: string): string | null {
  try {
    return new URL(publicOrigin).origin;
  } catch {
    return null;
  }
}

/**
 * 判断 `/f/` 之前的文本是相对路径还是绝对 URL。
 *
 * - 前缀为空：相对路径；
 * - 前缀是 `scheme://authority`：绝对 URL，返回其 origin 与 userinfo；
 * - 其他前缀：既不是同源绝对 URL 也不是根相对路径，忽略。
 */
function prefixOf(
  body: string,
  index: number,
): { kind: 'relative' } | { kind: 'absolute'; origin: string; userinfo: boolean } | null {
  let start = index;
  while (start > 0 && !isDelimiter(body[start - 1])) start -= 1;
  const prefix = body.slice(start, index);
  if (prefix === '') return { kind: 'relative' };
  if (!ABSOLUTE_PREFIX.test(prefix)) return null;
  try {
    const url = new URL(`${prefix}/`);
    return {
      kind: 'absolute',
      origin: url.origin,
      userinfo: url.username !== '' || url.password !== '',
    };
  } catch {
    return null;
  }
}

/** `/f/` 后紧跟 `/` 或文件扩展名时不是有效 file 链接。 */
function validSuffix(body: string, end: number): boolean {
  const next = body[end];
  if (next === '/') return false;
  if (next === '.') return !TOKEN_AFTER.test(body[end + 1] ?? '');
  return true;
}

export function extractMessageFileLinks(body: string, publicOrigin: string): string[] {
  const origin = normalizedOrigin(publicOrigin);
  if (origin === null) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /\/f\/([A-Za-z0-9_-]+)/gu;

  for (const match of body.matchAll(pattern)) {
    if (found.length >= LIMITS.messageFileLinksMax) break;
    const fileId = match[1];
    if (fileId === undefined || !FILE_ID.test(fileId)) continue;
    const end = (match.index ?? 0) + match[0].length;
    if (!validSuffix(body, end)) continue;

    const prefix = prefixOf(body, match.index ?? 0);
    if (prefix === null) continue;
    if (prefix.kind === 'absolute' && (prefix.userinfo || prefix.origin !== origin)) {
      continue;
    }
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    found.push(fileId);
  }

  return found;
}
