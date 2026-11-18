import { Button } from '../../app/lenso-controls';
import {
  LensoBackendProvider,
  useBackendLease,
  useLenso,
  useLensoBackendScope,
} from '../../app/lenso-runtime';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { lazy, Suspense, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';

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
    <AgentMemoryShell closeRef={closeRef} onClose={onClose}>
      <header className="agent-memory-head">
        <div className="agent-memory-head-main">
          <AgentMemoryTitle />
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
    </AgentMemoryShell>
  );
}

type AgentMemoryShellProps = {
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
};

/**
 * 页面级记忆面板只有两种打开者：菜单/侧栏（顶层 shell 为空）与 Members
 * （既有流程先关闭 Members 再打开记忆）。因此这里不复制父层 Radix 门控，
 * 只在本次打开周期按 Lenso 是否就绪选壳；模块晚到不影响当前周期。
 */
function AgentMemoryShell({ closeRef, onClose, children }: AgentMemoryShellProps) {
  const backend = useBackendLease(true);
  const lenso = useLenso();
  return (
    <LensoBackendProvider backend={backend}>
      {backend === 'lenso' && lenso ? (
        <LensoMemoryShell closeRef={closeRef} onClose={onClose} drawer={lenso.Drawer}>
          {children}
        </LensoMemoryShell>
      ) : (
        <RadixMemoryShell closeRef={closeRef} onClose={onClose}>
          {children}
        </RadixMemoryShell>
      )}
    </LensoBackendProvider>
  );
}

function RadixMemoryShell({
  closeRef,
  onClose,
  children,
}: AgentMemoryShellProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay agent-memory-overlay" />
        <DialogPrimitive.Content
          className="agent-memory-dialog"
          id="agent-memory-dialog"
          data-agent-memory-shell="radix"
          aria-describedby="agent-memory-note"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function LensoMemoryShell({
  closeRef,
  onClose,
  children,
  drawer: Drawer,
}: AgentMemoryShellProps & {
  drawer: NonNullable<ReturnType<typeof useLenso>>['Drawer'];
}) {
  useEffect(() => {
    // Drawer 固定 dismissible=false：嵌套详情打开时 outside press 不能误关父层。
    // 没有详情时由本层补回 Esc 关闭语义。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (document.querySelector('[data-memory-detail-dialog]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <Drawer.Root
      open
      modal
      side="end"
      dismissible={false}
      closeOnOutsidePress
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <Drawer.Backdrop
        variant="opaque"
        render={(props) => (
          <div
            {...props}
            className={`${String(props.className ?? '')} spa-dialog-overlay agent-memory-overlay`.trim()}
          />
        )}
      />
      <Drawer.Content
        id="agent-memory-dialog"
        data-agent-memory-shell="lenso"
        data-drawer-no-drag=""
        aria-labelledby="agent-memory-title"
        aria-describedby="agent-memory-note"
        initialFocus={() => closeRef.current}
        finalFocus="none"
        style={{ width: '100vw', maxWidth: '100vw' }}
        render={(props) => (
          <div {...props} className={`${String(props.className ?? '')} agent-memory-dialog`.trim()} />
        )}
      >
        {children}
      </Drawer.Content>
    </Drawer.Root>
  );
}

function AgentMemoryTitle() {
  const lenso = useLenso();
  const backend = useLensoBackendScope();
  return lenso && backend === 'lenso' ? (
    <lenso.Drawer.Title
      id="agent-memory-title"
      render={(props) => <h2 {...props}>Agent 记忆</h2>}
    />
  ) : (
    <DialogPrimitive.Title asChild>
      <h2 id="agent-memory-title">Agent 记忆</h2>
    </DialogPrimitive.Title>
  );
}
