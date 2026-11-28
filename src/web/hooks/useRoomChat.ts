import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { LIMITS } from '../../contracts/limits';
import { useActorStream, type ActorStreamEvent } from '../app/mcp/useActorStream';
import { rememberActorAvatars } from '../lib/actor-avatars';
import {
  mergeTimelineItems,
  nextOlderCursor,
  renderedWatermark,
  reverseChronological,
  type HistoryItem,
  type HistoryPage,
  type RoomDetail,
} from '../lib/chat';
import { catchUpGap, type CatchUpAuthorization, type CatchUpPage } from '../lib/history-recovery';
import type { WebSession } from '../lib/identity';
import { currentIdentityEpoch } from '../lib/identity-epoch';
import { callTool, mcpError, type McpError } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import {
  emptyPendingRefresh,
  historyItemVisible,
  markPendingRefresh,
  type PendingRefresh,
} from '../lib/room-stream-refresh';
import type { RoomsPage } from '../lib/rooms';
import { SCOPE_RESET_EVENT, type ScopeResetDetail } from '../lib/scope-reset';
import { triggerRecovery } from '../pwa/recovery';
import { useWebSession } from './useWebSession';

/**
 * 房间会话状态：metadata、成员、历史、实时刷新与已读。
 *
 * 服务端状态由 React Query 持有：
 * - `network_room_get` 与 `network_history_list` 是只读查询；
 * - SSE 只触发失效，查询重读后才更新页面；
 * - 翻页与已读是 mutation，成功后写回对应缓存。
 *
 * 历史合并规则保持 4B-2 的语义：按 timeline 补读、稳定 key 去重、刷新时
 * 不丢已加载的旧页。
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
  catchUp: HistoryCatchUpView | null;
  /**
   * 房间详情或历史正在重读、或历史补读进行中。
   *
   * 这些阶段 `room.head_seq` 与已加载窗口可能同时停在旧值，仅比较两者
   * 无法判断窗口是否可信；调用方只在自动 @ 的兜底判断里使用该信号，
   * 不据此阻塞发送。
   */
  historyStale: boolean;
}

export interface HistoryCatchUpView {
  /** 正在补读或待重试。 */
  active: boolean;
  caughtUp: boolean | null;
  pages: number;
  /** 已连续覆盖到的游标；失败后从这里继续。 */
  coveredCursor: string | null;
  coveredSeq: string | null;
  error: string | null;
  /** 权限代次/游标失效后从最新授权快照重建。 */
  rebuiltAt: number | null;
  notice: string | null;
}

export interface RoomChatOptions {
  /** 单宿主转发当前房间的 SSE 提示；anchor 等非 React Query 窗口据此收敛。 */
  onEvent?: (event: Extract<ActorStreamEvent, { type: 'event' }>) => void;
}
export interface ModerationRefresh {
  messageId?: string;
  pinsOnly?: boolean;
}

interface HistoryCache {
  items: HistoryItem[];
  nextOlder: string | null;
  olderEnded: boolean;
  olderLoaded: boolean;
  /** 已成功并入的 older 页数；刷新响应继承该值，翻页响应加一。 */
  olderPages: number;
  resumeCursor: string | null;
  /** 历史授权快照（成员代次 + 起始边界）；变化时旧窗口不可继续拼接。 */
  authorization: string | null;
  /** 缺口补读进度；未追平前不把缺口两端拼成连续历史。 */
  catchUp: HistoryCatchUpView | null;
  /** 重建代次；更大的值表示丢弃旧 items。 */
  reset: number;
}

/**
 * 刷新响应只包含最新一页，必须并入“提交时”的缓存，而不是请求发出时的快照。
 *
 * - 消息按稳定 key 合并，已加载的 older 页不会因为刷新响应晚到而消失；
 * - `olderLoaded` 一旦为 true 不回退；游标与结束状态由 older 页数更多的一侧
 *   持有，刷新响应只在尚未翻页时决定游标；
 * - 同时作为 `structuralSharing` 在缓存写入时再合并一次，覆盖“翻页在刷新
 *   响应返回前一刻完成”的窗口。
 */
