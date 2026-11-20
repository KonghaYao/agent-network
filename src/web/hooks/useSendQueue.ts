import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createOutboxIntent,
  findReusableIntent,
  isOutboxIntentExpired,
  isOutboxStorageKey,
  isRetryableError,
  readOutbox,
  removeOutboxIntent,
  updateIntent,
  writeOutbox,
  type OutboxIntent,
} from '../lib/outbox';
import {
  applySendStatus,
  reconcileOutboxStatuses,
} from '../lib/outbox-reconcile';
import { callTool, type McpError } from '../lib/mcp-client';
import type { SendResult, SendStatusItem } from '../lib/chat';
import { useRecoveryState } from '../pwa/recovery';

/**
 * 发送队列：持久意图 + 幂等 request_id/client_message_id + 响应丢失对账。
 *
 * 状态机与 legacy 一致：sending → committed / failed(retryable)。重试前必须
 * 先用 `network_message_send_status` 对账，绝不根据“没收到响应”直接重发。
 */

const STATUS_BATCH = 20;

interface SendInput {
  body: string;
  invoke: string[];
  mentions: string[];
  invokeExplicit: boolean;
  replyTo: string | null;
}

export interface SendOutcome {
  ok: boolean;
  error: string | null;
}

interface UseSendQueueOptions {
  actorId: string | null;
  token: string | null;
  roomId: string;
  onCommitted: (messageId: string) => void;
}

