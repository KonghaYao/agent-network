import { Button, EmptyState } from '../../app/lenso-controls';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

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

/** 展开由指针触发后，指针移动超过该距离才重新允许 hover 预览。 */
const HOVER_REARM_DISTANCE = 8;

/**
 * 房间未完成 Task 浮动入口：浮动在输入框上方，不占聊天文档流。
 *
 * 默认收起为 `Task N` 入口；点击展开列表，再次点击或 Esc/外部点击收起。
 * 面板绝对定位锚在 composer 容器上，展开前后不推移消息、输入框或
 * 「回到最新」。N=0 且收起时完全不渲染；展开时完成最后一条保留空态，
 * 直到用户主动收起。
 */
export function RoomTaskDock({
  roomId,
  room,
  token,
  actorId,
  canAskTask,
  onAskProgress,
  onOpenTrace,
}: {
  roomId: string;
  room: RoomView | null;
  token: string | null;
  actorId: string | null;
  canAskTask: (item: TaskListItemView) => boolean;
  onAskProgress: (item: TaskListItemView) => void;
  onOpenTrace: (rootId: string, focusId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [complete, setComplete] = useState<CompleteState | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const hoverArmedRef = useRef(true);
  const pointerOriginRef = useRef<{ x: number; y: number } | null>(null);
  const previewEscapeEventRef = useRef<Event | null>(null);
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
    setExpanded(false);
    setPreview(null);
    setComplete(null);
  }, [roomId]);

  useEffect(() => {
    if (!expanded) setPreview(null);
  }, [expanded]);

  // 面板从入口上方浮出后，静止的指针仍停在入口/原位置；先要求指针移动
  // 超过阈值，避免布局变化后的 hover 立即弹出预览挡住入口。
  useEffect(() => {
    if (!expanded) {
      hoverArmedRef.current = true;
      return undefined;
    }
    const origin = pointerOriginRef.current;
    if (!origin) {
      hoverArmedRef.current = true;
      return undefined;
    }
    hoverArmedRef.current = false;
    const onPointerMove = (event: PointerEvent) => {
      if (
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >=
        HOVER_REARM_DISTANCE
      ) {
        hoverArmedRef.current = true;
      }
    };
    document.addEventListener('pointermove', onPointerMove, true);
    return () => document.removeEventListener('pointermove', onPointerMove, true);
  }, [expanded]);

  const focusAfterCollapse = () => {
    // 收起后入口可能因 N=0 卸载；此时把焦点还给输入框而不是 body。
    requestAnimationFrame(() => {
      if (toggleRef.current) {
        toggleRef.current.focus();
        return;
      }
      document.getElementById('body')?.focus();
    });
  };

  const collapse = (restoreFocus: boolean) => {
    setPreview(null);
    setExpanded(false);
    if (restoreFocus) focusAfterCollapse();
  };

  // 点击面板外部收起；预览浮层与 Dialog 走 Portal，不应连带收起面板。
  useEffect(() => {
    if (!expanded || preview) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (dockRef.current?.contains(target)) return;
      if (
        target.closest(
          '.task-preview-popover, [role="dialog"], [role="alertdialog"], .spa-dialog-overlay',
        )
      ) {
        return;
      }
      const focusInside = dockRef.current?.contains(document.activeElement) ?? false;
      collapse(focusInside);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [expanded, preview]);

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

  const requestOpen = (rootId: string) => {
    setPreview({ rootId, pinned: true });
  };

  const requestClose = (rootId: string, _restoreFocus: boolean) => {
    setPreview((current) => (current?.rootId === rootId ? null : current));
  };

  const hoverOpen = (rootId: string) => {
    if (!hoverArmedRef.current) return;
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

  const onPreviewEscape = (event: Event) => {
    // 记录被预览消费的原始 Esc 事件；下一次 Esc 是不同事件，不会误吞。
    previewEscapeEventRef.current = event;
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

  /**
   * 引用 Task 根消息并询问进度由 ChatPage 处理；dock 只负责收起自身，
   * 让焦点回到输入框。只读房间没有 composer，入口本身不渲染。
   */
  const askProgress = (item: TaskListItemView) => {
    if (readOnly) return;
    setPreview(null);
    setExpanded(false);
    onAskProgress(item);
  };

  const onToggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (expanded) {
      pointerOriginRef.current = null;
      collapse(true);
      return;
    }
    // 只有真实指针点击才需要 hover 抑制；键盘打开时指针不在入口上。
    pointerOriginRef.current =
      event.detail > 0 ? { x: event.clientX, y: event.clientY } : null;
    setExpanded(true);
  };

  const onSectionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !expanded) return;
    const target = event.target;
    // 预览浮层内由 Radix 自己处理 Esc。
    if (target instanceof Element && target.closest('.task-preview-popover')) return;
    // 预览已打开时让 Radix 先关闭预览；Radix 在 document capture 阶段
    // 处理，冒泡到这里时 preview 可能已变成 null，用同一个原生事件区分。
    if (preview || previewEscapeEventRef.current === event.nativeEvent) {
      previewEscapeEventRef.current = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    collapse(true);
  };

  if (!room) return null;

  const countLabel =
    tasks.totalCount === null ? '…' : String(tasks.totalCount);
  const toggleTitle = tasks.error
    ? `Task 加载失败：${tasks.error}`
    : tasks.totalCount === null
      ? '正在加载 Task'
      : `${tasks.totalCount} 个未完成 Task`;

  // N=0 且收起：完全不渲染，不留占位、不产生 `Task 0` 噪音。
  if (!expanded && tasks.totalCount === 0) return null;

  return (
    <div id="task-dock-slot" className="task-dock-slot">
      <section
        ref={dockRef}
        id="task-dock"
        className={`task-dock${expanded ? '' : ' is-collapsed'}`}
        aria-label="未完成 Task"
        data-state={expanded ? 'expanded' : 'collapsed'}
        onKeyDown={onSectionKeyDown}
      >
        <div className="task-dock-head">
          <Button
            ref={toggleRef}
            id="task-dock-toggle"
            className="task-dock-toggle"
            type="button"
            variant="borderless"
            size="sm"
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
            onClick={onToggle}
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
          </Button>
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
              <Button type="button" variant="bordered" size="sm" onClick={() => void tasks.retry()}>
                重试
              </Button>
            </div>
          ) : null}
          {!tasks.error && tasks.loading ? (
            <p className="task-dock-status" role="status">
              正在加载 Task…
            </p>
          ) : null}
          {!tasks.error && !tasks.loading && tasks.items.length === 0 ? (
            <EmptyState
              id="task-dock-empty"
              className="task-dock-empty"
              style={{ padding: 12, gap: 4, color: 'var(--wx-muted)', fontSize: 12 }}
            >
              <span>暂无未完成 Task</span>
              <Button
                id="task-dock-empty-close"
                className="task-dock-empty-close"
                type="button"
                variant="bordered"
                size="sm"
                onClick={() => collapse(true)}
              >
                收起
              </Button>
            </EmptyState>
          ) : null}
          {tasks.items.length > 0 ? (
            <ul className="task-dock-list" aria-label="未完成 Task 列表">
              {tasks.items.map((item) => (
                <TaskListItem
                  key={item.root_message_id}
                  item={item}
                  readOnly={readOnly}
                  completing={tasks.completingRootId === item.root_message_id}
                  canAsk={canAskTask(item)}
                  previewOpen={preview?.rootId === item.root_message_id}
                  previewPinned={
                    preview?.rootId === item.root_message_id && preview.pinned
                  }
                  onRequestOpen={requestOpen}
                  onRequestClose={requestClose}
                  onHoverOpen={hoverOpen}
                  onHoverClose={hoverClose}
                  onEscapeKeyDown={onPreviewEscape}
                  onOpenTrace={(rootId, focusId) => {
                    requestClose(rootId, false);
                    onOpenTrace(rootId, focusId);
                  }}
                  onAskProgress={askProgress}
                  onComplete={openComplete}
                />
              ))}
            </ul>
          ) : null}
          {tasks.loadMoreError ? (
            <p id="task-dock-load-more-error" className="task-dock-foot-status" role="alert">
              加载更多失败：{tasks.loadMoreError}
              <Button
                type="button"
                variant="bordered"
                size="sm"
                disabled={tasks.loadingMore}
                onClick={() => void tasks.loadMore()}
              >
                重试
              </Button>
            </p>
          ) : null}
          {tasks.hasMore ? (
            <Button
              id="task-dock-load-more"
              className="task-dock-more"
              type="button"
              variant="bordered"
              size="sm"
              disabled={tasks.loadingMore}
              aria-busy={tasks.loadingMore ? 'true' : undefined}
              onClick={() => void tasks.loadMore()}
            >
              {tasks.loadingMore ? '加载中…' : '加载更多'}
            </Button>
          ) : null}
          {tasks.refreshError ? (
            <p className="task-dock-foot-status" role="status">
              刷新失败：{tasks.refreshError}
              <Button type="button" variant="bordered" size="sm" onClick={() => void tasks.retry()}>
                重试
              </Button>
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
