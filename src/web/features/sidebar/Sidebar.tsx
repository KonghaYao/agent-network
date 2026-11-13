import type { WebIdentity } from '../../lib/identity';
import {
  firstChar,
  roomFilterEmptyMessage,
  type RoomFilter,
  type RoomSummary,
} from '../../lib/rooms';
import { AccountMenu } from './AccountMenu';
import { RoomRow } from './RoomRow';

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
  onQueryChange: (value: string) => void;
  onFilterChange: (value: RoomFilter) => void;
  onCreateGroup: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

const FILTERS: { value: RoomFilter; label: string }[] = [
  { value: 'friend', label: '好友' },
  { value: 'agent', label: 'Agent' },
  { value: 'group', label: '群聊' },
];

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
    onQueryChange,
    onFilterChange,
    onCreateGroup,
    onRetry,
    onLoadMore,
  } = props;
  const message = statusMessage(props);
  const skeleton = status === 'loading' && rooms.length === 0;
  const moreVisible = loadingMore || loadMoreError !== null || hasMore;
  const showRetry = status === 'error' && rooms.length === 0;
  const filterLabel = FILTERS.find((entry) => entry.value === filter)?.label ?? '好友';

  return (
    <aside className="sidebar" aria-label="会话列表">
      <header className="sidebar-head">
        <div className="brand-row">
          <h1>WeBots</h1>
          <button
            className="icon-btn"
            id="new-group"
            type="button"
            aria-label="新建群聊"
            title="新建群聊"
            onClick={onCreateGroup}
          >
            +
          </button>
        </div>
        <label className="search-box">
          <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4 4" />
          </svg>
          <input
            id="room-search"
            type="search"
            placeholder="搜索"
            autoComplete="off"
            aria-label="搜索会话"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !query) return;
              onQueryChange('');
            }}
          />
        </label>
        <div
          className="room-filter"
          id="room-filter"
          role="tablist"
          aria-label="会话类型"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = FILTERS.findIndex((entry) => entry.value === filter);
            let next = index;
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = FILTERS.length - 1;
            else if (event.key === 'ArrowLeft') {
              next = (index - 1 + FILTERS.length) % FILTERS.length;
            } else next = (index + 1) % FILTERS.length;
            const target = FILTERS[next];
            if (!target) return;
            onFilterChange(target.value);
            const button = document.getElementById(`room-filter-${target.value}`);
            button?.focus();
          }}
        >
          {FILTERS.map((entry) => {
            const selected = entry.value === filter;
            return (
              <button
                key={entry.value}
                id={`room-filter-${entry.value}`}
                type="button"
                role="tab"
                data-room-filter={entry.value}
                aria-selected={selected}
                aria-controls="room-list"
                tabIndex={selected ? 0 : -1}
                onClick={() => onFilterChange(entry.value)}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </header>
      <div className="sidebar-list">
        <ol id="room-list" className="room-list" aria-label={filterLabel}>
          {skeleton
            ? Array.from({ length: 5 }, (_, index) => (
                <li key={index} className="room-skeleton" aria-hidden="true">
                  <span className="skeleton-avatar" />
                  <span className="skeleton-lines">
                    <span />
                    <span />
                  </span>
                </li>
              ))
            : rooms.map((room) => <RoomRow key={room.room_id} room={room} />)}
        </ol>
        <p id="room-list-status" className="list-hint" role="status" hidden={!message}>
          {message}
        </p>
        {showRetry ? (
          <button id="room-list-retry" className="list-retry" type="button" onClick={onRetry}>
            重试
          </button>
        ) : null}
        {status === 'credential-invalid' ? (
          <a id="credential-invalid-pair" className="list-retry" href="/pair">
            用另一台设备配对
          </a>
        ) : null}
        {moreVisible ? (
          <button
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
          </button>
        ) : null}
      </div>
      <footer className="sidebar-foot">
        {streamError ? (
          <span
            id="stream-dot"
            className="stream-dot"
            role="status"
            title={streamError}
            aria-label={streamError}
            data-state={streamError.startsWith('实时连接已停止') ? 'stopped' : undefined}
          />
        ) : null}
        <div className="account" id="account">
          <span className="account-avatar" id="account-avatar" aria-hidden="true">
            {me ? firstChar(me.name) : '?'}
          </span>
          <div className="account-main">
            <div className="account-name-row">
              <span className="account-name" id="account-name">
                {me ? me.name : '未登录'}
              </span>
              <AccountMenu me={me} />
            </div>
          </div>
        </div>
      </footer>
    </aside>
  );
}
