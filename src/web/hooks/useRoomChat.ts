import { useCallback, useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../contracts/limits';
import { useActorStream } from '../app/mcp/useActorStream';
import {
  mergeTimelineItems,
  nextOlderCursor,
  reverseChronological,
  type HistoryItem,
  type HistoryPage,
  type RoomDetail,
} from '../lib/chat';
import { ensureWebSession, type WebSession } from '../lib/identity';
import { callTool, type McpError } from '../lib/mcp-client';

/**
 * 房间会话状态：metadata、成员、历史、实时刷新与已读。
 *
 * 只发 `network_room_get` / `network_history_list` / `network_room_mark_read`；
 * 发送、附件和 outbox 由独立 hook 负责。历史页与首页列表共用同一套
 * `agentnet://stream` 单连接，不轮询。
 */

export interface RoomChatState {
  status: 'loading' | 'ready' | 'error';
  session: WebSession | null;
  detail: RoomDetail | null;
  items: HistoryItem[];
  error: string | null;
  refreshError: string | null;
  olderError: string | null;
  olderLoading: boolean;
  olderEnded: boolean;
  hasOlder: boolean;
}

const INITIAL: RoomChatState = {
  status: 'loading',
  session: null,
  detail: null,
  items: [],
  error: null,
  refreshError: null,
  olderError: null,
  olderLoading: false,
  olderEnded: false,
  hasOlder: false,
};

interface LoadResult {
  session: WebSession;
  detail: RoomDetail;
  page: HistoryPage;
}

function failureMessage(error: unknown): string {
  const failure = error as McpError;
  return failure.message || '读取会话失败';
}

function historyArgs(roomId: string, humanTimeline: boolean, cursor?: string | null) {
  const args: Record<string, unknown> = {
    room_id: roomId,
    direction: 'before',
    limit: LIMITS.historyPageDefault,
  };
  if (cursor) args.cursor = cursor;
  if (humanTimeline) args.view = 'timeline';
  return args;
}

/**
 * 最新页与已加载页之间可能隔着多页消息。按 `timeline_resume_cursor` 补读，
 * 直到追到本轮 snapshot，避免离线/后台标签页一次收到大量事件时漏消息。
 */
async function catchUpTimeline(
  token: string,
  roomId: string,
  snapshot: string,
  resumeCursor: string,
  latest: HistoryItem[],
  signal: AbortSignal,
): Promise<HistoryItem[]> {
  let target: bigint;
  try {
    target = BigInt(snapshot);
  } catch {
    return latest;
  }
  let merged = latest.slice();
  let cursor = resumeCursor;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await callTool<HistoryPage>(
      'network_history_list',
      { room_id: roomId, view: 'timeline', direction: 'after', cursor, limit: LIMITS.historyPageMax },
      { token, signal },
    );
    const items = page.timeline_items ?? [];
    merged = mergeTimelineItems(merged, items);
    const last = items[items.length - 1];
    const reached =
      last !== undefined &&
      BigInt(last.kind === 'presence' ? last.timeline_seq : last.created_seq) >= target;
    if (!page.timeline_has_more || reached) return merged;
    if (!page.timeline_next_cursor || page.timeline_next_cursor === cursor) return merged;
    cursor = page.timeline_next_cursor;
  }
  return merged;
}

