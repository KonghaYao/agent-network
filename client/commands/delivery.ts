/** 投递生命周期：claim/report/complete/fail/retry/cancel。 */

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
import { asNumber, asRecord, asString, emit, field, line } from '../output';

function deliveryId(args: CliArgs): string {
  const positional = args.positionals[1];
  const fromFlag = flagValue(args, 'delivery') ?? flagValue(args, 'delivery-id');
  const value = positional ?? fromFlag;
  if (!value) throw new CliError('用法：agentnet <claim|complete|fail|report|retry|cancel> <delivery-id>');
  return value;
}

function deliverySummary(value: Record<string, unknown>): void {
  line(
    `${field('delivery_id', asString(value.delivery_id, '-'))} ${field(
      'state',
      asString(value.state, '-'),
    )} ${field('attempt', asNumber(value.attempt))} ${field(
      'claim_id',
      asString(value.claim_id, '-'),
    )}`,
  );
  const message = asRecord(value.message);
  if (message.preview) line(`  ${asString(message.preview)}`);
}

export async function claim(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['delivery', 'delivery-id', 'request-id']);
  const id = deliveryId(args);
  const result = await client.callTool('network_delivery_claim', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    delivery_id: id,
  });
  emit(config, result, deliverySummary);
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
  const body = flagValue(args, 'body');
  const clientMessageId = flagValue(args, 'client-message-id');
  const result = await client.callTool('network_delivery_complete', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    delivery_id: id,
    attempt: integerFlag(args, 'attempt'),
    claim_id: requireFlag(args, 'claim-id'),
    ...(body === undefined ? {} : { final_body: body }),
    ...(clientMessageId === undefined ? {} : { client_message_id: clientMessageId }),
  });
  emit(config, result, (value) => {
    deliverySummary(value);
    const message = asRecord(value.message);
    if (message.message_id) line(`  final_message_id=${asString(message.message_id)}`);
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
