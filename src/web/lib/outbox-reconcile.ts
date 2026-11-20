import { isOutboxIntentExpired, updateIntent, type OutboxIntent } from './outbox';
import type { SendStatusItem } from './chat';

/**
 * 发送状态对账的纯函数：一次查询找到多条结果时必须累积到同一个 next，
 * 不能每条都从旧 items 重算而丢掉前一条。
 */

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function applySendStatus(
  items: OutboxIntent[],
  intent: OutboxIntent,
  status: SendStatusItem,
): OutboxIntent[] {
  if (status.room_id !== intent.room_id) {
    return updateIntent(items, intent.client_message_id, {
      status: 'failed',
      retryable: false,
      error: 'client_message_id 已用于其他房间',
      message_id: status.message_id,
    });
  }
  if (!status.recalled && Number(status.body_bytes) !== byteLength(intent.body)) {
    return updateIntent(items, intent.client_message_id, {
      status: 'failed',
      retryable: false,
      error: 'client_message_id 已用于不同正文',
      message_id: status.message_id,
    });
  }
  return updateIntent(items, intent.client_message_id, {
    status: 'committed',
    retryable: false,
    error: '',
    message_id: status.message_id,
    delivery_ids: status.delivery_ids,
    created_seq: status.created_seq,
    committed_at: Date.now(),
  });
}

export interface ReconcileResult {
  items: OutboxIntent[];
  /** 任意一条在服务端找到：调用方可以主动刷新时间线。 */
  found: boolean;
}

export function reconcileOutboxStatuses(
  items: OutboxIntent[],
  pending: OutboxIntent[],
  statuses: Map<string, SendStatusItem>,
  now = Date.now(),
): ReconcileResult {
  let next = items;
  let found = false;
  for (const intent of pending) {
    const status = statuses.get(intent.client_message_id);
    if (status) {
      next = applySendStatus(next, intent, status);
      found = true;
      continue;
    }
    if (isOutboxIntentExpired(intent, now)) {
      next = updateIntent(next, intent.client_message_id, {
        status: 'failed',
        retryable: false,
        error: '发送意图已过期，未自动重发',
      });
      continue;
    }
    if (intent.status === 'sending') {
      next = updateIntent(next, intent.client_message_id, {
        status: 'failed',
        retryable: true,
        error: '发送状态未确认，可重试',
      });
    }
  }
  return { items: next, found };
}
