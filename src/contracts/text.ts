/**
 * UTF-8 文本校验的唯一入口。
 *
 * 控制字符范围统一为 C0（0x00–0x1F）+ C1（0x7F–0x9F）+ U+2028/U+2029。
 * `allowNewlines` 只放行 `\t`、`\n`、`\r`；`allowControl` 用于明确要保留控制
 * 字符的展示/脱敏场景（默认关闭）。
 *
 * `utf8Text()` 返回可复用的 Zod schema；domain 层用 `assertUtf8Text()` 抛出带
 * 业务错误码的异常，两者共享同一份判定。
 */

import { z } from 'zod';
import { BusinessError } from './errors';

const NO_NEWLINES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ALLOW_NEWLINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const NO_NEWLINES_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const ALLOW_NEWLINES_ALL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/gu;

export interface Utf8TextOptions {
  /** 最大 UTF-8 字节数；省略表示不限制。 */
  readonly maxBytes?: number;
  /** 是否允许 `\t`、`\n`、`\r`；默认 false。 */
  readonly allowNewlines?: boolean;
  /** 是否跳过控制字符检查；默认 false。 */
  readonly allowControl?: boolean;
}

export interface Utf8TextMessages {
  readonly control?: string;
  readonly tooLarge?: string;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** 是否包含不允许的控制字符；与 `utf8Text()` 使用同一判定。 */
export function hasControlChars(value: string, options: Utf8TextOptions = {}): boolean {
  if (options.allowControl) return false;
  const pattern = options.allowNewlines ? ALLOW_NEWLINES : NO_NEWLINES;
  return pattern.test(value);
}

/** 是否超过 UTF-8 字节上限。 */
export function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  return utf8Bytes(value) > maxBytes;
}

/** 把不允许的控制字符替换为指定文本；用于展示脱敏，不用于输入校验。 */
export function replaceControlChars(
  value: string,
  replacement = ' ',
  options: Utf8TextOptions = {},
): string {
  if (options.allowControl) return value;
  const pattern = options.allowNewlines ? ALLOW_NEWLINES_ALL : NO_NEWLINES_ALL;
  return value.replace(pattern, replacement);
}

/** domain 层断言：控制字符映射 INVALID_ARGUMENT，超字节映射 PAYLOAD_TOO_LARGE。 */
export function assertUtf8Text(
  value: string,
  options: Utf8TextOptions = {},
  messages: Utf8TextMessages = {},
): void {
  if (hasControlChars(value, options)) {
    throw new BusinessError(
      'INVALID_ARGUMENT',
      messages.control ?? '文本不能包含控制字符或换行',
    );
  }
  if (options.maxBytes !== undefined && exceedsUtf8Bytes(value, options.maxBytes)) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      messages.tooLarge ?? '文本超过 UTF-8 字节上限',
    );
  }
}

/** 可复用 Zod schema；省略 `maxBytes` 时只校验控制字符。 */
export function utf8Text(
  options: Utf8TextOptions = {},
  messages: Utf8TextMessages = {},
): z.ZodString {
  return z.string().superRefine((value, context) => {
    if (hasControlChars(value, options)) {
      context.addIssue({
        code: 'custom',
        message: messages.control ?? '文本不能包含控制字符或换行',
      });
    }
    if (options.maxBytes !== undefined && exceedsUtf8Bytes(value, options.maxBytes)) {
      context.addIssue({
        code: 'custom',
        message: messages.tooLarge ?? '文本超过 UTF-8 字节上限',
      });
    }
  });
}
