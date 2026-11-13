import { callTool } from './mcp-client';

/**
 * 分块读取消息正文；与 legacy 的 8 次上限一致，超限时保留截断提示。
 */

const MAX_CHUNKS = 8;

interface ReadChunk {
  chunk: string;
  next_cursor: string | null;
  eof: boolean;
}

export async function readFullMessage(
  messageId: string,
  token?: string,
  signal?: AbortSignal,
): Promise<string> {
  let chunk = await callTool<ReadChunk>(
    'network_message_read',
    { message_id: messageId },
    { token, signal },
  );
  let text = chunk.chunk;
  let cursor = chunk.next_cursor;
  for (let index = 0; index < MAX_CHUNKS && cursor && !chunk.eof; index += 1) {
    chunk = await callTool<ReadChunk>(
      'network_message_read',
      { message_id: messageId, chunk_cursor: cursor },
      { token, signal },
    );
    text += chunk.chunk;
    cursor = chunk.next_cursor;
  }
  if (cursor) text += '\n…（消息过长，已截断）';
  return text;
}
