import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppShell, EmptyPane } from '../app/AppShell';
import { useActorStream } from '../app/mcp/useActorStream';
import { Sidebar, type SidebarStatus } from '../features/sidebar/Sidebar';
import { ensureWebSession, type WebIdentity } from '../lib/identity';
import { callTool, type McpError } from '../lib/mcp-client';
import {
  filterRooms,
  summarizeRoom,
  type RoomFilter,
  type RoomSummary,
  type RoomsPage,
} from '../lib/rooms';
import { readRoomFilter, writeRoomFilter } from '../stores/ui';

interface HomeData {
  status: SidebarStatus;
  me: WebIdentity | null;
  rooms: RoomSummary[];
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
}

const INITIAL: HomeData = {
  status: 'loading',
  me: null,
  rooms: [],
  error: null,
  hasMore: false,
  nextCursor: null,
};

function mergeRooms(current: RoomSummary[], incoming: RoomSummary[]): RoomSummary[] {
  const seen = new Set(current.map((room) => room.room_id));
  const merged = current.slice();
  for (const room of incoming) {
    if (seen.has(room.room_id)) continue;
    seen.add(room.room_id);
    merged.push(room);
  }
  return merged;
}

function failureStatus(error: McpError): SidebarStatus {
  if (error.code === 'LOGGED_OUT') return 'logged-out';
  if (error.code === 'CREDENTIAL_INVALID') return 'credential-invalid';
  return 'error';
}

/**
 * Home：会话列表、搜索、分类与空状态。
 *
 * 只读 `network_me` / `network_rooms_list`；进入聊天仍整页加载 legacy
 * `/c/:id`，不在 4B-1 重写输入、回执或房间生命周期。实时刷新复用现有
 * `agentnet://stream` 订阅，不轮询。
 */
export function HomePage() {
  const [data, setData] = useState<HomeData>(INITIAL);
  const [token, setToken] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RoomFilter>(() => readRoomFilter());
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const queuedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const loadRef = useRef<(silent?: boolean) => Promise<void>>(async () => undefined);

  const load = useCallback((silent = false): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (inFlightRef.current) {
      queuedRef.current = true;
      return inFlightRef.current;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    if (!silent) {
      setData((previous) => ({ ...previous, status: 'loading', error: null }));
    }

    const run = (async () => {
      try {
        const session = await ensureWebSession();
        if (!mountedRef.current || controller.signal.aborted) return;
        setToken(session.token);
        const page = await callTool<RoomsPage>(
          'network_rooms_list',
          { limit: 50 },
          { token: session.token, signal: controller.signal },
        );
        if (!mountedRef.current || controller.signal.aborted) return;
        const incoming = page.items.map(summarizeRoom);
        setData((previous) => {
          // 后台刷新只更新第一页；已翻过的旧页保留，与 legacy 的
          // “有下一页时保留用户翻过的页”一致。服务端确认没有下一页时，
          // 第一页就是全部会话，迟到的旧条目可以安全移除。
          const incomingIds = new Set(incoming.map((room) => room.room_id));
          const rooms = silent && page.has_more
            ? [...incoming, ...previous.rooms.filter((room) => !incomingIds.has(room.room_id))]
            : incoming;
          return {
            status: 'ready',
            me: session.identity,
            rooms,
            error: null,
            hasMore: page.has_more,
            nextCursor: page.next_cursor,
          };
        });
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted) return;
        const failure = error as McpError;
        const status = failureStatus(failure);
        if (status === 'logged-out' || status === 'credential-invalid') {
          setToken(null);
        }
        setData((previous) => ({
          ...previous,
          status:
            status === 'error' && previous.rooms.length > 0 ? 'ready' : status,
          error: failure.message || '读取会话失败',
        }));
      }
    })();

    inFlightRef.current = run;
    void run.then(() => {
      if (inFlightRef.current !== run) return;
      inFlightRef.current = null;
      if (queuedRef.current) {
        queuedRef.current = false;
        queueMicrotask(() => {
          void loadRef.current(true);
        });
      }
    });
    return run;
  }, []);

  loadRef.current = load;

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [load]);

  const stream = useActorStream({
    token,
    onEvent: useCallback(() => {
      void load(true);
    }, [load]),
  });

  const loadMore = useCallback(async () => {
    const cursor = dataRef.current.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const session = await ensureWebSession();
      const page = await callTool<RoomsPage>(
        'network_rooms_list',
        { limit: 50, cursor },
        { token: session.token },
      );
      if (!mountedRef.current) return;
      setData((previous) => ({
        ...previous,
        rooms: mergeRooms(previous.rooms, page.items.map(summarizeRoom)),
        hasMore: page.has_more,
        nextCursor: page.next_cursor,
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      const failure = error as McpError;
      if (failure.code === 'CREDENTIAL_INVALID' || failure.code === 'LOGGED_OUT') {
        const status = failureStatus(failure);
        if (status === 'logged-out' || status === 'credential-invalid') setToken(null);
        setData((previous) => ({
          ...previous,
          status,
          error: failure.message || '读取会话失败',
        }));
      } else {
        setLoadMoreError(failure.message || '加载更多失败');
      }
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [loadingMore]);

  const rooms = useMemo(() => filterRooms(data.rooms, filter, query), [data.rooms, filter, query]);

  const changeFilter = useCallback((value: RoomFilter) => {
    setFilter(value);
    writeRoomFilter(value);
  }, []);

  const empty: { title?: string; hint?: string } =
    data.status === 'logged-out'
      ? {
          title: '已退出登录',
          hint: '打开 Agent 分享链接，或使用已有连接提示词即可继续。',
        }
      : data.status === 'credential-invalid'
        ? {
            title: '凭据已失效',
            hint: '请用另一台已登录设备生成配对码后打开 /pair。',
          }
        : {};

  return (
    <AppShell
      sidebar={
        <Sidebar
          me={data.me}
          rooms={rooms}
          status={data.status}
          error={data.error}
          query={query}
          filter={filter}
          hasMore={data.hasMore && data.nextCursor !== null}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          streamError={stream.error}
          onQueryChange={setQuery}
          onFilterChange={changeFilter}
          onRetry={() => {
            void load(false);
          }}
          onLoadMore={() => {
            void loadMore();
          }}
        />
      }
      main={<EmptyPane title={empty.title} hint={empty.hint} />}
    />
  );
}