export function useRoomChat(roomId: string) {
  const [state, setState] = useState<RoomChatState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  const mountedRef = useRef(true);
  const sessionRef = useRef<WebSession | null>(null);
  const itemsRef = useRef<HistoryItem[]>([]);
  const nextOlderRef = useRef<string | null>(null);
  const olderEndedRef = useRef(false);
  const olderLoadingRef = useRef(false);
  const loadedOlderRef = useRef(false);
  const lastMarkedRef = useRef<string | null>(null);
  const resumeCursorRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const queuedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epochRef = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const applyDetail = useCallback((detail: RoomDetail) => {
    setState((previous) => ({ ...previous, detail }));
  }, []);

  const fetchSessionPage = useCallback(
    async (session: WebSession, signal: AbortSignal): Promise<{ detail: RoomDetail; page: HistoryPage }> => {
      const humanTimeline = session.identity.kind === 'human';
      const [detail, page] = await Promise.all([
        callTool<RoomDetail>('network_room_get', { room_id: roomId }, { token: session.token, signal }),
        callTool<HistoryPage>(
          'network_history_list',
          historyArgs(roomId, humanTimeline),
          { token: session.token, signal },
        ),
      ]);
      return { detail, page };
    },
    [roomId],
  );

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const epoch = ++epochRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((previous) => ({ ...previous, status: 'loading', error: null }));

    try {
      const session = await ensureWebSession();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      sessionRef.current = session;
      const { detail, page } = await fetchSessionPage(session, controller.signal);
      if (!mountedRef.current || epoch !== epochRef.current) return;

      const items = reverseChronological(page, session.identity.kind === 'human');
      itemsRef.current = items;
      nextOlderRef.current = nextOlderCursor(page, session.identity.kind === 'human');
      olderEndedRef.current = nextOlderRef.current === null;
      resumeCursorRef.current = page.timeline_resume_cursor ?? null;
      loadedOlderRef.current = false;
      olderLoadingRef.current = false;
      setState({
        status: 'ready',
        session,
        detail,
        items,
        error: null,
        refreshError: null,
        olderError: null,
        olderLoading: false,
        olderEnded: olderEndedRef.current,
        hasOlder: nextOlderRef.current !== null,
      });
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted || epoch !== epochRef.current) return;
      setState((previous) => ({
        ...previous,
        status: 'error',
        error: failureMessage(error),
      }));
    }
  }, [fetchSessionPage]);

  loadRef.current = load;

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      abortRef.current?.abort();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [load]);

  const refresh = useCallback((): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (inFlightRef.current) {
      queuedRef.current = true;
      return inFlightRef.current;
    }
    const session = sessionRef.current;
    if (!session) return loadRef.current();

    const run = (async () => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      try {
        const { detail, page } = await fetchSessionPage(session, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        const humanTimeline = session.identity.kind === 'human';
        let incoming = reverseChronological(page, humanTimeline);
        if (
          humanTimeline &&
          page.timeline_resume_cursor &&
          resumeCursorRef.current &&
          page.timeline_resume_cursor !== resumeCursorRef.current &&
          page.timeline_snapshot
        ) {
          incoming = await catchUpTimeline(
            session.token,
            roomId,
            page.timeline_snapshot,
            resumeCursorRef.current,
            incoming,
            controller.signal,
          );
        }
        if (!mountedRef.current || controller.signal.aborted) return;
        resumeCursorRef.current = page.timeline_resume_cursor ?? resumeCursorRef.current;
        const merged = stateRef.current.items.length
          ? mergeTimelineItems(stateRef.current.items, incoming)
          : incoming;
        itemsRef.current = merged;
        if (olderEndedRef.current) {
          nextOlderRef.current = null;
        } else if (!loadedOlderRef.current || nextOlderRef.current === null) {
          nextOlderRef.current = nextOlderCursor(page, humanTimeline);
          olderEndedRef.current = nextOlderRef.current === null;
        }
        setState((previous) => ({
          ...previous,
          status: 'ready',
          session,
          detail,
          items: merged,
          error: null,
          refreshError: null,
          olderEnded: olderEndedRef.current,
          hasOlder: nextOlderRef.current !== null,
        }));
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted) return;
        const failure = error as McpError;
        if (failure.code === 'CREDENTIAL_INVALID' || failure.code === 'LOGGED_OUT') {
          sessionRef.current = null;
          setState((previous) => ({ ...previous, status: 'error', error: failureMessage(error) }));
          return;
        }
        setState((previous) => ({ ...previous, refreshError: failureMessage(error) }));
      }
    })();

    inFlightRef.current = run;
    void run.then(() => {
      if (inFlightRef.current !== run) return;
      inFlightRef.current = null;
      if (!queuedRef.current) return;
      queuedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) void refresh();
      });
    });
    return run;
  }, [fetchSessionPage]);

  /** SSE 只给“某处变了”的提示；300ms 合并后重新读取权威状态。 */
  const scheduleRefresh = useCallback(() => {
    if (!mountedRef.current) return;
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, LIMITS.webRefreshDebounceMs);
  }, [refresh]);

  const stream = useActorStream({
    token: state.session?.token ?? null,
    onEvent: scheduleRefresh,
  });

  const loadOlder = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    const cursor = nextOlderRef.current;
    if (!session || !cursor || olderLoadingRef.current || olderEndedRef.current) return;
    olderLoadingRef.current = true;
    setState((previous) => ({ ...previous, olderLoading: true, olderError: null }));
    try {
      const humanTimeline = session.identity.kind === 'human';
      const page = await callTool<HistoryPage>(
        'network_history_list',
        historyArgs(roomId, humanTimeline, cursor),
        { token: session.token },
      );
      const incoming = reverseChronological(page, humanTimeline);
      const merged = mergeTimelineItems(stateRef.current.items, incoming);
      const next = nextOlderCursor(page, humanTimeline);
      loadedOlderRef.current = true;
      nextOlderRef.current = next && next !== cursor ? next : null;
      olderEndedRef.current = nextOlderRef.current === null;
      itemsRef.current = merged;
      setState((previous) => ({
        ...previous,
        items: merged,
        olderLoading: false,
        olderError: null,
        olderEnded: olderEndedRef.current,
        hasOlder: nextOlderRef.current !== null,
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      setState((previous) => ({
        ...previous,
        olderLoading: false,
        olderError: `加载更早失败：${failureMessage(error)}`,
      }));
    } finally {
      olderLoadingRef.current = false;
    }
  }, [roomId]);

  const markRead = useCallback(async (throughSeq: string): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !throughSeq) return;
    if (lastMarkedRef.current === throughSeq) return;
    lastMarkedRef.current = throughSeq;
    try {
      await callTool(
        'network_room_mark_read',
        { room_id: roomId, through_seq: throughSeq },
        { token: session.token },
      );
      if (!mountedRef.current) return;
      setState((previous) => {
        if (!previous.detail) return previous;
        return {
          ...previous,
          detail: {
            ...previous.detail,
            room: { ...previous.detail.room, my_last_read_seq: throughSeq },
          },
        };
      });
    } catch {
      // 已读失败不影响聊天；保留未读，下一次滚到底或刷新再重试。
      if (lastMarkedRef.current === throughSeq) lastMarkedRef.current = null;
    }
  }, [roomId]);

  return {
    ...state,
    streamError: stream.error,
    load,
    refresh,
    loadOlder,
    markRead,
    applyDetail,
  };
}
