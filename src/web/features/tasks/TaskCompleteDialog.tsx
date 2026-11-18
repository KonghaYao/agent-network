import { Button } from '../../app/lenso-controls';
import * as AlertDialogPrimitive from '../overlays/AlertDialog';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import type { TaskListItemView } from './types';

function failureMessage(error: unknown): string {
  return (error as McpError).message || '完成失败，请重试';
}

/**
 * Task 完成确认。
 *
 * 与命令式确认框共用按父层门控的 AlertDialog；这里保留受控内容，以便
 * 提交中显示“完成中”、失败后原位展示错误并重试。重试沿用同一 request_id，
 * 只有取消后重新打开才生成新 ID。成功前不删除列表项。
 */
export function TaskCompleteDialog({
  open,
  onOpenChange,
  item,
  roomId,
  complete,
  returnFocus,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: TaskListItemView | null;
  roomId: string;
  complete: (input: {
    roomId: string;
    rootId: string;
    requestId: string;
  }) => Promise<void>;
  returnFocus: HTMLElement | null;
  fallbackFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  // 父组件关闭时会先清空 item，关闭回调仍需记住最初的完成按钮。
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rootId = item?.root_message_id ?? null;

  useEffect(() => {
    if (!open || !rootId) return;
    setError(null);
    setBusy(false);
    requestIdRef.current = newRequestId('web_task_complete');
  }, [open, rootId]);

  useEffect(() => {
    if (open && returnFocus) returnFocusRef.current = returnFocus;
  }, [open, returnFocus]);

  const submit = async () => {
    if (busy || !rootId || !requestIdRef.current) return;
    setBusy(true);
    setError(null);
    try {
      await complete({
        roomId,
        rootId,
        requestId: requestIdRef.current,
      });
      onOpenChange(false);
    } catch (failure) {
      // 保留 request_id：超时/网络失败后的重试仍落到同一幂等操作。
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialogPrimitive.Root
      open={open && item !== null}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (!next) onOpenChange(false);
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="spa-dialog-overlay" />
        <AlertDialogPrimitive.Content
          id="task-complete-dialog"
          className="modal-card spa-dialog-content task-complete-dialog"
          aria-describedby="task-complete-message"
          aria-labelledby="task-complete-title"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const previous = returnFocusRef.current;
            const target =
              previous?.isConnected === true
                ? previous
                : fallbackFocusRef.current;
            target?.focus();
            returnFocusRef.current = null;
          }}
        >
          <AlertDialogPrimitive.Title asChild>
            <h2 id="task-complete-title">完成 Task</h2>
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <p className="task-complete-message" id="task-complete-message">
              将「{item?.preview || '这个 Task'}」标记为已完成。完成后会从常驻列表移除，
              消息、摘要与 Trace 仍然保留；不会结束已触发的 Agent 执行投递。
            </p>
          </AlertDialogPrimitive.Description>
          {error ? (
            <p id="task-complete-error" className="task-complete-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row modal-actions">
            <AlertDialogPrimitive.Cancel asChild>
              <Button
                id="task-complete-cancel"
                variant="bordered"
                size="md"
                className="spa-dialog-button"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              id="task-complete-confirm"
              type="button"
              variant="prominent"
              size="md"
              className="spa-dialog-button primary"
              aria-busy={busy ? 'true' : undefined}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? '完成中…' : error ? '重试' : '确认完成'}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
