import { callTool } from './mcp-client';

/**
 * 分块读取消息正文；与 legacy 的 8 次上限一致，超限时保留截断提示。
 */

const MAX_CHUNKS = 8;
const textEncoder = new TextEncoder();

interface ReadChunk {
  chunk: string;
  next_cursor: string | null;
  eof: boolean;
}

export interface ReadFullMessageOptions {
  /** 累计正文超过该 UTF-8 字节数即停止；默认不限制。 */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ReadFullMessageResult {
  /** 已读到的正文片段；`truncated` 为 true 时不代表完整原文。 */
  text: string;
  truncated: boolean;
}

/**
 * 读取完整正文，并把“是否读全”交给调用方判断。
 *
 * 超过 `maxBytes` 时提前停止后续分块请求，避免为了放弃缓存而白读大消息。
 */
export async function readFullMessageDetailed(
  messageId: string,
  token?: string,
  options: ReadFullMessageOptions = {},
): Promise<ReadFullMessageResult> {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  let chunk = await callTool<ReadChunk>(
    'network_message_read',
    { message_id: messageId },
    { token, signal: options.signal },
  );
  let text = chunk.chunk;
  let cursor = chunk.next_cursor;
  for (let index = 0; index < MAX_CHUNKS && cursor && !chunk.eof; index += 1) {
    if (textEncoder.encode(text).length > maxBytes) break;
    chunk = await callTool<ReadChunk>(
      'network_message_read',
      { message_id: messageId, chunk_cursor: cursor },
      { token, signal: options.signal },
    );
    text += chunk.chunk;
    cursor = chunk.next_cursor;
  }
  const truncated = textEncoder.encode(text).length > maxBytes || Boolean(cursor);
  return { text, truncated };
}

export async function readFullMessage(
  messageId: string,
  token?: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await readFullMessageDetailed(messageId, token, { signal });
  return result.truncated ? `${result.text}\n…（消息过长，已截断）` : result.text;
}
