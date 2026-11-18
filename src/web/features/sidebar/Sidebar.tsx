import { Tooltip } from '../../app/lenso-tooltip';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  LENSO_BADGE_FILL,
  LENSO_SKELETON_FILL,
  SearchInput,
  Separator,
  SegmentedControl,
  Skeleton,
  Toolbar,
} from '../../app/lenso-controls';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Link } from '../../app/router';
import type { RoomPreferenceMap } from '../../lib/room-preferences';
import type { WebIdentity } from '../../lib/identity';
import {
  roomFilterEmptyMessage,
  type RoomFilter,
  type RoomSummary,
} from '../../lib/rooms';
import { ContactRequestsButton } from './ContactRequestsButton';
import { LoggedOutStart } from './LoggedOutStart';
import { RoomRow } from './RoomRow';
import { SidebarAccount } from './SidebarAccount';

export type SidebarStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | 'logged-out'
  | 'credential-invalid';

interface SidebarProps {
  me: WebIdentity | null;
  rooms: RoomSummary[];
  status: SidebarStatus;
  error: string | null;
  query: string;
  filter: RoomFilter;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  streamError: string | null;
  preferences?: RoomPreferenceMap;
  unreadCounts?: Record<RoomFilter, number>;
  notice?: { message: string; error: boolean } | null;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: RoomFilter) => void;
  onCreateGroup: () => void;
  onOpenContacts: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onActionStatus?: (message: string) => void;
}

const FILTERS: { value: RoomFilter; label: string }[] = [
  { value: 'friend', label: '好友' },
  { value: 'agent', label: 'Agent' },
  { value: 'group', label: '群聊' },
];

const EMPTY_UNREAD_COUNTS: Record<RoomFilter, number> = { friend: 0, agent: 0, group: 0 };

/**
 * 44px 命中区只负责把焦点交给真实输入框。
 * pointer/mouse 的默认焦点迁移会把 activeElement 打回 body，必须一并阻止。
 */
function focusSearchHit(event: {
  button: number;
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  if (event.button !== 0) return;
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('input, button, a[href], [tabindex]')) return;
  event.preventDefault();
  document.getElementById('room-search')?.focus();
}

function statusMessage(props: SidebarProps): string {
  const { status, rooms, query, filter, error } = props;
  if (status === 'logged-out') return roomFilterEmptyMessage(filter, true);
  if (status === 'credential-invalid') return roomFilterEmptyMessage(filter, false, true);
  if (status === 'loading' && rooms.length === 0) return '正在读取…';
  if (query.trim() && rooms.length === 0) return '没有匹配的会话';
  if (status === 'error' && rooms.length === 0) return error ?? '读取会话失败';
  if (rooms.length === 0) return roomFilterEmptyMessage(filter);
  if (status === 'error') return error ?? '';
  return '';
}

