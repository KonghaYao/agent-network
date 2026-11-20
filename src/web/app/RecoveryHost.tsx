import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { callTool, readBrowserToken, type McpError } from '../lib/mcp-client';
import type { RoomDetail } from '../lib/chat';
import { bumpIdentityEpoch } from '../lib/identity-epoch';
import { queryKeys } from '../lib/query-keys';
import type { WebSession } from '../lib/identity';
import { revalidateWebSession, resetWebSession, cachedWebSession } from '../lib/identity';
import { clearPrivateQueries, clearRoomScope } from '../lib/scope-reset';
import { discardRoomTasks, resetRoomTasks } from '../lib/task-cache';
import type { RecoveryReason } from '../lib/recovery-coordinator';
import {
  getRecoverySnapshot,
  installRecoveryTriggers,
  reportIdentitySignal,
  reportRecoveryBlocked,
  reportRecoveryOffline,
  reportRecoveryReady,
  reportRecoveryUnavailable,
  setRecoveryRunner,
  triggerRecovery,
  useRecoveryState,
} from '../pwa/recovery';

/**
 * 前台恢复的唯一执行者：先核对身份，再核对当前房间访问边界，最后复用
 * 原有查询与房间游标补洞。窗口不直接重载，也不创建业务轮询。
 */

interface RecoveryHostProps {
  routeName: string;
  roomId: string | null;
}

const AUTH_INVALID_REASON =
  '当前身份已失效或已被撤销。请使用另一台已登录设备重新配对，或返回会话列表。';

/** 这些触发都意味着授权边界可能变化：旧 Task/Trace 必须先丢弃再重读。 */
const TASK_SCOPE_RESET_REASONS: ReadonlySet<RecoveryReason> = new Set([
  'auth',
  'membership',
  'stream-ack',
]);

function failureCode(error: unknown): string | null {
  return (error as McpError | null)?.code ?? null;
}

function isNetworkFailure(error: unknown): boolean {
  const code = failureCode(error);
  return code === null || code === 'TIMEOUT' || code === 'ABORTED' || code === 'INVALID_RESPONSE';
}

function roomDenied(code: string | null): boolean {
  return code === 'NOT_MEMBER' || code === 'NOT_FOUND' || code === 'PERMISSION_DENIED' ||
    code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
}

function blockedSession(queryClient: ReturnType<typeof useQueryClient>): void {
  resetWebSession();
  clearPrivateQueries(queryClient);
  // 不重新 bootstrap：缺 token 时桌面端会自动注册访客，遮罩期间不允许。
  queryClient.setQueryData(queryKeys.session(), null);
}

function RecoveryOverlay() {
  const state = useRecoveryState();

  useEffect(() => {
    const body = document.body;
    const root = document.getElementById('root');
    if (state.masked) {
      body.dataset.recoveryMasked = '1';
      root?.setAttribute('inert', '');
      root?.setAttribute('aria-hidden', 'true');
    } else {
      delete body.dataset.recoveryMasked;
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
    }
    return () => {
      delete body.dataset.recoveryMasked;
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
    };
  }, [state.masked]);

  if (typeof document === 'undefined') return null;

  const blocked = state.phase === 'blocked';
  const reconnect = state.masked && !blocked && state.phase === 'offline';
  const mask = state.masked
    ? createPortal(
        <div id="recovery-mask" className="recovery-mask" role="status" aria-live="polite">
          <div className="recovery-mask-card">
            <div className="chat-skeleton" aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <div className={`skeleton-row${row === 1 ? ' mine' : ''}`} key={row}>
                  <span className="skeleton-avatar" />
                  <span className="skeleton-bubble" />
                </div>
              ))}
            </div>
            <h2>{blocked ? '会话权限已变化' : reconnect ? '需要联网确认身份' : '正在重新验证'}</h2>
            <p id="recovery-mask-text">
              {blocked
                ? state.blockedReason || AUTH_INVALID_REASON
                : reconnect
                  ? state.blockedReason ||
                    '网络不可用，已暂停显示旧身份的私有内容。恢复网络后重试。'
                  : '正在核对身份与会话访问边界，完成后恢复当前窗口。'}
            </p>
            {blocked ? (
              <a id="recovery-mask-home" href="/" onClick={() => undefined}>
                返回会话列表
              </a>
            ) : reconnect ? (
              <button
                type="button"
                id="recovery-retry"
                onClick={() => triggerRecovery('auth', { mask: true })}
              >
                重试
              </button>
            ) : null}
          </div>
        </div>,
        document.body,
      )
    : null;

  const offline = !state.masked && (!state.online || state.phase === 'offline');
  const banner = offline
    ? createPortal(
        <div id="offline-banner" className="offline-banner" role="status" aria-live="polite">
          <span>
            {state.online
              ? state.blockedReason || '暂时无法连接，已保留当前内容。'
              : '连接中断，当前显示内存中的数据；恢复后会自动核对。'}
          </span>
          <button
            type="button"
            id="offline-retry"
            onClick={() => triggerRecovery('manual', { mask: false })}
          >
            重试
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {mask}
      {banner}
    </>
  );
}

