import type { QueryClient } from '@tanstack/react-query';

import { releasePreviewObjectUrls } from './preview-resources';
import { clearRecalledDrafts } from './recalled-drafts';

/**
 * 撤权/切号时的范围清理。
 *
 * 只消费客户端已经取得的授权结果：取消在途请求、删除该房间的查询缓存、
 * 释放预览 object URL，并广播给仍挂载的页面关闭弹窗/右栏预览。服务端
 * 权限判断不变，后续显示完全依赖重新鉴权后的查询。
 */
export const SCOPE_RESET_EVENT = 'agent-network:scope-reset';

export interface ScopeResetDetail {
  roomId: string | null;
  actorId: string | null;
}

function roomPredicate(roomId: string) {
  return (query: { queryKey: readonly unknown[] }) =>
    (query.queryKey[0] === 'room' && query.queryKey[1] === roomId) ||
    (query.queryKey[0] === 'room-tasks' && query.queryKey[1] === roomId);
}

function privatePredicate(query: { queryKey: readonly unknown[] }) {
  return query.queryKey[0] !== 'session';
}

function notifyScopeReset(detail: ScopeResetDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ScopeResetDetail>(SCOPE_RESET_EVENT, { detail }));
}

function cancelAndRemove(
  queryClient: QueryClient,
  predicate: (query: { queryKey: readonly unknown[] }) => boolean,
): void {
  void queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
}

export function clearRoomScope(
  queryClient: QueryClient,
  roomId: string,
  actorId: string | null = null,
): void {
  cancelAndRemove(queryClient, roomPredicate(roomId));
  releasePreviewObjectUrls();
  notifyScopeReset({ roomId, actorId });
}

/** 身份失效/切换：除 session 查询外全部丢弃，晚到响应随查询移除失效。 */
export function clearPrivateQueries(
  queryClient: QueryClient,
  actorId: string | null = null,
): void {
  cancelAndRemove(queryClient, privatePredicate);
  releasePreviewObjectUrls();
  // 撤回原文只在本标签页有效；身份边界一出现就必须丢弃，避免恢复时跨号残留。
  clearRecalledDrafts(actorId);
  notifyScopeReset({ roomId: null, actorId });
}
