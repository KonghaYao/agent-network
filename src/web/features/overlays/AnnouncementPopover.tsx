import * as PopoverPrimitive from '@radix-ui/react-popover';

/**
 * 头部公告快捷查看：Popover 只承载只读摘要与编辑入口。
 *
 * 移动端与桌面端共用同一浮层；`collisionPadding` 保证靠近视口边缘时
 * 仍然可见，不依赖手写的 flip/clamp 计算。
 */
export function AnnouncementPopover({
  announcement,
  canEdit,
  onEdit,
}: {
  announcement: string;
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          id="room-announcement-info"
          className="icon-btn announcement-dot"
          type="button"
          aria-label="查看群公告"
          title="查看群公告"
        >
          !
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id="room-announcement-popover"
          className="spa-popover"
          sideOffset={6}
          align="end"
          collisionPadding={12}
          aria-label="群公告"
        >
          <p className="spa-popover-text">{announcement}</p>
          <div className="row">
            {canEdit ? (
              <PopoverPrimitive.Close asChild>
                <button id="room-announcement-edit" type="button" className="primary" onClick={onEdit}>
                  编辑公告
                </button>
              </PopoverPrimitive.Close>
            ) : (
              <PopoverPrimitive.Close asChild>
                <button type="button">关闭</button>
              </PopoverPrimitive.Close>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
