/** 房间、历史、发送与收件箱。 */

import type { CliArgs } from '../args';
import {
  assertKnownFlags,
  booleanFlag,
  commaList,
  flagValue,
  newId,
  optionalIntegerFlag,
  requireFlag,
} from '../args';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  emit,
  field,
  line,
  shorten,
} from '../output';

interface RoomPreview {
  room_id?: string;
  kind?: string;
  title?: string;
  head_seq?: string;
  my_last_read_seq?: string;
  member_count?: number;
  status?: string;
  last_message?: { preview?: string } | null;
}

function roomLabel(room: RoomPreview): string {
  const title = room.title?.trim();
  if (title) return title;
  return room.kind === 'direct' ? '(私聊)' : '(未命名群聊)';
}

function roomIdFrom(args: CliArgs, command: string): string {
  const fromFlag = flagValue(args, 'room');
  const fromPositional = args.positionals[1];
  const value = fromFlag ?? fromPositional;
  if (!value) {
    throw new CliError(`缺少房间 id：使用 ${command} --room <id>（可用 rooms 查看）`);
  }
  return value;
}

export async function rooms(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['cursor', 'limit']);
  const limit = optionalIntegerFlag(args, 'limit', { min: 1 });
  const cursor = flagValue(args, 'cursor');
  const result = await client.callTool('network_rooms_list', {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  emit(config, result, (value) => {
    const items = asArray(value.items).map((item) => asRecord(item) as RoomPreview);
    line(
      `ROOMS (${items.length}${value.has_more ? ', more' : ''}) next_cursor=${asString(
        value.next_cursor,
        '-',
      )} has_more=${String(value.has_more === true)}`,
    );
    for (const room of items) {
      const unread = room.my_last_read_seq !== room.head_seq;
      line(
        `${roomLabel(room)}  ${room.room_id}  [${room.kind ?? '?'}]  members=${asNumber(
          room.member_count,
        )}  head=${room.head_seq ?? '-'}${unread ? '  UNREAD' : ''}${
          room.status === 'dissolved' ? '  DISSOLVED' : ''
        }`,
      );
      if (room.last_message?.preview) line(`  ${shorten(room.last_message.preview)}`);
    }
  });
}

export async function history(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['room', 'cursor', 'limit', 'direction', 'timeline']);
  const roomId = roomIdFrom(args, 'history');
  const limit = optionalIntegerFlag(args, 'limit', { min: 1 });
  const cursor = flagValue(args, 'cursor');
  const direction = flagValue(args, 'direction');
  if (direction !== undefined && direction !== 'before' && direction !== 'after') {
    throw new CliError('--direction 只支持 before 或 after');
  }
  const timeline = booleanFlag(args, 'timeline');
  const result = await client.callTool('network_history_list', {
    room_id: roomId,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(direction === undefined ? {} : { direction }),
    ...(timeline ? { view: 'timeline' } : {}),
  });
  emit(config, result, (value) => {
    // timeline 视图使用独立的 timeline_* 字段；默认 messages 视图仍是 items。
    const items = asArray(timeline ? value.timeline_items : value.items);
    const nextCursor = timeline ? value.timeline_next_cursor : value.next_cursor;
    const hasMore = timeline ? value.timeline_has_more : value.has_more;
    line(
      `HISTORY ${timeline ? 'TIMELINE ' : ''}room=${roomId} items=${items.length}${
        hasMore ? ' more' : ''
      } next_cursor=${asString(nextCursor, '-')} has_more=${String(hasMore === true)}`,
    );
    for (const raw of items) {
      const item = asRecord(raw);
      if (item.kind === 'presence') {
        line(
          `${asString(item.timeline_seq, '-')}  [presence] ${asString(
            item.transition,
            '?',
          )}  ${asString(item.agent_id, '-')}  ${asString(item.occurred_at, '-')}`,
        );
        continue;
      }
      line(
        `${asString(item.created_seq, asString(item.timeline_seq, '-'))}  ${asString(
          item.message_id,
          '-',
        )}  ${asString(item.sender_kind, '?')}:${asString(item.sender_id, '-')}  ${shorten(
          asString(item.preview),
        )}`,
      );
    }
  });
}

export async function bodyFromArgs(args: CliArgs): Promise<string> {
  let body = requireFlag(args, 'body', '消息正文；传 - 从 stdin 读取');
  if (body === '-') body = await Bun.stdin.text();
  if (body.length === 0) throw new CliError('消息正文不能为空');
  return body;
}

/** `--claim delivery:attempt:claim_id`，与旧脚本和 network_message_send 契约一致。 */
function claimFromArgs(args: CliArgs): Record<string, unknown> | undefined {
  const raw = flagValue(args, 'claim');
  if (raw === undefined) return undefined;
  const [deliveryId, attemptRaw, claimId, ...rest] = raw.split(':');
  if (
    rest.length > 0 ||
    !deliveryId ||
    !claimId ||
    attemptRaw === undefined ||
    !/^\d+$/u.test(attemptRaw)
  ) {
    throw new CliError('--claim 格式为 <delivery-id>:<attempt>:<claim-id>');
  }
  return {
    delivery_id: deliveryId,
    attempt: Number(attemptRaw),
    claim_id: claimId,
  };
}

