import { useEffect, useState } from 'react';

import { Button } from '../app/lenso-controls';
import {
  clearUpdateError,
  dismissUpdate,
  manualReload,
  requestSafeUpdate,
  showUpdateNotice,
  startVersionMonitor,
  useUpdateState,
  type UpdateState,
} from './update-store';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退到临时 textarea；两者都失败时保持页面不动。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function titleFor(state: UpdateState): string {
  if (state.phase === 'error') {
    return state.errorKind === 'reloaded' ? '更新未完成' : '无法安全更新';
  }
  if (state.phase === 'incompatible') return '需要更新';
  if (state.phase === 'reloading') return '正在更新';
  return '有新版本';
}

function leadFor(state: UpdateState): string {
  if (state.message) return state.message;
  if (state.phase === 'reloading') return '正在重新加载页面并恢复本标签的文字草稿…';
  if (state.phase === 'incompatible') {
    return '当前页面与服务器版本不兼容。可以继续查看已有内容，但新的发送和上传已暂停；请完成手头操作后更新。';
  }
  return '已发布兼容的新版本。当前页面不会自动刷新；完成手头操作后再更新。';
}

/**
 * 固定在视口底部的更新提示。
 *
 * 使用现有 Lenso Button 适配层与主题变量；移动端占满安全区宽度，键盘可达。
 * 所有动作都需要用户显式点击，`controllerchange` 与 SW 更新不会触发刷新。
 */
export function UpdateNotice() {
  const state = useUpdateState();
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => startVersionMonitor(), []);
  useEffect(() => {
    setCopyStatus('');
  }, [state.message, state.errorKind]);

  const visible =
    !state.noticeDismissed &&
    (state.phase === 'available' ||
      state.phase === 'incompatible' ||
      state.phase === 'reloading' ||
      state.phase === 'error');
  // 提示可以隐藏，但“需要更新”的事实不能消失。不兼容写保护与未完成的
  // 快照错误都保留一个非阻塞的持久入口，点击后重新展开原提示。
  const showMarker =
    state.noticeDismissed && (state.contractIncompatible || state.phase === 'error');

  if (!visible) {
    if (!showMarker) return null;
    const blocked = state.contractIncompatible;
    return (
      <div
        id="pwa-update-marker"
        className="pwa-update-marker"
        data-update-phase={state.phase}
        data-write-blocked={blocked ? 'true' : 'false'}
        role="status"
        aria-live="polite"
      >
        <span className="pwa-update-marker-text">
          {blocked
            ? '需要更新：发送与上传已暂停'
            : state.draftText
              ? '更新未完成：草稿仍可复制'
              : '更新未完成：请手动刷新'}
        </span>
        <Button
          id="pwa-update-marker-open"
          type="button"
          variant="borderless"
          size="sm"
          onClick={showUpdateNotice}
        >
          查看
        </Button>
      </div>
    );
  }

  const copyDraft = async () => {
    const copied = await copyText(state.draftText);
    setCopyStatus(copied ? '草稿已复制' : '复制失败，请手动选择正文复制');
  };

  const normalActions = state.phase === 'available' || state.phase === 'incompatible';
  const snapshotError = state.errorKind === 'snapshot' || state.errorKind === 'storage';
  const reloadedError = state.errorKind === 'reloaded';
  const checkError = state.errorKind === 'version';

  return (
    <div
      id="pwa-update-notice"
      className="pwa-update-notice"
      data-update-phase={state.phase}
      data-update-error={state.errorKind ?? ''}
      role="status"
      aria-live="polite"
    >
      <div className="pwa-update-copy">
        <strong className="pwa-update-title">{titleFor(state)}</strong>
        <p className="pwa-update-lead">{leadFor(state)}</p>
        {copyStatus ? (
          <p className="pwa-update-status" role="status">{copyStatus}</p>
        ) : null}
      </div>
      <div className="pwa-update-actions">
        {state.phase === 'reloading' ? null : (
          <>
            {snapshotError || reloadedError ? (
              <>
                {snapshotError && state.draftText ? (
                  <Button
                    id="pwa-update-copy-draft"
                    type="button"
                    variant="bordered"
                    size="sm"
                    onClick={() => void copyDraft()}
                  >
                    复制草稿
                  </Button>
                ) : null}
                <Button
                  id="pwa-update-manual"
                  type="button"
                  variant="prominent"
                  size="sm"
                  onClick={manualReload}
                >
                  手动刷新
                </Button>
                <Button
                  id="pwa-update-stay"
                  type="button"
                  variant="borderless"
                  size="sm"
                  onClick={clearUpdateError}
                >
                  留在当前页
                </Button>
              </>
            ) : checkError ? (
              <>
                <Button
                  id="pwa-update-apply"
                  type="button"
                  variant="prominent"
                  size="sm"
                  disabled={state.checking}
                  onClick={() => void requestSafeUpdate()}
                >
                  重试
                </Button>
                <Button
                  id="pwa-update-later"
                  type="button"
                  variant="borderless"
                  size="sm"
                  onClick={dismissUpdate}
                >
                  稍后
                </Button>
              </>
            ) : normalActions ? (
              <>
                <Button
                  id="pwa-update-apply"
                  type="button"
                  variant="prominent"
                  size="sm"
                  disabled={state.checking}
                  onClick={() => void requestSafeUpdate()}
                >
                  {state.checking ? '正在检查…' : '更新'}
                </Button>
                <Button
                  id="pwa-update-later"
                  type="button"
                  variant="borderless"
                  size="sm"
                  onClick={dismissUpdate}
                >
                  稍后
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
