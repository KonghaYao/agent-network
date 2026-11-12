/**
 * 共享 Server-Sent Events 解析。
 *
 * CLI、monitor 与测试 harness 都使用同一份 eventsource-parser 行为，
 * 覆盖 BOM、CRLF/CR、多行 `data:`、`id`、`retry` 与注释行。
 * web 内联脚本不能 import 包，仍保留自己的解析器。
 */

import { createParser } from 'eventsource-parser';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { EventSourceMessage } from 'eventsource-parser';

export type SseMessage = EventSourceMessage;

export interface SseStreamOptions {
  /** keepalive 注释行；调用方可借此刷新空闲计时。 */
  onComment?: (comment: string) => void;
  onRetry?: (retry: number) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * eventsource-parser@3 只按 LF/CRLF 分行；SSE 规范也接受单独的 CR。
 * 这里在解析前统一换行，并处理 CR 落在 chunk 边界的情况。
 */
function newlineNormalizer(): TransformStream<string, string> {
  let pendingCr = false;
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      let text = pendingCr ? `\r${chunk}` : chunk;
      pendingCr = false;
      if (text.endsWith('\r')) {
        pendingCr = true;
        text = text.slice(0, -1);
      }
      controller.enqueue(text.replace(/\r\n?/gu, '\n'));
    },
    flush(controller) {
      if (pendingCr) controller.enqueue('\n');
    },
  });
}

/** 把字节流解码并解析为 SSE 消息；调用方只处理需要的 `data`。 */
export async function* sseMessageStream(
  body: ReadableStream<Uint8Array>,
  options: SseStreamOptions = {},
): AsyncGenerator<SseMessage> {
  const stream = body
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .pipeThrough(newlineNormalizer())
    .pipeThrough(new EventSourceParserStream(options));
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * 从一段完整或残缺的 SSE 文本中提取最后一个合法 JSON 对象。
 *
 * 用于一次性响应（例如 `text/event-stream` 的 JSON-RPC 回包）与测试 harness
 * 的单帧解析；无法解析的 keepalive/通知帧直接忽略。
 */
export function parseSseJsonText(text: string): Record<string, unknown> | null {
  let candidate: Record<string, unknown> | null = null;
  const parser = createParser({
    onEvent(event) {
      if (event.data.length === 0) return;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (isRecord(parsed)) candidate = parsed;
      } catch {
        // 忽略无法解析的帧；SSE 可能包含 keepalive 或非 JSON 通知。
      }
    },
  });
  // createParser 不处理 BOM；流式路径由 EventSourceParserStream 负责。
  const input = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/gu, '\n');
  // 单帧文本通常没有结尾空行；补一个事件分隔符再解析。
  parser.feed(`${input}\n\n`);
  parser.reset({ consume: true });
  return candidate;
}
