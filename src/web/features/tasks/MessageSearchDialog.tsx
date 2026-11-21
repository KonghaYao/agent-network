import { LensoBackendProvider, useBackendLease } from '../../app/lenso-runtime';
import { Button, Checkbox, Label, SearchInput } from '../../app/lenso-controls';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { LIMITS } from '../../../contracts/limits';
import type { McpError } from '../../lib/mcp-client';
import { callTool } from '../../lib/mcp-client';
import type { TaskSummary } from './TaskSummaryBar';
import { Modal } from '../overlays/Modal';
import { MessageSearchControls } from '../search/MessageSearchControls';
import { MessageSearchSnippet } from '../search/MessageSearchSnippet';
import type {
  LocateResult,
  MessageSearchHit,
  MessageSearchMode,
  MessageSearchScope,
  SearchNavigationTarget,
} from '../search/message-search-types';
import { useMessageSearchQuery } from '../search/useMessageSearchQuery';

interface ContextPage {
  items: {
    message_id: string;
    sender_name: string;
    created_at: number;
    preview: string;
    body_bytes: number;
  }[];
}

function failureText(error: unknown): string {
  return (error as McpError).message || '搜索失败，请重试';
}

function timeLabel(value: number): string {
  return new Date(Number(value)).toLocaleString();
}

/**
 * Lenso Button 的 StyleX 原子类带 `:not(#\#)` 提权，className 无法覆盖
 * 固定的 34px 高度、nowrap 与胶囊圆角，正文会溢出并压住下一项。
 * 内联 style 在 Lenso 合并顺序里最后生效，只复位布局，不改配色逻辑。
 */
const SEARCH_RESULT_STYLE: CSSProperties = {
  display: 'block',
  boxSizing: 'border-box',
  width: '100%',
  height: 'auto',
  minHeight: 44,
  padding: '10px',
  borderRadius: 8,
  background: 'transparent',
  color: 'inherit',
  textAlign: 'left',
  whiteSpace: 'normal',
  justifyContent: 'flex-start',
};

/**
 * 搜索聊天记录：精确/模糊、当前会话/全部会话，以及“只看任务”。
 *
 * 输入 300ms 防抖；中文输入法组合期间不发请求也不处理导航键。
 * 请求由 generation + AbortController 保护，旧响应不会覆盖新结果。
 */
