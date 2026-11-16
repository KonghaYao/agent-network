import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { RoomView } from '../../lib/chat';
import { taskAuthorizationKey } from '../../lib/task-cache';
import { useRoomTasks } from '../../hooks/useRoomTasks';
import { TaskCompleteDialog } from './TaskCompleteDialog';
import { TaskListItem } from './TaskListItem';
import type { TaskListItemView } from './types';

interface PreviewState {
  rootId: string;
  pinned: boolean;
}

interface CompleteState {
  item: TaskListItemView;
  returnFocus: HTMLElement | null;
}

/**
 * 房间常驻未完成 Task：位于聊天区输入框上方，属于 chat-body 布局。
 *
 * 默认展开紧凑列表，可折叠为 `Task N`。列表不覆盖消息或回到底部按钮；
 * 高度通过 CSS 变量同步给 `jump-latest`，滚动到最新按钮会随 dock 上移。
 */
export function RoomTaskDock({
  roomId,
  room,
  token,
  actorId,
  onOpenTrace,
}: {
  roomId: string;
  room: RoomView | null;
  token: string | null;
  actorId: string | null;
  onOpenTrace: (rootId: string, focusId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [complete, setComplete] = useState<CompleteState | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const readOnly = room?.read_only === true;
  const authorizationKey = taskAuthorizationKey(room);
  const tasks = useRoomTasks({
    roomId,
    token,
    actorId,
    authorizationKey,
    enabled: Boolean(room && token && actorId),
  });

  useEffect(() => {
    setExpanded(true);
    setPreview(null);
    setComplete(null);
  }, [roomId]);

  useEffect(() => {
    if (!preview) return;
    if (tasks.items.some((item) => item.root_message_id === preview.rootId)) return;
    const active = document.activeElement;
    const popover = document.getElementById(`task-preview-${preview.rootId}`);
    const trigger = document.querySelector<HTMLElement>(
      `[data-task-root="${preview.rootId}"] .task-dock-item-trigger`,
    );
    const restoreFocus =
      active instanceof Node &&
      ((popover !== null && popover.contains(active)) ||
        (trigger !== null && trigger.contains(active)));
    setPreview(null);
    if (restoreFocus) {
      // 触发行已被移除：焦点落到 dock 入口，避免回到 body。
      requestAnimationFrame(() => toggleRef.current?.focus());
    }
  }, [preview, tasks.items]);

  // 把 dock 实际高度交给 `.jump-latest`，避免“回到最新”被面板遮挡。
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const body = slot?.closest<HTMLElement>('.chat-body');
    if (!slot || !body) return undefined;
    const status = body.querySelector<HTMLElement>('#status');
    const update = () => {
      // dock 与状态行都在 composer 上方；两者高度共同决定回到底部按钮的位置。
      const offset = slot.offsetHeight + (status?.offsetHeight ?? 0);
      body.style.setProperty('--task-dock-height', `${offset}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(slot);
    if (status) observer.observe(status);
    return () => {
      observer.disconnect();
      body.style.removeProperty('--task-dock-height');
    };
  }, [roomId]);

  const requestOpen = (rootId: string) => {
    setPreview({ rootId, pinned: true });
  };

  const requestClose = (rootId: string, _restoreFocus: boolean) => {
    setPreview((current) => (current?.rootId === rootId ? null : current));
  };

  const hoverOpen = (rootId: string) => {
    setPreview((current) => {
      if (current?.pinned) return current;
      return { rootId, pinned: false };
    });
  };

  const hoverClose = (rootId: string) => {
    setPreview((current) =>
      current && current.rootId === rootId && !current.pinned ? null : current,
    );
  };

  const openComplete = (item: TaskListItemView) => {
    if (readOnly || !item.can_complete || item.status !== 'open') return;
    setPreview(null);
    setComplete({
      item,
      returnFocus:
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  };

  if (!room) return null;

  const countLabel =
    tasks.totalCount === null ? '…' : String(tasks.totalCount);
  const toggleTitle = tasks.error
    ? `Task 加载失败：${tasks.error}`
    : tasks.totalCount === null
      ? '正在加载 Task'
      : `${tasks.totalCount} 个未完成 Task`;

  return (
    <div className="task-dock-slot" ref={slotRef}>
      <section
        id="task-dock"
        className={`task-dock${expanded ? '' : ' is-collapsed'}`}
        aria-label="未完成 Task"
        data-state={expanded ? 'expanded' : 'collapsed'}
      >
        <div className="task-dock-head">
          <button
            ref={toggleRef}
            id="task-dock-toggle"
            className="task-dock-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls="task-dock-panel"
            aria-label={
              tasks.error
                ? `Task 加载失败：${tasks.error}`
                : tasks.totalCount === null
                  ? 'Task 正在加载'
                  : `Task ${tasks.totalCount} 个未完成`
            }
            title={toggleTitle}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="task-dock-title">Task</span>
            <span
              id="task-dock-count"
              className={`task-dock-count${tasks.totalCount === null ? ' task-dock-count--unknown' : ''}`}
            >
              {countLabel}
            </span>
            <span className="task-dock-caret" aria-hidden="true">
              ▾
            </span>
          </button>
        </div>
        <div
          id="task-dock-panel"
          className="task-dock-body"
          hidden={!expanded}
          aria-busy={tasks.loading || tasks.loadingMore ? 'true' : undefined}
        >
          {tasks.error ? (
            <div id="task-dock-error" className="task-dock-error" role="alert">
              <span>Task 加载失败：{tasks.error}</span>
              <button type="button" onClick={() => void tasks.retry()}>
                重试
              </button>
            </div>
          ) : null}
          {!tasks.error && tasks.loading ? (
            <p className="task-dock-status" role="status">
              正在加载 Task…
            </p>
          ) : null}
          {!tasks.error && !tasks.loading && tasks.items.length === 0 ? (
            <p id="task-dock-empty" className="task-dock-empty">
              暂无未完成 Task
            </p>
          ) : null}
          {tasks.items.length > 0 ? (
            <ul className="task-dock-list" aria-label="未完成 Task 列表">
              {tasks.items.map((item) => (
                <TaskListItem
                  key={item.root_message_id}
                  item={item}
                  readOnly={readOnly}
                  completing={tasks.completingRootId === item.root_message_id}
                  previewOpen={preview?.rootId === item.root_message_id}
                  previewPinned={
                    preview?.rootId === item.root_message_id && preview.pinned
                  }
                  onRequestOpen={requestOpen}
                  onRequestClose={requestClose}
                  onHoverOpen={hoverOpen}
                  onHoverClose={hoverClose}
                  onOpenTrace={(rootId, focusId) => {
                    requestClose(rootId, false);
                    onOpenTrace(rootId, focusId);
                  }}
                  onComplete={openComplete}
                />
              ))}
            </ul>
          ) : null}
          {tasks.loadMoreError ? (
            <p id="task-dock-load-more-error" className="task-dock-foot-status" role="alert">
              加载更多失败：{tasks.loadMoreError}
              <button
                type="button"
                disabled={tasks.loadingMore}
                onClick={() => void tasks.loadMore()}
              >
                重试
              </button>
            </p>
          ) : null}
          {tasks.hasMore ? (
            <button
              id="task-dock-load-more"
              className="task-dock-more"
              type="button"
              disabled={tasks.loadingMore}
              aria-busy={tasks.loadingMore ? 'true' : undefined}
              onClick={() => void tasks.loadMore()}
            >
              {tasks.loadingMore ? '加载中…' : '加载更多'}
            </button>
          ) : null}
          {tasks.refreshError ? (
            <p className="task-dock-foot-status" role="status">
              刷新失败：{tasks.refreshError}
              <button type="button" onClick={() => void tasks.retry()}>
                重试
              </button>
            </p>
          ) : null}
          {tasks.notice ? (
            <p id="task-dock-notice" className="task-dock-foot-status" role="status">
              {tasks.notice}
            </p>
          ) : null}
        </div>
      </section>
      <TaskCompleteDialog
        open={complete !== null}
        onOpenChange={(open) => {
          if (!open) setComplete(null);
        }}
        item={complete?.item ?? null}
        roomId={roomId}
        complete={tasks.complete}
        returnFocus={complete?.returnFocus ?? null}
        fallbackFocusRef={toggleRef}
      />
    </div>
  );
}
