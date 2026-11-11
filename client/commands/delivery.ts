/** 投递生命周期：claim/report/complete/fail/retry/cancel 与待办 reply 闭环。 */

import { integer, newId, required } from '../options';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import { asArray, asNumber, asRecord, asString, emit, field, line } from '../output';
import { bodyFromOptions } from './rooms';

interface DeliveryRefOptions {
  delivery?: string;
  deliveryId?: string;
}

function deliveryId(
  options: DeliveryRefOptions,
  positional: string | undefined,
  command: string,
): string {
  const value = positional ?? options.delivery ?? options.deliveryId;
  if (!value) {
    throw new CliError(
      `用法：agentnet ${command} <delivery-id>（运行 agentnet ${command} --help 查看示例）`,
    );
  }
  return value;
}

/**
 * 渲染投递。claim/report 等返回扁平 delivery；complete 返回
 * `{ delivery, message }`，必须从嵌套对象读取，否则所有字段都会退化成 `-`。
 */
function deliverySummary(value: Record<string, unknown>, nested = false): void {
  const delivery = nested ? asRecord(value.delivery) : value;
  const message = asRecord(delivery.message);
  line(
    `${field('delivery_id', asString(delivery.delivery_id, '-'))} ${field(
      'state',
      asString(delivery.state, '-'),
    )} ${field('attempt', asNumber(delivery.attempt))} ${field(
      'claim_id',
      asString(delivery.claim_id, '-'),
    )} ${field(
      'message_id',
      asString(delivery.message_id, asString(message.message_id, '-')),
    )} ${field('room_id', asString(delivery.room_id, '-'))}`,
  );
  if (message.preview) line(`  ${asString(message.preview)}`);
}

async function claimDelivery(
  client: McpClient,
  id: string,
  requestId = newId('req'),
): Promise<Record<string, unknown>> {
  return client.callTool('network_delivery_claim', {
    request_id: requestId,
    delivery_id: id,
  });
}

async function completeDelivery(
  client: McpClient,
  input: {
    deliveryId: string;
    attempt: number;
    claimId: string;
    requestId?: string;
    finalBody?: string;
    clientMessageId?: string;
  },
): Promise<Record<string, unknown>> {
  return client.callTool('network_delivery_complete', {
    request_id: input.requestId ?? newId('req'),
    delivery_id: input.deliveryId,
    attempt: input.attempt,
    claim_id: input.claimId,
    ...(input.finalBody === undefined ? {} : { final_body: input.finalBody }),
    ...(input.clientMessageId === undefined
      ? {}
      : { client_message_id: input.clientMessageId }),
  });
}

/** 在收件箱（含 completed/failed 等）中按 delivery_id 查找当前记录。 */
async function findInboxDelivery(
  client: McpClient,
  id: string,
): Promise<Record<string, unknown> | null> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    const result = await client.callTool('network_inbox_list', {
      state: 'all',
      limit: 50,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const items = asArray(result.items).map(asRecord);
    const found = items.find((item) => asString(item.delivery_id) === id);
    if (found) return found;
    const next = asString(result.next_cursor);
    if (!result.has_more || !next || seen.has(next)) return null;
    seen.add(next);
    cursor = next;
  }
  return null;
}

interface ClaimOptions extends DeliveryRefOptions {
  requestId?: string;
}

export async function claim(
  client: McpClient,
  config: ResolvedConfig,
  options: ClaimOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'claim');
  const result = await claimDelivery(client, id, options.requestId);
  emit(config, result, (value) => deliverySummary(value));
}

interface ReportOptions extends DeliveryRefOptions {
  requestId?: string;
  attempt?: string;
  claimId?: string;
  status?: string;
}

export async function report(
  client: McpClient,
  config: ResolvedConfig,
  options: ReportOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'report');
  const result = await client.callTool('network_delivery_report', {
    request_id: options.requestId ?? newId('req'),
    delivery_id: id,
    attempt: integer(options.attempt, 'attempt', { command: 'report' }),
    claim_id: required(options.claimId, 'claim-id', { command: 'report' }),
    status: required(options.status, 'status', { command: 'report' }),
  });
  emit(config, result, deliverySummary);
}

interface CompleteOptions extends DeliveryRefOptions {
  requestId?: string;
  attempt?: string;
  claimId?: string;
  body?: string;
  clientMessageId?: string;
}

export async function complete(
  client: McpClient,
  config: ResolvedConfig,
  options: CompleteOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'complete');
  const result = await completeDelivery(client, {
    deliveryId: id,
    attempt: integer(options.attempt, 'attempt', { command: 'complete' }),
    claimId: required(options.claimId, 'claim-id', { command: 'complete' }),
    requestId: options.requestId,
    finalBody: options.body,
    clientMessageId: options.clientMessageId,
  });
  emit(config, result, (value) => {
    deliverySummary(value, true);
    const delivery = asRecord(value.delivery);
    const finalMessage = asRecord(value.message);
    const finalId = asString(
      finalMessage.message_id,
      asString(delivery.result_message_id, '-'),
    );
    if (finalId !== '-') line(`  final_message_id=${finalId}`);
  });
}

