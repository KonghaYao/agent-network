/**
 * 我的看板浮窗：固定标题区、桌面三列、手机三栏、右侧详情与快速跳转。
 *
 * 浮窗覆盖当前聊天但不卸载 ChatPage；收起只改变本机显示。归档是唯一写操作，
 * 确认后失效 `['focus']` 并由 React Query 重读列与计数。
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRooms } from '../../hooks/useRooms';
import { useWebSession } from '../../hooks/useWebSession';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { callTool } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { confirmDialog } from '../overlays/confirm';
import { Modal } from '../overlays/Modal';
import type { MessageSearchHit } from '../search/message-search-types';
import { FocusCard } from './FocusCard';
import { FocusDetail } from './FocusDetail';
import { FocusLanes, FocusSkeleton } from './FocusLanes';
import { FocusQuickJump } from './FocusQuickJump';
import {
  closeFocusBoard,
  closeFocusItem,
  closeFocusQuick,
  jumpFromBoard,
  openFocusBoard,
  openFocusItem,
  openFocusQuick,
  setFocusColumn,
  setFocusTab,
  showFocusNotice,
  useFocusView,
} from './focus-store';
import {
  archiveFocusItem,
  enableFocus,
  useFocusDetail,
  useFocusItems,
  useFocusStatus,
} from './focus-queries';
import {
  FOCUS_COLUMNS,
  type FocusColumnKey,
  type FocusDetailData,
  type FocusEvidence,
  type FocusItem,
} from './focus-types';

const PREPARING_TIMEOUT_MS = 15_000;

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent);
}

function genericError(): string {
  return '看板暂时打不开，请稍后重试。';
}

function emptyHint(): string {
  return '秘书还没有整理出需要你处理的事';
}

export function FocusBoard() {
  const { session } = useWebSession();
  const me = session?.identity ?? null;
  const token = session?.token ?? null;
  const actorId = me?.kind === 'human' ? me.actor_id : null;
  const queryClient = useQueryClient();
  const view = useFocusView();
  const desktop = useMediaQuery('(min-width: 760px)');
  const rooms = useRooms(Boolean(token));
  const status = useFocusStatus(actorId, token, { poll: true });
  const [enabling, setEnabling] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [preparingTimedOut, setPreparingTimedOut] = useState(false);
  const laneRefs = useRef<Partial<Record<FocusColumnKey, HTMLDivElement | null>>>({});
  const restoredKey = useRef('');

  const binding = status.data;
  const active = binding?.status === 'active';
  const currentList = useFocusItems({
    actorId,
    token,
    archived: false,
    query: '',
    enabled: view.open && active && view.tab === 'current',
  });
  const archivedList = useFocusItems({
    actorId,
    token,
    archived: true,
    query: '',
    enabled: view.open && active && view.tab === 'archived',
  });
  const detail = useFocusDetail(actorId, token, view.selectedItemId, view.open && active);

  useEffect(() => {
    if (binding?.status !== 'provisioning') {
      setPreparingTimedOut(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setPreparingTimedOut(true), PREPARING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [binding?.status]);

  // Esc 优先收起快速跳转，再收起详情；最后一层交给 Modal 关整窗。
  useEffect(() => {
    if (!view.open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      if (view.quickOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeFocusQuick();
        return;
      }
      if (view.selectedItemId) {
        event.preventDefault();
        event.stopPropagation();
        closeFocusItem();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [view.open, view.quickOpen, view.selectedItemId]);

  // 打开、切 tab 或切列时恢复该列断点；SSE 刷新不打断用户当前滚动。
  useEffect(() => {
    if (!view.open || view.tab !== 'current') return;
    if (view.selectedItemId && !desktop) return;
    const key = `${view.open}:${view.tab}:${view.column}:${desktop}:${currentList.isSuccess}`;
    if (restoredKey.current === key) return;
    restoredKey.current = key;
    const frame = requestAnimationFrame(() => {
      for (const column of FOCUS_COLUMNS) {
        const node = laneRefs.current[column.key];
        if (node) node.scrollTop = view.scrollTops[column.key] ?? 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    currentList.isSuccess,
    desktop,
    view.column,
    view.open,
    view.scrollTops,
    view.selectedItemId,
    view.tab,
  ]);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.focus() }),
    [queryClient],
  );

  const roomName = useCallback(
    (roomId: string | undefined) => {
      if (!roomId) return '原会话';
      return rooms.rooms.find((room) => room.room_id === roomId)?.name ?? '原会话';
    },
    [rooms.rooms],
  );

  const openEnable = async () => {
    if (!token || enabling) return;
    setEnabling(true);
    try {
      await enableFocus(token);
      await invalidate();
      openFocusBoard();
    } catch {
      showFocusNotice('暂时无法开启任务秘书，请稍后重试。', true);
      openFocusBoard();
    } finally {
      setEnabling(false);
    }
  };

  const loadDetailForJump = async (item: FocusItem): Promise<FocusDetailData | null> => {
    if (!token || !actorId) return null;
    try {
      return await queryClient.fetchQuery({
        queryKey: queryKeys.focusItem(actorId, item.item_id),
        queryFn: () =>
          callTool<FocusDetailData>(
            'network_focus_get',
            { item_id: item.item_id },
            { token },
          ),
        staleTime: 5_000,
      });
    } catch {
      return null;
    }
  };

  const jumpToEvidence = (evidence: FocusEvidence, query = '') => {
    if (!evidence.readable || !evidence.room_id || !evidence.message_id) {
      showFocusNotice('这条原消息当前不可见。', true);
      return;
    }
    jumpFromBoard({
      room_id: evidence.room_id,
      message_id: evidence.message_id,
      query,
      mode: 'exact',
      scope: 'room',
    });
  };

  const jumpFromCard = async (item: FocusItem) => {
    setArchivingId(item.item_id);
    try {
      const data = await loadDetailForJump(item);
      const evidence = data
        ? [...data.evidence].reverse().find(
            (entry) => entry.readable && entry.room_id && entry.message_id,
          )
        : undefined;
      if (!evidence) {
        showFocusNotice('这张卡暂时没有可见的原消息。', true);
        return;
      }
      jumpToEvidence(evidence);
    } finally {
      setArchivingId(null);
    }
  };

  const askArchive = async (item: FocusItem) => {
    if (!token) return;
    const ok = await confirmDialog({
      title: '归档这个事项？',
      message: `「${item.title || '这个事项'}」会从三列移出，仍可在「已归档」查看。`,
      confirmText: '归档',
      cancelText: '取消',
    });
    if (!ok) return;
    setArchivingId(item.item_id);
    try {
      await archiveFocusItem(token, item);
      closeFocusItem();
      await invalidate();
      showFocusNotice(`已归档「${item.title || '这个事项'}」`);
    } catch {
      showFocusNotice('归档没有完成，请重试。', true);
    } finally {
      setArchivingId(null);
    }
  };

  const openFromQuick = (item: FocusItem) => {
    setFocusTab(item.archived_at ? 'archived' : 'current');
    openFocusItem(item.item_id);
    closeFocusQuick();
  };

  const jumpFromQuick = (hit: MessageSearchHit, query: string) => {
    jumpFromBoard(
      {
        room_id: hit.room_id,
        message_id: hit.message_id,
        query,
        mode: 'exact',
        scope: 'room',
      },
      'quick',
    );
  };

  const counts = binding?.counts;
  const needsCount = counts?.needs_me ?? 0;
  const currentCount =
    binding !== undefined ? counts!.needs_me + counts!.tracking + counts!.done : undefined;
  const archivedCount = counts?.archived;
  const currentItems = currentList.data?.items ?? [];

  const loadingBoard = status.isLoading || (active && currentList.isLoading && !currentList.data);
  const listError = active && currentList.isError && !currentList.data;
  const archivedError = active && archivedList.isError && !archivedList.data;
  const detailError = Boolean(detail.error) && !detail.data;
  const showDetailPanel = Boolean(view.selectedItemId);

  const detailNode = showDetailPanel ? (
    <FocusDetail
      detail={detail.data}
      loading={detail.isLoading}
      error={detailError ? genericError() : null}
      archived={view.tab === 'archived' || Boolean(detail.data?.item.archived_at)}
      busy={archivingId === view.selectedItemId}
      token={token ?? ''}
      roomName={roomName}
      onRetry={() => void detail.refetch()}
      onClose={closeFocusItem}
      onJump={(evidence) => jumpToEvidence(evidence)}
      onArchive={(item) => void askArchive(item)}
    />
  ) : null;

  const lanes = (
    <FocusLanes
      items={currentItems}
      counts={counts}
      column={view.column}
      desktop={desktop}
      archivingId={archivingId}
      laneRef={(key, node) => {
        laneRefs.current[key] = node;
      }}
      onOpen={(item) => openFocusItem(item.item_id)}
      onJump={(item) => void jumpFromCard(item)}
      onArchive={(item) => void askArchive(item)}
    />
  );

  const archivedGrid = (
    <div className="focus-archive-grid">
      {(archivedList.data?.items ?? []).map((item) => (
        <FocusCard
          key={item.item_id}
          item={item}
          archived
          busy={archivingId === item.item_id}
          onOpen={() => openFocusItem(item.item_id)}
          onJump={() => void jumpFromCard(item)}
          onArchive={() => void askArchive(item)}
        />
      ))}
    </div>
  );

  const skeleton = <FocusSkeleton />;

  const preparing = binding?.status === 'provisioning' && view.open;
  const body = (() => {
    if (preparing) {
      if (preparingTimedOut) {
        return (
          <div className="focus-state" role="status">
            <p>秘书暂不可用，稍后重试。</p>
            <button
              type="button"
              className="focus-retry"
              onClick={() => {
                setPreparingTimedOut(false);
                void status.refetch();
              }}
            >
              重试
            </button>
          </div>
        );
      }
      return (
        <div className="focus-state" role="status">
          <p>秘书正在准备你的看板</p>
          <p className="focus-state-hint">稍等片刻，整理结果会自己出现。</p>
        </div>
      );
    }
    if (status.isError && !binding) {
      return (
        <div className="focus-state" role="status">
          <p>{genericError()}</p>
          <button type="button" className="focus-retry" onClick={() => void status.refetch()}>
            重试
          </button>
        </div>
      );
    }
    if (!binding || binding.status === 'disabled') {
      return (
        <div className="focus-state" role="status">
          <p>开启后，秘书会在这里整理你需要处理的事。</p>
          <button
            type="button"
            className="focus-enable-button"
            disabled={enabling}
            onClick={() => void openEnable()}
          >
            {enabling ? '正在开启…' : '开启任务秘书'}
          </button>
        </div>
      );
    }
    if (binding.status === 'paused' || binding.status === 'failed') {
      return (
        <div className="focus-state" role="status">
          <p>秘书暂不可用，稍后重试。</p>
          <button
            type="button"
            className="focus-retry"
            disabled={enabling}
            onClick={() => void openEnable()}
          >
            重试
          </button>
        </div>
      );
    }
    if (loadingBoard) return skeleton;
    if (listError) {
      return (
        <div className="focus-state" role="status">
          <p>{genericError()}</p>
          <button type="button" className="focus-retry" onClick={() => void currentList.refetch()}>
            重试
          </button>
        </div>
      );
    }
    if (view.tab === 'archived') {
      if (archivedError) {
        return (
          <div className="focus-state" role="status">
            <p>{genericError()}</p>
            <button
              type="button"
              className="focus-retry"
              onClick={() => void archivedList.refetch()}
            >
              重试
            </button>
          </div>
        );
      }
      if (archivedList.isLoading && !archivedList.data) return skeleton;
      const items = archivedList.data?.items ?? [];
      return items.length > 0 ? (
        archivedGrid
      ) : (
        <div className="focus-state">
          <p>还没有归档的事项</p>
        </div>
      );
    }
    const items = currentList.data?.items ?? [];
    if (items.length === 0) {
      return (
        <div className="focus-state">
          <p>{emptyHint()}</p>
        </div>
      );
    }
    return lanes;
  })();

  return (
    <Modal
      open={view.open}
      onOpenChange={(open) => {
        if (open) openFocusBoard();
        else closeFocusBoard();
      }}
      title="我的看板"
      titleId="focus-board-title"
      contentId="focus-board"
      className="focus-board-card"
      headerActions={
        <div className="focus-board-actions">
          <button
            type="button"
            id="focus-quick-trigger"
            className="focus-quick-trigger"
            aria-expanded={view.quickOpen}
            aria-keyshortcuts="Meta+K Control+K"
            onClick={openFocusQuick}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" />
            </svg>
            快速跳转
            <kbd>{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        </div>
      }
    >
      <div className="focus-board">
        <p className="focus-board-sub">
          {me?.name ?? '我'}的任务秘书 · {needsCount} 件需要我
        </p>
        <div className="focus-tabs" role="tablist" aria-label="看板范围">
          <button
            type="button"
            role="tab"
            aria-selected={view.tab === 'current'}
            className={view.tab === 'current' ? 'is-active' : undefined}
            onClick={() => setFocusTab('current')}
          >
            当前事项 <b>{currentCount ?? 0}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view.tab === 'archived'}
            className={view.tab === 'archived' ? 'is-active' : undefined}
            onClick={() => setFocusTab('archived')}
          >
            已归档 <b>{archivedCount ?? 0}</b>
          </button>
        </div>
        {!desktop && view.tab === 'current' && !showDetailPanel ? (
          <div className="focus-mobile-tabs" role="tablist" aria-label="事项栏目">
            {FOCUS_COLUMNS.map((column) => (
              <button
                key={column.key}
                type="button"
                role="tab"
                data-lane={column.key}
                aria-selected={view.column === column.key}
                className={view.column === column.key ? 'is-active' : undefined}
                onClick={() => setFocusColumn(column.key)}
              >
                {column.label}
                <b>
                  {counts?.[column.key] ??
                    currentItems.filter((item) => item.column_key === column.key).length}
                </b>
              </button>
            ))}
          </div>
        ) : null}

        <div
          className={`focus-board-work${showDetailPanel && desktop ? ' has-detail' : ''}`}
        >
          {showDetailPanel && !desktop ? (
            detailNode
          ) : (
            <>
              <div className="focus-board-main">{body}</div>
              {showDetailPanel && desktop ? detailNode : null}
            </>
          )}
        </div>

        <p
          className={`focus-notice${view.notice?.error ? ' is-error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {view.notice?.text ?? ''}
        </p>

        {view.quickOpen && token ? (
          <FocusQuickJump
            token={token}
            onOpenItem={openFromQuick}
            onJumpMessage={jumpFromQuick}
          />
        ) : null}
      </div>
    </Modal>
  );
}
