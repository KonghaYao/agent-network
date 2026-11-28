/**
 * 看板宿主：常驻挂载浮窗，负责身份切换、全局 ⌘K/Ctrl+K 与当前用户状态。
 *
 * 宿主体积保持很小；列、详情与搜索都在按需渲染的子组件里。快捷键只打开
 * 宿主自己的浮窗，不抢占输入框、中文组词或其他对话框。
 */

import { useEffect } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { navigate } from '../../app/router';
import { FocusBoard } from './FocusBoard';
import {
  ensureFocusOwner,
  openFocusBoard,
  openFocusQuick,
  useFocusView,
} from './focus-store';
import { useFocusStatus } from './focus-queries';

function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('textarea, input, select, [contenteditable="true"]'))
  );
}

function foreignDialogOpen(): boolean {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  for (const dialog of dialogs) {
    if (dialog.id === 'focus-board') continue;
    // Lenso/Radix 退场时会短暂保留隐藏节点；只有仍可见的对话框才算占用。
    if (dialog instanceof HTMLElement) {
      if (dialog.hidden || dialog.getAttribute('aria-hidden') === 'true') continue;
      if (dialog.checkVisibility?.() === false) continue;
    }
    return true;
  }
  return false;
}

export function FocusHost() {
  const { session } = useWebSession();
  const me = session?.identity ?? null;
  const token = session?.token ?? null;
  const human = me?.kind === 'human' ? me : null;
  const view = useFocusView();
  const status = useFocusStatus(human?.actor_id ?? null, token, {
    enabled: Boolean(human && token),
  });

  useEffect(() => {
    ensureFocusOwner(human?.actor_id ?? null);
  }, [human?.actor_id]);

  // 从 Home 等非聊天页跳原消息时，先进入目标会话；目标本身仍留给 ChatPage
  // 就绪后消费，避免这里重复做一次锚点请求。
  useEffect(() => {
    const target = view.pendingJump;
    if (!target) return;
    if (window.location.pathname.startsWith('/c/')) return;
    navigate(`/c/${encodeURIComponent(target.room_id)}`);
  }, [view.pendingJump]);

  useEffect(() => {
    if (!human || !token) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      if (event.isComposing) return;
      if (editableTarget(event.target)) return;
      if (view.open) {
        if (view.quickOpen) return;
        event.preventDefault();
        openFocusQuick();
        return;
      }
      if (foreignDialogOpen()) return;
      if (!status.data?.enabled) return;
      event.preventDefault();
      openFocusBoard({ quick: true });
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [human, status.data?.enabled, token, view.open, view.quickOpen]);

  return <FocusBoard />;
}
