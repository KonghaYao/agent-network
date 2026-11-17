import { Button } from '../../app/lenso-controls';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { FenixMemoryApiContext } from './fenix/api';
import { EmptyState } from './fenix/ui/empty-state';
import { Spinner } from './fenix/ui/spinner';
import { createMemoryFenixApi } from './fenix/memory-api';
import type { AgentMemoryTarget } from './memory-store';
import './fenix/css/fenix.css';
import './memory-panel.css';

/**
 * The whole page is one dynamic chunk: the dialog keeps the loading spinner and
 * session gate, then hands the body to the upstream Fenix `MemoriesPage`. The page
 * owns the perspective rail, search, two-column workspace and mobile stacking; the
 * dialog intentionally does not render a second shell.
 */
const MemoriesPage = lazy(() =>
  import('./fenix/MemoriesPage').then((module) => ({ default: module.MemoriesPage })),
);

/**
 * 独立「Agent 记忆」弹窗。
 *
 * 只保留产品 chrome（标题、目标、只读徽章、关闭、说明）与会话闸门；
 * 内容与视角栏由 Fenix `MemoriesPage` 渲染。`showHeader={false}` 避免和弹窗标题重复。
 * 适配器通过 React context 注入：目标 actor/token 变化时 provider 值随之变化，
 * 旧弹窗卸载不会清空新弹窗的实例。
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
  const closeRef = useRef<HTMLButtonElement>(null);

  const api = useMemo(
    () => (token ? createMemoryFenixApi({ actorId: target.actor_id, token }) : null),
    [target.actor_id, token],
  );

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

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
            <Button
              type="button"
              className="agent-memory-close"
              id="agent-memory-close"
              ref={closeRef}
              aria-label="关闭 Agent 记忆"
              onClick={onClose}
            >
              ×
            </Button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden" id="agent-memory-content">
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
            ) : !token || !api ? (
              <EmptyState
                role="alert"
                className="py-16"
                title="浏览器身份尚未初始化"
                description="请刷新页面后重试。"
              />
            ) : (
              <FenixMemoryApiContext.Provider value={api}>
                <Suspense fallback={<Spinner className="flex py-16" label="正在加载记忆…" />}>
                  <MemoriesPage showHeader={false} />
                </Suspense>
              </FenixMemoryApiContext.Provider>
            )}
          </div>

          <p className="agent-memory-note" id="agent-memory-note" role="note">
            后端原始记忆，可能包含其他会话信息；本地遗忘可能尚未同步。面板只读，不修改任何记忆。
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
