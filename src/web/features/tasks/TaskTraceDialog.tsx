import { useEffect, useState } from 'react';

import { callTool, type McpError } from '../../lib/mcp-client';
import type { TaskSummary } from './TaskSummaryBar';
import { Modal } from '../overlays/Modal';

interface TraceItem {
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
  created_seq: string;
  created_at: string;
  preview: string;
  body_bytes: number;
  recalled: boolean;
  role: 'root' | 'member' | 'reference';
  reply_to: string | null;
  referenced_by: string | null;
  has_unavailable_reference: boolean;
}

interface TracePage {
  root_message_id: string;
  items: TraceItem[];
  next_cursor: string | null;
  prev_cursor: string | null;
  has_more_before: boolean;
  has_more_after: boolean;
  message_count: number;
  focus_message_id: string | null;
}

interface SummaryPage {
  items: TaskSummary[];
}

const PAGE = 50;

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

function timeLabel(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString();
}

/**
 * Task Trace 抽屉：按原消息顺序双向分页。
 *
 * 加载更早用 `prev_cursor` 前插，加载更晚用 `next_cursor` 后补；按
 * message_id 去重，保证分页边界重复项不会出现两次。点击条目只关闭抽屉并
 * 定位到主时间线中已加载的消息，不改变已读或触发任何写操作。
 */
export function TaskTraceDialog({
  open,
  onOpenChange,
  roomId,
  rootId,
  focusId,
  token,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  rootId: string | null;
  focusId: string | null;
  token: string;
  onJump: (messageId: string) => void;
}) {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [prevCursor, setPrevCursor] = useState<string | null>(null);
  const [hasBefore, setHasBefore] = useState(false);
  const [hasAfter, setHasAfter] = useState(false);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const merge = (incoming: TraceItem[], mode: 'initial' | 'before' | 'after') => {
    setItems((current) => {
      const seen = new Set(current.map((entry) => entry.message_id));
      if (mode === 'before') {
        const prepend = incoming.filter((entry) => !seen.has(entry.message_id));
        return [...prepend, ...current];
      }
      const append = incoming.filter((entry) => !seen.has(entry.message_id));
      return [...current, ...append];
    });
  };

  const load = async (mode: 'initial' | 'before' | 'after') => {
    if (!open || !rootId || busy) return;
    if (mode === 'before' && !prevCursor) return;
    if (mode === 'after' && !nextCursor) return;
    setBusy(true);
    setStatus('正在加载…');
    try {
      const args: Record<string, unknown> = {
        room_id: roomId,
        root_message_id: rootId,
        limit: PAGE,
      };
      if (mode === 'initial' && focusId) args.focus_message_id = focusId;
      if (mode === 'before') args.cursor = prevCursor;
      if (mode === 'after') args.cursor = nextCursor;
      const [page, summaries] = await Promise.all([
        callTool<TracePage>('network_task_trace', args, { token }),
        mode === 'initial'
          ? callTool<SummaryPage>(
              'network_task_summaries',
              { room_id: roomId, root_message_ids: [rootId] },
              { token },
            )
          : Promise.resolve(null),
      ]);
      merge(page.items ?? [], mode);
      setNextCursor(page.next_cursor ?? null);
      setPrevCursor(page.prev_cursor ?? null);
      setHasBefore(page.has_more_before === true);
      setHasAfter(page.has_more_after === true);
      setCount(page.message_count ?? 0);
      if (summaries) {
        setSummary(summaries.items.find((entry) => entry.root_message_id === rootId) ?? null);
      }
      setStatus('');
    } catch (failure) {
      setStatus(failureText(failure));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open || !rootId) return;
    setItems([]);
    setSummary(null);
    setNextCursor(null);
    setPrevCursor(null);
    setHasBefore(false);
    setHasAfter(false);
    setCount(0);
    setStatus('正在加载…');
    void load('initial');
    // load 由 open/root 驱动；依赖里不能加入每次渲染变化的 load。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rootId, focusId]);

  useEffect(() => {
    if (open) return;
    setItems([]);
    setSummary(null);
    setStatus('');
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={summary?.preview || 'Task'}
      titleId="task-trace-title"
      contentId="task-trace-drawer"
      className="task-trace-card"
      footer={
        <div className="row modal-actions">
          <button id="task-trace-close" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      }
    >
      <p id="task-trace-meta" className="task-trace-meta">
        {summary
          ? `${summary.message_count} 条消息 · ${summary.participant_count} 个 Agent 参与`
          : `${count || 0} 条消息`}
      </p>
      <div id="task-trace-participants" className="task-trace-participants" aria-label="参与 Agent">
        {summary?.participants.map((participant) => (
          <span className="task-trace-participant-name" key={participant.actor_id}>
            {participant.name}
          </span>
        ))}
      </div>
      <div className="task-trace-toolbar">
        <button
          id="task-trace-refresh"
          className="link-btn"
          type="button"
          disabled={busy}
          onClick={() => {
            setItems([]);
            setNextCursor(null);
            setPrevCursor(null);
            void load('initial');
          }}
        >
          刷新
        </button>
        <span id="task-trace-status" role="status" aria-live="polite">
          {status}
        </span>
      </div>
      <button
        id="task-trace-older"
        className="task-trace-page"
        type="button"
        hidden={!hasBefore || !prevCursor}
        disabled={busy}
        onClick={() => void load('before')}
      >
        加载更早
      </button>
      <div id="task-trace-items" className="task-trace-items" role="list">
        {items.length === 0 && !busy ? (
          <p className="task-trace-empty">没有可显示的消息</p>
        ) : (
          items.map((item) => (
            <button
              type="button"
              key={item.message_id}
              className={`task-trace-item${item.role === 'root' ? ' is-focus' : ''}${item.recalled ? ' is-recalled' : ''}`}
              role="listitem"
              disabled={item.recalled}
              onClick={() => {
                onJump(item.message_id);
                onOpenChange(false);
              }}
            >
              <span className="task-trace-item-head">
                <span className="task-trace-sender">{item.sender_name || item.sender_id}</span>
                <span className="task-trace-time">{timeLabel(item.created_at)}</span>
                <span className={`task-trace-role task-trace-role-${item.role}`}>
                  {item.role === 'root' ? '起点' : item.role === 'reference' ? '引用' : '处理'}
                </span>
              </span>
              <span className="task-trace-preview">
                {item.recalled ? '此消息已撤回' : item.preview || '（无正文）'}
              </span>
              {item.has_unavailable_reference ? (
                <span className="task-trace-note">引用的来源已不可见</span>
              ) : null}
            </button>
          ))
        )}
      </div>
      <button
        id="task-trace-newer"
        className="task-trace-page"
        type="button"
        hidden={!hasAfter || !nextCursor}
        disabled={busy}
        onClick={() => void load('after')}
      >
        加载更晚
      </button>
      {items.length > 0 ? (
        <p className="task-trace-meta">
          {items.length} / {count || items.length} 条已加载
        </p>
      ) : null}
    </Modal>
  );
}