export function RecoveryHost({ routeName, roomId }: RecoveryHostProps) {
  const queryClient = useQueryClient();
  const recovery = useRecoveryState();
  const routeRef = useRef({ routeName, roomId });
  routeRef.current = { routeName, roomId };

  useEffect(() => installRecoveryTriggers(), []);

  /**
   * 身份边界遮罩出现时，旧凭据下的私有视图不能继续留在内存里：
   * 先把 session 查询置空（停止所有依赖 token 的查询），再清掉私有缓存。
   * 成功重新鉴权后由恢复轮重新写入 session 与房间数据。
   */
  useEffect(() => {
    if (!recovery.masked || !recovery.sticky) return;
    queryClient.setQueryData(queryKeys.session(), null);
    clearPrivateQueries(queryClient);
  }, [queryClient, recovery.masked, recovery.sticky]);

  useEffect(() => {
    setRecoveryRunner(async (round) => {
      const resetTaskScope = round.reasons.some((reason) =>
        TASK_SCOPE_RESET_REASONS.has(reason),
      );
      const route = routeRef.current;
      if (resetTaskScope && route.routeName === 'room' && route.roomId) {
        // 身份/撤权/重连确认前先清空旧 Task 列表与 Trace；遮罩与既有
        // 模块级 epoch 仍负责拦截晚到写，清理本身不放宽任何校验。
        discardRoomTasks(queryClient, route.roomId);
      }
      const previous = queryClient.getQueryData<WebSession>(queryKeys.session()) ?? cachedWebSession();
      // 同一页内 localStorage 被改写（切号/撤权）时，即使本轮不是 auth 触发，
      // 也必须在发起网络核对前切到粘性遮罩。
      if (previous && readBrowserToken() !== previous.token) {
        reportIdentitySignal();
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        reportRecoveryOffline();
        return;
      }
      let session: WebSession;
      try {
        session = await revalidateWebSession();
      } catch (error) {
        const code = failureCode(error);
        if (code === 'CREDENTIAL_INVALID' || code === 'LOGGED_OUT' || code === 'PAIRING_REQUIRED') {
          blockedSession(queryClient);
          reportRecoveryBlocked((error as McpError).message || AUTH_INVALID_REASON);
          return;
        }
        reportRecoveryUnavailable((error as McpError).message);
        return;
      }

      const sessionChanged = Boolean(
        previous &&
          (previous.token !== session.token ||
            previous.identity.actor_id !== session.identity.actor_id),
      );
      if (sessionChanged) {
        // 恢复轮确认 token/actor 已变化：旧身份在途写入全部作废。
        bumpIdentityEpoch();
        clearPrivateQueries(queryClient, previous?.identity.actor_id ?? null);
      }
      queryClient.setQueryData(queryKeys.session(), session);

      const current = routeRef.current;
      if (current.routeName === 'room' && current.roomId) {
        let detail: RoomDetail;
        try {
          detail = await callTool<RoomDetail>(
            'network_room_get',
            { room_id: current.roomId },
            { token: session.token },
          );
        } catch (error) {
          const code = failureCode(error);
          if (readBrowserToken() !== session.token) {
            triggerRecovery('auth', { mask: true });
            return;
          }
          if (roomDenied(code)) {
            clearRoomScope(queryClient, current.roomId, session.identity.actor_id);
            queryClient.setQueryData(queryKeys.room(current.roomId), null);
            reportRecoveryBlocked(
              '你已不在该会话中，或当前身份没有读取权限。旧内容已隐藏。',
              current.roomId,
            );
            return;
          }
          if (isNetworkFailure(error)) {
            reportRecoveryUnavailable((error as McpError).message);
            return;
          }
          clearRoomScope(queryClient, current.roomId, session.identity.actor_id);
          reportRecoveryBlocked((error as McpError).message || '读取会话权限失败', current.roomId);
          return;
        }
        if (readBrowserToken() !== session.token) {
          triggerRecovery('auth', { mask: true });
          return;
        }
        if (detail.room?.room_id !== current.roomId) {
          clearRoomScope(queryClient, current.roomId, session.identity.actor_id);
          reportRecoveryBlocked('会话信息与当前地址不一致。', current.roomId);
          return;
        }
        queryClient.setQueryData(queryKeys.room(current.roomId), detail);
        const humanTimeline = session.identity.kind === 'human';
        const historyKey = queryKeys.history(current.roomId, humanTimeline);
        // 详情（含当前成员边界）先于历史补读完成；补读复用 history 缓存游标。
        await queryClient.refetchQueries({
          queryKey: historyKey,
          exact: true,
          type: 'active',
        });
        if (readBrowserToken() !== session.token) {
          triggerRecovery('auth', { mask: true });
          return;
        }
        const historyState = queryClient.getQueryState(historyKey);
        if (historyState?.status === 'error') {
          reportRecoveryUnavailable(
            (historyState.error as McpError | null)?.message || '历史同步失败，已保留当前内容。',
          );
          return;
        }
        // 只重新读取状态，不重建/派发已有 Agent 任务。
        void queryClient.invalidateQueries({
          queryKey: queryKeys.roomFiles(current.roomId),
          exact: true,
        });
        if (resetTaskScope) {
          // 鉴权通过后再重读：列表从首页重建，已打开的 Trace 原位重读。
          void resetRoomTasks(queryClient, current.roomId);
        } else {
          void queryClient.invalidateQueries({ queryKey: queryKeys.taskSummaries(current.roomId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.roomTasks(current.roomId) });
        }
      }

      void queryClient.invalidateQueries({
        queryKey: queryKeys.rooms(session.identity.actor_id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.contactRequests(session.identity.actor_id),
      });
      if (readBrowserToken() !== session.token) {
        triggerRecovery('auth', { mask: true });
        return;
      }
      reportRecoveryReady();
    });
    return () => setRecoveryRunner(null);
  }, [queryClient]);

  // 供探针与诊断读取；不包含 token、消息正文或房间标题。
  useEffect(() => {
    const countPrefix = (prefix: string) =>
      queryClient
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === prefix).length;
    const removed: Record<string, number> = {};
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'removed') return;
      const prefix = String(event.query.queryKey[0] ?? '');
      removed[prefix] = (removed[prefix] ?? 0) + 1;
    });
    const debug = {
      snapshot: () => getRecoverySnapshot(),
      cache: () => ({
        room: countPrefix('room'),
        roomTasks: countPrefix('room-tasks'),
        removedRoom: removed.room ?? 0,
        removedRoomTasks: removed['room-tasks'] ?? 0,
        sessionPresent: Boolean(queryClient.getQueryData(queryKeys.session())),
      }),
      // 诊断只暴露已读水位，不包含正文、token 或标题。
      roomRead: (roomId: string) =>
        queryClient.getQueryData<RoomDetail>(queryKeys.room(roomId))?.room.my_last_read_seq ??
        null,
    };
    (window as unknown as { __agentNetworkRecoveryHost?: typeof debug }).__agentNetworkRecoveryHost =
      debug;
    return () => {
      unsubscribe();
      delete (window as unknown as { __agentNetworkRecoveryHost?: unknown })
        .__agentNetworkRecoveryHost;
    };
  }, [queryClient]);

  return <RecoveryOverlay />;
}
