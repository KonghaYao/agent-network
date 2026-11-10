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
    line(`ROOMS (${items.length}${value.has_more ? ', more' : ''})`);
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
  const result = await client.callTool('network_history_list', {
    room_id: roomId,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(direction === undefined ? {} : { direction }),
    ...(booleanFlag(args, 'timeline') ? { view: 'timeline' } : {}),
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`HISTORY room=${roomId} items=${items.length}${value.has_more ? ' more' : ''}`);
    for (const raw of items) {
      const item = asRecord(raw);
      line(
        `${asString(item.created_seq, '-')}  ${asString(item.message_id, '-')}  ${asString(
          item.sender_kind,
          '?',
        )}:${asString(item.sender_id, '-')}  ${shorten(asString(item.preview))}`,
      );
    }
  });
}

async function bodyFromArgs(args: CliArgs): Promise<string> {
  let body = requireFlag(args, 'body', '消息正文；传 - 从 stdin 读取');
  if (body === '-') body = await Bun.stdin.text();
  if (body.length === 0) throw new CliError('消息正文不能为空');
  return body;
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
    'mentions',
    'reply-to',
    'task-root',
    'request-id',
    'client-message-id',
  ]);
  const roomId = roomIdFrom(args, 'send');
  const body = await bodyFromArgs(args);
  const invoke = commaList(flagValue(args, 'invoke'));
  const mentions = commaList(flagValue(args, 'mentions'));
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
  });
  emit(config, result, (value) => {
    const message = asRecord(value.message);
    const deliveries = asArray(value.delivery_ids).map(String);
    line(
      `已发送 ${field('message_id', asString(message.message_id, '-'))} ${field(
        'seq',
        asString(message.created_seq, '-'),
      )} ${field('room_id', roomId)}`,
    );
    line(`deliveries=${deliveries.length > 0 ? deliveries.join(',') : 'none'}`);
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
      }`,
    );
    for (const raw of items) {
      const item = asRecord(raw);
      const message = asRecord(item.message);
      line(
        `${asString(item.state, '?')}  ${asString(item.delivery_id, '-')}  attempt=${asNumber(
          item.attempt,
        )}  room=${asString(item.room_id, '-')}  from=${asString(
          message.sender_name,
          asString(message.sender_id, '-'),
        )}`,
      );
      if (message.preview) line(`  ${shorten(asString(message.preview))}`);
    }
  });
}
