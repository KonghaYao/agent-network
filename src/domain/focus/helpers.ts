/**
 * Task Focus 的 owner 推导与读取辅助。
 *
 * 卡主工具只接受 Bearer 身份：Agent（含秘书）调用一律 `PERMISSION_DENIED`，
 * 且任何工具都不接受 owner 参数，避免借用他人身份读卡。
 */

import { BusinessError } from '../../contracts/errors';
import { sha256Hex, stableStringify } from '../../storage/db';
import { actorId, type Principal } from '../principal';

/** 只允许已注册 Human；owner 从 principal 推导，不接受参数。 */
export function focusOwner(principal: Principal): string {
  if (principal.actor?.kind === 'agent') {
    throw new BusinessError('PERMISSION_DENIED', '看板工具只允许卡主本人（Human）调用');
  }
  const owner = actorId(principal);
  if (owner.length === 0) {
    throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册');
  }
  return owner;
}

/**
 * 列表游标 scope：绑定 owner、归档维度、列与搜索词的稳定哈希。
 *
 * 任一筛选变化后旧游标都不可继续翻页；哈希避免把搜索词写入客户端可见游标。
 */
export async function focusListCursorScope(
  owner: string,
  archived: boolean,
  column: string | null,
  query: string | null,
): Promise<string> {
  const digest = await sha256Hex(
    stableStringify({ owner, archived, column, query }),
  );
  return `focus:${owner}:${digest}`;
}

/** SQL LIKE 字面量转义；配合 `ESCAPE '\'` 使用。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

/** 按码点截断，避免把代理对切成半个字符。 */
export function truncateChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

export function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

/** 毫秒时间对外的字符串形式；null 保持 null。 */
export function timeText(value: number | null): string | null {
  return value === null ? null : String(value);
}
