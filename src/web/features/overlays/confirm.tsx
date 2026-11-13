import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * 命令式确认框：语义与 `window.confirm` 一致——确认返回 true，取消、
 * Esc、背板点击返回 false；关闭后 Radix 把焦点还给触发元素。
 *
 * 这是唯一的 `<alertdialog>` 出口，禁止在 React 页面里再直接调用
 * `window.confirm`，以便统一 a11y 与移动端样式。
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let pending: PendingConfirm | null = null;
let returnFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PendingConfirm | null {
  return pending;
}

function settle(value: boolean): void {
  const current = pending;
  const target = returnFocus;
  pending = null;
  returnFocus = null;
  emit();
  current?.resolve(value);
  // Radix 只会在存在 Trigger 时自动还焦；命令式确认框自己记录触发元素。
  requestAnimationFrame(() => {
    if (target && target.isConnected) target.focus();
  });
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (pending) settle(false);
  returnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise<boolean>((resolve) => {
    pending = { options, resolve };
    emit();
  });
}

/** 挂载一次即可；当前放在 Home/Chat 共用的 App 根里。 */
export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(
    () => () => {
      // 路由切换导致宿主卸载时，别让调用方永远等下去。
      if (pending) settle(false);
    },
    [],
  );

  const options = current?.options;
  return (
    <AlertDialogPrimitive.Root
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="spa-dialog-overlay" />
        <AlertDialogPrimitive.Content
          id="confirm-dialog"
          className="modal-card spa-dialog-content confirm-card"
          aria-describedby="confirm-dialog-message"
        >
          <AlertDialogPrimitive.Title asChild>
            <h2 id="confirm-dialog-title">{options?.title ?? '确认操作'}</h2>
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <p className="confirm-message" id="confirm-dialog-message">
              {options?.message ?? ''}
            </p>
          </AlertDialogPrimitive.Description>
          <div className="row modal-actions">
            <AlertDialogPrimitive.Cancel
              id="confirm-dialog-cancel"
              className="spa-dialog-button"
              onClick={() => settle(false)}
            >
              {options?.cancelText ?? '取消'}
            </AlertDialogPrimitive.Cancel>
            {/*
              确认键不用 AlertDialog.Action：Radix 的 Action 会先触发
              onOpenChange(false)，可能抢先把 Promise 结算成 false。这里
              显式结算 true，再由 onOpenChange 做收尾（pending 已空）。
            */}
            <button
              id="confirm-dialog-ok"
              type="button"
              className={`spa-dialog-button primary${options?.danger ? ' danger' : ''}`}
              onClick={() => settle(true)}
            >
              {options?.confirmText ?? '确定'}
            </button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
