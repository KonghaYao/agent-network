import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ConfirmRenderer } from './ConfirmRenderer';

/** 命令式确认框唯一出口；store 不依赖 Alert renderer。 */
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
  renderer: typeof ConfirmRenderer | null;
}

let pending: PendingConfirm | null = null;
let returnFocus: HTMLElement | null = null;
let renderer: typeof ConfirmRenderer | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => pending;

export function preloadConfirm() {
  loading ??= import('./ConfirmRenderer').then((module) => {
    renderer = module.ConfirmRenderer;
  }).catch(() => { loading = null; });
}

function settle(value: boolean): void {
  const current = pending;
  const target = returnFocus;
  pending = null;
  returnFocus = null;
  emit();
  current?.resolve(value);
  requestAnimationFrame(() => {
    if (target?.isConnected) target.focus();
  });
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (pending) settle(false);
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  preloadConfirm();
  return new Promise<boolean>((resolve) => {
    // 本轮锁定 renderer；chunk 到达不能替换已经获得焦点的 fallback。
    pending = { options, resolve, renderer };
    emit();
  });
}

function ConfirmFallback({ options }: { options: ConfirmOptions }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return (
    <dialog ref={ref} id="confirm-dialog" role="alertdialog"
      className="modal-card spa-dialog-content confirm-card"
      aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message"
      onCancel={(event) => { event.preventDefault(); settle(false); }}>
      <h2 id="confirm-dialog-title">{options.title}</h2>
      <p id="confirm-dialog-message" className="confirm-message">{options.message}</p>
      <div className="row modal-actions">
        <button id="confirm-dialog-cancel" className="spa-dialog-button" autoFocus
          onClick={() => settle(false)}>{options.cancelText ?? '取消'}</button>
        <button id="confirm-dialog-ok" type="button"
          className={`spa-dialog-button primary${options.danger ? ' danger' : ''}`}
          onClick={() => settle(true)}>{options.confirmText ?? '确定'}</button>
      </div>
    </dialog>
  );
}

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => () => { if (pending) settle(false); }, []);
  if (!current) return null;
  const Renderer = current.renderer;
  return Renderer ? <Renderer options={current.options} settle={settle} />
    : <ConfirmFallback options={current.options} />;
}
