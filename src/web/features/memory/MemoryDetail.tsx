import { useEffect, useRef, useState } from 'react';

import {
  availabilityText,
  FACT_TYPE_LABEL,
  fetchMemoryDetail,
  formatMemoryTime,
  memoryFailureOf,
  type MemoryDetail as MemoryDetailData,
  type MemoryFailure,
} from './memory-data';
import { maskSecrets } from './mask';

/** 单条记忆详情；正文、上下文与来源默认全部掩码。 */
export function MemoryDetail({
  actorId,
  token,
  memoryId,
  onClose,
}: {
  actorId: string;
  token: string;
  memoryId: string;
  onClose: () => void;
}) {
  const [memory, setMemory] = useState<MemoryDetailData | null>(null);
  const [failure, setFailure] = useState<MemoryFailure | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setFailure(null);
    setReason(null);
    setReasonCode(null);
    setMemory(null);
    setRevealed(false);
    void (async () => {
      try {
        const result = await fetchMemoryDetail(actorId, memoryId, token, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.available) {
          setReason(availabilityText(result.reason));
          setReasonCode(result.reason);
          return;
        }
        setReason(null);
        setReasonCode(null);
        if (!result.memory) {
          setFailure({ kind: 'error', message: '这条记忆不存在或已被移除。' });
          return;
        }
        setMemory(result.memory);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [actorId, memoryId, token]);

  const masked = memory ? maskSecrets(memory.text) : '';
  const hasHidden = Boolean(memory && masked !== memory.text);

  return (
    <section
      className="memory-detail"
      id="memory-detail"
      data-state="open"
      aria-labelledby="memory-detail-title"
    >
      <div className="memory-detail-head">
        <h3 id="memory-detail-title">记忆详情</h3>
        <button
          type="button"
          className="memory-detail-close"
          id="memory-detail-close"
          aria-label="关闭记忆详情"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {loading ? (
        <p className="memory-status" id="memory-detail-status" role="status">
          正在读取记忆详情…
        </p>
      ) : null}

      {!loading && failure ? (
        <div className="memory-empty" id="memory-detail-status" data-state={failure.kind} role="status">
          <p>{failure.message}</p>
        </div>
      ) : null}

      {!loading && !failure && reason ? (
        <p className="memory-empty" id="memory-detail-status" data-state={reasonCode ?? 'unavailable'} role="status">
          {reason}
        </p>
      ) : null}

      {memory ? (
        <div className="memory-detail-body" aria-live="polite">
          <div className="memory-detail-meta">
            <span className={`memory-type type-${memory.fact_type ?? 'unknown'}`}>
              {memory.fact_type ? FACT_TYPE_LABEL[memory.fact_type] : '未分类'}
            </span>
            <span>{memory.state === 'invalidated' ? '已失效' : '有效'}</span>
            <span>{formatMemoryTime(memory.mentioned_at)}</span>
          </div>
          <p className="memory-detail-text" id="memory-detail-text">
            {revealed ? memory.text : masked}
          </p>
          <div className="memory-detail-actions">
            <button
              type="button"
              id="memory-detail-reveal"
              aria-expanded={revealed}
              aria-controls="memory-detail-text"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? '隐藏原文' : '查看原文'}
            </button>
            {hasHidden && !revealed ? (
              <span className="memory-hint" id="memory-detail-masked">
                凭据与带 token 的链接已掩码
              </span>
            ) : null}
          </div>
          {memory.text_truncated ? (
            <p className="memory-hint">正文超过 32 KB，服务端已截断。</p>
          ) : null}

          {memory.context ? (
            <section className="memory-detail-section" aria-labelledby="memory-detail-context-title">
              <h4 id="memory-detail-context-title">上下文</h4>
              <p className="memory-detail-context" id="memory-detail-context">
                {revealed ? memory.context : maskSecrets(memory.context)}
              </p>
            </section>
          ) : null}

          {memory.source_memories.length > 0 ? (
            <section className="memory-detail-section" aria-labelledby="memory-detail-sources-title">
              <h4 id="memory-detail-sources-title">来源记忆</h4>
              <ul className="memory-sources" id="memory-detail-sources">
                {memory.source_memories.map((source, index) => (
                  <li key={`${source.id}-${index}`}>
                    <span className="memory-sources-meta">
                      {source.type ? FACT_TYPE_LABEL[source.type] : '未分类'}
                      {source.mentioned_at ? ` · ${formatMemoryTime(source.mentioned_at)}` : ''}
                    </span>
                    <span className="memory-sources-text">
                      {revealed ? source.text : maskSecrets(source.text)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <details className="memory-detail-more">
            <summary>更多信息</summary>
            <dl>
              <div>
                <dt>发生时间</dt>
                <dd>{formatMemoryTime(memory.occurred_start)}</dd>
              </div>
              <div>
                <dt>结束时间</dt>
                <dd>{formatMemoryTime(memory.occurred_end)}</dd>
              </div>
              <div>
                <dt>证据数</dt>
                <dd>{memory.proof_count}</dd>
              </div>
              <div>
                <dt>历史版本</dt>
                <dd>{memory.history_count}</dd>
              </div>
              {memory.tags.length > 0 ? (
                <div>
                  <dt>标签</dt>
                  <dd>{memory.tags.join('、')}</dd>
                </div>
              ) : null}
            </dl>
          </details>
        </div>
      ) : null}
    </section>
  );
}

/** 桌面右侧空占位；移动端由 CSS 隐藏。 */
export function MemoryDetailPlaceholder() {
  return (
    <div className="memory-detail-placeholder">
      <p>从左侧选择一条记忆查看详情。</p>
    </div>
  );
}
