/** 消息式 Task：mark/unmark/summaries/trace/search。 */

import { commaList, newId, optionalInteger, required } from '../options';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import { asArray, asNumber, asRecord, asString, emit, field, line, shorten } from '../output';

export interface TaskMarkOptions {
  room?: string;
  message?: string;
  requestId?: string;
}

export async function taskMark(
  client: McpClient,
  config: ResolvedConfig,
  options: TaskMarkOptions,
): Promise<void> {
  const result = await client.callTool('network_task_mark', {
    request_id: options.requestId ?? newId('req'),
    room_id: required(options.room, 'room', { command: 'task mark' }),
    message_id: required(options.message, 'message', {
      suggestion: '要标记的消息 id',
      command: 'task mark',
    }),
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
  options: TaskMarkOptions,
): Promise<void> {
  const result = await client.callTool('network_task_unmark', {
    request_id: options.requestId ?? newId('req'),
    room_id: required(options.room, 'room', { command: 'task unmark' }),
    message_id: required(options.message, 'message', {
      suggestion: '要取消标记的消息 id',
      command: 'task unmark',
    }),
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

export interface TaskSummariesOptions {
  room?: string;
  roots?: string;
  root?: string;
}

export async function taskSummaries(
  client: McpClient,
  config: ResolvedConfig,
  options: TaskSummariesOptions,
): Promise<void> {
  const roots = commaList(options.roots ?? options.root) ?? [];
  if (roots.length === 0) {
    throw new CliError(
      '缺少 --roots（逗号分隔的 task_root_id，最多 20 个；运行 agentnet task summaries --help 查看示例）',
    );
  }
  const result = await client.callTool('network_task_summaries', {
    room_id: required(options.room, 'room', { command: 'task summaries' }),
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

export interface TaskTraceOptions {
  room?: string;
  root?: string;
  cursor?: string;
  focus?: string;
  limit?: string;
}

export async function taskTrace(
  client: McpClient,
  config: ResolvedConfig,
  options: TaskTraceOptions,
): Promise<void> {
  const limit = optionalInteger(options.limit, 'limit', { min: 1, command: 'task trace' });
  const result = await client.callTool('network_task_trace', {
    room_id: required(options.room, 'room', { command: 'task trace' }),
    root_message_id: required(options.root, 'root', {
      suggestion: 'Task 起点 message id',
      command: 'task trace',
    }),
    ...(limit === undefined ? {} : { limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.focus === undefined ? {} : { focus_message_id: options.focus }),
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

export interface TaskSearchOptions {
  room?: string;
  query?: string;
  cursor?: string;
  limit?: string;
}

export async function taskSearch(
  client: McpClient,
  config: ResolvedConfig,
  options: TaskSearchOptions,
): Promise<void> {
  const limit = optionalInteger(options.limit, 'limit', { min: 1, command: 'task search' });
  const result = await client.callTool('network_task_search', {
    room_id: required(options.room, 'room', { command: 'task search' }),
    query: required(options.query, 'query', { command: 'task search' }),
    ...(limit === undefined ? {} : { limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
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
