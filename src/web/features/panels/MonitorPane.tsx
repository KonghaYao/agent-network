import { Tooltip } from '../../app/lenso-tooltip';
import { Button, EmptyState, FieldError, Input, Separator, Surface, Toolbar } from '../../app/lenso-controls';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import {
  monitorUrlFormSchema,
  type MonitorUrlForm,
} from '../../../contracts/web-forms';
import type { RoomMonitorState } from '../../hooks/useRoomMonitor';
import { confirmDialog } from '../overlays/confirm';

interface MonitorPaneProps {
  open: boolean;
  onClose: () => void;
  monitor: RoomMonitorState;
}

function hostLabel(url: string | null): string {
  if (!url) return '网页内容';
  try {
    return new URL(url).hostname || '网页内容';
  } catch {
    return '网页内容';
  }
}

/**
 * 网页监控右栏。
 *
 * iframe 默认 about:blank，关闭或清除后立刻卸载文档；URL 只写入 iframe
 * 的 src 与外部链接的 href，不作为 HTML。按产品选择不加 sandbox，风险
 * 提示保留在外链按钮的 Tooltip/aria-label。
 */
export function MonitorPane({ open, onClose, monitor }: MonitorPaneProps) {
  const { register, handleSubmit, reset, formState } = useForm<MonitorUrlForm>({
    resolver: zodResolver(monitorUrlFormSchema),
    defaultValues: { url: '' },
  });

  useEffect(() => {
    reset({ url: monitor.url ?? '' });
  }, [monitor.url, reset]);

  const mixed = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      Boolean(monitor.url?.startsWith('http://')),
    [monitor.url],
  );

  const submit = handleSubmit(async (values) => {
    await monitor.save(values.url);
  });

  const clear = async () => {
    const confirmed = await confirmDialog({
      title: '清除网址',
      message: '清除此会话的网址？其他设备也会同步清除。',
      confirmText: '清除',
      danger: true,
    });
    if (confirmed) await monitor.clear();
  };

  return (
    <aside
      className="monitor-pane"
      id="monitor-pane"
      aria-labelledby="monitor-title"
      hidden={!open}
    >
      <form id="monitor-form" className="monitor-toolbar" onSubmit={(event) => void submit(event)}>
        <Toolbar
          aria-label="网页监控操作"
          xstyle={{
            display: 'flex',
            width: '100%',
            alignItems: 'center',
            gap: 6,
            borderRadius: 0,
          }}
        >
        <h2 id="monitor-title" className="monitor-title">
          网页监控
        </h2>
        <Input
          id="monitor-url"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          aria-label="网页地址"
          maxLength={LIMITS.roomMonitorUrlMax}
          placeholder="https://…"
          aria-invalid={formState.errors.url ? true : undefined}
          aria-describedby={formState.errors.url ? 'monitor-url-error' : undefined}
          style={{ height: 36, borderRadius: 8 }}
          {...register('url')}
        />
        <div className="monitor-actions">
          <Tooltip as={Button}
            className="monitor-icon primary"
            id="monitor-save"
            type="submit"
            variant="prominent"
            size="sm"
            aria-label="保存网页地址"
            hint="保存网页地址（Enter）"
            disabled={monitor.busy}
          >
            保存
          </Tooltip>
          <Tooltip as={Button}
            className="monitor-icon"
            id="monitor-clear"
            type="button"
            variant="borderless"
            size="sm"
            style={{ color: 'var(--wx-text)' }}
            aria-label="清除网页地址"
            hint="清除网页地址"
            disabled={monitor.busy}
            onClick={() => void clear()}
          >
            清除
          </Tooltip>
          <Separator
            orientation="vertical"
            style={{ flex: '0 0 auto', margin: '0 2px' }}
          />
          <Tooltip as="a"
            className="monitor-icon monitor-external"
            id="monitor-external"
            href={monitor.url ?? '#'}
            target="_blank"
            rel="noopener"
            aria-disabled={monitor.url ? 'false' : 'true'}
            hint="仅打开可信网页；目标站点可能拒绝嵌入（X-Frame-Options/CSP），HTTPS 可能阻止 HTTP 目标；iframe 未加 sandbox，同源页面可读取本页登录凭据。"
            aria-label="新标签页打开网页；仅限可信地址，iframe 未加 sandbox，同源页面可读取本页登录凭据"
            onClick={(event) => {
              if (!monitor.url) event.preventDefault();
            }}
          >
            外链
          </Tooltip>
          <Tooltip as={Button}
            className="monitor-icon"
            id="monitor-refresh"
            type="button"
            variant="borderless"
            size="sm"
            style={{ color: 'var(--wx-text)' }}
            aria-label="刷新网页"
            hint="刷新网页（重新读取地址）"
            disabled={monitor.busy}
            onClick={() => void monitor.refresh()}
          >
            刷新
          </Tooltip>
          <Tooltip as={Button}
            className="monitor-icon monitor-close"
            id="monitor-close"
            type="button"
            variant="borderless"
            size="sm"
            style={{ color: 'var(--wx-text)' }}
            aria-label="关闭网页监控"
            hint="关闭网页监控"
            onClick={onClose}
          >
            关闭
          </Tooltip>
        </div>
        </Toolbar>
      </form>
      {formState.errors.url ? (
        <FieldError id="monitor-url-error">
          {formState.errors.url.message}
        </FieldError>
      ) : null}
      <p id="monitor-status" className="monitor-status" role="status" aria-live="polite">
        {monitor.loading ? '正在读取…' : monitor.status}
      </p>
      {monitor.error ? (
        <div id="monitor-error" className="monitor-error" role="alert">
          <p id="monitor-error-text">{monitor.error}</p>
          <Button id="monitor-retry" type="button" variant="bordered" size="sm" onClick={() => void monitor.refresh()}>
            重试
          </Button>
        </div>
      ) : null}
      {mixed ? (
        <p id="monitor-mixed" className="monitor-hint">
          HTTPS 页面可能阻止 HTTP 目标。
        </p>
      ) : null}
      <Surface
        id="monitor-frame-wrap"
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          margin: '8px 10px 10px',
          overflow: 'hidden',
          border: '1px solid var(--wx-line)',
          borderRadius: 6,
          background: '#fff',
        }}
      >
        {!monitor.url ? (
          <div id="monitor-empty" className="monitor-empty">
            <EmptyState style={{ padding: 0, color: 'inherit', fontSize: 'inherit' }}>
              暂无网页
            </EmptyState>
          </div>
        ) : null}
        <iframe
          id="monitor-frame"
          className="monitor-frame"
          title={`网页内容 · ${hostLabel(monitor.url)}`}
          src={monitor.url ?? 'about:blank'}
          hidden={!monitor.url}
          referrerPolicy="no-referrer"
        />
      </Surface>
    </aside>
  );
}
