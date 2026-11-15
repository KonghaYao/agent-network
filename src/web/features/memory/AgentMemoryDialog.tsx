import * as DialogPrimitive from '@radix-ui/react-dialog';
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { MemoryDetail, MemoryDetailPlaceholder } from './MemoryDetail';
import { MemoryFacts } from './MemoryFacts';
import { MemoryOverview } from './MemoryOverview';
import {
  availabilityText,
  fetchMemoryOverview,
  memoryFailureOf,
  type MemoryFailure,
  type MemoryOverviewResult,
} from './memory-data';
import type { AgentMemoryTarget } from './memory-store';
import './memory-panel.css';

const MemoryConstellation = lazy(() =>
  import('./MemoryConstellation').then((module) => ({ default: module.MemoryConstellation })),
);
const MemoryTimeline = lazy(() =>
  import('./MemoryTimeline').then((module) => ({ default: module.MemoryTimeline })),
);
const MemoryEntities = lazy(() =>
  import('./MemoryEntities').then((module) => ({ default: module.MemoryEntities })),
);

type MemoryTab = 'overview' | 'constellation' | 'timeline' | 'entities' | 'facts';

const TABS: { id: MemoryTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'constellation', label: '星座' },
  { id: 'timeline', label: '时间线' },
  { id: 'entities', label: '实体' },
  { id: 'facts', label: '事实' },
];

/**
 * 独立「Agent 记忆」弹窗：概览 / 星座 / 时间线 / 实体 / 事实。
 *
 * 与本地账本 `MemoryDialog` 并存；不展示 bank/space/provider 等内部标识，
 * 正文默认掩码。弹窗本体由宿主懒加载；星座、时间线、实体在弹窗内再次
 * 懒加载，避免增加首屏主包体积。
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
  const [activeTab, setActiveTab] = useState<MemoryTab>('overview');
  const [visited, setVisited] = useState<Set<MemoryTab>>(() => new Set(['overview']));
  const closeRef = useRef<HTMLButtonElement>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const activeTabRef = useRef<MemoryTab>(activeTab);
  activeTabRef.current = activeTab;

  const selectMemory = (id: string, trigger?: HTMLElement | null) => {
    detailTriggerRef.current = trigger ?? null;
    setSelectedId(id);
  };

  /** 关闭详情后把焦点还给触发按钮；按钮因搜索/筛选卸载时回到当前 Tab。 */
  const closeDetail = () => {
    setSelectedId(null);
    requestAnimationFrame(() => {
      const trigger = detailTriggerRef.current;
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
        return;
      }
      document.getElementById(`memory-tab-${activeTabRef.current}`)?.focus({ preventScroll: true });
    });
  };

  const switchTab = (next: MemoryTab) => {
    if (next === activeTab) return;
    setSelectedId(null);
    detailTriggerRef.current = null;
    setActiveTab(next);
    setVisited((current) => {
      if (current.has(next)) return current;
      const updated = new Set(current);
      updated.add(next);
      return updated;
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = TABS[nextIndex]!;
    switchTab(next.id);
    requestAnimationFrame(() =>
      document.getElementById(`memory-tab-${next.id}`)?.focus({ preventScroll: true }),
    );
  };

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

  const unavailable = overview ? availabilityText(overview.reason) : null;

  const panelProps = (id: MemoryTab) => ({
    id: `memory-panel-${id}`,
    role: 'tabpanel' as const,
    'aria-labelledby': `memory-tab-${id}`,
    hidden: activeTab !== id,
    className: 'memory-tab-panel',
  });

  const unavailableNote = (id: string) => {
    if (loading) {
      return (
        <p className="memory-status" id={id} role="status">
          正在读取记忆统计…
        </p>
      );
    }
    if (failure) {
      return (
        <p className="memory-empty" id={id} data-state={failure.kind} role="status">
          {failure.message}
        </p>
      );
    }
    if (overview && !overview.available) {
      return (
        <p className="memory-empty" id={id} data-state={overview.reason} role="status">
          {unavailable}
        </p>
      );
    }
    return (
      <p className="memory-empty" id={id} data-state="unavailable" role="status">
        记忆面板暂不可用。
      </p>
    );
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay agent-memory-overlay" />
        <DialogPrimitive.Content
          className="agent-memory-dialog"
          id="agent-memory-dialog"
          aria-describedby="agent-memory-note"
          onEscapeKeyDown={(event) => {
            // 详情打开时 Escape 只关闭详情，并把焦点交还触发按钮。
            if (!selectedId) return;
            event.preventDefault();
            closeDetail();
          }}
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
              <div className="memory-tabs" role="tablist" aria-label="记忆视图" onKeyDown={onTabKeyDown}>
                {TABS.map((tab) => (
                  <button
                    type="button"
                    role="tab"
                    key={tab.id}
                    id={`memory-tab-${tab.id}`}
                    className={`memory-tab${activeTab === tab.id ? ' active' : ''}`}
                    aria-selected={activeTab === tab.id}
                    aria-controls={`memory-panel-${tab.id}`}
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    onClick={() => switchTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="memory-tab-panels">
                <div {...panelProps('overview')}>
                  {visited.has('overview') ? (
                    <>
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
                    </>
                  ) : null}
                </div>

                <div {...panelProps('constellation')}>
                  {visited.has('constellation') ? (
                    canBrowse && token ? (
                      <Suspense
                        fallback={
                          <p className="memory-status" role="status">
                            正在加载星座图…
                          </p>
                        }
                      >
                        <MemoryConstellation
                          actorId={target.actor_id}
                          token={token}
                          activeId={selectedId}
                          onSelect={selectMemory}
                        />
                      </Suspense>
                    ) : (
                      unavailableNote('memory-graph-status')
                    )
                  ) : null}
                </div>

                <div {...panelProps('timeline')}>
                  {visited.has('timeline') ? (
                    canBrowse && token ? (
                      <Suspense
                        fallback={
                          <p className="memory-status" role="status">
                            正在加载时间线…
                          </p>
                        }
                      >
                        <MemoryTimeline
                          actorId={target.actor_id}
                          token={token}
                          activeId={selectedId}
                          onSelect={selectMemory}
                        />
                      </Suspense>
                    ) : (
                      unavailableNote('memory-timeline-status')
                    )
                  ) : null}
                </div>

                <div {...panelProps('entities')}>
                  {visited.has('entities') ? (
                    canBrowse && token ? (
                      <Suspense
                        fallback={
                          <p className="memory-status" role="status">
                            正在加载实体…
                          </p>
                        }
                      >
                        <MemoryEntities
                          actorId={target.actor_id}
                          token={token}
                          onSelectMemory={selectMemory}
                        />
                      </Suspense>
                    ) : (
                      unavailableNote('memory-entities-status')
                    )
                  ) : null}
                </div>

                <div {...panelProps('facts')}>
                  {visited.has('facts') ? (
                    canBrowse && token ? (
                      <MemoryFacts
                        actorId={target.actor_id}
                        token={token}
                        activeId={selectedId}
                        onSelect={selectMemory}
                      />
                    ) : (
                      unavailableNote('memory-facts-status')
                    )
                  ) : null}
                </div>
              </div>
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
                  onClose={closeDetail}
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