export function MessageSearchDialog({
  open,
  onOpenChange,
  roomId,
  token,
  onOpenTask,
  onLocate,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  token: string;
  onOpenTask: (rootId: string, focusMessageId: string | null) => void;
  onLocate: (target: SearchNavigationTarget) => Promise<LocateResult>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const backend = useBackendLease(open);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<MessageSearchMode>('exact');
  const [scope, setScope] = useState<MessageSearchScope>('room');
  const [taskOnly, setTaskOnly] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState('');
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const contextTrigger = useRef<HTMLButtonElement | null>(null);
  // 全局结果可能来自别的会话，上下文必须沿用结果自带的 room_id。
  const [contextTarget, setContextTarget] = useState<{
    roomId: string;
    messageId: string;
  } | null>(null);
  const [contextItems, setContextItems] = useState<ContextPage['items']>([]);
  const [contextStatus, setContextStatus] = useState('');

  const search = useMessageSearchQuery({
    open,
    roomId,
    token,
    query,
    mode,
    scope,
    taskOnly,
    composing,
  });
  const resultCount = taskOnly ? search.tasks.length : search.hits.length;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMode('exact');
    setScope('room');
    setTaskOnly(false);
    setComposing(false);
    composingRef.current = false;
    setSelectedIndex(-1);
    setLocating(false);
    setLocateError('');
    setContextTarget(null);
    setContextItems([]);
    setContextStatus('');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // 搜索已打开时再次 Ctrl/Cmd+F：聚焦并全选查询，不重复开层。
  useEffect(() => {
    if (!open || contextTarget !== null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      const input = inputRef.current;
      input?.focus();
      input?.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [contextTarget, open]);

  // 显式接管搜索层的 Escape：Lenso SearchField 可能在输入框层吞掉按键，
  // 不能只依赖 Modal。上下文弹窗打开时让子层先处理。
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.keyCode === 229 ||
        composingRef.current
      ) {
        return;
      }
      if (contextTarget !== null) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [contextTarget, onOpenChange, open]);

  useEffect(() => {
    setSelectedIndex(resultCount > 0 ? 0 : -1);
    // 只在新的首屏结果会话里重置；加载更多不应把选中项拉回第一条。
  }, [search.session]);

  useEffect(() => {
    if (!contextTarget) return undefined;
    let active = true;
    setContextStatus('正在加载上下文…');
    setContextItems([]);
    void callTool<ContextPage>(
      'network_message_context',
      {
        room_id: contextTarget.roomId,
        message_id: contextTarget.messageId,
        before: 4,
        after: 4,
      },
      { token },
    )
      .then((page) => {
        if (!active) return;
        setContextItems(page.items ?? []);
        setContextStatus('');
      })
      .catch((failure) => {
        if (active) setContextStatus(failureText(failure));
      });
    return () => {
      active = false;
    };
  }, [contextTarget, token]);

  const revealSelected = useCallback((index: number) => {
    requestAnimationFrame(() => {
      resultsRef.current
        ?.querySelector<HTMLElement>(`[data-search-index="${index}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, []);

  const selectIndex = useCallback(
    (next: number, moveFocus = false) => {
      if (resultCount <= 0) return;
      const clamped = Math.max(0, Math.min(resultCount - 1, next));
      setSelectedIndex(clamped);
      revealSelected(clamped);
      if (moveFocus) {
        requestAnimationFrame(() => {
          const row = resultsRef.current?.querySelector<HTMLElement>(
            `[data-search-index="${clamped}"]`,
          );
          const target =
            row?.querySelector<HTMLElement>('[data-search-locate]') ??
            (row?.tagName === 'BUTTON' ? row : null);
          target?.focus();
        });
      }
    },
    [resultCount, revealSelected],
  );

  const locateHit = useCallback(
    async (item: MessageSearchHit) => {
      if (locating) return;
      setLocating(true);
      setLocateError('');
      try {
        const result = await onLocate({
          room_id: item.room_id,
          message_id: item.message_id,
          query: query.trim(),
          mode,
          scope,
        });
        if (!result.ok) setLocateError(result.error);
      } catch (failure) {
        setLocateError(failureText(failure));
      } finally {
        setLocating(false);
      }
    },
    [locating, mode, onLocate, query, scope],
  );

  // 输入框 Enter 与结果按钮 Enter 走同一动作：任务打开抽屉，消息滚动/锚点/切房。
  const activateResult = useCallback(
    (index: number) => {
      if (index < 0 || index >= resultCount) return;
      if (taskOnly) {
        const entry = search.tasks[index];
        if (!entry) return;
        onOpenTask(entry.task.root_message_id, entry.matches[0]?.message_id ?? null);
        onOpenChange(false);
        return;
      }
      const item = search.hits[index];
      if (item) void locateHit(item);
    },
    [locateHit, onOpenChange, onOpenTask, resultCount, search.hits, search.tasks, taskOnly],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    search.runNow();
  };

  const resetSelection = () => setSelectedIndex(-1);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing || event.keyCode === 229 || composingRef.current) {
      // IME 组合期间把导航键与 Esc 留给输入法，避免弹窗或表单抢走按键。
      // Enter 必须同时 preventDefault：合成 compositionstart 而没有真实组合时，
      // 只 stopPropagation 会让浏览器执行隐式表单提交，多发一次搜索。
      if (
        event.key === 'Escape' ||
        event.key === 'Enter' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp'
      ) {
        if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === 'Escape') {
      // 交给 Modal 处理关闭；不 preventDefault，避免 Radix 跳过 Esc。
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (resultCount > 0 && selectedIndex >= 0) {
        const next = Math.max(
          0,
          Math.min(resultCount - 1, selectedIndex + (event.shiftKey ? -1 : 0)),
        );
        if (next !== selectedIndex) {
          setSelectedIndex(next);
          revealSelected(next);
        }
        activateResult(next);
      } else {
        // 输入后结果尚未返回、或选中项已被重置：Enter 先提交当前查询。
        search.runNow();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (resultCount <= 0) return;
      event.preventDefault();
      selectIndex(selectedIndex < 0 ? 0 : selectedIndex + (event.key === 'ArrowDown' ? 1 : -1));
    }
  };

  const status = (() => {
    if (locateError) return locateError;
    if (locating) return '正在定位消息…';
    if (search.phase === 'loading') return '正在搜索…';
    if (search.phase === 'loading-more') return '正在加载更多…';
    if (search.error) return search.error;
    if (search.phase === 'scan-limited-empty') return '本批未命中，可继续搜索更早记录';
    if (search.phase === 'empty') return taskOnly ? '没有匹配的任务' : '没有找到匹配消息';
    if (resultCount > 0) {
      const count = taskOnly ? `已找到 ${resultCount} 个任务` : `已找到 ${resultCount} 条消息`;
      const selected =
        selectedIndex >= 0 && selectedIndex < resultCount ? `第 ${selectedIndex + 1} / ` : '';
      const truncated = search.truncated ? ' · 命中过多，仅显示部分任务' : '';
      const more = search.hasMore ? ' · 还有更早记录可搜索' : '';
      return `${selected}${count}${truncated}${more}`;
    }
    return '';
  })();

  const moreLabel =
    search.phase === 'scan-limited-empty' ? '继续搜索更早记录' : '加载更多';

  const emptyText =
    search.phase === 'scan-limited-empty'
      ? '本批未命中，可继续搜索更早记录'
      : taskOnly
        ? '没有匹配的任务'
        : '没有找到匹配消息';

  return (
    <LensoBackendProvider backend={backend}>
      <Modal
        open={open}
        onOpenChange={(next) => {
          // fallback 的父层也可能收到 Escape；上下文打开时只关闭子层。
          if (!next && contextTarget !== null) setContextTarget(null);
          else onOpenChange(next);
        }}
        title="搜索聊天记录"
        titleId="message-search-title"
        contentId="message-search-dialog"
        className="message-search-card"
        initialFocusRef={inputRef}
        returnFocusRef={returnFocusRef}
        footer={
          <div className="row modal-actions">
            <Button id="message-search-close" type="button" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        }
      >
        <form id="message-search-form" className="message-search-form" onSubmit={submit}>
          <div className="field">
            <Label htmlFor="message-search-input">搜索消息内容</Label>
            <SearchInput
              ref={inputRef}
              id="message-search-input"
              name="query"
              required
              maxLength={LIMITS.messageSearchQueryMax}
              autoComplete="off"
              placeholder={scope === 'all' ? '搜索全部会话记录' : '搜索完整聊天记录'}
              value={query}
              aria-controls="message-search-results"
              onChange={(event) => {
                setQuery(event.target.value);
                setLocateError('');
                resetSelection();
              }}
              onCompositionStart={() => {
                composingRef.current = true;
                setComposing(true);
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                setComposing(false);
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>
          <MessageSearchControls
            mode={mode}
            scope={scope}
            taskOnly={taskOnly}
            onModeChange={(next) => {
              setMode(next);
              setLocateError('');
              resetSelection();
            }}
            onScopeChange={(next) => {
              setScope(next);
              if (next === 'all') setTaskOnly(false);
              setLocateError('');
              resetSelection();
            }}
          />
          <p id="message-search-mode-help" className="message-search-help">
            {taskOnly
              ? '任务搜索沿用关键词规则，不支持精确/模糊切换'
              : mode === 'exact'
                ? '连续原文匹配，忽略英文字母大小写'
                : '字符按顺序出现即可命中；稀疏时继续搜索更早记录'}
          </p>
          <div className="message-search-actions">
            <Checkbox
              className="message-search-filter"
              data-task-only
              checked={taskOnly}
              disabled={scope === 'all'}
              onCheckedChange={(checked) => {
                setTaskOnly(checked);
                resetSelection();
              }}
            >
              只看任务
            </Checkbox>
            {scope === 'all' ? (
              <span id="message-search-task-note" className="message-search-filter-note">
                全部会话不支持只看任务
              </span>
            ) : null}
            <Button className="primary" type="submit" disabled={search.busy}>
              {search.busy ? '搜索中…' : '搜索'}
            </Button>
          </div>
        </form>
        <p id="message-search-status" className="contact-search-status" role="status" aria-live="polite">
          {status}
        </p>
        <div
          id="message-search-results"
          className="message-search-results"
          role="group"
          aria-label="搜索结果"
          ref={resultsRef}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            if (resultCount <= 0) return;
            event.preventDefault();
            selectIndex(
              selectedIndex < 0 ? 0 : selectedIndex + (event.key === 'ArrowDown' ? 1 : -1),
              true,
            );
          }}
        >
          {resultCount === 0 &&
          (search.phase === 'empty' || search.phase === 'scan-limited-empty') ? (
            <p id="message-search-empty" className="message-search-empty" aria-hidden="true">
              {emptyText}
            </p>
          ) : null}
          {taskOnly
            ? search.tasks.map((entry, index) => (
                <Button
                  type="button"
                  className={`task-search-result${selectedIndex === index ? ' is-active' : ''}`}
                  style={SEARCH_RESULT_STYLE}
                  key={entry.task.root_message_id}
                  data-search-index={index}
                  data-active={selectedIndex === index ? 'true' : 'false'}
                  aria-current={selectedIndex === index ? 'true' : undefined}
                  onFocus={() => setSelectedIndex(index)}
                  onClick={() => {
                    onOpenTask(
                      entry.task.root_message_id,
                      entry.matches[0]?.message_id ?? null,
                    );
                    onOpenChange(false);
                  }}
                >
                  <span className="task-search-main">
                    <span className="task-search-top">
                      <strong>{entry.task.preview || 'Task'}</strong>
                      <span className="task-search-count">{entry.task.message_count} 消息</span>
                    </span>
                    <span className="task-search-preview">
                      {entry.matches[0]?.snippet || entry.task.preview}
                    </span>
                  </span>
                </Button>
              ))
            : search.hits.map((item, index) => (
                <article
                  className={`message-search-result${selectedIndex === index ? ' is-active' : ''}`}
                  key={`${item.room_id}:${item.message_id}`}
                  data-search-index={index}
                  data-active={selectedIndex === index ? 'true' : 'false'}
                  aria-current={selectedIndex === index ? 'true' : undefined}
                >
                  <Button
                    type="button"
                    className="message-search-locate"
                    variant="borderless"
                    style={{ ...SEARCH_RESULT_STYLE, minHeight: 0, padding: 0 }}
                    data-search-locate
                    disabled={locating}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => void locateHit(item)}
                  >
                    <span className="message-search-meta">
                      {scope === 'all' ? (
                        <>
                          <span className="message-search-room">{item.room_display_name}</span>
                          <span className="message-search-kind">
                            {item.room_kind === 'group' ? '群聊' : '私聊'}
                          </span>
                          <span className="message-search-separator" aria-hidden="true">
                            ·
                          </span>
                        </>
                      ) : null}
                      <strong>{item.sender_name}</strong>
                      <span className="message-search-separator" aria-hidden="true">
                        ·
                      </span>
                      <time>{timeLabel(item.created_at)}</time>
                    </span>
                    <span className="message-search-snippet">
                      <MessageSearchSnippet
                        text={item.snippet || item.preview || '（消息已撤回）'}
                        ranges={item.match_ranges}
                      />
                    </span>
                  </Button>
                  <div className="message-search-result-actions">
                    <Button
                      type="button"
                      className="message-search-context"
                      variant="bordered"
                      size="sm"
                      data-search-context
                      onClick={(event) => {
                        contextTrigger.current = event.currentTarget;
                        setContextTarget({ roomId: item.room_id, messageId: item.message_id });
                      }}
                    >
                      上下文
                    </Button>
                  </div>
                </article>
              ))}
        </div>
        {search.hasMore ? (
          <Button
            id="message-search-more"
            className="list-retry"
            type="button"
            disabled={search.busy}
            onClick={search.loadMore}
          >
            {search.busy ? '正在加载…' : moreLabel}
          </Button>
        ) : null}
      </Modal>
      <Modal
        returnFocusRef={contextTrigger}
        open={contextTarget !== null}
        onOpenChange={(next) => {
          if (!next) setContextTarget(null);
        }}
        title="查看上下文"
        titleId="message-context-title"
        contentId="message-context-dialog"
        className="message-search-card"
        footer={
          <div className="row modal-actions">
            <Button
              id="message-context-close"
              type="button"
              onClick={() => setContextTarget(null)}
            >
              关闭
            </Button>
          </div>
        }
      >
        <p id="message-context-status" className="contact-search-status" role="status">
          {contextStatus}
        </p>
        <div id="message-context-items" className="message-context-items">
          {contextItems.map((item) => (
            <article
              key={item.message_id}
              className={`message-context-item${item.message_id === contextTarget?.messageId ? ' is-focus' : ''}`}
            >
              <header>
                <strong>{item.sender_name}</strong>
                <span>{timeLabel(item.created_at)}</span>
              </header>
              <p>{item.body_bytes === 0 ? '此消息已撤回' : item.preview || '（无正文）'}</p>
            </article>
          ))}
        </div>
      </Modal>
    </LensoBackendProvider>
  );
}
