/** 消息式 Task：mark/unmark/summaries/trace/search。 */

import type { CliArgs } from '../args';
import {
  assertKnownFlags,
  commaList,
  flagValue,
  newId,
  optionalIntegerFlag,
  requireFlag,
} from '../args';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import { asArray, asNumber, asRecord, asString, emit, field, line, shorten } from '../output';

export async function taskMark(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['room', 'message', 'request-id']);
  const result = await client.callTool('network_task_mark', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    room_id: requireFlag(args, 'room'),
    message_id: requireFlag(args, 'message', '要标记的消息 id'),
  });
  emit(config, result, (value) => {
    line(
      `TASK marked ${field('room_id', asString(value.room_id, '-'))} ${field(
        'task_root_id',
        asString(value.task_root_id, asString(value.message_id, '-')),
      )}`,
    );
  });
}

export async function taskUnmark(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['room', 'message', 'request-id']);
  const result = await client.callTool('network_task_unmark', {
    request_id: flagValue(args, 'request-id') ?? newId('req'),
    room_id: requireFlag(args, 'room'),
    message_id: requireFlag(args, 'message', '要取消标记的消息 id'),
  });
  emit(config, result, (value) => {
    line(
      `TASK unmarked ${field('room_id', asString(value.room_id, '-'))} ${field(
        'task_root_id',
        asString(value.task_root_id, asString(value.message_id, '-')),
      )}`,
    );
  });
}

export async function taskSummaries(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['room', 'roots', 'root']);
  const roots = commaList(flagValue(args, 'roots') ?? flagValue(args, 'root')) ?? [];
  if (roots.length === 0) {
    throw new CliError('缺少 --roots（逗号分隔的 task_root_id，最多 20 个）');
  }
  const result = await client.callTool('network_task_summaries', {
    room_id: requireFlag(args, 'room'),
    root_message_ids: roots,
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(`TASK SUMMARIES (${items.length})`);
    for (const raw of items) {
      const item = asRecord(raw);
      line(
        `${asString(item.root_message_id, asString(item.task_root_id, '-'))}  messages=${asNumber(
          item.message_count,
        )}  participants=${asNumber(
          item.participant_count,
          asArray(item.participants).length,
        )}${item.can_unmark === false ? '  read-only' : ''}`,
      );
      const preview = asString(item.preview);
      if (preview) line(`  ${shorten(preview)}`);
    }
  });
}

export async function taskTrace(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['room', 'root', 'cursor', 'focus', 'limit']);
  const limit = optionalIntegerFlag(args, 'limit', { min: 1 });
  const cursor = flagValue(args, 'cursor');
  const focus = flagValue(args, 'focus');
  const result = await client.callTool('network_task_trace', {
    room_id: requireFlag(args, 'room'),
    root_message_id: requireFlag(args, 'root', 'Task 起点 message id'),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(focus === undefined ? {} : { focus_message_id: focus }),
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(
      `TASK TRACE items=${items.length}${value.has_more_before ? ' more-before' : ''}${
        value.has_more_after ? ' more-after' : ''
      } next_cursor=${asString(value.next_cursor, '-')} prev_cursor=${asString(
        value.prev_cursor,
        '-',
      )} has_more_before=${String(value.has_more_before === true)} has_more_after=${String(
        value.has_more_after === true,
      )}`,
    );
    for (const raw of items) {
      const item = asRecord(raw);
      line(
        `${asString(item.created_seq, '-')}  ${asString(item.message_id, '-')}  ${asString(
          item.role,
          '?',
        )}  ${shorten(asString(item.preview))}`,
      );
    }
  });
}

export async function taskSearch(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, ['room', 'query', 'cursor', 'limit']);
  const limit = optionalIntegerFlag(args, 'limit', { min: 1 });
  const cursor = flagValue(args, 'cursor');
  const result = await client.callTool('network_task_search', {
    room_id: requireFlag(args, 'room'),
    query: requireFlag(args, 'query'),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  emit(config, result, (value) => {
    const items = asArray(value.items);
    line(
      `TASK SEARCH items=${items.length}${value.truncated ? ' truncated' : ''} next_cursor=${asString(
        value.next_cursor,
        '-',
      )} has_more=${String(value.has_more === true)}`,
    );
    for (const raw of items) {
      const item = asRecord(raw);
      const task = asRecord(item.task);
      line(
        `${asString(task.root_message_id, asString(task.task_root_id, '-'))}  hits=${asNumber(
          item.hit_count,
          asArray(item.matches).length,
        )}  ${shorten(asString(task.preview))}`,
      );
    }
  });
}
