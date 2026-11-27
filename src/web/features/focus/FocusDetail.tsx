/**
 * 事项详情：列、下一步、等待/期限、摘要、证据与修订历史。
 *
 * 证据发送人需要 `network_message_context` 补一次只读上下文；失败只回退为
 * 「来源消息」，不阻断详情其他字段，也不展示服务端错误术语。
 */

import { useQuery } from '@tanstack/react-query';

import { callTool } from '../../lib/mcp-client';
import type { FocusDetailData, FocusEvidence, FocusItem } from './focus-types';
import { FOCUS_COLUMN_LABELS, focusTimeLabel } from './focus-types';

interface ContextView {
  items: { message_id: string; sender_name: string }[];
}

function EvidenceSender({
  token,
  evidence,
}: {
  token: string;
  evidence: FocusEvidence;
}) {
  const canRead = evidence.readable && Boolean(evidence.room_id && evidence.message_id);
  const query = useQuery({
    queryKey: ['focus', 'evidence-context', evidence.evidence_id],
    enabled: canRead,
    staleTime: 300_000,
    queryFn: ({ signal }) =>
      callTool<ContextView>(
        'network_message_context',
        {
          room_id: evidence.room_id ?? '',
          message_id: evidence.message_id ?? '',
          before: 0,
          after: 0,
        },
        { token, signal },
      ),
  });
  const sender = query.data?.items.find(
    (item) => item.message_id === evidence.message_id,
  )?.sender_name;
  if (sender) return <span className="focus-evidence-sender">{sender}</span>;
  return <span className="focus-evidence-sender">来源消息</span>;
}

function jumpLabel(item: FocusItem, archived: boolean): string {
  if (archived || item.archived_at) return '已归档';
  return FOCUS_COLUMN_LABELS[item.column_key];
}

export function FocusDetail({
  detail,
  loading,
  error,
  archived,
  busy,
  token,
  roomName,
  onRetry,
  onClose,
  onJump,
  onArchive,
}: {
  detail: FocusDetailData | undefined;
  loading: boolean;
  error: string | null;
  archived: boolean;
  busy: boolean;
  token: string;
  roomName: (roomId: string | undefined) => string;
  onRetry: () => void;
  onClose: () => void;
  onJump: (evidence: FocusEvidence) => void;
  onArchive: (item: FocusItem) => void;
}) {
  const item = detail?.item;
  const recentFirst = detail ? [...detail.evidence].reverse() : [];
  return (
    <aside className="focus-detail" aria-label="事项详情">
      <header className="focus-detail-head">
        <button
          type="button"
          className="focus-detail-back"
          onClick={onClose}
          aria-label="返回事项列表"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M19 12H6m5-5-5 5 5 5" />
          </svg>
          返回
        </button>
        {item ? (
          <span className={`focus-column-chip focus-column-chip--${item.column_key}`}>
            {jumpLabel(item, archived)}
          </span>
        ) : null}
        <button
          type="button"
          className="focus-detail-close"
          onClick={onClose}
          aria-label="关闭详情"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      {loading && !item ? (
        <div className="focus-detail-state" role="status">
          正在读取事项…
        </div>
      ) : null}
      {error && !item ? (
        <div className="focus-detail-state focus-detail-error" role="status">
          <p>事项详情暂时打不开。</p>
          <button type="button" className="focus-retry" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}

      {item ? (
        <>
          <div className="focus-detail-scroll">
            <h3 className="focus-detail-title">{item.title || '未命名事项'}</h3>
            {item.next_step ? (
              <p className="focus-detail-next">
                <span className="focus-detail-label">下一步</span>
                {item.next_step}
              </p>
            ) : null}
            <dl className="focus-detail-facts">
              {item.waiting_on ? (
                <div>
                  <dt>等待</dt>
                  <dd>{item.waiting_on}</dd>
                </div>
              ) : null}
              {item.due_text || item.due_at ? (
                <div>
                  <dt>期限</dt>
                  <dd>{item.due_text ?? focusTimeLabel(item.due_at, true)}</dd>
                </div>
              ) : null}
              <div>
                <dt>更新</dt>
                <dd>{focusTimeLabel(item.updated_at, true) ?? '—'}</dd>
              </div>
            </dl>
            {item.summary ? <p className="focus-detail-summary">{item.summary}</p> : null}

            <section className="focus-evidence" aria-label="来源证据">
              <h4>来源</h4>
              {detail && detail.evidence.length > 0 ? (
                <ol className="focus-evidence-list">
                  {recentFirst.map((evidence, index) => {
                    const canJump = evidence.readable && Boolean(evidence.room_id && evidence.message_id);
                    const at = Number(evidence.occurred_at);
                    const createdAt = Number.isFinite(at) && at > 0
                      ? new Date(at).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '';
                    return (
                      <li key={evidence.evidence_id} className="focus-evidence-item">
                        <div className="focus-evidence-meta">
                          {evidence.readable ? (
                            <EvidenceSender token={token} evidence={evidence} />
                          ) : (
                            <span className="focus-evidence-sender">来源已失效</span>
                          )}
                          <span className="focus-evidence-room">
                            {roomName(evidence.room_id)}
                          </span>
                          {index === 0 ? <span className="focus-evidence-latest">最近</span> : null}
                          {createdAt ? <time className="focus-evidence-time">{createdAt}</time> : null}
                        </div>
                        {evidence.excerpt ? (
                          <p className="focus-evidence-excerpt">{evidence.excerpt}</p>
                        ) : null}
                        <div className="focus-evidence-actions">
                          {canJump ? (
                            <button
                              type="button"
                              className="focus-card-action"
                              onClick={() => onJump(evidence)}
                            >
                              原消息
                            </button>
                          ) : (
                            <span className="focus-evidence-gone">原消息当前不可见</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="focus-detail-muted">暂时没有可读的来源。</p>
              )}
            </section>

            {detail && detail.revisions.length > 0 ? (
              <details className="focus-revisions">
                <summary>修订历史（{detail.revisions.length}）</summary>
                <ol>
                  {[...detail.revisions].reverse().map((revision) => (
                    <li key={revision.revision_id}>
                      <span className="focus-revision-version">v{revision.version}</span>
                      <span className="focus-revision-reason">{revision.reason || '更新'}</span>
                      <time>{focusTimeLabel(revision.created_at, true) ?? ''}</time>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>

          <footer className="focus-detail-foot">
            {archived || item.archived_at ? (
              <span className="focus-card-archived">
                {focusTimeLabel(item.archived_at, true)
                  ? `已归档于 ${focusTimeLabel(item.archived_at, true)}`
                  : '已归档'}
              </span>
            ) : (
              <button
                type="button"
                className="focus-archive-button"
                disabled={busy || item.restricted}
                onClick={() => onArchive(item)}
              >
                归档
              </button>
            )}
          </footer>
        </>
      ) : null}
    </aside>
  );
}
