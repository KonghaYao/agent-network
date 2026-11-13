import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { navigate } from '../../app/router';
import type { RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';

interface LeavePreview {
  room_id: string;
  pending_deliveries: number;
  claimed_deliveries: number;
  can_leave: boolean;
  can_dissolve: boolean;
  owner_transfer_required: boolean;
  dissolved: boolean;
  read_only: boolean;
}

/**
 * 退群确认：先读 `network_room_leave_preview`，再按预览结果决定是否允许
 * 提交。pending/claimed 投递存在时必须显式 `confirm_in_flight`，与工具
 * 契约一致；群主会被要求先转让。
 */
export function LeaveRoomDialog({
  open,
  onOpenChange,
  room,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomView;
  token: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: queryKeys.leavePreview(room.room_id),
    enabled: open,
    queryFn: () =>
      callTool<LeavePreview>(
        'network_room_leave_preview',
        { room_id: room.room_id },
        { token },
      ),
  });

  const data = preview.data;
  const inFlight = (data?.pending_deliveries ?? 0) + (data?.claimed_deliveries ?? 0);
  const blocked = Boolean(
    data && (!data.can_leave || data.owner_transfer_required || data.read_only),
  );

  const leave = async () => {
    if (busy || blocked) return;
    setBusy(true);
    setError('');
    try {
      await callTool(
        'network_room_leave',
        {
          request_id: newRequestId('web_room_leave'),
          room_id: room.room_id,
          ...(inFlight > 0 ? { confirm_in_flight: true } : {}),
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: ['rooms'] });
      onOpenChange(false);
      navigate('/');
    } catch (failure) {
      setError((failure as McpError).message || '退出群聊失败');
    } finally {
      setBusy(false);
    }
  };

  const message = preview.isPending
    ? '正在检查退出后果…'
    : preview.error
      ? (preview.error as McpError).message || '读取退出后果失败'
      : blocked
        ? data?.owner_transfer_required
          ? '群主不能直接退群，请先转让群主或解散群聊。'
          : data?.read_only
            ? '该群已解散，当前为只读归档；退出后会失去归档访问。'
            : '当前不能退出该群。'
        : inFlight > 0
          ? `退出会撤销你在该群的 ${data?.pending_deliveries ?? 0} 条待处理和 ${data?.claimed_deliveries ?? 0} 条已领取投递，确定继续？`
          : '退出后立即失去该群的发言与文件授权，历史记录不会再对你可见。';

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="spa-dialog-overlay" />
        <AlertDialogPrimitive.Content
          id="leave-dialog"
          className="modal-card spa-dialog-content confirm-card"
          aria-describedby="leave-message"
        >
          <AlertDialogPrimitive.Title asChild>
            <h2>退出群聊</h2>
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <p id="leave-message" className="confirm-message">
              {message}
            </p>
          </AlertDialogPrimitive.Description>
          {error ? (
            <p id="leave-status" className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row modal-actions">
            <AlertDialogPrimitive.Cancel id="leave-cancel" className="spa-dialog-button">
              取消
            </AlertDialogPrimitive.Cancel>
            <button
              id="leave-confirm"
              type="button"
              className="spa-dialog-button danger"
              disabled={busy || blocked || preview.isPending || Boolean(preview.error)}
              onClick={() => void leave()}
            >
              {busy ? '正在退出…' : '退出群聊'}
            </button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
