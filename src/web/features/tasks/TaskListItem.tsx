import { TaskPreviewPopover } from './TaskPreviewPopover';
import type { TaskListItemView } from './types';

/**
 * 常驻 dock 的一行：触发预览的主按钮与“完成”是兄弟按钮，不嵌套。
 */
export function TaskListItem({
  item,
  readOnly,
  completing,
  previewOpen,
  previewPinned,
  onRequestOpen,
  onRequestClose,
  onHoverOpen,
  onHoverClose,
  onOpenTrace,
  onComplete,
}: {
  item: TaskListItemView;
  readOnly: boolean;
  completing: boolean;
  previewOpen: boolean;
  previewPinned: boolean;
  onRequestOpen: (rootId: string) => void;
  onRequestClose: (rootId: string, restoreFocus: boolean) => void;
  onHoverOpen: (rootId: string) => void;
  onHoverClose: (rootId: string) => void;
  onOpenTrace: (rootId: string, focusId: string | null) => void;
  onComplete: (item: TaskListItemView) => void;
}) {
  const preview = item.preview || '（无正文）';
  const canComplete = !readOnly && item.status === 'open' && item.can_complete;
  const disabledReason = readOnly
    ? '群聊只读归档，不能完成 Task'
    : item.status === 'completed'
      ? 'Task 已完成'
      : !item.can_complete
        ? '当前没有完成权限（可能被禁言或群策略限制）'
        : '';
  const reasonId = `task-complete-reason-${item.root_message_id}`;

  return (
    <li className="task-dock-item" data-task-root={item.root_message_id}>
      <TaskPreviewPopover
        item={item}
        open={previewOpen}
        pinned={previewPinned}
        onRequestOpen={onRequestOpen}
        onRequestClose={onRequestClose}
        onHoverOpen={onHoverOpen}
        onHoverClose={onHoverClose}
        onOpenTrace={onOpenTrace}
      />
      <div className="task-dock-item-actions">
        <button
          type="button"
          className="task-dock-complete"
          disabled={!canComplete || completing}
          aria-busy={completing ? 'true' : undefined}
          aria-describedby={disabledReason ? reasonId : undefined}
          aria-label={`完成 Task：${preview}`}
          title={disabledReason || '标记为已完成'}
          onClick={() => onComplete(item)}
        >
          {completing ? '完成中…' : item.status === 'completed' ? '已完成' : '完成'}
        </button>
        {disabledReason ? (
          <span id={reasonId} className="visually-hidden">
            {disabledReason}
          </span>
        ) : null}
      </div>
    </li>
  );
}
