import { Button, Separator } from '../../app/lenso-controls';
import { Popover } from '../../app/lenso-popover';
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

import { LIMITS } from '../../../contracts/limits';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { taskTimeLabel } from './task-format';
import type { TaskListItemView } from './types';

const HOVER_OPEN_DELAY = 260;
const HOVER_CLOSE_DELAY = 180;

/**
 * Task 行的摘要预览。
 *
 * 桌面精细指针悬浮打开、移入浮层不闪关，且不移动焦点；点击/Enter/Space
 * 固定打开。移动端只靠点按，不依赖 hover。Esc/点击外部由适配器关闭，
 * 固定打开时把焦点还给触发按钮。
 */
export function TaskPreviewPopover({
  item,
  open,
  pinned,
  onRequestOpen,
  onRequestClose,
  onHoverOpen,
  onHoverClose,
  onEscapeKeyDown,
  onOpenTrace,
  canAsk,
  onAskProgress,
}: {
  item: TaskListItemView;
  open: boolean;
  pinned: boolean;
  onRequestOpen: (rootId: string) => void;
  onRequestClose: (rootId: string, restoreFocus: boolean) => void;
  onHoverOpen: (rootId: string) => void;
  onHoverClose: (rootId: string) => void;
  onEscapeKeyDown: (event: Event) => void;
  onOpenTrace: (rootId: string, focusId: string | null) => void;
  canAsk: boolean;
  onAskProgress: (item: TaskListItemView) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const restoreFocusRef = useRef(false);
  /** 「询问进度」要交焦给 composer，关闭预览时不得把焦点抢回触发按钮。 */
  const suppressRestoreFocusRef = useRef(false);
  const keyboardIntentRef = useRef(false);
  const hoverCapable = useMediaQuery('(hover: hover) and (pointer: fine)');
  const mobile = useIsMobile();
  const hoverEnabled = hoverCapable && !mobile;

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearOpenTimer, clearCloseTimer]);

  useEffect(() => {
    if (!open) clearTimers();
  }, [clearTimers, open]);

  useEffect(() => {
    if (pinned) clearTimers();
  }, [clearTimers, pinned]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const scheduleOpen = () => {
    if (!hoverEnabled || pinned || open) return;
    clearCloseTimer();
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      onHoverOpen(item.root_message_id);
    }, HOVER_OPEN_DELAY);
  };

  const scheduleClose = () => {
    if (!hoverEnabled || pinned) return;
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onHoverClose(item.root_message_id);
    }, HOVER_CLOSE_DELAY);
  };

  const requestClose = (restoreFocus: boolean) => {
    const restore = restoreFocus && !suppressRestoreFocusRef.current;
    suppressRestoreFocusRef.current = false;
    restoreFocusRef.current = restore;
    onRequestClose(item.root_message_id, restore);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      suppressRestoreFocusRef.current = false;
      onRequestOpen(item.root_message_id);
      return;
    }
    requestClose(pinned);
  };

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    // 悬浮已打开时，点击应固定而不是被触发器当作“再次点击关闭”。
    if (open && !pinned) {
      event.preventDefault();
      onRequestOpen(item.root_message_id);
    }
  };

  const handlePointerDown = (_event: PointerEvent<HTMLButtonElement>) => {
    keyboardIntentRef.current = false;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      keyboardIntentRef.current = true;
    }
  };

  const recent = item.recent_messages.slice(0, LIMITS.taskListRecentMessagesMax);
  const preview = item.preview || '（无正文）';

  return (
    <Popover open={open} onOpenChange={handleOpenChange}
      trigger={<Button
          ref={triggerRef}
          type="button"
          variant="borderless"
          size="sm"
          className="task-dock-item-trigger"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', height: 'auto', whiteSpace: 'normal', color: 'var(--lenso-label-primary)' }}
          aria-label={`查看 Task：${preview}，${item.message_count} 条消息，${item.participant_count} 个 Agent 参与`}
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onClick={handleTriggerClick}
        >
          <span className="task-dock-preview">{preview}</span>
        </Button>}
          // 对齐面板外缘，避免按列表内边距定位时露出底层消息头像的彩色窄边。
          anchor={triggerRef.current?.closest<HTMLElement>('.task-dock-body') ?? null}
          id={`task-preview-${item.root_message_id}`}
          className="task-preview-popover"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={`Task 预览：${preview}`}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={(event) => {
            // 悬浮不抢焦点；键盘 Enter/Space 才允许焦点进入内容。
            if (!keyboardIntentRef.current) event.preventDefault();
            keyboardIntentRef.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreFocusRef.current) triggerRef.current?.focus();
            restoreFocusRef.current = false;
          }}
          onPointerEnter={clearCloseTimer}
          onPointerLeave={scheduleClose}
        >
          <div className="task-preview-head">
            <span className="task-preview-sender" title={preview}>{preview}</span>
            <span className="task-preview-time">{taskTimeLabel(item.root_created_at)}</span>
          </div>
          <p className="task-preview-meta">
            {item.message_count} 条消息 · {item.participant_count} 个 Agent 参与
          </p>
          <Separator data-task-divider="" />
          <div className="task-preview-scroll">
          <p className="task-preview-text">{preview}</p>
          <Separator data-task-divider="" />
          <div className="task-preview-recents">
            <p className="task-preview-section">最近回复</p>
            {recent.length === 0 ? (
              <p className="task-preview-empty">暂无相关回复</p>
            ) : (
              <ul className="task-preview-recent-list">
                {recent.map((message) => {
                  const sender = message.sender_name || message.sender_id;
                  const text = message.recalled
                    ? '此消息已撤回'
                    : message.preview || '（无正文）';
                  return (
                    <li key={message.message_id}>
                      <Button
                        type="button"
                        variant="borderless"
                        size="sm"
                        className={`task-preview-recent${message.recalled ? ' is-recalled' : ''}`}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', height: 'auto', whiteSpace: 'normal', color: message.recalled ? 'var(--wx-muted)' : 'var(--lenso-label-primary)' }}
                        aria-label={`查看 ${sender} 的回复：${text}`}
                        onClick={() => {
                          // 先回到触发行，Trace 关闭时可把焦点还给它。
                          triggerRef.current?.focus();
                          requestClose(false);
                          onOpenTrace(item.root_message_id, message.message_id);
                        }}
                      >
                        <span className="task-preview-recent-head">
                          <span className="task-preview-recent-sender">{sender}</span>
                          <span className="task-preview-recent-time">
                            {taskTimeLabel(message.created_at)}
                          </span>
                        </span>
                        <span className="task-preview-recent-text">{text}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          </div>
          <Separator data-task-divider="" />
          <div className="task-preview-actions">
            {canAsk ? (
              <Button
                type="button"
                variant="bordered"
                size="sm"
                className="task-preview-ask"
                onClick={() => {
                  suppressRestoreFocusRef.current = true;
                  restoreFocusRef.current = false;
                  onAskProgress(item);
                }}
              >
                询问进度
              </Button>
            ) : null}
            <Button
              type="button"
              variant="prominent"
              size="sm"
              className="task-preview-all"
              onClick={() => {
                triggerRef.current?.focus();
                requestClose(false);
                onOpenTrace(item.root_message_id, null);
              }}
            >
              查看全部 {item.message_count} 条消息
            </Button>
          </div>
    </Popover>
  );
}
