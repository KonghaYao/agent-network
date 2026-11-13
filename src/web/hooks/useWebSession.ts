import { useQuery } from '@tanstack/react-query';

import { ensureWebSession, type WebSession } from '../lib/identity';
import type { McpError } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';

export type SessionStatus =
  | 'loading'
  | 'ready'
  | 'logged-out'
  | 'credential-invalid'
  | 'error';

export interface SessionState {
  session: WebSession | null;
  status: SessionStatus;
  error: string | null;
}

function classify(error: unknown): { status: SessionStatus; message: string } {
  const failure = error as McpError;
  if (failure.code === 'LOGGED_OUT') {
    return {
      status: 'logged-out',
      message: failure.message || '已退出登录',
    };
  }
  if (failure.code === 'CREDENTIAL_INVALID') {
    return {
      status: 'credential-invalid',
      message: failure.message || '当前凭据已失效',
    };
  }
  return { status: 'error', message: failure.message || '身份初始化失败' };
}

/**
 * 浏览器身份：只读缓存，不在查询里写 localStorage。
 *
 * `ensureWebSession` 本身是 single-flight；React Query 只负责把结果共享
 * 给列表/聊天/联系人查询，并在退出登录后由 `queryClient.clear()` 丢弃。
 */
export function useWebSession(): SessionState {
  const query = useQuery({
    queryKey: queryKeys.session(),
    queryFn: ensureWebSession,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  if (query.data) {
    return { session: query.data, status: 'ready', error: null };
  }
  if (query.error) {
    const failure = classify(query.error);
    return { session: null, status: failure.status, error: failure.message };
  }
  return { session: null, status: 'loading', error: null };
}
