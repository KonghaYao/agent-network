import { useEffect, useState, type FormEvent } from 'react';

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
  const [query, setQuery] = useState('');
  const [taskOnly, setTaskOnly] = useState(false);
  const [messages, setMessages] = useState<MessageHit[]>([]);
  const [tasks, setTasks] = useState<TaskHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
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
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="搜索聊天记录"
        titleId="message-search-title"
        contentId="message-search-dialog"
        className="message-search-card"
        footer={
          <div className="row modal-actions">
            <button id="message-search-close" type="button" onClick={() => onOpenChange(false)}>
              关闭
            </button>
          </div>
        }
      >
        <form id="message-search-form" className="message-search-form" onSubmit={submit}>
          <label className="field">
            <span>搜索消息内容</span>
            <input
              id="message-search-input"
              type="search"
              required
              autoComplete="off"
              placeholder="搜索完整聊天记录"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(null);
                setHasMore(false);
              }}
            />
          </label>
          <label className="message-search-filter">
            <input
              type="checkbox"
              data-task-only
              checked={taskOnly}
              onChange={(event) => {
                setTaskOnly(event.target.checked);
                reset();
              }}
            />
            只看任务
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? '搜索中…' : '搜索'}
          </button>
        </form>
        <p id="message-search-status" className="contact-search-status" role="status" aria-live="polite">
          {status}
        </p>
        <div id="message-search-results" className="message-search-results">
          {taskOnly
            ? tasks.map((entry) => (
                <button
                  type="button"
                  className="task-search-result"
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
                </button>
              ))
            : messages.map((item) => (
                <button
                  type="button"
                  className="message-search-result"
                  key={item.message_id}
                  onClick={() => setContextId(item.message_id)}
                >
                  <strong>
                    {item.sender_name} · {timeLabel(item.created_at)}
                  </strong>
                  <span>{item.snippet || item.preview || '（消息已撤回）'}</span>
                </button>
              ))}
        </div>
        {hasMore ? (
          <button
            id="message-search-more"
            className="list-retry"
            type="button"
            disabled={busy}
            onClick={() => void run(true)}
          >
            {busy ? '正在加载…' : '更多结果'}
          </button>
        ) : null}
      </Modal>
      <Modal
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
            <button id="message-context-close" type="button" onClick={() => setContextId(null)}>
              关闭
            </button>
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
    </>
  );
}
