/**
 * 看板卡片：卡体打开详情，底部「原消息」独立直达来源。
 *
 * 卡面只使用列表契约已有的字段；来源会话名与发送人属于详情证据，避免为
 * 每张卡额外拉取详情。restricted 卡不展示被遮蔽的标题、下一步或摘要。
 */

import type { FocusColumnKey, FocusItem } from './focus-types';
import { focusTimeLabel } from './focus-types';

export function FocusCard({
  item,
  column,
  archived,
  busy,
  onOpen,
  onJump,
  onArchive,
}: {
  item: FocusItem;
  column?: FocusColumnKey;
  archived?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onJump: () => void;
  onArchive: () => void;
}) {
  const updated = focusTimeLabel(item.updated_at);
  const due = item.due_text ?? focusTimeLabel(item.due_at);
  const jumpable = item.source_count > 0 && !item.restricted;

  if (item.restricted) {
    return (
      <article className="focus-card focus-card--restricted" data-focus-item={item.item_id}>
        <div className="focus-card-locked" data-column={column}>
          <p className="focus-card-locked-title">来源已失效</p>
          <p className="focus-card-locked-hint">这张卡的内容当前不可见。</p>
        </div>
        {!archived ? (
          <footer className="focus-card-foot">
            <button
              type="button"
              className="focus-card-action"
              disabled={busy}
              onClick={onArchive}
            >
              归档
            </button>
          </footer>
        ) : (
          <footer className="focus-card-foot">
            <span className="focus-card-archived">已归档</span>
          </footer>
        )}
      </article>
    );
  }

  return (
    <article
      className="focus-card"
      data-focus-item={item.item_id}
      data-column={column ?? item.column_key}
    >
      <button
        type="button"
        className="focus-card-body"
        aria-label={`查看事项：${item.title || '未命名事项'}`}
        onClick={onOpen}
      >
        <span className="focus-card-title">{item.title || '未命名事项'}</span>
        {item.next_step ? (
          <span className="focus-card-next">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 12h13m-5-5 5 5-5 5" />
            </svg>
            <span>{item.next_step}</span>
          </span>
        ) : null}
        {item.waiting_on || due ? (
          <span className="focus-chips">
            {item.waiting_on ? (
              <span className="focus-chip focus-chip--wait">等 {item.waiting_on}</span>
            ) : null}
            {due ? <span className="focus-chip focus-chip--due">{due}</span> : null}
          </span>
        ) : null}
        <span className="focus-card-meta">
          <span>{item.source_count} 条来源</span>
          {updated ? <time dateTime={new Date(Number(item.updated_at)).toISOString()}>{updated}</time> : null}
        </span>
      </button>
      <footer className="focus-card-foot">
        <button
          type="button"
          className="focus-card-action focus-card-source"
          disabled={!jumpable || busy}
          title={jumpable ? '打开最近一条来源消息' : '来源当前不可见'}
          onClick={onJump}
        >
          原消息
        </button>
        {archived ? <span className="focus-card-archived">已归档</span> : null}
      </footer>
    </article>
  );
}
