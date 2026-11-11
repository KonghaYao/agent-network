/** 投递生命周期：claim/report/complete/fail/retry/cancel 与待办 reply 闭环。 */

import type { CliArgs } from '../args';
import {
  assertKnownFlags,
  flagValue,
  integerFlag,
  newId,
  requireFlag,
} from '../args';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import { asArray, asNumber, asRecord, asString, emit, field, line } from '../output';
import { bodyFromArgs } from './rooms';

function deliveryId(args: CliArgs): string {
  const positional = args.positionals[1];
  const fromFlag = flagValue(args, 'delivery') ?? flagValue(args, 'delivery-id');
  const value = positional ?? fromFlag;
  if (!value) throw new CliError('用法：agentnet <claim|complete|fail|report|retry|cancel> <delivery-id>');
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

export async function claim(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['delivery', 'delivery-id', 'request-id']);
  const id = deliveryId(args);
  const result = await claimDelivery(client, id, flagValue(args, 'request-id'));
  emit(config, result, (value) => deliverySummary(value));
}

export async function report(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['delivery', 'delivery-id', 'request-id', 'attempt', 'claim-id', 'status']);
  const id = deliveryId(args);
  const result = await client.callTool('network_delivery_report', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    delivery_id: id,
    attempt: integerFlag(args, 'attempt'),
    claim_id: requireFlag(args, 'claim-id'),
    status: requireFlag(args, 'status'),
  });
  emit(config, result, deliverySummary);
}

export async function complete(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, [
    'delivery',
    'delivery-id',
    'request-id',
    'attempt',
    'claim-id',
    'body',
    'client-message-id',
  ]);
  const id = deliveryId(args);
  const result = await completeDelivery(client, {
    deliveryId: id,
    attempt: integerFlag(args, 'attempt'),
    claimId: requireFlag(args, 'claim-id'),
    requestId: flagValue(args, 'request-id'),
    finalBody: flagValue(args, 'body'),
    clientMessageId: flagValue(args, 'client-message-id'),
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

export async function fail(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['delivery', 'delivery-id', 'request-id', 'attempt', 'claim-id', 'error']);
  const id = deliveryId(args);
  const result = await client.callTool('network_delivery_fail', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    delivery_id: id,
    attempt: integerFlag(args, 'attempt'),
    claim_id: requireFlag(args, 'claim-id'),
    error: requireFlag(args, 'error'),
  });
  emit(config, result, deliverySummary);
}

export async function retry(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['delivery', 'delivery-id', 'request-id', 'expected-attempt']);
  const id = deliveryId(args);
  const result = await client.callTool('network_delivery_retry', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    delivery_id: id,
    expected_attempt: integerFlag(args, 'expected-attempt'),
  });
  emit(config, result, deliverySummary);
}

export async function cancel(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['delivery', 'delivery-id', 'request-id', 'reason']);
  const id = deliveryId(args);
  const result = await client.callTool('network_delivery_cancel', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    delivery_id: id,
    reason: requireFlag(args, 'reason'),
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
export async function reply(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, [
    'delivery',
    'delivery-id',
    'body',
    'request-id',
    'client-message-id',
  ]);
  const id = deliveryId(args);
  const body = await bodyFromArgs(args);
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

  const requestId = flagValue(args, 'request-id') ?? newId('req');
  const clientMessageId = flagValue(args, 'client-message-id') ?? newId('msg');
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