export async function send(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, [
    'room',
    'body',
    'invoke',
    'no-invoke',
    'mentions',
    'mention',
    'reply-to',
    'task-root',
    'claim',
    'request-id',
    'client-message-id',
  ]);
  const roomId = roomIdFrom(args, 'send');
  const body = await bodyFromArgs(args);
  const explicitInvoke = commaList(flagValue(args, 'invoke'));
  const noInvoke = booleanFlag(args, 'no-invoke');
  if (noInvoke && explicitInvoke !== undefined) {
    throw new CliError('--invoke 与 --no-invoke 不能同时使用');
  }
  const invoke = noInvoke ? [] : explicitInvoke;
  const mentionRaw = flagValue(args, 'mentions') ?? flagValue(args, 'mention');
  const mentions = commaList(mentionRaw);
  const claim = claimFromArgs(args);
  const requestId = flagValue(args, 'request-id') ?? newId('req');
  const clientMessageId = flagValue(args, 'client-message-id') ?? newId('msg');
  const replyTo = flagValue(args, 'reply-to');
  const taskRoot = flagValue(args, 'task-root');
  const result = await client.callTool('network_message_send', {
    request_id: requestId,
    client_message_id: clientMessageId,
    room_id: roomId,
    body,
    ...(invoke === undefined ? {} : { invoke }),
    ...(mentions === undefined ? {} : { mentions }),
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    ...(taskRoot === undefined ? {} : { task_root_id: taskRoot }),
    ...(claim === undefined ? {} : { claim }),
  });
  const output: Record<string, unknown> = {
    ...result,
    request_id: requestId,
    client_message_id: clientMessageId,
  };
  emit(config, output, (value) => {
    const message = asRecord(value.message);
    const deliveries = asArray(value.delivery_ids).map(String);
    line(
      `已发送 ${field('message_id', asString(message.message_id, '-'))} ${field(
        'seq',
        asString(message.created_seq, '-'),
      )} ${field('room_id', roomId)}`,
    );
    line(
      `deliveries=${deliveries.length > 0 ? deliveries.join(',') : 'none'} ${field(
        'request_id',
        requestId,
      )} ${field('client_message_id', clientMessageId)}`,
    );
  });
}

export async function inbox(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['state', 'cursor', 'limit']);
  const state = flagValue(args, 'state');
  if (
    state !== undefined &&
    !['pending', 'claimed', 'completed', 'failed', 'cancelled', 'all'].includes(state)
  ) {
    throw new CliError('--state 只支持 pending|claimed|completed|failed|cancelled|all');
  }
  const limit = optionalIntegerFlag(args, 'limit', { min: 1 });
  const cursor = flagValue(args, 'cursor');
  const result = await client.callTool('network_inbox_list', {
    ...(state === undefined ? {} : { state }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(
      `INBOX pending_count=${asNumber(value.pending_count)} items=${items.length}${
        value.has_more ? ' more' : ''
      } ${field('next_cursor', asString(value.next_cursor, '-'))} ${field(
        'has_more',
        String(value.has_more === true),
      )} ${field('claimed_delivery_id', asString(value.claimed_delivery_id, '-'))}`,
    );
    for (const raw of items) {
      const item = asRecord(raw);
      const message = asRecord(item.message);
      line(
        `${asString(item.state, '?')}  ${asString(item.delivery_id, '-')}  attempt=${asNumber(
          item.attempt,
        )}  ${field('claim_id', asString(item.claim_id, '-'))}  ${field(
          'message_id',
          asString(item.message_id, asString(message.message_id, '-')),
        )}  ${field('room_id', asString(item.room_id, '-'))}  from=${asString(
          message.sender_name,
          asString(message.sender_id, '-'),
        )}`,
      );
      if (message.preview) line(`  ${shorten(asString(message.preview))}`);
    }
  });
}

export async function read(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['message', 'message-id', 'cursor', 'chunk-cursor']);
  const messageId = flagValue(args, 'message') ?? flagValue(args, 'message-id');
  if (!messageId) throw new CliError('用法：agentnet read --message <message-id> [--cursor <chunk-cursor>]');
  const cursor = flagValue(args, 'cursor') ?? flagValue(args, 'chunk-cursor');
  const result = await client.callTool('network_message_read', {
    message_id: messageId,
    ...(cursor === undefined ? {} : { chunk_cursor: cursor }),
  });
  emit(config, result, (value) => {
    const chunk = asString(value.chunk);
    if (chunk.length > 0) process.stdout.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    line(
      `read ${field('message_id', asString(value.message_id, messageId))} ${field(
        'room_id',
        asString(value.room_id, '-'),
      )} ${field('chunk_cursor', asString(value.chunk_cursor, '-'))} ${field(
        'next_cursor',
        asString(value.next_cursor, '-'),
      )} ${field('eof', String(value.eof === true))} ${field(
        'body_bytes',
        asNumber(value.body_bytes),
      )}`,
    );
  });
}

/** 按 client_message_id 对账发送结果；用于响应丢失后判断是否还要重发。 */
export async function sendStatus(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['client-message-id', 'client-message-ids']);
  const raw =
    flagValue(args, 'client-message-id') ??
    flagValue(args, 'client-message-ids') ??
    args.positionals[2] ??
    args.positionals[1];
  const ids = [...new Set(commaList(raw) ?? [])];
  if (ids.length === 0) {
    throw new CliError(
      '用法：agentnet send-status --client-message-id <id>[,<id>]（或 send status <id>）',
    );
  }
  const result = await client.callTool('network_message_send_status', {
    client_message_ids: ids,
  });
  emit(config, result, (value) => {
    const items = asArray(value.items).map(asRecord);
    line(`SEND STATUS (${items.length})`);
    for (const item of items) {
      const deliveries = asArray(item.delivery_ids).map(String);
      line(
        `${asString(item.client_message_id, '-')}  ${field(
          'found',
          String(item.found === true),
        )}  ${field('message_id', asString(item.message_id, '-'))}  ${field(
          'room_id',
          asString(item.room_id, '-'),
        )}  ${field('created_seq', asString(item.created_seq, '-'))}  deliveries=${
          deliveries.length > 0 ? deliveries.join(',') : 'none'
        }`,
      );
    }
  });
}
