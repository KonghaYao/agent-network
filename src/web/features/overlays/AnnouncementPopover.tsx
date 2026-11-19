import { Tooltip } from '../../app/lenso-tooltip';
import { Alert, Button } from '../../app/lenso-controls';
import { useState } from 'react';
import { Popover } from '../../app/lenso-popover';

/**
 * 头部公告快捷查看：Popover 只承载只读摘要与编辑入口。
 *
 * 移动端与桌面端共用同一浮层；`collisionPadding` 保证靠近视口边缘时
 * 仍然可见，不依赖手写的 flip/clamp 计算。
 */
export function AnnouncementPopover({
  roomId,
  announcement,
  canEdit,
  onEdit,
}: {
  roomId: string;
  announcement: string;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [openRoomId, setOpenRoomId] = useState(roomId);
  // 浏览器后退复用同一 ChatPage 实例，浮层不能把上一个房间的展开状态带给新房间。
  if (openRoomId !== roomId) {
    setOpenRoomId(roomId);
    setOpen(false);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}
      id="room-announcement-popover"
      className="spa-popover"
      sideOffset={6}
      align="end"
      collisionPadding={12}
      aria-label="群公告"
      trigger={
        <Tooltip as={Button}
          id="room-announcement-info"
          className="icon-btn announcement-dot"
          type="button"
          aria-label="查看群公告"
          hint="查看群公告"
        >
          !
        </Tooltip>
      }
    >
      <div className="spa-popover-text">
        <Alert id="room-announcement" className="room-announcement"
          role="note" aria-live="polite" status="default"
          style={{ width: 'auto', margin: 0, padding: 0, border: 0, background: 'transparent' }}
        >
          {announcement}
        </Alert>
      </div>
      <div className="row">
        {canEdit ? (
          <Button id="room-announcement-edit" type="button" className="primary" onClick={() => {
            setOpen(false);
            onEdit();
          }}>
            编辑公告
          </Button>
        ) : (
          <Button type="button" onClick={() => setOpen(false)}>关闭</Button>
        )}
      </div>
    </Popover>
  );
}
