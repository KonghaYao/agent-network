import { LensoBackendProvider, useBackendLease } from '../../app/lenso-runtime';
import { Button, Checkbox, Label, SearchInput } from '../../app/lenso-controls';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';

import { LIMITS } from '../../../contracts/limits';
import type { McpError } from '../../lib/mcp-client';
import { callTool } from '../../lib/mcp-client';
import type { TaskSummary } from './TaskSummaryBar';
import { Modal } from '../overlays/Modal';

interface MessageHit {
  message_id: string;
  sender_name: string;
  created_at: number;
  preview: string;
  snippet: string;
  known?: boolean;
}

interface MessagePage {
  items: MessageHit[];
  next_cursor: string | null;
  has_more: boolean;
}

interface TaskHit {
  task: TaskSummary;
  hit_count: number;
  matches: { message_id: string; snippet: string }[];
}

interface TaskPage {
  items: TaskHit[];
  next_cursor: string | null;
  has_more: boolean;
  truncated: boolean;
}

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
 * 搜索聊天记录：普通全文搜索与“只看任务”。
 *
 * 1–2 个字符由服务端自动回退到 `instr` 子串匹配；页面不复制阈值逻辑。
 * 普通结果打开上下文窗口，任务结果打开 Task Trace 并定位到首个命中。
 */
export function MessageSearchDialog({
  open,
  onOpenChange,
  roomId,
  token,
  onOpenTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  token: string;
  onOpenTask: (rootId: string, focusMessageId: string | null) => void;
}) {
  const backend = useBackendLease(open);
  const [query, setQuery] = useState('');
  const [taskOnly, setTaskOnly] = useState(false);
  const [messages, setMessages] = useState<MessageHit[]>([]);
  const [tasks, setTasks] = useState<TaskHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const contextTrigger = useRef<HTMLButtonElement | null>(null);
  const [contextId, setContextId] = useState<string | null>(null);
  const [contextItems, setContextItems] = useState<ContextPage['items']>([]);
  const [contextStatus, setContextStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setTaskOnly(false);
    setMessages([]);
    setTasks([]);
    setCursor(null);
    setHasMore(false);
    setStatus('');
    setBusy(false);
    setContextId(null);
    setContextItems([]);
    setContextStatus('');
  }, [open]);

  useEffect(() => {
    if (!contextId) return;
    let active = true;
    setContextStatus('正在加载上下文…');
    setContextItems([]);
    void callTool<ContextPage>(
      'network_message_context',
      { room_id: roomId, message_id: contextId, before: 4, after: 4 },
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
  }, [contextId, roomId, token]);

  const run = async (more = false) => {
    const value = query.trim();
    if (!value || busy) return;
    setBusy(true);
    if (!more) {
      setMessages([]);
      setTasks([]);
      setStatus('正在搜索…');
    } else {
      setStatus('正在加载更多…');
    }
    try {
      if (taskOnly) {
        const page = await callTool<TaskPage>(
          'network_task_search',
          {
            room_id: roomId,
            query: value,
            limit: 20,
            ...(more && cursor ? { cursor } : {}),
          },
          { token },
        );
        const seen = new Set(tasks.map((entry) => entry.task.root_message_id));
        const next = (page.items ?? []).filter((entry) => {
          if (seen.has(entry.task.root_message_id)) return false;
          seen.add(entry.task.root_message_id);
          return true;
        });
        setTasks((current) => [...current, ...next]);
        setCursor(page.next_cursor ?? null);
        setHasMore(Boolean(page.next_cursor));
        setStatus(
          page.truncated
            ? '命中过多，仅显示部分任务'
            : next.length === 0 && !more
              ? '没有匹配的任务'
              : '',
        );
      } else {
        const page = await callTool<MessagePage>(
          'network_message_search',
          {
            room_id: roomId,
            query: value,
            limit: 25,
            ...(more && cursor ? { cursor } : {}),
          },
          { token },
        );
        setMessages((current) => [...current, ...(page.items ?? [])]);
        setCursor(page.next_cursor ?? null);
        setHasMore(page.has_more === true);
        setStatus((page.items?.length ?? 0) === 0 && !more ? '没有找到匹配消息' : '');
      }
    } catch (failure) {
      setStatus(failureText(failure));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(false);
  };

  const reset = () => {
    setMessages([]);
    setTasks([]);
    setCursor(null);
    setHasMore(false);
    setStatus('');
  };

  return (
    <LensoBackendProvider backend={backend}>
      <Modal
        open={open}
        onOpenChange={(next) => {
          // fallback 的父层也可能收到 Escape；上下文打开时只关闭子层。
          if (!next && contextId !== null) setContextId(null);
          else onOpenChange(next);
        }}
        title="搜索聊天记录"
        titleId="message-search-title"
        contentId="message-search-dialog"
        className="message-search-card"
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
              id="message-search-input"
              name="query"
              required
              maxLength={LIMITS.messageSearchQueryMax}
              autoComplete="off"
              placeholder="搜索完整聊天记录"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(null);
                setHasMore(false);
              }}
            />
          </div>
          <Checkbox
            className="message-search-filter"
            data-task-only
            checked={taskOnly}
            onCheckedChange={(checked) => {
              setTaskOnly(checked);
              reset();
            }}
          >
            只看任务
          </Checkbox>
          <Button className="primary" type="submit" disabled={busy}>
            {busy ? '搜索中…' : '搜索'}
          </Button>
        </form>
        <p id="message-search-status" className="contact-search-status" role="status" aria-live="polite">
          {status}
        </p>
        <div id="message-search-results" className="message-search-results">
          {taskOnly
            ? tasks.map((entry) => (
                <Button
                  type="button"
                  className="task-search-result"
                  style={SEARCH_RESULT_STYLE}
                  key={entry.task.root_message_id}
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
            : messages.map((item) => (
                <Button
                  type="button"
                  className="message-search-result"
                  style={SEARCH_RESULT_STYLE}
                  key={item.message_id}
                  onClick={(event) => {
                    contextTrigger.current = event.currentTarget;
                    setContextId(item.message_id);
                  }}
                >
                  <strong>
                    {item.sender_name} · {timeLabel(item.created_at)}
                  </strong>
                  <span>{item.snippet || item.preview || '（消息已撤回）'}</span>
                </Button>
              ))}
        </div>
        {hasMore ? (
          <Button
            id="message-search-more"
            className="list-retry"
            type="button"
            disabled={busy}
            onClick={() => void run(true)}
          >
            {busy ? '正在加载…' : '更多结果'}
          </Button>
        ) : null}
      </Modal>
      <Modal
        returnFocusRef={contextTrigger}
        open={contextId !== null}
        onOpenChange={(next) => {
          if (!next) setContextId(null);
        }}
        title="查看上下文"
        titleId="message-context-title"
        contentId="message-context-dialog"
        className="message-search-card"
        footer={
          <div className="row modal-actions">
            <Button id="message-context-close" type="button" onClick={() => setContextId(null)}>
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
              className={`message-context-item${item.message_id === contextId ? ' is-focus' : ''}`}
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