export function useSendQueue({ actorId, token, roomId, onCommitted }: UseSendQueueOptions) {
  const [items, setItems] = useState<OutboxIntent[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const committedRef = useRef(onCommitted);
  committedRef.current = onCommitted;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const actorRef = useRef(actorId);
  actorRef.current = actorId;
  const reconcileInFlightRef = useRef(false);
  const recovery = useRecoveryState();
  const lastRecoveredAtRef = useRef(0);

  const persist = useCallback(
    (next: OutboxIntent[]) => {
      if (actorRef.current !== actorId) return;
      itemsRef.current = next;
      setItems(next);
      if (actorId) writeOutbox(actorId, next);
    },
    [actorId],
  );

  useEffect(() => {
    if (!actorId) {
      itemsRef.current = [];
      setItems([]);
      return;
    }
    // 队列按 actor 共享；只把当前房间的行展示给时间线，写入时保留其他房间。
    const saved = readOutbox(actorId);
    itemsRef.current = saved;
    setItems(saved);
  }, [actorId, roomId]);

  const applyFound = useCallback(
    (intent: OutboxIntent, status: SendStatusItem): OutboxIntent[] =>
      applySendStatus(itemsRef.current, intent, status),
    [],
  );

  const queryStatus = useCallback(
    async (
      ids: string[],
    ): Promise<{ ok: boolean; found: Map<string, SendStatusItem>; stale?: boolean }> => {
      const accessToken = tokenRef.current;
      const actorAtStart = actorRef.current;
      const found = new Map<string, SendStatusItem>();
      if (!accessToken || ids.length === 0) return { ok: true, found };
      for (let index = 0; index < ids.length; index += STATUS_BATCH) {
        const batch = ids.slice(index, index + STATUS_BATCH);
        try {
          const page = await callTool<{ items: SendStatusItem[] }>(
            'network_message_send_status',
            { client_message_ids: batch },
            { token: accessToken },
          );
          if (tokenRef.current !== accessToken || actorRef.current !== actorAtStart) {
            return { ok: false, found, stale: true };
          }
          for (const item of page.items ?? []) {
            if (item.found) found.set(item.client_message_id, item);
          }
        } catch {
          if (tokenRef.current !== accessToken || actorRef.current !== actorAtStart) {
            return { ok: false, found, stale: true };
          }
          return { ok: false, found };
        }
      }
      return { ok: true, found };
    },
    [],
  );

  const reconcile = useCallback(async (): Promise<void> => {
    if (reconcileInFlightRef.current) return;
    const accessToken = tokenRef.current;
    const currentActor = actorRef.current;
    if (!accessToken || !currentActor) return;
    const pending = itemsRef.current.filter(
      (item) => item.room_id === roomId && item.status !== 'committed',
    );
    if (pending.length === 0) return;
    reconcileInFlightRef.current = true;
    try {
      const response = await queryStatus(pending.map((item) => item.client_message_id));
      // 查询失败保持“待确认”；身份代次变化时丢弃晚到结果。
      if (!response.ok || response.stale) return;
      if (actorRef.current !== currentActor || tokenRef.current !== accessToken) return;
      const result = reconcileOutboxStatuses(itemsRef.current, pending, response.found);
      persist(result.items);
      if (result.found) committedRef.current('');
    } finally {
      reconcileInFlightRef.current = false;
    }
  }, [persist, queryStatus, roomId]);

  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  // 前台恢复/更新前显式对账：不因曾对账过而永久跳过。
  useEffect(() => {
    if (!actorId || recovery.phase !== 'ready') return;
    if (recovery.completedAt <= lastRecoveredAtRef.current) return;
    lastRecoveredAtRef.current = recovery.completedAt;
    void reconcile();
  }, [actorId, reconcile, recovery.completedAt, recovery.phase]);

  // 同 actor 另一个标签页写入 journal 后重新并入，不覆盖本地未提交项。
  useEffect(() => {
    if (!actorId) return undefined;
    const onStorage = (event: StorageEvent) => {
      if (!isOutboxStorageKey(actorId, event.key)) return;
      const saved = readOutbox(actorId);
      itemsRef.current = saved;
      setItems(saved);
      void reconcile();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [actorId, reconcile]);

  const markCommitted = useCallback(
    (intent: OutboxIntent, result: SendResult): OutboxIntent[] => {
      const message = result.message;
      return updateIntent(itemsRef.current, intent.client_message_id, {
        status: 'committed',
        retryable: false,
        error: '',
        message_id: message?.message_id ?? null,
        delivery_ids: result.delivery_ids ?? [],
        created_seq: message?.created_seq == null ? null : String(message.created_seq),
        committed_at: Date.now(),
      });
    },
    [],
  );

  const submit = useCallback(
    async (intent: OutboxIntent): Promise<SendOutcome> => {
      const accessToken = tokenRef.current;
      const currentActor = actorRef.current;
      if (!accessToken) return { ok: false, error: '浏览器身份尚未初始化，请刷新页面后重试' };
      persist(
        updateIntent(itemsRef.current, intent.client_message_id, {
          status: 'sending',
          retryable: false,
          error: '',
          attempt: intent.attempt + 1,
        }),
      );
      try {
        const args: Record<string, unknown> = {
          request_id: intent.request_id,
          client_message_id: intent.client_message_id,
          room_id: intent.room_id,
          body: intent.body,
        };
        // 人类无存活选择器目标时省略 invoke，让服务端按正文唯一精确成员解析；
        // 显式目标（含 []）与 Agent 身份照常发送，关闭服务端猜测。
        if (intent.invoke_explicit) args.invoke = intent.invoke;
        if ((intent.mentions ?? []).length > 0) args.mentions = intent.mentions;
        if (intent.reply_to) args.reply_to = intent.reply_to;
        const result = await callTool<SendResult>('network_message_send', args, {
          token: accessToken,
        });
        // 晚到的成功响应不能写进新身份的 outbox。
        if (actorRef.current !== currentActor || tokenRef.current !== accessToken) {
          return { ok: false, error: '身份已变化，请刷新后重新核对发送结果' };
        }
        persist(markCommitted(intent, result));
        committedRef.current(result.message?.message_id ?? '');
        return { ok: true, error: null };
      } catch (error) {
        const failure = error as McpError;
        if (actorRef.current !== currentActor || tokenRef.current !== accessToken) {
          return { ok: false, error: '身份已变化，请刷新后重新核对发送结果' };
        }
        persist(
          updateIntent(itemsRef.current, intent.client_message_id, {
            status: 'failed',
            retryable: isRetryableError(failure),
            error: failure.message || '发送失败',
          }),
        );
        return { ok: false, error: failure.message || '发送失败' };
      }
    },
    [markCommitted, persist],
  );

  const send = useCallback(
    async (input: SendInput): Promise<SendOutcome> => {
      if (!tokenRef.current) return { ok: false, error: '浏览器身份尚未初始化，请刷新页面后重试' };
      const reusable = findReusableIntent(itemsRef.current, {
        roomId,
        body: input.body,
        invoke: input.invoke,
        mentions: input.mentions,
        invokeExplicit: input.invokeExplicit,
        replyTo: input.replyTo,
      });
      if (reusable) {
        const response = await queryStatus([reusable.client_message_id]);
        if (response.stale) return { ok: false, error: '身份已变化，请刷新后重新核对发送结果' };
        if (response.ok) {
          const status = response.found.get(reusable.client_message_id);
          if (status) {
            persist(applyFound(reusable, status));
            committedRef.current(status.message_id ?? '');
            return { ok: true, error: null };
          }
        } else {
          return { ok: false, error: '暂时无法对账，请稍后重试' };
        }
        return submit(reusable);
      }
      const intent = createOutboxIntent({
        roomId,
        body: input.body,
        invoke: input.invoke,
        mentions: input.mentions,
        invokeExplicit: input.invokeExplicit,
        replyTo: input.replyTo,
      });
      persist([...itemsRef.current, intent]);
      return submit(intent);
    },
    [applyFound, persist, queryStatus, roomId, submit],
  );

  const retry = useCallback(
    async (clientMessageId: string): Promise<SendOutcome> => {
      const intent = itemsRef.current.find((item) => item.client_message_id === clientMessageId);
      if (!intent) return { ok: false, error: '发送意图不存在' };
      if (isOutboxIntentExpired(intent)) {
        persist(
          updateIntent(itemsRef.current, clientMessageId, {
            status: 'failed',
            retryable: false,
            error: '发送意图已过期，未自动重发',
          }),
        );
        return { ok: false, error: '发送意图已过期，请重新输入' };
      }
      const response = await queryStatus([clientMessageId]);
      if (response.stale) return { ok: false, error: '身份已变化，请刷新后重新核对发送结果' };
      if (response.ok) {
        const status = response.found.get(clientMessageId);
        if (status) {
          persist(applyFound(intent, status));
          committedRef.current(status.message_id ?? '');
          return { ok: true, error: null };
        }
      } else {
        return { ok: false, error: '暂时无法对账，请稍后重试' };
      }
      return submit(intent);
    },
    [applyFound, persist, queryStatus, submit],
  );

  const remove = useCallback(
    (clientMessageId: string) => {
      if (actorId) removeOutboxIntent(actorId, clientMessageId);
      const next = itemsRef.current.filter(
        (item) => item.client_message_id !== clientMessageId,
      );
      itemsRef.current = next;
      setItems(next);
    },
    [actorId],
  );

  /** 服务端消息进入时间线后清掉本地“已提交”行；失败行保留给用户重试。 */
  const prune = useCallback(
    (knownMessageIds: Set<string>) => {
      const filtered = itemsRef.current.filter((item) => {
        if (item.status !== 'committed') return true;
        return Boolean(item.message_id && !knownMessageIds.has(item.message_id));
      });
      if (filtered.length !== itemsRef.current.length) persist(filtered);
    },
    [persist],
  );

  const visible = items.filter((item) => item.room_id === roomId);
  return { items: visible, send, retry, remove, prune, reconcile };
}
