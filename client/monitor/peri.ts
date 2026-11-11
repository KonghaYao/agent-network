/**
 * `agentnet monitor --harness peri`：旧 peri 监听的 TypeScript 等价实现。
 *
 * 对外契约（与旧 shell 监听一致）：
 * - stdout 每行是 `ALERT <json>` 或 READY/RECONNECTING/DEGRADED/ERROR 诊断；
 * - 只有 claim 成功才输出可处理的 delivery，冲突输出 conflict/deferred/failed；
 * - 刻意不读正文、不写 event_file：Peri 常把 stdout 追加到 watch.log，
 *   正文不得因此持久化。宿主按 message_id 自行读取；
 * - 订阅、seen、退避、心跳与状态目录复用共享引擎，不执行旧脚本。
 */

import { CliError, resolveConfig } from '../mcp';
import { asRecord } from '../output';
import { MonitorEngine, type MonitorEventFormat } from './engine';
import {
  REMINDER_HINT,
  claimNoticeEvent,
  type ClaimFailure,
  type ClaimInfo,
  type DeliveryFields,
} from './events';
import { MonitorRpc, type JsonObject } from './rpc';
import { MonitorState } from './state';

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

const ALERT_PREFIX = 'ALERT ';
/** 与旧脚本的 clientInfo 一致。 */
const CLIENT_NAME = 'peri-watch';
const CLIENT_VERSION = '2.0.0';

/** jq `//`：null/undefined/false 才回退。 */
function or<T>(value: T | null | undefined | false, fallback: T): T {
  return value === null || value === undefined || value === false ? fallback : value;
}

/** jq 对象字面量缺省值语义：缺键或 undefined 输出 null。 */
function raw(value: unknown): unknown {
  return value === undefined ? null : value;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function streamSource(item: JsonObject): unknown {
  return raw(item.source);
}

/** 通知里的 source 缺失时，旧脚本回退成字面量 "stream"。 */
function noticeSource(item: JsonObject, source: string): string {
  if (source === 'inbox.snapshot') return source;
  const value = item.source;
  return value === null || value === undefined || value === false ? 'stream' : text(value);
}

function claimObject(fields: DeliveryFields, claim: ClaimInfo): JsonObject {
  return {
    delivery_id: fields.deliveryId,
    attempt: claim.attempt,
    claim_id: claim.claimId,
  };
}

/**
 * 流通知 delivery：保留事件自身的 source/event_id/seq/created_at，
 * 不附加正文与 event_file。键顺序与 jq 输出一致。
 */
function streamDelivery(item: JsonObject, fields: DeliveryFields, claim: ClaimInfo): JsonObject {
  return {
    type: 'delivery',
    source: streamSource(item),
    event_id: raw(item.event_id),
    delivery_id: raw(item.delivery_id),
    room_id: raw(item.room_id),
    message_id: raw(item.message_id),
    sender_id: raw(item.sender_id),
    seq: raw(item.seq),
    created_at: raw(item.created_at),
    attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
    auto_claimed: true,
    claim_state: 'claimed',
    claim: claimObject(fields, claim),
  };
}

/** 重连快照 delivery：取 inbox 条目的 created_seq 与 message.sender_id。 */
function snapshotDelivery(item: JsonObject, fields: DeliveryFields, claim: ClaimInfo): JsonObject {
  const message = asRecord(item.message);
  return {
    type: 'delivery',
    source: 'inbox.snapshot',
    delivery_id: raw(item.delivery_id),
    room_id: raw(item.room_id),
    message_id: raw(item.message_id),
    sender_id: text(or(message.sender_id, '')),
    seq: text(or(item.seq, or(item.created_seq, ''))),
    created_seq: raw(item.created_seq),
    attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
    auto_claimed: true,
    claim_state: 'claimed',
    claim: claimObject(fields, claim),
  };
}

function periDelivery(
  item: JsonObject,
  fields: DeliveryFields,
  claim: ClaimInfo,
  source: string,
): JsonObject {
  return source === 'inbox.snapshot'
    ? snapshotDelivery(item, fields, claim)
    : streamDelivery(item, fields, claim);
}

/** reminder 不 claim、不带正文；字段保持 jq 的 null 语义。 */
function periReminder(item: JsonObject): JsonObject {
  return {
    type: 'reminder',
    source: 'stream',
    delivery_id: raw(item.delivery_id),
    room_id: raw(item.room_id),
    message_id: raw(item.message_id),
    attempt: raw(item.attempt),
    progress_at: raw(item.progress_at),
    event_id: raw(item.event_id),
    seq: raw(item.seq),
    created_at: raw(item.created_at),
    hint: REMINDER_HINT,
  };
}

export const PERI_EVENT_FORMAT: MonitorEventFormat = {
  deliveryWithoutBody: periDelivery,
  claimNotice: (item: JsonObject, fields: DeliveryFields, failure: ClaimFailure, source: string) =>
    claimNoticeEvent(fields, failure, noticeSource(item, source)),
  reminder: periReminder,
};

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): number {
  writeStdout(line);
  return 1;
}

export async function runPeriMonitor(
  context: MonitorContext,
  options: { stateDir?: string } = {},
): Promise<number> {
  const token = context.token;
  if (!token) return fail('ERROR type=credential message=missing_token');
  if (/[\r\n]/u.test(token)) return fail('ERROR type=credential message=invalid_token_format');
  if (context.baseUrl === null) {
    return fail('ERROR type=configuration message=missing_agentnet_url');
  }

  let endpoint: string;
  try {
    endpoint = resolveConfig({ url: context.baseUrl, token, json: false }).endpoint;
  } catch (error) {
    if (error instanceof CliError) {
      return fail('ERROR type=configuration message=invalid_agentnet_url');
    }
    throw error;
  }

  const stateDirectory = options.stateDir ?? process.env.AGENTNET_MONITOR_STATE_DIR;
  const keep = process.env.AGENTNET_MONITOR_KEEP === '1';
  let state: MonitorState;
  try {
    state = await MonitorState.create({
      directory: stateDirectory,
      keep,
      tempPrefix: 'peri-watch.',
    });
  } catch {
    return fail('ERROR type=environment message=workdir_failed');
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);

  try {
    const rpc = new MonitorRpc({
      endpoint,
      token,
      signal: controller.signal,
      clientName: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
    });
    const engine = new MonitorEngine({
      rpc,
      state,
      signal: controller.signal,
      diagnostics: writeStdout,
      prefix: ALERT_PREFIX,
      readBody: false,
      format: PERI_EVENT_FORMAT,
    });
    return await engine.run();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    await state.cleanup();
  }
}
