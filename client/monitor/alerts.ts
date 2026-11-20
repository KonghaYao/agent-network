/**
 * JSON 事件的宿主告警分类。
 *
 * Monitor 宿主（Peri `monitor_start.alert` 等）按行正则触发提醒；如果把
 * reminder / reconnecting / ready 等高频事件也纳入，真正的 delivery 会被
 * 淹没。这里在每条 JSON 事件上加布尔 `alert`，宿主只需匹配
 * `"alert":true`，事件本身仍然完整输出到流。
 */

import { asString } from '../output';
import type { JsonObject } from './rpc';

/**
 * 推荐给 Monitor 宿主的 alert 正则；只命中需要行动的事件。
 *
 * `^ERROR ` 覆盖 claude 启动早期的 stderr 失败行（缺 token、actor 不匹配、
 * workdir 创建失败等）；这些行在 `--json` 下仍是文本，不会带 alert 字段。
 */
export const ALERT_PATTERN = '"alert":true|^ERROR ';

/**
 * 需要宿主行动的 JSON 事件类型。
 *
 * - delivery：新消息已 claim，必须处理；
 * - delivery_deferred：新消息因自己已有 claim 未能领取，必须立即读正文回复；
 * - delivery_claim_failed：claim 已占用但正文读取/事件文件写入失败（解析失败），
 *   需要重试或 complete/fail 释放，不能静默卡住；
 * - error：鉴权、协议、登录、inbox、格式等失败；
 * - expiring：距 24h 上限不足 10 分钟，需要安排重启。
 *
 * 明确不告警：reminder、ready、recovered、reconnecting、degraded、deadline、
 * expired、delivery_conflict、普通 stream_event / room_message / delivery_state。
 */
const ALERT_TYPES = new Set([
  'delivery',
  'delivery_deferred',
  'delivery_claim_failed',
  'error',
  'expiring',
]);

/** 除类型外，任何 `attention: "action_required"` 与 session.login 都需要行动。 */
export function isAlertEvent(event: JsonObject): boolean {
  const type = asString(event.type);
  if (ALERT_TYPES.has(type)) return true;
  if (event.attention === 'action_required') return true;
  return type === 'session.login' || asString(event.source) === 'session.login';
}