interface FailOptions extends DeliveryRefOptions {
  requestId?: string;
  attempt?: string;
  claimId?: string;
  error?: string;
}

export async function fail(
  client: McpClient,
  config: ResolvedConfig,
  options: FailOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'fail');
  const result = await client.callTool('network_delivery_fail', {
    request_id: options.requestId ?? newId('req'),
    delivery_id: id,
    attempt: integer(options.attempt, 'attempt', { command: 'fail' }),
    claim_id: required(options.claimId, 'claim-id', { command: 'fail' }),
    error: required(options.error, 'error', { command: 'fail' }),
  });
  emit(config, result, deliverySummary);
}

interface RetryOptions extends DeliveryRefOptions {
  requestId?: string;
  expectedAttempt?: string;
}

export async function retry(
  client: McpClient,
  config: ResolvedConfig,
  options: RetryOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'retry');
  const result = await client.callTool('network_delivery_retry', {
    request_id: options.requestId ?? newId('req'),
    delivery_id: id,
    expected_attempt: integer(options.expectedAttempt, 'expected-attempt', {
      command: 'retry',
    }),
  });
  emit(config, result, deliverySummary);
}

interface CancelOptions extends DeliveryRefOptions {
  requestId?: string;
  reason?: string;
}

export async function cancel(
  client: McpClient,
  config: ResolvedConfig,
  options: CancelOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'cancel');
  const result = await client.callTool('network_delivery_cancel', {
    request_id: options.requestId ?? newId('req'),
    delivery_id: id,
    reason: required(options.reason, 'reason', { command: 'cancel' }),
  });
  emit(config, result, deliverySummary);
}

/**
 * 待办闭环：pending 先 claim；claimed 直接沿用现有 claim。
 *
 * 回复通过 `network_message_send { claim }` 发送，成功后再 complete
 * （不再传 final_body，正文已经作为独立消息发送）。任何一步失败都保留
 * 当前 claim，下一次 reply 会走 claimed 分支，不会重复 claim。
 */
interface ReplyOptions extends DeliveryRefOptions {
  body?: string;
  requestId?: string;
  clientMessageId?: string;
}

export async function reply(
  client: McpClient,
  config: ResolvedConfig,
  options: ReplyOptions,
  positional?: string,
): Promise<void> {
  const id = deliveryId(options, positional, 'reply');
  const body = await bodyFromOptions(options.body, 'reply');
  const found = await findInboxDelivery(client, id);
  if (!found) {
    throw new CliError(`待办中未找到投递：${id}（可先运行 agentnet inbox --state all）`);
  }
  let state = asString(found.state);
  let attempt: unknown = found.attempt;
  let claimId = asString(found.claim_id);
  const roomId = asString(found.room_id);

  if (state === 'pending') {
    const claimed = await claimDelivery(client, id);
    state = asString(claimed.state, state);
    attempt = claimed.attempt;
    claimId = asString(claimed.claim_id);
  }
  if (state !== 'claimed') {
    throw new CliError(`投递 ${id} 当前状态为 ${state || '未知'}，无需回复`);
  }
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
    throw new CliError(`投递 ${id} 缺少有效的 attempt`);
  }
  if (!claimId) throw new CliError(`投递 ${id} 缺少 claim_id`);
  if (!roomId) throw new CliError(`投递 ${id} 缺少 room_id`);

  const requestId = options.requestId ?? newId('req');
  const clientMessageId = options.clientMessageId ?? newId('msg');
  const sent = await client.callTool('network_message_send', {
    request_id: requestId,
    client_message_id: clientMessageId,
    room_id: roomId,
    body,
    claim: { delivery_id: id, attempt, claim_id: claimId },
  });

  let completed: Record<string, unknown>;
  try {
    completed = await completeDelivery(client, {
      deliveryId: id,
      attempt,
      claimId,
    });
  } catch (error) {
    const messageId = asString(asRecord(sent.message).message_id, '-');
    const reason = error instanceof Error ? error.message : String(error);
    const cause = error instanceof CliError ? error : null;
    throw new CliError(`回复已发送（message_id=${messageId}），但 complete 失败：${reason}`, {
      code: cause?.code,
      details: {
        message_id: messageId,
        delivery_id: id,
        attempt,
        claim_id: claimId,
        state: 'claimed',
        sent: true,
        ...(cause?.details === undefined ? {} : { complete_details: cause.details }),
      },
    });
  }

  const delivery = asRecord(completed.delivery);
  const output: Record<string, unknown> = {
    ...sent,
    delivery,
    request_id: requestId,
    client_message_id: clientMessageId,
  };
  emit(config, output, (value) => {
    const message = asRecord(value.message);
    line(
      `已回复 ${field('message_id', asString(message.message_id, '-'))} ${field(
        'room_id',
        roomId,
      )} ${field('request_id', requestId)} ${field('client_message_id', clientMessageId)}`,
    );
    deliverySummary(value.delivery as Record<string, unknown>);
  });
}
