import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ReactNode, type RefObject } from 'react';

/**
 * Radix Dialog 的薄封装。
 *
 * 保留 legacy 的 `.modal-card` 排版与标题层级；overlay 由 Radix 负责
 * 焦点陷阱、Esc、背板点击与关闭后焦点返回。内容在关闭时直接卸载，
 * 避免隐藏的 dialog 进入 axe 扫描。
 */
export function Modal({
  open,
  onOpenChange,
  title,
  titleId,
  children,
  footer,
  className = '',
  contentId,
  closeId,
  closeButtonRef,
  initialFocusRef,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  titleId?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentId?: string;
  /** 保留 legacy 关闭按钮 id，供灰度与 E2E 对照。 */
  closeId?: string;
  /** 调用方需要显式聚焦内置关闭按钮时传入。 */
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  /** 打开后优先聚焦的元素；未提供时沿用 Radix 默认焦点。 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 打开者可能已被卸载（例如菜单项）时，由调用方指定关闭后的落点。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  // 打开弹窗的元素可能是普通按钮而非 Radix Trigger；显式记录并在关闭时
  // 归还焦点，避免焦点落到 body（键盘用户丢失上下文）。
  const restoreRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay" />
        <DialogPrimitive.Content
          id={contentId}
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
          {children}
          {footer}
          <DialogPrimitive.Close
            id={closeId}
            ref={closeButtonRef}
            className="spa-dialog-close"
            aria-label="关闭"
          >
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
