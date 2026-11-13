import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ReactNode } from 'react';

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  titleId?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentId?: string;
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
          onOpenAutoFocus={() => {
            restoreRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title asChild>
            <h2 id={titleId}>{title}</h2>
          </DialogPrimitive.Title>
          {children}
          {footer}
          <DialogPrimitive.Close className="spa-dialog-close" aria-label="关闭">
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
