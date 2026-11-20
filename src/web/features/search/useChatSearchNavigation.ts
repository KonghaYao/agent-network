import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import { navigate } from '../../app/router';
import { useMessageSearchNavigation } from '../../hooks/useMessageSearchNavigation';
import type {
  LocateResult,
  SearchNavigationTarget,
} from './message-search-types';

function renderedMessage(messageId: string): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.dataset.messageId === messageId) return node;
  }
  return null;
}

function dialogOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));
}

function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('textarea, input, select, [contenteditable="true"]'))
  );
}

/**
 * ChatPage 级搜索定位：当前房间直接闪烁，跨房间先导航再消费一次性目标。
 *
 * 跨房目标只保存在 ref 中，等新房间 ready 后重新请求锚点窗口；不缓存
 * 旧房间游标，也不在失败时泄露目标房间是否存在。
 */
export function useChatSearchNavigation({
  roomId,
  token,
  humanTimeline,
  ready,
  roomStatus,
  searchOpen,
  setSearchOpen,
  setStatus,
  forcePin,
}: {
  roomId: string;
  token: string;
  humanTimeline: boolean;
  ready: boolean;
  roomStatus: 'loading' | 'ready' | 'error';
  searchOpen: boolean;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setStatus: (message: string) => void;
  forcePin: () => void;
}) {
  const navigation = useMessageSearchNavigation({ roomId, token, humanTimeline });
  const pendingRef = useRef<SearchNavigationTarget | null>(null);
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  const locate = useCallback(
    async (target: SearchNavigationTarget): Promise<LocateResult> => {
      if (target.room_id !== roomIdRef.current) {
        pendingRef.current = target;
        setSearchOpen(false);
        setStatus('正在切换到目标会话…');
        navigate(`/c/${encodeURIComponent(target.room_id)}`);
        return { ok: true };
      }
      // 当前会话且消息已渲染：直接滚动闪烁；全局搜索强制使用锚点窗口。
      if (target.scope !== 'all' && renderedMessage(target.message_id)) {
        navigation.flashMessage(target);
        setSearchOpen(false);
        return { ok: true };
      }
      const ok = await navigation.openAnchor(target);
      if (ok) {
        setSearchOpen(false);
        return { ok: true };
      }
      return { ok: false, error: '消息当前不可见，请重新搜索' };
    },
    [navigation, setSearchOpen, setStatus],
  );

  // 跨房目标在房间 ready 后只消费一次；失败、切到别的房间或房间加载失败
  // 都清空目标，避免晚到的旧目标在新房间再次触发定位。
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.room_id !== roomId) {
      pendingRef.current = null;
      return;
    }
    if (!ready) {
      if (roomStatus === 'error') {
        pendingRef.current = null;
        setStatus('消息当前不可见，请重新搜索');
      }
      return;
    }
    pendingRef.current = null;
    setStatus('正在定位消息…');
    void navigation.openAnchor(pending).then((ok) => {
      setStatus(ok ? '' : '消息当前不可见，请重新搜索');
    });
  }, [navigation, ready, roomId, roomStatus, setStatus]);

  const returnLatest = useCallback(() => {
    navigation.clear();
    forcePin();
  }, [forcePin, navigation]);

  // 搜索弹窗已关闭的历史窗口：Esc 返回最新；弹窗、全屏预览或输入中不接管。
  useEffect(() => {
    if (navigation.state.status !== 'anchored') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (dialogOpen()) return;
      if (document.body.classList.contains('file-preview-fullscreen-open')) return;
      if (editableTarget(event.target)) return;
      event.preventDefault();
      returnLatest();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navigation.state.status, returnLatest]);

  // 会话就绪时 Ctrl/Cmd+F 打开搜索；搜索已打开时由弹窗聚焦并全选。
  useEffect(() => {
    if (!ready || searchOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      if (dialogOpen() || editableTarget(event.target)) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ready, searchOpen, setSearchOpen]);

  return { navigation, locate, returnLatest };
}
