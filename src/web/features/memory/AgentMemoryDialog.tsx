import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { MemoryDetail, MemoryDetailPlaceholder } from './MemoryDetail';
import { MemoryFacts } from './MemoryFacts';
import { MemoryOverview } from './MemoryOverview';
import {
  fetchMemoryOverview,
  memoryFailureOf,
  type MemoryFailure,
  type MemoryOverviewResult,
} from './memory-data';
import type { AgentMemoryTarget } from './memory-store';
import './memory-panel.css';

/**
 * 独立「Agent 记忆」弹窗：只读 overview + 事实列表 + 详情。
 *
 * 与本地账本 `MemoryDialog` 并存；不展示 bank/space/provider 等内部标识，
 * 正文默认掩码。弹窗本体由宿主懒加载，不进入首屏主包。
 */
export function AgentMemoryDialog({
  target,
  onClose,
}: {
  target: AgentMemoryTarget;
  onClose: () => void;
}) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const [overview, setOverview] = useState<MemoryOverviewResult | null>(null);
  const [failure, setFailure] = useState<MemoryFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setFailure({ kind: 'error', message: '浏览器身份尚未初始化，请刷新页面后重试。' });
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    setOverview(null);
    void (async () => {
      try {
        const result = await fetchMemoryOverview(target.actor_id, token, controller.signal);
        if (controller.signal.aborted) return;
        setOverview(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(memoryFailureOf(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reloadKey, target.actor_id, token]);

  const name = overview?.actor.name ?? target.name;
  const canBrowse = Boolean(token && overview?.available && overview.stats);
  const reachedBottom = Boolean(selectedId);

  return (
    <DialogPrimitive.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay agent-memory-overlay" />
        <DialogPrimitive.Content
          className="agent-memory-dialog"
          id="agent-memory-dialog"
          aria-describedby="agent-memory-note"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <header className="agent-memory-head">
            <div className="agent-memory-head-main">
              <DialogPrimitive.Title asChild>
                <h2 id="agent-memory-title">Agent 记忆</h2>
              </DialogPrimitive.Title>
              <span className="agent-memory-target" id="agent-memory-target">
                {name}
              </span>
              <span className="memory-badge" id="agent-memory-readonly">
                只读
              </span>
              <span className="memory-badge subtle">后端原始记忆</span>
            </div>
            <button
              type="button"
              className="agent-memory-close"
              id="agent-memory-close"
              ref={closeRef}
              aria-label="关闭 Agent 记忆"
              onClick={onClose}
            >
              ×
            </button>
          </header>

          <div className="agent-memory-body">
            <div className="agent-memory-main">
              <MemoryOverview
                targetName={name}
                result={overview}
                failure={failure}
                loading={loading}
              />
              {failure ? (
                <button
                  type="button"
                  className="memory-retry"
                  id="memory-overview-retry"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  重新读取
                </button>
              ) : null}
              {canBrowse && token ? (
                <MemoryFacts
                  actorId={target.actor_id}
                  token={token}
                  activeId={selectedId}
                  onSelect={setSelectedId}
                />
              ) : null}
            </div>
            <aside
              className={`memory-detail-column${reachedBottom ? ' open' : ''}`}
              aria-label="记忆详情"
            >
              {canBrowse && token && selectedId ? (
                <MemoryDetail
                  actorId={target.actor_id}
                  token={token}
                  memoryId={selectedId}
                  onClose={() => setSelectedId(null)}
                />
              ) : (
                <MemoryDetailPlaceholder />
              )}
            </aside>
          </div>

          <p className="agent-memory-note" id="agent-memory-note" role="note">
            后端原始记忆，可能包含其他会话信息；本地遗忘可能尚未同步。面板只读，不修改任何记忆。
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
