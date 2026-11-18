import * as Radix from '@radix-ui/react-alert-dialog';
import {
  cloneElement, createContext, useContext, useId, useRef,
  type ComponentProps, type ReactElement, type ReactNode,
} from 'react';

import { Button } from '../../app/lenso-controls';
import { LensoBackendProvider, useBackendLease, useLenso } from '../../app/lenso-runtime';
import { getTopModalShell, type ModalShell } from '../../app/modal-shell';
import './alert-dialog.css';

const Context = createContext<{
  shell: ModalShell;
  close: () => void;
  titleId: string;
  restore: { current: HTMLElement | null };
}>(null!);

/** 与 Modal 相同的打开周期 lease；命令式 confirm 可以传入创建 pending 时的决策。 */
export function Root({ open = false, onOpenChange, shell, children }: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shell?: ModalShell;
  children: ReactNode;
}) {
  const backend = useBackendLease(open);
  const lease = useRef<{ open: boolean; shell: ModalShell } | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const titleId = useId();
  if (open && !lease.current?.open) {
    lease.current = {
      open: true,
      shell: shell ?? (getTopModalShell() === 'radix' || backend !== 'lenso' ? 'radix' : 'lenso'),
    };
    const active = document.activeElement;
    const menuId = active instanceof Element ? active.closest('[role="menu"]')?.getAttribute('aria-labelledby') : null;
    restore.current = menuId ? document.getElementById(menuId) : active instanceof HTMLElement ? active : null;
  } else if (!open && lease.current?.open) lease.current.open = false;
  const actual = lease.current?.shell ?? 'radix';
  const module = useLenso();
  const Dialog = actual === 'lenso' && module ? module.AlertDialog : null;
  return (
    <Context.Provider value={{ shell: actual, close: () => onOpenChange?.(false), titleId, restore }}>
      <LensoBackendProvider backend={backend}>
        {Dialog
          ? <Dialog.Root open={open} onOpenChange={onOpenChange}
              onDismissAttempt={(details) => { if (details.reason === 'outside-press') onOpenChange?.(false); }}
            >{children}</Dialog.Root>
          : <Radix.Root open={open} onOpenChange={onOpenChange}>{children}</Radix.Root>}
      </LensoBackendProvider>
    </Context.Provider>
  );
}

export function Portal({ children }: { children: ReactNode }) {
  return useContext(Context).shell === 'radix' ? <Radix.Portal>{children}</Radix.Portal> : children;
}

export function Overlay(props: ComponentProps<typeof Radix.Overlay>) {
  const { shell, close } = useContext(Context);
  const module = useLenso();
  return shell === 'lenso' && module
    ? <module.AlertDialog.Backdrop render={(attrs) => <div {...attrs} className={props.className}
        onClick={(event) => { if (event.target === event.currentTarget) close(); }} />} />
    : <Radix.Overlay {...props} onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented && event.target === event.currentTarget) close();
      }} />;
}

export function Content({ onCloseAutoFocus, ...props }: ComponentProps<typeof Radix.Content>) {
  const { shell, titleId, restore } = useContext(Context);
  const module = useLenso();
  if (shell !== 'lenso' || !module) return <Radix.Content {...props} data-alert-shell="radix" onCloseAutoFocus={onCloseAutoFocus} />;
  return (
    <module.AlertDialog.Content
      id={props.id}
      aria-modal="true"
      aria-labelledby={props['aria-labelledby'] ?? titleId}
      aria-describedby={props['aria-describedby']}
      initialFocus={() => document.querySelector<HTMLElement>(`#${props.id} .modal-actions button:not(:disabled)`)}
      finalFocus={() => {
        if (onCloseAutoFocus) {
          onCloseAutoFocus(new Event('closeAutoFocus', { cancelable: true }));
          return null;
        }
        return restore.current;
      }}
      render={(attrs) => <div {...attrs} data-alert-shell="lenso" className={props.className} />}
    >{props.children}</module.AlertDialog.Content>
  );
}

export function Title({ children }: { asChild?: boolean; children: ReactElement<ComponentProps<'h2'>> }) {
  const { shell, titleId } = useContext(Context);
  const module = useLenso();
  if (shell !== 'lenso' || !module) return <Radix.Title asChild>{children}</Radix.Title>;
  return <module.AlertDialog.Title id={children.props.id ?? titleId}
    render={(attrs) => cloneElement(children, { ...attrs, className: children.props.className })} />;
}

export function Description({ children }: { asChild?: boolean; children: ReactElement<ComponentProps<'p'>> }) {
  const { shell } = useContext(Context);
  const module = useLenso();
  if (shell !== 'lenso' || !module) return <Radix.Description asChild>{children}</Radix.Description>;
  return <module.AlertDialog.Description id={children.props.id}
    render={(attrs) => cloneElement(children, { ...attrs, className: children.props.className })} />;
}

/** 普通按钮显式关闭，不使用 Action/Close，避免异步提交被 SDK 提前结算。 */
export function Cancel({ asChild, children, ...props }: ComponentProps<typeof Radix.Cancel>) {
  const { shell, close } = useContext(Context);
  if (shell === 'radix') return <Radix.Cancel asChild={asChild} {...props}>{children}</Radix.Cancel>;
  if (asChild) return children;
  return <Button {...props} onClick={(event) => {
    props.onClick?.(event);
    if (!event.defaultPrevented) close();
  }}>{children}</Button>;
}
