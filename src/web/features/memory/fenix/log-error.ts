/**
 * Fenix 错误日志的统一出口。
 *
 * `FenixApiError.message` 来自请求层，可能是带 `?token=...` 的上游 URL（或回显的
 * 请求上下文）。仓库约束是日志不得输出 token、凭据摘要或消息正文，因此调用方不要
 * 直接 `console.error(..., error)`：这里先取错误码，再对 message 做与 DOM 相同的
 * `maskSecrets` 掩码。
 */

import { maskSecrets } from '../mask';
import { FenixApiError } from './api';

/** 生成可安全写入日志的错误摘要；不含原始 message。 */
export function describeFenixError(error: unknown): string {
  if (error instanceof FenixApiError) {
    return `${error.name} [${error.code}]: ${maskSecrets(error.message)}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${maskSecrets(error.message)}`;
  }
  return maskSecrets(String(error));
}

/** 记录已掩码的错误摘要。调用方只传上下文，不传原始 error 对象。 */
export function logFenixError(context: string, error: unknown): void {
  console.error(context, describeFenixError(error));
}
