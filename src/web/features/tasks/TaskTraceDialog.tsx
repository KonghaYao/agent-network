import { Modal } from '../overlays/Modal';
import { useTaskTrace } from '../../hooks/useTaskTrace';

function timeLabel(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString();
}

/**
 * Task Trace 抽屉：按原消息顺序双向分页。
 *
 * 读取与刷新交给 `useTaskTrace`：`task.updated`、房间消息/撤回与成员变化
 * 失效同一查询，已打开的 Trace 会原位重读；加载更早用 `prev_cursor` 前插，
 * 更晚用 `next_cursor` 后补，按 message_id 去重。点击条目只关闭抽屉并定位到
 * 主时间线中已加载的消息，不改变已读或触发任何写操作。
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
  const trace = useTaskTrace({ open, roomId, rootId, focusId, token });
  const summary = trace.summary;
  const busy = trace.busy;

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
          ? `${summary.message_count} 条消息 · ${summary.participant_count} 个 Agent 参与${
              summary.status === 'completed' ? ' · 已完成' : ''
            }`
          : `${trace.count || 0} 条消息`}
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
          onClick={() => void trace.refresh()}
        >
          刷新
        </button>
        <span id="task-trace-status" role="status" aria-live="polite">
          {trace.status}
        </span>
      </div>
      <button
        id="task-trace-older"
        className="task-trace-page"
        type="button"
        hidden={!trace.hasBefore}
        disabled={busy}
        onClick={() => void trace.loadOlder()}
      >
        加载更早
      </button>
      <div id="task-trace-items" className="task-trace-items" role="list">
        {trace.items.length === 0 && !busy ? (
          <p className="task-trace-empty">没有可显示的消息</p>
        ) : (
          trace.items.map((item) => (
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
        hidden={!trace.hasAfter}
        disabled={busy}
        onClick={() => void trace.loadNewer()}
      >
        加载更晚
      </button>
      {trace.items.length > 0 ? (
        <p className="task-trace-meta">
          {trace.items.length} / {trace.count || trace.items.length} 条已加载
        </p>
      ) : null}
    </Modal>
  );
}