/** 左侧栏：品牌、搜索、分类、会话列表与账号区块。 */
export function Sidebar(props: SidebarProps) {
  const {
    me,
    rooms,
    status,
    query,
    filter,
    hasMore,
    loadingMore,
    loadMoreError,
    streamError,
    preferences = {},
    unreadCounts = EMPTY_UNREAD_COUNTS,
    notice = null,
    onQueryChange,
    onFilterChange,
    onCreateGroup,
    onOpenContacts,
    onRetry,
    onLoadMore,
    onActionStatus,
  } = props;
  const message = statusMessage(props);
  const skeleton = status === 'loading' && rooms.length === 0;
  const moreVisible = loadingMore || loadMoreError !== null || hasMore;
  const showRetry = status === 'error' && rooms.length === 0;
  const filterLabel = FILTERS.find((entry) => entry.value === filter)?.label ?? '好友';

  // 防抖后只播报变化后的汇总，避免消息连续到达时反复打断读屏。
  const [filterAnnouncement, setFilterAnnouncement] = useState('');
  const announcedCounts = useRef('');
  useEffect(() => {
    const parts = FILTERS.filter((entry) => unreadCounts[entry.value] > 0).map(
      (entry) => `${entry.label} ${unreadCounts[entry.value]} 个会话未读`,
    );
    const next = parts.join('，');
    if (next === announcedCounts.current) return undefined;
    const timer = window.setTimeout(() => {
      announcedCounts.current = next;
      setFilterAnnouncement(next);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [unreadCounts]);

  // 组合输入期间吞掉 keydown，避免 Lenso SearchField 的 Escape 清空候选词。
  // type=search 的 Chromium 原生 Escape 清空发生在默认动作阶段，必须同时
  // preventDefault；组合结束后普通 Escape 仍由 SearchField/调用方清空。
  const detachSearchKeys = useRef<(() => void) | null>(null);
  const searchComposing = useRef(false);
  const searchRef = useCallback((node: HTMLInputElement | null) => {
    detachSearchKeys.current?.();
    detachSearchKeys.current = null;
    if (!node) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!event.isComposing && event.keyCode !== 229 && !searchComposing.current) return;
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
    };
    node.addEventListener('keydown', onKeyDownCapture, true);
    detachSearchKeys.current = () => {
      node.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, []);
  useEffect(
    () => () => {
      detachSearchKeys.current?.();
      searchComposing.current = false;
    },
    [],
  );

  return (
    <aside className="sidebar" aria-label="会话列表">
      <header className="sidebar-head">
        <div className="brand-row">
          <Toolbar aria-label="品牌与会话操作" style={{ display: 'contents' }}>
            <h1>WeBots</h1>
            <ContactRequestsButton onOpen={onOpenContacts} />
            <Tooltip as={Button}
              className="icon-btn"
              id="new-group"
              type="button"
              aria-label="新建群聊"
              hint="新建群聊"
              onClick={onCreateGroup}
            >
              +
            </Tooltip>
          </Toolbar>
        </div>
        {/* 视觉 32px、命中区 44px：外层补足上下可点击高度。 */}
        <div
          className="search-box"
          onPointerDown={focusSearchHit}
          onMouseDown={focusSearchHit}
        >
          <SearchInput
            ref={searchRef}
            id="room-search"
            placeholder="搜索"
            autoComplete="off"
            aria-label="搜索会话"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onCompositionStart={() => {
              searchComposing.current = true;
            }}
            onCompositionEnd={() => {
              searchComposing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !query) return;
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              onQueryChange('');
            }}
          />
        </div>
        <div className="room-filter" id="room-filter">
          <SegmentedControl
            aria-label="会话类型"
            value={filter}
            onValueChange={(value) => {
              if (value === 'friend' || value === 'agent' || value === 'group') onFilterChange(value);
            }}
            items={FILTERS.map((entry) => {
              const count = unreadCounts[entry.value];
              return {
                value: entry.value,
                label: (
                  <span id={`room-filter-${entry.value}`} data-room-filter={entry.value}>
                    {entry.label}
                    {count > 0 ? (
                      <Tooltip as="span"
                        className="room-filter-unread"
                        aria-hidden="true"
                        hint={`${count} 个会话有未读消息`}
                      >
                        <Badge placement="" style={LENSO_BADGE_FILL}>
                          {count > 99 ? '99+' : count}
                        </Badge>
                      </Tooltip>
                    ) : null}
                  </span>
                ),
              };
            })}
          />
        </div>
        <p
          id="room-filter-unread-status"
          className="visually-hidden"
          aria-live="polite"
          aria-atomic="true"
        >
          {filterAnnouncement}
        </p>
        {notice ? (
          <Alert
            id="contact-link-banner"
            className="contact-link-banner"
            role="status"
            aria-live="polite"
            status={notice.error ? 'danger' : 'default'}
            data-error={notice.error ? '1' : undefined}
          >
            {notice.message}
          </Alert>
        ) : null}
      </header>
      <div className="sidebar-list">
        <ol id="room-list" className="room-list" aria-label={filterLabel}>
          {skeleton
            ? Array.from({ length: 5 }, (_, index) => (
                <li key={index} className="room-skeleton" aria-hidden="true">
                  <span className="skeleton-avatar">
                    <Skeleton style={LENSO_SKELETON_FILL} />
                  </span>
                  <span className="skeleton-lines">
                    <Skeleton />
                    <Skeleton />
                  </span>
                </li>
              ))
            : rooms.map((room) => (
                <RoomRow
                  key={room.room_id}
                  room={room}
                  preferences={preferences}
                  onStatus={onActionStatus}
                />
              ))}
        </ol>
        <div id="room-list-status" className="list-hint" role="status" hidden={!message}>
          <EmptyState
            style={{
              padding: 0,
              color: 'inherit',
              fontSize: 'inherit',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </EmptyState>
        </div>
        {status === 'logged-out' ? <LoggedOutStart /> : null}
        {showRetry ? (
          <Button id="room-list-retry" className="list-retry" type="button" onClick={onRetry}>
            重试
          </Button>
        ) : null}
        {status === 'credential-invalid' ? (
          <Link id="credential-invalid-pair" className="list-retry" to="/pair">
            用另一台设备配对
          </Link>
        ) : null}
        {moreVisible ? (
          <Button
            id="room-list-more"
            className="list-retry"
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore
              ? '正在加载更多…'
              : loadMoreError
                ? '加载更多失败，点击重试'
                : '加载更多会话'}
          </Button>
        ) : null}
      </div>
      <footer className="sidebar-foot">
        <Separator
          className="sidebar-foot-rule"
          style={{
            position: 'absolute',
            top: -1,
            left: 0,
            right: 0,
            width: 'auto',
            margin: 0,
            background: 'var(--wx-line)',
          }}
        />
        {streamError ? (
          <Tooltip as="span"
            id="stream-dot"
            className="stream-dot"
            role="status"
            hint={streamError}
            aria-label={streamError}
            data-state={streamError.startsWith('实时连接已停止') ? 'stopped' : undefined}
          />
        ) : null}
        <SidebarAccount me={me} />
      </footer>
    </aside>
  );
}
