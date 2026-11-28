import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { registerModalShell } from '../../app/modal-shell';

import { LensoBackendProvider, useBackendLease, useLenso } from '../../app/lenso-runtime';
import './modal.css';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  titleId?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 标题区右侧动作；与内置关闭键同一行，由调用方控制响应式。 */
  headerActions?: ReactNode;
  className?: string;
  contentId?: string;
  /** 保留 legacy 关闭按钮 id，供灰度与 E2E 对照。 */
  closeId?: string;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 打开者可能已被卸载（例如菜单项）时，指定关闭后的落点。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** 嵌套浮层迁移完成前，父子必须同用 Radix。 */
  shell?: 'lenso' | 'radix';
}

let lastOutsideFocus: HTMLElement | null = null;
let focusUsers = 0;
function rememberOutside(event: Event) {
  if (!(event.target instanceof HTMLElement) ||
      event.target.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
  const target = event.type === 'pointerdown'
    ? event.target.closest<HTMLElement>('button, input, textarea, [tabindex]')
    : event.target;
  if (target && target !== document.body) lastOutsideFocus = target;
}
function trackOpeners() {
  if (focusUsers++ === 0) {
    document.addEventListener('focusin', rememberOutside);
    document.addEventListener('pointerdown', rememberOutside, true);
  }
  return () => {
    if (--focusUsers === 0) {
      document.removeEventListener('focusin', rememberOutside);
      document.removeEventListener('pointerdown', rememberOutside, true);
      lastOutsideFocus = null;
    }
  };
}

/** 外壳和子控件共用打开周期锁，模块晚到只影响下一次打开。 */
export function Modal(props: ModalProps) {
  useEffect(trackOpeners, []);
  const backend = useBackendLease(props.open);
  const module = useLenso();
  const shell = props.shell !== 'radix' && backend === 'lenso' && module ? 'lenso' : 'radix';
  useLayoutEffect(() => {
    if (props.open) return registerModalShell(shell);
  }, [props.open, shell]);
  return (
    <LensoBackendProvider backend={backend}>
      {shell === 'lenso' && module
        ? <LensoModal {...props} modal={module.Modal} />
        : <RadixModal {...props} />}
    </LensoBackendProvider>
  );
}

function LensoModal({
  open, onOpenChange, title, titleId, children, footer, headerActions, className = '',
  contentId, closeId, closeButtonRef, initialFocusRef, returnFocusRef, modal: Dialog,
}: ModalProps & { modal: NonNullable<ReturnType<typeof useLenso>>['Modal'] }) {
  const generatedTitleId = useId();
  const headingId = titleId ?? generatedTitleId;
  const restoreRef = useRef<HTMLElement | null>(lastOutsideFocus);
  const wasOpen = useRef(false);
  const remember = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || target === document.body ||
        target.closest('[role="dialog"], [role="alertdialog"]')) return;
    // 菜单项随菜单卸载；通过 ARIA 关联保留稳定 Trigger，而不是失效的条目。
    const menu = target.closest('[role="menu"]');
    const trigger = menu?.getAttribute('aria-labelledby');
    if (menu) {
      if (trigger) restoreRef.current = document.getElementById(trigger) ?? restoreRef.current;
      return;
    }
    restoreRef.current = target;
  };
  if (open && !wasOpen.current) remember(document.activeElement);
  wasOpen.current = open;
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const rememberOutside = (event: Event) => {
      if (event.type === 'pointerdown' && event.target instanceof Element &&
          !event.target.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) {
        remember(event.target.closest('button, input, textarea, [tabindex]'));
      } else if (event.type === 'focusin') remember(event.target);
    };
    document.addEventListener('focusin', rememberOutside);
    document.addEventListener('pointerdown', rememberOutside, true);
    return () => {
      document.removeEventListener('focusin', rememberOutside);
      document.removeEventListener('pointerdown', rememberOutside, true);
    };
  }, []);
  useEffect(() => () => {
    // 条件挂载消费者（Forward）会连 Root 一起卸载；SDK 无关闭帧可还焦。
    const target = returnFocusRef?.current ?? restoreRef.current;
    queueMicrotask(() => {
      if (target?.isConnected && !document.querySelector('[role="dialog"], [role="alertdialog"]')) target.focus();
    });
  }, [returnFocusRef]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} presentation="dialog" modal>
      <Dialog.Backdrop render={(props) => <div {...props} className="spa-dialog-overlay" />} />
        <Dialog.Content
          ref={contentRef}
          id={contentId}
          aria-modal="true"
          aria-labelledby={headingId}
          aria-describedby={undefined}
          placement="center"
          initialFocus={initialFocusRef ? () => initialFocusRef.current : 'auto'}
          finalFocus={() => returnFocusRef?.current ?? restoreRef.current}
          render={(props) => <div {...props} className={`modal-card spa-dialog-content ${className}`.trim()} />}
        >
          <Dialog.Title id={headingId} render={(props) => <h2 {...props} className={undefined} />}>{title}</Dialog.Title>
          {headerActions}
          {children}
          {footer}
          <Dialog.Close
            id={closeId}
            ref={closeButtonRef}
            aria-label="关闭"
            render={(props) => <button {...props} className="spa-dialog-close" />}
          >×</Dialog.Close>
        </Dialog.Content>
    </Dialog.Root>
  );
}

function RadixModal({
  open, onOpenChange, title, titleId, children, footer, headerActions, className = '',
  contentId, closeId, closeButtonRef, initialFocusRef, returnFocusRef, shell,
}: ModalProps) {
  const restoreRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay" />
        <DialogPrimitive.Content
          id={contentId}
          aria-labelledby={titleId}
          data-modal-shell={shell === 'radix' ? 'radix' : 'fallback'}
          className={`modal-card spa-dialog-content ${className}`.trim()}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            restoreRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (initialFocusRef?.current) {
              event.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusRef?.current ?? restoreRef.current;
            if (target?.isConnected) target.focus();
          }}
        >
          <DialogPrimitive.Title asChild>
            <h2 id={titleId}>{title}</h2>
          </DialogPrimitive.Title>
          {headerActions}
          {children}
          {footer}
          <DialogPrimitive.Close
            id={closeId}
            ref={closeButtonRef}
            className="spa-dialog-close"
            aria-label="关闭"
          >×</DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
