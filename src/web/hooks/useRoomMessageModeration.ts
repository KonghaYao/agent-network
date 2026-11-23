import { useCallback, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../contracts/limits';
import { confirmDialog } from '../features/overlays/confirm';
import type { HistoryMessage, PinnedMessage, RoomView } from '../lib/chat';
import { callTool, type McpError } from '../lib/mcp-client';
import { readFullMessageDetailed } from '../lib/message-body';
import {
  cacheableRecalledDraftBody,
  readRecalledDraft,
  RECALLED_DRAFT_BODY_MAX_BYTES,
  rememberRecalledDraft,
} from '../lib/recalled-drafts';
import { newRequestId } from '../lib/request-id';
import { setUpdateBusy } from '../pwa/update-busy';
import { isUpdateWriteBlocked, useUpdateWriteBlocked } from '../pwa/update-store';
import type { ModerationRefresh } from './useRoomChat';

const UPDATE_BLOCKED_MESSAGE = '当前页面与服务器版本不兼容，请先更新后再操作。';

/**
 * 撤回前读取原文的短超时。
 *
 * 两分钟撤回窗口优先：读取只是“重新编辑”入口的增益，超时直接放弃缓存，
 * 随后仍按原逻辑撤回，绝不因为读取慢而拖过窗口或报错。
 */
const RECALL_BODY_READ_TIMEOUT_MS = 1500;

/** 普通成员的剩余撤回窗口；时间缺失时按已进入安全余量处理。 */
function recallWindowRemainingMs(item: HistoryMessage, now = Date.now()): number {
  const createdAt = Number(item.created_at);
  if (!Number.isFinite(createdAt)) return 0;
  return LIMITS.messageRecallWindowMs - (now - createdAt);
}

/**
 * 本次读取原文可用的超时。
 *
 * 群主（`canModerate`）不受两分钟窗口限制，固定 1.5s；普通成员剩余窗口
 * 不足安全余量时返回 null，调用方跳过读取立刻撤回。
 */
export function recallDraftReadTimeoutMs(
  item: HistoryMessage,
  canModerate: boolean,
  now = Date.now(),
): number | null {
  if (canModerate) return RECALL_BODY_READ_TIMEOUT_MS;
  const remaining = recallWindowRemainingMs(item, now);
  if (remaining <= LIMITS.webRecallWindowSafetyMarginMs) return null;
  return Math.min(
    RECALL_BODY_READ_TIMEOUT_MS,
    remaining - LIMITS.webRecallWindowSafetyMarginMs,
  );
}

/** 读取本机没有副本的本人消息；任何失败都返回 null，不影响撤回。 */
async function fetchRecallDraftBody(
  messageId: string,
  token: string,
  timeoutMs = RECALL_BODY_READ_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const { text, truncated } = await readFullMessageDetailed(messageId, token, {
      maxBytes: RECALLED_DRAFT_BODY_MAX_BYTES,
      signal: controller.signal,
    });
    if (truncated) return null;
    return cacheableRecalledDraftBody(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface UseRoomMessageModerationOptions {
  room: RoomView | null;
  pinnedMessages: PinnedMessage[];
  identityId: string | null;
  token: string | null;
  onStatus: (message: string) => void;
  /** 撤回成功后的 UI 清理；锚点窗口刷新也由调用方在这里收口。 */
  onRecalled: (item: HistoryMessage) => void;
  refreshModeration: (options: ModerationRefresh) => Promise<void>;
}

export interface RoomMessageModeration {
  canModerate: boolean;
  pinnedMessageIds: ReadonlySet<string>;
  busy: boolean;
  recall: (item: HistoryMessage) => Promise<void>;
  setPinned: (item: HistoryMessage, pinned: boolean) => Promise<void>;
  /** 置顶区可取消尚未加载正文的消息，只需要 message_id。 */
  unpin: (messageId: string) => Promise<void>;
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

function pinLimitFailure(error: unknown): boolean {
  const failure = error as McpError;
  return failure.code === 'CONFLICT' && failure.details?.reason === 'pin_limit';
}

/**
 * 群主消息管理：撤回任意可见消息、置顶/取消置顶。
 *
 * 权限只相信服务端返回的 `capabilities.manage_messages`；admin/member 不会
 * 因为本地角色缓存获得入口。所有写操作在开始前和确认后复检更新闸门，
 * 并用独立 busy key 防止同一页面重复提交。
 */
export function useRoomMessageModeration({
  room,
  pinnedMessages,
  identityId,
  token,
  onStatus,
  onRecalled,
  refreshModeration,
}: UseRoomMessageModerationOptions): RoomMessageModeration {
  const writeBlocked = useUpdateWriteBlocked();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const busyKeyRef = useRef<string | null>(null);
  const operationRef = useRef(0);

  const canModerate =
    room?.kind === 'group' &&
    !room.read_only &&
    room.capabilities?.manage_messages === true;
  const pinnedMessageIds = useMemo(
    () =>
      new Set(
        pinnedMessages
          .slice(0, LIMITS.roomPinnedMessagesMax)
          .map((message) => message.message_id),
      ),
    [pinnedMessages],
  );

  const begin = useCallback((operation: string) => {
    busyRef.current = true;
    setBusy(true);
    const key = `room-moderation:${room?.room_id ?? ''}:${operation}:${++operationRef.current}`;
    busyKeyRef.current = key;
    setUpdateBusy(key, '正在更新群消息');
    return key;
  }, [room?.room_id]);

  const finish = useCallback((key: string) => {
    setUpdateBusy(key, null);
    if (busyKeyRef.current === key) busyKeyRef.current = null;
    busyRef.current = false;
    setBusy(false);
  }, []);

  const recall = useCallback(
    async (item: HistoryMessage) => {
      if (!room || !token || busyRef.current) return;
      if (!canModerate && item.sender_id !== identityId) return;
      if (isUpdateWriteBlocked()) {
        onStatus(UPDATE_BLOCKED_MESSAGE);
        return;
      }
      const ownerCopy =
        '撤回后保留已撤回提示，未完成的 Agent 工作会取消；文件访问权限不变。';
      const confirmed = await confirmDialog({
        title: '撤回消息',
        message: canModerate
          ? ownerCopy
          : '撤回这条消息？仅支持两分钟内的普通消息，已触发的 Agent 工作需单独取消。',
        confirmText: '撤回',
        danger: true,
      });
      if (!confirmed) return;
      if (isUpdateWriteBlocked()) {
        onStatus(UPDATE_BLOCKED_MESSAGE);
        return;
      }
      if (busyRef.current) return;
      const key = begin('recall');
      try {
        // 只有本人消息才抓取原文；群主撤回他人消息不得读取或缓存正文。
        // 发送成功时已留存的副本直接复用，不再浪费一次读取。普通成员的
        // 读取必须给撤回留出安全余量，窗口不足时跳过读取直接撤回。
        if (
          identityId &&
          item.sender_id === identityId &&
          readRecalledDraft(identityId, item.message_id) === null
        ) {
          const readTimeout = recallDraftReadTimeoutMs(item, canModerate);
          if (readTimeout !== null) {
            const body = await fetchRecallDraftBody(item.message_id, token, readTimeout);
            // 读取返回后复核窗口：已进入安全余量时不再缓存，立刻撤回，
            // 也不做任何其它可选异步动作。
            if (
              body &&
              (canModerate ||
                recallWindowRemainingMs(item) > LIMITS.webRecallWindowSafetyMarginMs)
            ) {
              rememberRecalledDraft(identityId, item.message_id, body);
            }
          }
        }
        await callTool(
          'network_message_recall',
          { request_id: newRequestId('web_recall'), message_id: item.message_id },
          { token },
        );
        onStatus('消息已撤回');
        onRecalled(item);
        await refreshModeration({
          messageId: item.message_id,
          hasTask: Boolean(item.task_root_id),
        });
      } catch (error) {
        onStatus(`撤回失败：${failureText(error)}`);
      } finally {
        finish(key);
      }
    },
    [
      begin,
      canModerate,
      finish,
      identityId,
      onRecalled,
      onStatus,
      refreshModeration,
      room,
      token,
    ],
  );

  const setPinnedMessage = useCallback(
    async (messageId: string, targetPinned: boolean) => {
      if (!room || !token || !canModerate || busyRef.current) return;
      if (
        targetPinned &&
        !pinnedMessageIds.has(messageId) &&
        pinnedMessageIds.size >= LIMITS.roomPinnedMessagesMax
      ) {
        onStatus('最多置顶 3 条，请先取消一条');
        return;
      }
      if (isUpdateWriteBlocked()) {
        onStatus(UPDATE_BLOCKED_MESSAGE);
        return;
      }
      const key = begin(targetPinned ? 'pin' : 'unpin');
      try {
        await callTool(
          'network_room_message_pin',
          {
            request_id: newRequestId(targetPinned ? 'web_pin' : 'web_unpin'),
            room_id: room.room_id,
            message_id: messageId,
            pinned: targetPinned,
          },
          { token },
        );
        onStatus(targetPinned ? '已置顶' : '已取消置顶');
        await refreshModeration({ pinsOnly: true });
      } catch (error) {
        onStatus(
          pinLimitFailure(error)
            ? '置顶失败：最多置顶 3 条，请先取消一条'
            : `${targetPinned ? '置顶' : '取消置顶'}失败：${failureText(error)}`,
        );
      } finally {
        finish(key);
      }
    },
    [
      begin,
      canModerate,
      finish,
      onStatus,
      pinnedMessageIds,
      refreshModeration,
      room,
      token,
    ],
  );

  const setPinned = useCallback(
    (item: HistoryMessage, targetPinned: boolean) =>
      setPinnedMessage(item.message_id, targetPinned),
    [setPinnedMessage],
  );

  const unpin = useCallback(
    (messageId: string) => setPinnedMessage(messageId, false),
    [setPinnedMessage],
  );

  return {
    canModerate: canModerate === true && !writeBlocked,
    pinnedMessageIds,
    busy,
    recall,
    setPinned,
    unpin,
  };
}
