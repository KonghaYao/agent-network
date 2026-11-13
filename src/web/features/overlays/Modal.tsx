import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

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
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay" />
        <DialogPrimitive.Content
          id={contentId}
          className={`modal-card spa-dialog-content ${className}`.trim()}
          aria-describedby={undefined}
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
