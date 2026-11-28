/**
 * 侧栏左下角的任务秘书入口；AccountMenu 复用同一份状态与动作。
 *
 * 未开启显示「开启任务秘书」，已开启显示「我的看板」与 needs_me 计数。
 * 首次点击先调用 enable，再打开浮窗；重复点击由后端幂等收敛。
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import type { WebIdentity } from '../../lib/identity';
import { queryKeys } from '../../lib/query-keys';
import { enableFocus, useFocusStatus } from './focus-queries';
import { openFocusBoard, showFocusNotice } from './focus-store';

export function useFocusEntry() {
  const { session } = useWebSession();
  const me = session?.identity ?? null;
  const token = session?.token ?? null;
  const human = me?.kind === 'human' ? me : null;
  const queryClient = useQueryClient();
  const status = useFocusStatus(human?.actor_id ?? null, token, {
    enabled: Boolean(human && token),
  });
  const [busy, setBusy] = useState(false);
  const enabled = status.data?.enabled === true;
  const count = status.data?.counts.needs_me ?? 0;

  const activate = useCallback(async () => {
    if (!token || busy) return;
    if (status.data?.enabled) {
      openFocusBoard();
      return;
    }
    setBusy(true);
    try {
      await enableFocus(token);
      await queryClient.invalidateQueries({ queryKey: queryKeys.focus() });
      openFocusBoard();
    } catch {
      showFocusNotice('暂时无法开启任务秘书，请稍后重试。', true);
      openFocusBoard();
    } finally {
      setBusy(false);
    }
  }, [busy, queryClient, status.data?.enabled, token]);

  return {
    visible: Boolean(human && token),
    enabled,
    count,
    busy,
    label: enabled ? '我的看板' : '开启任务秘书',
    menuLabel: enabled
      ? `我的看板${count > 0 ? ` · ${count} 件需要我` : ''}`
      : '开启任务秘书',
    activate,
  };
}

export function FocusEntry({ me }: { me: WebIdentity | null }) {
  const focus = useFocusEntry();
  if (!focus.visible || me?.kind !== 'human') return null;
  return (
    <div className="focus-entry">
      <button
        type="button"
        id="focus-entry"
        className="focus-entry-link"
        data-enabled={focus.enabled ? '1' : undefined}
        aria-busy={focus.busy}
        disabled={focus.busy}
        onClick={() => void focus.activate()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M9 4v16m6-16v16" />
        </svg>
        <span>{focus.label}</span>
        {focus.enabled && focus.count > 0 ? (
          <span className="focus-entry-count" aria-label={`${focus.count} 件需要我`}>
            {focus.count}
          </span>
        ) : null}
      </button>
    </div>
  );
}
