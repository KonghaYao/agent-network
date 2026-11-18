import { Button } from '../../app/lenso-controls';
import * as AlertDialogPrimitive from './AlertDialog';
import { getLensoStatus } from '../../app/lenso-runtime';
import { getTopModalShell, type ModalShell } from '../../app/modal-shell';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * 命令式确认框：语义与 `window.confirm` 一致——确认返回 true，取消、
 * Esc、背板点击返回 false；关闭后把焦点还给触发元素。
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
  id: number;
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
  shell: ModalShell;
}

let nextId = 0;
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
    // fallback lease 释放后，触发控件可能刚升级为 Lenso；按稳定 id 找回同一入口。
    const connected = target?.isConnected ? target : target?.id ? document.getElementById(target.id) : null;
    connected?.focus();
  });
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (pending) settle(false);
  returnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise<boolean>((resolve) => {
    const shell = getTopModalShell() === 'radix' || getLensoStatus() !== 'ready' ? 'radix' : 'lenso';
    pending = { id: ++nextId, options, resolve, shell };
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

  if (!current) return null;
  const options = current.options;
  return (
    <AlertDialogPrimitive.Root
      key={current.id}
      open={current !== null}
      shell={current?.shell}
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
          aria-labelledby="confirm-dialog-title"
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
            <Button
              id="confirm-dialog-ok"
              type="button"
              className={`spa-dialog-button primary${options?.danger ? ' danger' : ''}`}
              onClick={() => settle(true)}
            >
              {options?.confirmText ?? '确定'}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
