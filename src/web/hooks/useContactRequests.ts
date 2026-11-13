import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { useWebSession } from './useWebSession';

const PAGE_SIZE = 50;

export interface ContactRequestActor {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
  agent_session_id?: string | null;
}

export interface ContactRequestView {
  contact_request_id: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  message: string;
  auto_accepted: boolean;
  from_actor: ContactRequestActor;
  to_actor: ContactRequestActor;
  created_at: string;
  updated_at: string;
  expires_at: string;
  can_respond: boolean;
  can_cancel: boolean;
}

export interface ContactRequestsPage {
  items: ContactRequestView[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ContactRequestsState {
  items: ContactRequestView[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<unknown>;
}

interface BadgePage {
  items: ContactRequestView[];
  has_more: boolean;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 待处理好友申请（incoming + outgoing）。
 *
 * 申请只存在于独立收件箱，不创建房间；接受后才由服务端在同一事务里
 * 建立 direct 会话。列表不发额外轮询，收到 `agentnet://stream` 的
 * contact 事件时由页面失效查询。
 */
export function useContactRequests(enabled: boolean): ContactRequestsState {
  const { session } = useWebSession();
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;

  const query = useInfiniteQuery({
    queryKey: queryKeys.contactRequests(actorId),
    enabled: enabled && Boolean(token),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      callTool<ContactRequestsPage>(
        'network_contact_requests_list',
        {
          direction: 'all',
          status: 'pending',
          limit: PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { token: token ?? undefined, signal },
      ),
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
  });

  const items: ContactRequestView[] = [];
  const seen = new Set<string>();
  for (const page of query.data?.pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.contact_request_id)) continue;
      seen.add(item.contact_request_id);
      items.push(item);
    }
  }

  const lastPage = query.data?.pages[query.data.pages.length - 1];
  return {
    items,
    loading: query.isPending && enabled,
    hasMore: Boolean(lastPage?.has_more && lastPage.next_cursor),
    loadingMore: query.isFetchingNextPage,
    error: query.error ? failureMessage(query.error) : null,
    loadMore: () => query.fetchNextPage(),
  };
}

/** 侧栏角标：只统计收到的 pending 申请，最多加载 50 条后显示 `50+`。 */
export function useContactRequestBadge(): { count: number; hasMore: boolean } {
  const { session } = useWebSession();
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;
  const query = useQuery({
    queryKey: queryKeys.contactRequestBadge(actorId),
    enabled: Boolean(token),
    queryFn: ({ signal }) =>
      callTool<BadgePage>(
        'network_contact_requests_list',
        { direction: 'incoming', status: 'pending', limit: PAGE_SIZE },
        { token: token ?? undefined, signal },
      ),
  });
  const count = query.data?.items.length ?? 0;
  return { count, hasMore: query.data?.has_more === true };
}
