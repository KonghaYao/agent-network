import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Eye, Fingerprint, Globe, Network, Search, type LucideIcon } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { configureFenixMemoryApi } from './fenix/api';
import { EmptyState } from './fenix/ui/empty-state';
import { Input } from './fenix/ui/input';
import { Spinner } from './fenix/ui/spinner';
import { createMemoryFenixApi } from './fenix/memory-api';
import { NS, useTranslation } from './fenix/i18n';
import type { AgentMemoryTarget } from './memory-store';
import './fenix/css/fenix.css';
import './memory-panel.css';

const DataView = lazy(() =>
  import('./fenix/components/DataView').then((module) => ({ default: module.DataView })),
);
const MemoryDetailModal = lazy(() =>
  import('./fenix/components/MemoryDetailModal').then((module) => ({
    default: module.MemoryDetailModal,
  })),
);
const EntitiesView = lazy(() =>
  import('./fenix/components/EntitiesView').then((module) => ({
    default: module.EntitiesView,
  })),
);

type MemoryPerspective = 'world' | 'experience' | 'observation' | 'entities';

const PERSPECTIVES = [
  {
    id: 'world',
    icon: Globe,
    labelKey: 'perspectives.world',
    descriptionKey: 'perspectives.worldDescription',
    markClass: 'bg-sky-500',
  },
  {
    id: 'experience',
    icon: Fingerprint,
    labelKey: 'perspectives.experience',
    descriptionKey: 'perspectives.experienceDescription',
    markClass: 'bg-violet-500',
  },
  {
    id: 'observation',
    icon: Eye,
    labelKey: 'perspectives.observation',
    descriptionKey: 'perspectives.observationDescription',
    markClass: 'bg-amber-500',
  },
  {
    id: 'entities',
    icon: Network,
    labelKey: 'perspectives.entities',
    descriptionKey: 'perspectives.entitiesDescription',
    markClass: 'bg-rose-500',
  },
] as const satisfies ReadonlyArray<{
  id: MemoryPerspective;
  icon: LucideIcon;
  labelKey: string;
  descriptionKey: string;
  markClass: string;
}>;

function isFactPerspective(
  perspective: MemoryPerspective,
): perspective is Exclude<MemoryPerspective, 'entities'> {
  return perspective !== 'entities';
}

/**
 * 独立「Agent 记忆」弹窗（Fenix 视角 IA）。
 *
 * 视角栏：世界 / 经历 / 观察 / 实体；事实视角内由 Fenix `DataView` 提供
 * 星座图 / 表格 / 时间线三种视图模式。每个用户动作只发一次
 * `network_agent_memory_graph { include_rows: true, timezone }`；视图切换、
 * 表格翻页、时间线缩放都不再取数。实体视角使用 Fenix `EntitiesView`：
 * 列表服务端分页 50/页、翻页只发 1 次并替换当前页；关系图与详情各按一次
 * 用户动作取数；不提供客户端名称搜索（服务端实体工具没有 `q`）。
 */
export function AgentMemoryDialog({
  target,
  onClose,
}: {
  target: AgentMemoryTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const [perspective, setPerspective] = useState<MemoryPerspective>('world');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const api = useMemo(
    () => (token ? createMemoryFenixApi({ actorId: target.actor_id, token }) : null),
    [target.actor_id, token],
  );

  // 必须在子组件渲染/发起取数之前完成注入：Fenix 组件在 effect 里读取
  // 模块级 `hindsightApi`，父组件 render 早于子组件 effect。
  if (api) configureFenixMemoryApi(api);
  useEffect(() => () => configureFenixMemoryApi(null), []);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const switchPerspective = (next: MemoryPerspective) => {
    if (next === perspective) return;
    setSelectedMemoryId(null);
    setPerspective(next);
  };

  const onPerspectiveKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = PERSPECTIVES.findIndex((item) => item.id === perspective);
    let nextIndex = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % PERSPECTIVES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + PERSPECTIVES.length) % PERSPECTIVES.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = PERSPECTIVES.length - 1;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = PERSPECTIVES[nextIndex]!;
    switchPerspective(next.id);
    requestAnimationFrame(() =>
      document.getElementById(`memory-perspective-${next.id}`)?.focus({ preventScroll: true }),
    );
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearchQuery(searchInput.trim());
  };

  const sessionError =
    session.status === 'logged-out' || session.status === 'credential-invalid'
      ? session.error
      : session.status === 'error'
        ? session.error
        : null;

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
                {target.name}
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

          <div className="agent-memory-fenix-body fenix-memory-root">
            <aside className="agent-memory-perspectives">
              <div className="agent-memory-perspectives-head">
                <strong>{t('perspectives.title')}</strong>
                <span>{t('perspectives.description')}</span>
              </div>

              {/* 实体视角不渲染搜索框：`network_agent_memory_entities` 没有 `q` 参数，
                  不在已加载页内做客户端名称过滤冒充搜索。 */}
              {isFactPerspective(perspective) ? (
                <form className="agent-memory-search" onSubmit={submitSearch} role="search">
                  <Search aria-hidden="true" />
                  <Input
                    id="memory-fenix-search"
                    value={searchInput}
                    onInput={(event) => setSearchInput(event.currentTarget.value)}
                    placeholder={t('workspace.searchPlaceholder')}
                    aria-label={t('workspace.searchPlaceholder')}
                    className="bg-background pl-9"
                  />
                </form>
              ) : null}

              <nav
                className="agent-memory-perspective-list"
                aria-label={t('perspectives.title')}
                onKeyDown={onPerspectiveKeyDown}
              >
                {PERSPECTIVES.map(({ id, icon: Icon, labelKey, descriptionKey, markClass }) => {
                  const selected = perspective === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      id={`memory-perspective-${id}`}
                      className={`agent-memory-perspective${selected ? ' active' : ''}`}
                      aria-pressed={selected}
                      onClick={() => switchPerspective(id)}
                    >
                      <span className={`agent-memory-perspective-mark ${markClass}`} aria-hidden="true" />
                      <Icon aria-hidden="true" />
                      <span className="agent-memory-perspective-text">
                        <strong>{t(labelKey)}</strong>
                        <span>{t(descriptionKey)}</span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <div className="agent-memory-content">
              {session.status === 'loading' ? (
                <Spinner className="flex py-16" label="正在读取浏览器身份…" />
              ) : sessionError ? (
                <EmptyState
                  tone="danger"
                  role="alert"
                  className="py-16"
                  title="浏览器身份尚未就绪"
                  description={sessionError}
                />
              ) : !token ? (
                <EmptyState
                  role="alert"
                  className="py-16"
                  title="浏览器身份尚未初始化"
                  description="请刷新页面后重试。"
                />
              ) : perspective === 'entities' ? (
                <Suspense fallback={<Spinner className="flex py-16" label="正在加载实体…" />}>
                  <EntitiesView />
                </Suspense>
              ) : (
                <Suspense fallback={<Spinner className="flex py-16" label="正在加载记忆…" />}>
                  <DataView
                    key={`${perspective}:${searchQuery}`}
                    factType={perspective}
                    initialQuery={searchQuery}
                  />
                </Suspense>
              )}
            </div>
          </div>

          <p className="agent-memory-note" id="agent-memory-note" role="note">
            后端原始记忆，可能包含其他会话信息；本地遗忘可能尚未同步。面板只读，不修改任何记忆。
          </p>

          {selectedMemoryId ? (
            <Suspense fallback={null}>
              <MemoryDetailModal
                memoryId={selectedMemoryId}
                onClose={() => setSelectedMemoryId(null)}
              />
            </Suspense>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
