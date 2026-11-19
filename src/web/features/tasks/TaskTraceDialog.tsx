import { Button } from '../../app/lenso-controls';
import {
  LensoBackendProvider,
  useBackendLease,
  useLenso,
} from '../../app/lenso-runtime';
import {
  getTopModalShell,
  registerModalShell,
  type ModalShell,
} from '../../app/modal-shell';
import { Modal } from '../overlays/Modal';
import { useTaskTrace } from '../../hooks/useTaskTrace';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

function timeLabel(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString();
}

/** Lenso 升级会替换触发按钮节点；记录稳定选择器供关闭时找回同一入口。 */
function restoreSelector(element: HTMLElement): string | null {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const rootId = element.closest('[data-task-root]')?.getAttribute('data-task-root');
  return rootId
    ? `[data-task-root="${CSS.escape(rootId)}"] .task-dock-item-trigger`
    : null;
}

type Trace = ReturnType<typeof useTaskTrace>;

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
  const title = trace.summary?.preview || 'Task';

  return (
    <TaskTraceShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      content={<TraceContent trace={trace} onJump={onJump} onOpenChange={onOpenChange} />}
      footer={<TraceFooter onClose={() => onOpenChange(false)} />}
    />
  );
}

function TraceContent({
  trace,
  onJump,
  onOpenChange,
}: {
  trace: Trace;
  onJump: (messageId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const summary = trace.summary;
  const busy = trace.busy;

  return (
    <>
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
        <Button
          id="task-trace-refresh"
          className="link-btn"
          type="button"
          variant="borderless"
          size="sm"
          disabled={busy}
          onClick={() => void trace.refresh()}
        >
          刷新
        </Button>
        <span id="task-trace-status" role="status" aria-live="polite">
          {trace.status}
        </span>
      </div>
      <Button
        id="task-trace-older"
        className="task-trace-page"
        type="button"
        variant="bordered"
        size="sm"
        hidden={!trace.hasBefore}
        disabled={busy}
        onClick={() => void trace.loadOlder()}
      >
        加载更早
      </Button>
      <div id="task-trace-items" className="task-trace-items" role="list">
        {trace.items.length === 0 && !busy ? (
          <p className="task-trace-empty">没有可显示的消息</p>
        ) : (
          trace.items.map((item) => (
            <Button
              type="button"
              key={item.message_id}
              variant="borderless"
              size="sm"
              className={`task-trace-item${item.role === 'root' ? ' is-focus' : ''}${item.recalled ? ' is-recalled' : ''}`}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', height: 'auto', whiteSpace: 'normal', color: item.recalled ? 'var(--wx-muted)' : 'var(--lenso-label-primary)' }}
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
            </Button>
          ))
        )}
      </div>
      <Button
        id="task-trace-newer"
        className="task-trace-page"
        type="button"
        variant="bordered"
        size="sm"
        hidden={!trace.hasAfter}
        disabled={busy}
        onClick={() => void trace.loadNewer()}
      >
        加载更晚
      </Button>
      {trace.items.length > 0 ? (
        <p className="task-trace-meta">
          {trace.items.length} / {trace.count || trace.items.length} 条已加载
        </p>
      ) : null}
    </>
  );
}

function TraceFooter({ onClose }: { onClose: () => void }) {
  return (
    <div className="row modal-actions">
      <Button id="task-trace-close" type="button" variant="bordered" size="md" onClick={onClose}>
        关闭
      </Button>
    </div>
  );
}

type ShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  content: ReactNode;
  footer: ReactNode;
};

/**
 * Trace 的壳在打开瞬间锁定：顶层是 Radix（MessageSearch/上下文）时沿用
 * Radix，避免兄弟浮层混用两套焦点与滚动锁；页面级（TaskDock/预览）才升级
 * 为 Lenso Drawer。打开周期内模块到达或父层关闭都不换壳。
 */
function TaskTraceShell({ open, onOpenChange, title, content, footer }: ShellProps) {
  const backend = useBackendLease(open);
  const lenso = useLenso();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const restoreBy = useRef<string | null>(null);
  const lease = useRef<{ open: boolean; shell: ModalShell } | null>(null);

  if (open && !lease.current?.open) {
    const active = document.activeElement;
    restoreFocus.current = active instanceof HTMLElement ? active : null;
    restoreBy.current = active instanceof HTMLElement ? restoreSelector(active) : null;
    lease.current = {
      open: true,
      shell:
        getTopModalShell() === 'radix' || backend !== 'lenso' || !lenso
          ? 'radix'
          : 'lenso',
    };
  } else if (!open && lease.current?.open) {
    lease.current.open = false;
  }
  const shell = lease.current?.shell ?? 'radix';
  const resolveReturnFocus = () => {
    const captured = restoreFocus.current;
    if (captured?.isConnected) return captured;
    return restoreBy.current
      ? document.querySelector<HTMLElement>(restoreBy.current)
      : null;
  };
  const returnFocusRef = {
    get current() {
      return resolveReturnFocus();
    },
  } as RefObject<HTMLElement | null>;

  return (
    <LensoBackendProvider backend={backend}>
      {shell === 'lenso' && lenso ? (
        <LensoTraceDrawer
          open={open}
          onOpenChange={onOpenChange}
          title={title}
          content={content}
          footer={footer}
          drawer={lenso.Drawer}
          restoreFocus={resolveReturnFocus}
        />
      ) : (
        <Modal
          shell="radix"
          open={open}
          onOpenChange={onOpenChange}
          title={title}
          titleId="task-trace-title"
          contentId="task-trace-drawer"
          className="task-trace-card"
          footer={footer}
          returnFocusRef={returnFocusRef}
        >
          {content}
        </Modal>
      )}
    </LensoBackendProvider>
  );
}

function LensoTraceDrawer({
  open,
  onOpenChange,
  title,
  content,
  footer,
  drawer: Drawer,
  restoreFocus,
}: ShellProps & {
  drawer: NonNullable<ReturnType<typeof useLenso>>['Drawer'];
  restoreFocus: () => HTMLElement | null;
}) {
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open) return registerModalShell('lenso');
  }, [open]);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const target = restoreFocus();
      const frame = target ? requestAnimationFrame(() => target.focus()) : null;
      wasOpen.current = open;
      return () => {
        if (frame !== null) cancelAnimationFrame(frame);
      };
    }
    wasOpen.current = open;
  }, [open, restoreFocus]);
  // 关闭时立即卸载，避免 Lenso 退出动画期间吞掉下一次点击。
  if (!open) return null;

  return (
    <Drawer.Root
      open={open}
      modal
      side="end"
      closeOnOutsidePress
      onOpenChange={onOpenChange}
    >
      <Drawer.Backdrop
        variant="opaque"
        render={(props) => (
          <div
            {...props}
            className={`${String(props.className ?? '')} spa-dialog-overlay task-trace-overlay`.trim()}
          />
        )}
      />
      <Drawer.Content
        id="task-trace-drawer"
        data-task-trace-shell="lenso"
        data-drawer-no-drag=""
        aria-labelledby="task-trace-title"
        aria-describedby={undefined}
        initialFocus="auto"
        finalFocus={() => restoreFocus()}
        style={{ width: 'min(560px, 100vw)', maxWidth: '100vw' }}
        render={(props) => (
          <div {...props} className={`${String(props.className ?? '')} task-trace-drawer`.trim()} />
        )}
      >
        <Drawer.Title
          id="task-trace-title"
          render={(props) => <h2 {...props}>{title}</h2>}
        />
        {content}
        {footer}
        <Drawer.Close
          aria-label="关闭"
          render={(props) => (
            <button {...props} className="spa-dialog-close">
              ×
            </button>
          )}
        />
      </Drawer.Content>
    </Drawer.Root>
  );
}
