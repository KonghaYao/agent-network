import { LIMITS } from '../../contracts/limits';
import type { HistoryItem, HistoryPage } from './chat';
import { callTool } from './mcp-client';

/**
 * 群聊自动 @ 的发送前兜底读取。
 *
 * 自动 @ 原先只看已加载历史窗口，而窗口在长时间挂起、恢复轮进行中、历史
 * 补读失败或只打开旧页时可能为空/滞后。这里只回读最近一条消息，代价是
 * 一次 limit=1 的只读调用；失败或超时返回 null，调用方按现有窗口语义继续
 * 发送，不阻塞、不报错、不丢消息。
 */
export async function readLatestMentionItems(options: {
  token: string;
  roomId: string;
  timeoutMs?: number;
}): Promise<HistoryItem[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LIMITS.webAutoMentionProbeTimeoutMs,
  );
  try {
    const page = await callTool<HistoryPage>(
      'network_history_list',
      {
        room_id: options.roomId,
        direction: 'before',
        limit: LIMITS.webAutoMentionProbeLimit,
      },
      { token: options.token, signal: controller.signal },
    );
    // 服务端按 created_seq 倒序返回；buildSendPlan 的 items 按时间正序。
    return page.items.slice().reverse();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