function mergeHistoryCache(
  current: HistoryCache | undefined,
  incoming: HistoryCache,
): HistoryCache {
  if (!current) return incoming;
  if (incoming.reset > current.reset) return incoming;
  const olderLoaded = current.olderLoaded || incoming.olderLoaded;
  const owner = incoming.olderPages >= current.olderPages ? incoming : current;
  return {
    items: mergeTimelineItems(current.items, incoming.items),
    nextOlder: owner.nextOlder,
    olderEnded: owner.olderEnded,
    olderLoaded,
    olderPages: Math.max(current.olderPages, incoming.olderPages),
    resumeCursor: incoming.resumeCursor ?? current.resumeCursor,
    authorization: incoming.authorization ?? current.authorization,
    catchUp: incoming.catchUp ?? current.catchUp,
    reset: Math.max(current.reset, incoming.reset),
  };
}

/** React Query 的 structuralSharing 签名固定为 unknown，这里只做类型收窄。 */
function shareHistoryCache(oldData: unknown, newData: unknown): HistoryCache {
  return mergeHistoryCache(
    oldData as HistoryCache | undefined,
    newData as HistoryCache,
  );
}

function failureMessage(error: unknown): string {
  const failure = error as McpError;
  return failure.message || '读取会话失败';
}

function fatalError(error: unknown): boolean {
  if (!error) return false;
  const failure = error as McpError;
  return failure.code === 'CREDENTIAL_INVALID' || failure.code === 'LOGGED_OUT';
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
 * 直到追到本轮 snapshot；预算只表示让出主线程，不表示追平。
 */
function authorizationKey(
  authorization: CatchUpAuthorization | null | undefined,
): string | null {
  if (!authorization) return null;
  return `${authorization.member_generation}:${authorization.history_from_seq}`;
}

async function fetchTimelineAfter(
  token: string,
  roomId: string,
  cursor: string,
  signal: AbortSignal,
): Promise<CatchUpPage> {
  const page = await callTool<HistoryPage>(
    'network_history_list',
    {
      room_id: roomId,
      view: 'timeline',
      direction: 'after',
      cursor,
      limit: LIMITS.historyPageMax,
    },
    { token, signal },
  );
  return {
    items: page.timeline_items ?? [],
    nextCursor: page.timeline_next_cursor ?? null,
    hasMore: page.timeline_has_more === true,
    resumeCursor: page.timeline_resume_cursor ?? null,
    snapshot: page.timeline_snapshot ?? null,
    authorization: page.authorization ?? null,
  };
}

/**
 * 只有真正失去房间访问权的成员事件才需要遮住旧私有视图。
 *
 * 服务端对“被移出”下发 `change: "removed"` + `action_required`；对
 * `room_role_changed`（admin→member）虽然也标 `action_required`，但成员
 * 仍在群内，历史边界按 `joined_seq` 计算、与角色无关，当前正文与输入框
 * 仍然有效，只应原地刷新能力视图。改名、公告、策略、加人、移除旁观者、
 * 群主变更、`room.created` 与解散归档都是 informational 或非移除事件。
 */
function revokesCurrentAccess(
  event: Extract<ActorStreamEvent, { type: 'event' }>,
): boolean {
  // 旁观者收到 informational 的 change=removed，不能因此遮住自己的会话；
  // 角色变化不改变读边界，不能仅凭 action_required 误遮罩。
  if (event.attention !== 'action_required') return false;
  return event.change === 'removed';
}

export function useRoomChat(roomId: string, options: RoomChatOptions = {}) {
  const queryClient = useQueryClient();
  const sessionState = useWebSession();
  const session = sessionState.session;
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;
  const humanTimeline = session?.identity.kind === 'human';
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const detailKey = queryKeys.room(roomId);
  const historyKey = queryKeys.history(roomId, humanTimeline);

  /**
   * 身份/房间代次：晚到的补读、翻页与回执写入必须与发起时一致。
   * token 变化视为新身份会话；同一 actor 重登录也丢弃旧响应。
   */
  const contextRef = useRef({ actorId, token, roomId, epoch: 0 });
  if (
    contextRef.current.actorId !== actorId ||
    contextRef.current.token !== token ||
    contextRef.current.roomId !== roomId
  ) {
    contextRef.current = {
      actorId,
      token,
      roomId,
      epoch: contextRef.current.epoch + 1,
    };
  }

  /**
   * 首屏 history 请求发起时刻，按挂载/切房后的首次查询记录。
   *
   * 不能用“响应完成时刻”判断握手窗口：请求可能先被服务端读取快照，
   * 响应却晚于 ack 才完成。只要 ack 晚于请求发起，快照就可能早于订阅
   * 覆盖，必须补拉一次；响应何时完成不影响判断。
   */
  const initialHistoryRequestedRef = useRef<{ roomId: string; at: number | null }>({
    roomId,
    at: null,
  });
  if (initialHistoryRequestedRef.current.roomId !== roomId) {
    initialHistoryRequestedRef.current = { roomId, at: null };
  }

  const detailQuery = useQuery({
    queryKey: detailKey,
    enabled: Boolean(token),
    queryFn: async ({ signal }) => {
      const requestIdentityEpoch = currentIdentityEpoch();
      const requestEpoch = contextRef.current.epoch;
      const detail = await callTool<RoomDetail>(
        'network_room_get',
        { room_id: roomId },
        { token: token ?? undefined, signal },
      );
      if (
        requestIdentityEpoch !== currentIdentityEpoch() ||
        contextRef.current.epoch !== requestEpoch ||
        contextRef.current.roomId !== roomId
      ) {
        throw mcpError('身份或房间已变化，丢弃旧会话响应', 'STALE_CONTEXT');
      }
      return detail;
    },
  });

  // 群成员/直聊对端资料进入 actor 头像缓存，供消息补图。
  useEffect(() => {
    const members = detailQuery.data?.members;
    if (!members) return;
    rememberActorAvatars(
      members.map((member) => ({
        actor_id: member.actor_id,
        name: member.name,
        avatar_url: member.avatar_url ?? null,
      })),
    );
  }, [detailQuery.data?.members]);

  const historyQuery = useQuery<HistoryCache>({
    queryKey: historyKey,
    enabled: Boolean(token),
    // 翻页与刷新写同一份缓存；提交时以当时的缓存为准，避免晚到的刷新覆盖 older。
    structuralSharing: shareHistoryCache,
    queryFn: async ({ client, signal, queryKey }) => {
      const requestActor = actorId;
      const requestEpoch = contextRef.current.epoch;
      const requestIdentityEpoch = currentIdentityEpoch();
      const staleContext = () =>
        requestIdentityEpoch !== currentIdentityEpoch() ||
        contextRef.current.epoch !== requestEpoch ||
        contextRef.current.actorId !== requestActor ||
        contextRef.current.roomId !== roomId;
      const first = initialHistoryRequestedRef.current;
      if (first.roomId === roomId && first.at === null) first.at = Date.now();
      const previous = client.getQueryData<HistoryCache>(queryKey) ?? null;
      const page = await callTool<HistoryPage>(
        'network_history_list',
        historyArgs(roomId, humanTimeline),
        { token: token ?? undefined, signal },
      );
      if (staleContext()) {
        throw mcpError('身份或房间已变化，丢弃旧历史响应', 'STALE_CONTEXT');
      }
      const latest = reverseChronological(page, humanTimeline);
      const pageAuth = authorizationKey(page.authorization);
      const pageResume = page.timeline_resume_cursor ?? null;
      const generationChanged = Boolean(
        previous?.authorization && pageAuth && previous.authorization !== pageAuth,
      );
      let rebuilt = generationChanged;
      let incoming = latest;
      let catchUp: HistoryCatchUpView | null = generationChanged
        ? null
        : previous?.catchUp ?? null;
      const previousResume =
        previous?.catchUp?.caughtUp === false && previous.catchUp.coveredCursor
          ? previous.catchUp.coveredCursor
          : previous?.resumeCursor ?? null;

      if (
        humanTimeline &&
        page.timeline_snapshot &&
        previous &&
        pageResume &&
        previousResume &&
        pageResume !== previousResume &&
        !generationChanged
      ) {
        let pagesRead = previous.catchUp?.pages ?? 0;
        const progress = (
          error: string | null,
          coveredCursor: string | null,
          coveredSeq: string | null,
        ): HistoryCatchUpView => ({
          active: true,
          caughtUp: false,
          pages: pagesRead,
          coveredCursor,
          coveredSeq,
          error,
          rebuiltAt: null,
          notice: '正在同步会话历史…',
        });
        try {
          const result = await catchUpGap({
            initialItems: latest,
            resumeCursor: previousResume,
            targetSnapshot: page.timeline_snapshot,
            expectedAuthorization: pageAuth ?? previous.authorization,
            authorizationKey,
            signal,
            fetchPage: (cursor) =>
              fetchTimelineAfter(token ?? '', roomId, cursor, signal),
            onBatch: (batch) => {
              pagesRead += batch.pages;
              if (staleContext()) return;
              const next = progress(null, batch.coveredCursor, batch.coveredSeq);
              client.setQueryData<HistoryCache>(queryKey, (current) =>
                current ? { ...current, catchUp: next } : current,
              );
            },
          });
          if (staleContext()) {
            throw mcpError('身份或房间已变化，丢弃旧历史响应', 'STALE_CONTEXT');
          }
          if (result.caughtUp) {
            incoming = result.items;
            catchUp = {
              active: false,
              caughtUp: true,
              pages: Math.max(pagesRead, result.pages),
              coveredCursor: null,
              coveredSeq: result.coveredSeq,
              error: null,
              rebuiltAt: null,
              notice: null,
            };
          } else if (result.failure?.kind === 'stale') {
            rebuilt = true;
            incoming = latest;
            catchUp = {
              active: false,
              caughtUp: false,
              pages: Math.max(pagesRead, result.pages),
              coveredCursor: null,
              coveredSeq: result.coveredSeq,
              error: null,
              rebuiltAt: Date.now(),
              notice: '权限或历史边界已变化，已按最新授权重建；可上翻加载更早消息。',
            };
          } else if (result.failure?.kind === 'aborted') {
            throw mcpError('恢复已取消', 'ABORTED');
          } else {
            pagesRead = Math.max(pagesRead, result.pages);
            const next = progress(
              `补读中断：${result.failure?.message || '将从最后成功位置重试'}`,
              result.coveredCursor,
              result.coveredSeq,
            );
            const updated = client.setQueryData<HistoryCache>(queryKey, (current) =>
              current ? { ...current, catchUp: next } : current,
            );
            // 不把缺口两端拼成连续历史：保留旧窗口，下一轮从 coveredCursor 继续。
            return updated ?? previous;
          }
        } catch (error) {
          if (staleContext() || signal.aborted) throw error;
          const code = (error as McpError).code;
          if (code === 'CURSOR_EXPIRED' || code === 'INVALID_ARGUMENT') {
            rebuilt = true;
            incoming = latest;
            catchUp = {
              active: false,
              caughtUp: false,
              pages: pagesRead,
              coveredCursor: null,
              coveredSeq: null,
              error: null,
              rebuiltAt: Date.now(),
              notice: '权限或历史边界已变化，已按最新授权重建；可上翻加载更早消息。',
            };
          } else {
            const next = progress(
              `补读中断：${
                (error as McpError).message || '将从最后成功位置重试'
              }`,
              previous.catchUp?.coveredCursor ?? previousResume,
              previous.catchUp?.coveredSeq ?? null,
            );
            const updated = client.setQueryData<HistoryCache>(queryKey, (current) =>
              current ? { ...current, catchUp: next } : current,
            );
            return updated ?? previous;
          }
        }
      }

      // 请求期间可能已完成翻页；以此刻的缓存为基准，而不是请求前的 previous。
      const current = client.getQueryData<HistoryCache>(queryKey) ?? previous ?? undefined;
      if (staleContext()) {
        throw mcpError('身份或房间已变化，丢弃旧历史响应', 'STALE_CONTEXT');
      }
      const pageNextOlder = nextOlderCursor(page, humanTimeline);
      const reset = rebuilt ? (current?.reset ?? 0) + 1 : current?.reset ?? 0;
      const base = rebuilt ? [] : current?.items ?? [];
      const merged = mergeHistoryCache(current, {
        items: mergeTimelineItems(base, incoming),
        nextOlder: pageNextOlder,
        olderEnded: pageNextOlder === null,
        olderLoaded: false,
        olderPages: 0,
        resumeCursor: pageResume ?? current?.resumeCursor ?? null,
        authorization: pageAuth ?? current?.authorization ?? null,
        catchUp,
        reset,
      });
      return merged;
    },
  });

  const older = useMutation({
    mutationFn: async () => {
      const requestEpoch = contextRef.current.epoch;
      const requestIdentityEpoch = currentIdentityEpoch();
      const state = queryClient.getQueryData<HistoryCache>(historyKey);
      const cursor = state?.nextOlder ?? null;
      if (!cursor) throw new Error('已经到最早的消息了');
      const page = await callTool<HistoryPage>(
        'network_history_list',
        historyArgs(roomId, humanTimeline, cursor),
        { token: token ?? undefined },
      );
      if (
        requestIdentityEpoch !== currentIdentityEpoch() ||
        contextRef.current.epoch !== requestEpoch
      ) {
        throw mcpError('身份或房间已变化，丢弃旧历史页', 'STALE_CONTEXT');
      }
      return { page, cursor, requestIdentityEpoch };
    },
    onSuccess: ({ page, cursor, requestIdentityEpoch }) => {
      if (requestIdentityEpoch !== currentIdentityEpoch()) return;
      queryClient.setQueryData<HistoryCache>(historyKey, (previous) => {
        if (!previous) return previous;
        const incoming = reverseChronological(page, humanTimeline);
        const merged = mergeTimelineItems(previous.items, incoming);
        const next = nextOlderCursor(page, humanTimeline);
        const nextOlder = next && next !== cursor ? next : null;
        return {
          ...previous,
          items: merged,
          nextOlder,
          olderLoaded: true,
          olderPages: previous.olderPages + 1,
          olderEnded: nextOlder === null,
        };
      });
    },
  });

  const lastMarkedRef = useRef<string | null>(null);
  const markReadMutation = useMutation({
    mutationFn: async (throughSeq: string) => {
      const start = contextRef.current;
      const identityEpoch = currentIdentityEpoch();
      await callTool(
        'network_room_mark_read',
        { room_id: roomId, through_seq: throughSeq },
        { token: start.token ?? undefined },
      );
      return {
        throughSeq,
        identityEpoch,
        actorId: start.actorId,
        token: start.token,
        roomId: start.roomId,
      };
    },
    onSuccess: ({
      throughSeq,
      identityEpoch,
      actorId: startActor,
      token: startToken,
      roomId: startRoom,
    }) => {
      // 遮罩出现会卸载本 hook 的组件；模块级代次不随卸载冻结，晚到的写响应
      // 只属于发起时的身份，切号/撤权后丢弃，避免把旧身份的已读水位写进
      // 新身份的房间与列表缓存。token/actor/房间再作二次校验。
      if (identityEpoch !== currentIdentityEpoch()) return;
      const current = contextRef.current;
      if (
        current.actorId !== startActor ||
        current.token !== startToken ||
        current.roomId !== startRoom
      ) {
        return;
      }
      queryClient.setQueryData<RoomDetail>(detailKey, (previous) =>
        previous
          ? { ...previous, room: { ...previous.room, my_last_read_seq: throughSeq } }
          : previous,
      );
      queryClient.setQueryData<InfiniteData<RoomsPage, string | null>>(
        queryKeys.rooms(current.actorId),
        (previous) =>
          previous
            ? {
                ...previous,
                pages: previous.pages.map((page) => ({
                  ...page,
                  items: page.items.map((room) =>
                    room.room_id === roomId
                      ? { ...room, my_last_read_seq: throughSeq }
                      : room,
                  ),
                })),
              }
            : previous,
      );
    },
  });

  // 新身份/新房间不能继承上一个代次的“已标记水位”，否则会跳过自己的首次已读。
  useEffect(() => {
    lastMarkedRef.current = null;
  }, [actorId, token, roomId]);

  /**
   * 已加载消息的权威重读：撤回、回执可能不在最新页。
   * 只有消息确实在可见窗口内才发锚点请求，避免每条新消息都额外读一次。
   */
  const refreshVisibleMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (!token) return;
      const cached = queryClient.getQueryData<HistoryCache>(historyKey);
      const visible = cached?.items.some(
        (item) => item.kind !== 'presence' && item.message_id === messageId,
      );
      if (!visible) return;
      const requestEpoch = contextRef.current.epoch;
      const requestIdentityEpoch = currentIdentityEpoch();
      try {
        const page = await callTool<HistoryPage>(
          'network_history_list',
          {
            room_id: roomId,
            anchor_message_id: messageId,
            limit: LIMITS.historyPageDefault,
            ...(humanTimeline ? { view: 'timeline' } : {}),
          },
          { token },
        );
        if (
          requestIdentityEpoch !== currentIdentityEpoch() ||
          contextRef.current.epoch !== requestEpoch
        ) {
          return;
        }
        const incoming = humanTimeline ? page.timeline_items ?? [] : page.items;
        queryClient.setQueryData<HistoryCache>(historyKey, (previous) =>
          previous
            ? { ...previous, items: mergeTimelineItems(previous.items, incoming) }
            : previous,
        );
      } catch {
        // 消息已不可见/已撤权时由恢复轮统一处理，不把单个锚点失败升级为整页错误。
      }
    },
    [historyKey, humanTimeline, queryClient, roomId, token],
  );

  useEffect(() => {
    const onReset = (event: Event) => {
      const detail = (event as CustomEvent<ScopeResetDetail>).detail;
      if (detail?.roomId === roomId || detail?.actorId === actorId) {
        contextRef.current = { ...contextRef.current, epoch: contextRef.current.epoch + 1 };
        lastMarkedRef.current = null;
      }
    };
    window.addEventListener(SCOPE_RESET_EVENT, onReset);
    return () => window.removeEventListener(SCOPE_RESET_EVENT, onReset);
  }, [actorId, roomId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) {
      await queryClient.refetchQueries({ queryKey: queryKeys.session() });
      return;
    }
    await Promise.all([detailQuery.refetch(), historyQuery.refetch()]);
  }, [detailQuery, historyQuery, queryClient, token]);

  const load = useCallback(async (): Promise<void> => {
    if (!token) {
      await queryClient.refetchQueries({ queryKey: queryKeys.session() });
      return;
    }
    await refresh();
  }, [queryClient, refresh, token]);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshRef = useRef<PendingRefresh>(emptyPendingRefresh());
  /** 首次 ack 的握手补拉只允许发生一次；重连 ack 走独立分支。 */
  const initialAckHandledRef = useRef(false);
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    [],
  );
  // 切换房间时旧房间的事件不能失效新房间的查询。
  useEffect(() => {
    pendingRefreshRef.current = emptyPendingRefresh();
    lastMarkedRef.current = null;
    initialAckHandledRef.current = false;
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, [roomId]);

  const refreshChainRef = useRef<Promise<void>>(Promise.resolve());
  const runPendingRefresh = useCallback(async (): Promise<void> => {
    refreshTimerRef.current = null;
    const pending = pendingRefreshRef.current;
    pendingRefreshRef.current = emptyPendingRefresh();
    const jobs: Promise<unknown>[] = [];
    if (pending.rooms) {
      jobs.push(queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) }));
    }
    if (pending.detail) {
      // exact：不能命中同前缀的 history / files。
      jobs.push(queryClient.invalidateQueries({ queryKey: detailKey, exact: true }));
    }
    if (pending.history) {
      jobs.push(queryClient.invalidateQueries({ queryKey: historyKey, exact: true }));
    }
    // 文件面板可见时才存在活动查询；不可见时仅标脏，不额外发请求。
    if (pending.files) {
      jobs.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.roomFiles(roomId), exact: true }),
      );
    }
    if (pending.contacts) {
      jobs.push(
        queryClient.invalidateQueries({
          queryKey: queryKeys.contactRequests(actorId),
        }),
      );
    }
    if (pending.contactBadge) {
      jobs.push(
        queryClient.invalidateQueries({
          queryKey: queryKeys.contactRequestBadge(actorId),
        }),
      );
    }
    if (pending.focus) {
      jobs.push(queryClient.invalidateQueries({ queryKey: queryKeys.focus() }));
    }
    for (const messageId of pending.messageIds) {
      jobs.push(refreshVisibleMessage(messageId));
    }
    await Promise.all(jobs);
  }, [
    actorId,
    detailKey,
    historyKey,
    queryClient,
    refreshVisibleMessage,
    roomId,
  ]);

  /** SSE、管理操作共用同一串行 drain；后一次读取执行时合并最新 pending。 */
  const flushRefresh = useCallback((): Promise<void> => {
    const next = refreshChainRef.current.then(() => runPendingRefresh());
    refreshChainRef.current = next.catch(() => undefined);
    return next;
  }, [runPendingRefresh]);
  /**
   * 群管理操作后的定向刷新，与 SSE 共用同一 pending 合并器。
   *
   * - 置顶只失效 detail；不重读历史与会话排序；
   * - 撤回只重读已渲染窗口；
   * - 若已有防抖刷新在排队，先取消并合并到本次，避免两个 refresh 互相覆盖。
   */
  const refreshModeration = useCallback(
    async ({
      messageId,
      pinsOnly = false,
    }: ModerationRefresh = {}): Promise<void> => {
      if (!token) return;
      const pending = pendingRefreshRef.current;
      pending.detail = true;
      if (!pinsOnly) {
        pending.rooms = true;
        if (messageId) {
          // 撤回消息无法作为 anchor 重读；只有已渲染的窗口需要重读一次。
          const cached = queryClient.getQueryData<HistoryCache>(historyKey);
          if (historyItemVisible(cached?.items, messageId)) pending.history = true;
        }
      }
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      await flushRefresh();
    },
    [flushRefresh, token],
  );

  /**
   * SSE 只给“某处变了”的提示；300ms 窗口内按房间与查询类别合并，
   * 窗口结束后让查询自己重读权威状态。
   *
   * 首次 ack 不代表订阅已经覆盖首屏：只要 ack 晚于首屏 history 的请求
   * 发起时刻，服务端可能已经读过更早的快照，而 ack 之前写入的消息不会
   * 被订阅重放，必须补拉一次当前房间，与响应何时完成无关。
   * ack 早于或等于请求发起时，请求在订阅建立后才发出，首屏查询已经覆盖，
   * 不额外读取。重连 ack 仍整体刷新，覆盖断线期间错过的事件。
   */
  const scheduleRefresh = useCallback(
    (event: ActorStreamEvent) => {
      if (!token) return;
      const pending = pendingRefreshRef.current;
      if (event.type === 'ack') {
        if (event.reconnect) {
          // 重连 ACK 与 online/visibility 合并成同一轮统一恢复；
          // 身份与房间边界由 RecoveryHost 先核对，再复用当前游标补洞。
          triggerRecovery('stream-ack');
          return;
        }
        // 首次 ack 只判断一次，避免重复 ack/事件再次触发补拉。
        if (initialAckHandledRef.current) return;
        initialAckHandledRef.current = true;
        const requestedAt = initialHistoryRequestedRef.current.at;
        if (requestedAt === null || event.at <= requestedAt) return;
        // 握手窗口：history 请求早于 ack，快照可能不含 ack 前的写入。
        // 只补当前房间；无关房间事件仍只刷新侧栏。
        pending.history = true;
        pending.detail = true;
      } else {
        const membershipEvent =
          event.roomId === roomId &&
          event.source !== 'room.pins' &&
          (event.source === 'room.membership' ||
            event.source === 'room.lifecycle' ||
            event.kind === 'room');
        if (membershipEvent && revokesCurrentAccess(event)) {
          // 只有确实撤销本身份访问权的事件才遮住旧私有视图；改名、加成员、
          // room.created 等 informational 变化只刷新查询，不打断输入。
          triggerRecovery('membership', { mask: true });
          return;
        }
        markPendingRefresh(pending, event, roomId, humanTimeline);
        if (event.change === 'recalled' && event.messageId) {
          // 撤回只影响已加载窗口；未渲染的消息等下次读取权威状态。
          const cached = queryClient.getQueryData<HistoryCache>(historyKey);
          if (historyItemVisible(cached?.items, event.messageId)) pending.history = true;
        }
        // anchor 窗口不在 React Query；由这里转发 recalled 提示，避免另开订阅。
        onEventRef.current?.(event);
      }
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => void flushRefresh(), LIMITS.webRefreshDebounceMs);
    },
    [flushRefresh, humanTimeline, roomId, token],
  );

  const stream = useActorStream({ token, onEvent: scheduleRefresh });

  const loadOlder = useCallback(async (): Promise<void> => {
    if (older.isPending) return;
    await older.mutateAsync().catch(() => undefined);
  }, [older]);

  const markRead = useCallback(
    async (throughSeq: string): Promise<void> => {
      if (!token || !throughSeq) return;
      // 只能推进到真正渲染过的消息；补读目标与 room.head_seq 都不算展示。
      const watermark = renderedWatermark(historyQuery.data?.items ?? []);
      if (!watermark) return;
      let target = throughSeq;
      try {
        if (BigInt(throughSeq) > BigInt(watermark)) target = watermark;
      } catch {
        return;
      }
      const currentRead = historyQuery.data
        ? detailQuery.data?.room.my_last_read_seq
        : null;
      if (currentRead) {
        try {
          if (BigInt(target) <= BigInt(currentRead)) return;
        } catch {
          // 旧数据格式异常时仍允许服务端校验。
        }
      }
      if (lastMarkedRef.current === target) return;
      lastMarkedRef.current = target;
      await markReadMutation.mutateAsync(target).catch(() => {
        lastMarkedRef.current = null;
      });
    },
    [detailQuery.data, historyQuery.data, markReadMutation, token],
  );

  const detail = detailQuery.data ?? null;
  const history = historyQuery.data ?? null;
  const historyStale =
    detailQuery.isFetching ||
    historyQuery.isFetching ||
    history?.catchUp?.active === true;
  const fatal =
    sessionState.status === 'logged-out' ||
    sessionState.status === 'credential-invalid' ||
    sessionState.status === 'pairing-required' ||
    fatalError(detailQuery.error) ||
    fatalError(historyQuery.error);
  const initialError =
    sessionState.status === 'error' ||
    sessionState.status === 'credential-invalid' ||
    sessionState.status === 'pairing-required' ||
    sessionState.status === 'logged-out'
      ? sessionState.error
      : (!detail || !history) && (detailQuery.error || historyQuery.error)
        ? failureMessage(detailQuery.error ?? historyQuery.error)
        : null;
  const ready = Boolean(detail && history);
  const status: RoomChatState['status'] =
    fatal || (initialError && !ready) ? 'error' : ready ? 'ready' : 'loading';

  const refreshErrorSource =
    ready && !fatal ? (detailQuery.error ?? historyQuery.error) : null;

  return {
    status,
    session,
    detail,
    items: history?.items ?? [],
    error: initialError,
    refreshError: refreshErrorSource && !fatal ? failureMessage(refreshErrorSource) : null,
    streamError: stream.error,
    olderError: older.error ? `加载更早失败：${failureMessage(older.error)}` : null,
    olderLoading: older.isPending,
    olderEnded: history?.olderEnded ?? false,
    hasOlder: Boolean(history?.nextOlder),
    catchUp: history?.catchUp ?? null,
    historyStale,
    load,
    refresh,
    refreshModeration,
    loadOlder,
    markRead,
  } satisfies RoomChatState & {
    streamError: string | null;
    load: () => Promise<void>;
    refresh: () => Promise<void>;
    refreshModeration: (options?: ModerationRefresh) => Promise<void>;
    loadOlder: () => Promise<void>;
    markRead: (throughSeq: string) => Promise<void>;
  };
}
