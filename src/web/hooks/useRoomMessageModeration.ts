import { useCallback, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../contracts/limits';
import { confirmDialog } from '../features/overlays/confirm';
import type { HistoryMessage, PinnedMessage, RoomView } from '../lib/chat';
import { callTool, type McpError } from '../lib/mcp-client';
import { newRequestId } from '../lib/request-id';
import { setUpdateBusy } from '../pwa/update-busy';
import { isUpdateWriteBlocked, useUpdateWriteBlocked } from '../pwa/update-store';
import type { ModerationRefresh } from './useRoomChat';

const UPDATE_BLOCKED_MESSAGE = '当前页面与服务器版本不兼容，请先更新后再操作。';

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
