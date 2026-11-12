import { z } from 'zod';
import { BusinessError } from './errors';

export type CursorDirection = 'before' | 'after';

export interface CursorPayload {
  /** 游标版本。 */
  v: 1;
  /** 资源范围，例如 `room:rm_1`。 */
  scope: string;
  /** 翻页方向。 */
  dir: CursorDirection;
  /** 已应用到的事件/消息序号。 */
  seq: number;
  /** 复合排序的次级键；普通序号游标不使用。 */
  key?: string;
  /** 首次查询时固定的快照上界；历史翻页沿用它。 */
  snapshot: number;
}

/**
 * 游标载荷的唯一校验规则。
 *
 * 保留原有错误分类：base64/JSON 损坏与字段/版本不合法使用不同文案；未知字段
 * 继续透传（loose），避免旧游标因新增字段被拒绝。
 */
const CURSOR_PAYLOAD = z
  .object({
    v: z.literal(1),
    scope: z.string(),
    dir: z.enum(['before', 'after']),
    seq: z.number().finite(),
    key: z.string().optional(),
    snapshot: z.number().finite(),
  })
  .loose();

const encoder = new TextEncoder();

function toBase64Url(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return atob(padded);
}

export function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeCursor(cursor: string, scope: string): CursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new BusinessError('INVALID_ARGUMENT', 'cursor 不是合法的版本化游标');
  }
  const parsed = CURSOR_PAYLOAD.safeParse(payload);
  if (!parsed.success) {
    throw new BusinessError('INVALID_ARGUMENT', 'cursor 字段不完整或版本不受支持');
  }
  const record = parsed.data as CursorPayload;
  if (record.scope !== scope) {
    throw new BusinessError('INVALID_ARGUMENT', 'cursor 不能跨 scope 重用', {
      expected: scope,
      actual: record.scope,
    });
  }
  return record;
}
