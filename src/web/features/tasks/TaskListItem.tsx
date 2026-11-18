import { Tooltip } from '../../app/lenso-tooltip';
import { Button } from '../../app/lenso-controls';
import { TaskPreviewPopover } from './TaskPreviewPopover';
import type { TaskListItemView } from './types';

/**
 * 常驻 dock 的一行：触发预览的主按钮与“询问进度”/“完成”是兄弟按钮，不嵌套。
 */
export function TaskListItem({
  item,
  readOnly,
  completing,
  canAsk,
  previewOpen,
  previewPinned,
  onRequestOpen,
  onRequestClose,
  onHoverOpen,
  onHoverClose,
  onEscapeKeyDown,
  onOpenTrace,
  onAskProgress,
  onComplete,
}: {
  item: TaskListItemView;
  readOnly: boolean;
  completing: boolean;
  canAsk: boolean;
  previewOpen: boolean;
  previewPinned: boolean;
  onRequestOpen: (rootId: string) => void;
  onRequestClose: (rootId: string, restoreFocus: boolean) => void;
  onHoverOpen: (rootId: string) => void;
  onHoverClose: (rootId: string) => void;
  onEscapeKeyDown: (event: Event) => void;
  onOpenTrace: (rootId: string, focusId: string | null) => void;
  onAskProgress: (item: TaskListItemView) => void;
  onComplete: (item: TaskListItemView) => void;
}) {
  const preview = item.preview || '（无正文）';
  const askable = canAsk && !readOnly;
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
        onEscapeKeyDown={onEscapeKeyDown}
        onOpenTrace={onOpenTrace}
        canAsk={askable}
        onAskProgress={onAskProgress}
      />
      <div className="task-dock-item-actions">
        {askable ? (
          <Tooltip as={Button}
            type="button"
            variant="bordered"
            size="sm"
            className="task-dock-ask"
            aria-label={`询问进度：${preview}`}
            hint="引用这条 Task 并询问 Agent 进度"
            onClick={() => onAskProgress(item)}
          >
            询问进度
          </Tooltip>
        ) : null}
        <Tooltip as={Button}
          type="button"
          variant="bordered"
          size="sm"
          className="task-dock-complete"
          disabled={!canComplete || completing}
          aria-busy={completing ? 'true' : undefined}
          aria-describedby={disabledReason ? reasonId : undefined}
          aria-label={`完成 Task：${preview}`}
          hint={disabledReason || '标记为已完成'}
          onClick={() => onComplete(item)}
        >
          {completing ? '完成中…' : item.status === 'completed' ? '已完成' : '完成'}
        </Tooltip>
        {disabledReason ? (
          <span id={reasonId} className="visually-hidden">
            {disabledReason}
          </span>
        ) : null}
      </div>
    </li>
  );
}
