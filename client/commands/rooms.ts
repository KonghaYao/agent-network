/** 房间、历史、发送与收件箱。 */

import { commaList, newId, optionalInteger, required } from '../options';
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

function roomIdFrom(value: string | undefined, command: string): string {
  if (!value) {
    throw new CliError(
      `缺少房间 id：使用 ${command} --room <id>（可用 rooms 查看；运行 agentnet ${command} --help 查看示例）`,
    );
  }
  return value;
}

export interface RoomsOptions {
  limit?: string;
  cursor?: string;
}

export async function rooms(
  client: McpClient,
  config: ResolvedConfig,
  options: RoomsOptions,
): Promise<void> {
  const limit = optionalInteger(options.limit, 'limit', { min: 1, command: 'rooms' });
  const cursor = options.cursor;
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

export interface HistoryOptions {
  room?: string;
  cursor?: string;
  limit?: string;
  direction?: string;
  timeline?: boolean;
}

export async function history(
  client: McpClient,
  config: ResolvedConfig,
  options: HistoryOptions,
  positionalRoom?: string,
): Promise<void> {
  const roomId = roomIdFrom(options.room ?? positionalRoom, 'history');
  const limit = optionalInteger(options.limit, 'limit', { min: 1, command: 'history' });
  const cursor = options.cursor;
  const direction = options.direction;
  if (direction !== undefined && direction !== 'before' && direction !== 'after') {
    throw new CliError('--direction 只支持 before 或 after（运行 agentnet history --help 查看示例）');
  }
  const timeline = options.timeline === true;
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

export async function bodyFromOptions(
  body: string | undefined,
  command = 'send',
): Promise<string> {
  let text = required(body, 'body', {
    suggestion: '消息正文；传 - 从 stdin 读取',
    command,
  });
  if (text === '-') text = await Bun.stdin.text();
  if (text.length === 0) throw new CliError('消息正文不能为空');
  return text;
}

/** `--claim delivery:attempt:claim_id`，与旧脚本和 network_message_send 契约一致。 */
function claimFromOptions(raw: string | undefined): Record<string, unknown> | undefined {
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

export interface SendOptions {
  room?: string;
  body?: string;
  invoke?: string;
  noInvoke?: boolean;
  mentions?: string;
  mention?: string;
  replyTo?: string;
  taskRoot?: string;
  claim?: string;
  requestId?: string;
  clientMessageId?: string;
}

export async function send(
  client: McpClient,
  config: ResolvedConfig,
  options: SendOptions,
  positionalRoom?: string,
): Promise<void> {
  const roomId = roomIdFrom(options.room ?? positionalRoom, 'send');
  const body = await bodyFromOptions(options.body);
  const explicitInvoke = commaList(options.invoke);
  const noInvoke = options.noInvoke === true;
  if (noInvoke && explicitInvoke !== undefined) {
    throw new CliError('--invoke 与 --no-invoke 不能同时使用（运行 agentnet send --help 查看示例）');
  }
  const invoke = noInvoke ? [] : explicitInvoke;
  const mentionRaw = options.mentions ?? options.mention;
  const mentions = commaList(mentionRaw);
  const claim = claimFromOptions(options.claim);
  const requestId = options.requestId ?? newId('req');
  const clientMessageId = options.clientMessageId ?? newId('msg');
  const replyTo = options.replyTo;
  const taskRoot = options.taskRoot;
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

export interface InboxOptions {
  state?: string;
  cursor?: string;
  limit?: string;
}

export async function inbox(
  client: McpClient,
  config: ResolvedConfig,
  options: InboxOptions,
): Promise<void> {
  const state = options.state;
  if (
    state !== undefined &&
    !['pending', 'claimed', 'completed', 'failed', 'cancelled', 'all'].includes(state)
  ) {
    throw new CliError(
      '--state 只支持 pending|claimed|completed|failed|cancelled|all（运行 agentnet inbox --help 查看示例）',
    );
  }
  const limit = optionalInteger(options.limit, 'limit', { min: 1, command: 'inbox' });
  const cursor = options.cursor;
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

export interface ReadOptions {
  message?: string;
  messageId?: string;
  cursor?: string;
  chunkCursor?: string;
}

export async function read(
  client: McpClient,
  config: ResolvedConfig,
  options: ReadOptions,
): Promise<void> {
  const messageId = options.message ?? options.messageId;
  if (!messageId) {
    throw new CliError(
      '用法：agentnet read --message <message-id> [--cursor <chunk-cursor>]（运行 agentnet read --help 查看示例）',
    );
  }
  const cursor = options.cursor ?? options.chunkCursor;
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
export interface SendStatusOptions {
  clientMessageId?: string;
  clientMessageIds?: string;
}

export async function sendStatus(
  client: McpClient,
  config: ResolvedConfig,
  options: SendStatusOptions,
  positionalIds: readonly string[] = [],
): Promise<void> {
  const raw =
    options.clientMessageId ??
    options.clientMessageIds ??
    positionalIds.filter((value) => value.length > 0).join(',');
  const ids = [...new Set(commaList(raw) ?? [])];
  if (ids.length === 0) {
    throw new CliError(
      '用法：agentnet send-status --client-message-id <id>[,<id>]（或 send status <id>；运行 agentnet send-status --help 查看示例）',
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
