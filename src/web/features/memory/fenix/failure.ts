/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/failure.ts
 * Modified for Agent Network: 把上游 ApiError 判定改为本地 FenixApiError，其余失败分类逻辑不变；
 * 新增 `unavailable` 分类（服务端 `available=false` 的 no_space/bank_missing/panel_disabled/
 * backend_* 是可预期状态，不是可重试故障，也不是空数据）。
 */

import { FenixApiError } from "./api";

/**
 * Hindsight 请求失败的分类：把「无权限」从通用加载失败里拆出来。
 *
 * 为什么必须分类：`/web/hindsight/**` 除 `/status` 外的全部端点在「当前用户无法解析出 bank 映射」
 * 时返回 `403 { code: "forbidden" }`（见包内 `src/server/routes/web/hindsight.ts`）。这是授权态
 * 而非瞬时故障——Retry 永远得到同一个 403，而通用失败分支既给了无意义的重试入口，又会把服务端
 * 英文 message（`Cannot resolve bank ID`）直接回显给用户。因此授权失败单独成分支：本地化文案 +
 * 不给重试。
 *
 * 为什么两种码都要认：后端在本包显式写 `forbidden`，而 `request()` 的 `normalizeErrorCode` 只在
 * 响应**没有** code 时才按 HTTP status 归一（401/403 → `UNAUTHORIZED`）；带 code 的响应原样透传。
 * 只认 `UNAUTHORIZED` 会漏掉本包全部 403，正是这个缺口被复核指出的形态。
 */
export type HindsightFailure =
  | { kind: "forbidden" }
  | { kind: "unavailable"; detail: string }
  | { kind: "error"; detail: string };

/** 授权类错误码：`forbidden` 是本包后端值，`UNAUTHORIZED` 是 request 层对无 code 的 401/403 归一值。 */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set(["forbidden", "UNAUTHORIZED", "PERMISSION_DENIED"]);

/** 可预期但不可浏览的状态：不渲染重试入口，也不伪装成空数据。 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["UNAVAILABLE"]);

/** 是否为授权类失败（401/403）：调用方据此决定不给重试入口。 */
export function isForbiddenFailure(error: unknown): boolean {
  return error instanceof FenixApiError && FORBIDDEN_CODES.has(error.code);
}

/**
 * 归一请求失败。
 *
 * `detail` 是给用户看的诊断行：优先用错误自身携带的 message（request 层已把后端 message 与自身
 * 网络异常文案统一放在这里），拿不到时用调用方给的 fallback；非授权分支才展示它，授权分支由界面
 * 给固定文案，避免回显服务端英文。
 */
export function toHindsightFailure(error: unknown, fallbackDetail = ""): HindsightFailure {
  if (isForbiddenFailure(error)) return { kind: "forbidden" };
  const message = error instanceof Error ? error.message : "";
  if (error instanceof FenixApiError && UNAVAILABLE_CODES.has(error.code)) {
    return { kind: "unavailable", detail: message || fallbackDetail };
  }
  return { kind: "error", detail: message || fallbackDetail };
}
