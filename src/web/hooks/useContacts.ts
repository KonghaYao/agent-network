import { useInfiniteQuery } from '@tanstack/react-query';

import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { useWebSession } from './useWebSession';

const PAGE_SIZE = 50;

export interface Contact {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id: string | null;
  relation: 'active' | 'none';
  created_at: string;
}

export interface ContactsPage {
  items: Contact[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ContactsState {
  contacts: Contact[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<unknown>;
}

/**
 * 好友列表：建群与加成员共用。
 *
 * 只把 `relation === 'active'` 的条目交给选择器；`none` 只是个人收藏，
 * 不能用于建群或单聊授权。
 */
export function useContacts(enabled: boolean): ContactsState {
  const { session } = useWebSession();
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;

  const query = useInfiniteQuery({
    queryKey: queryKeys.contacts(actorId),
    enabled: enabled && Boolean(token),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      callTool<ContactsPage>(
        'network_contacts_list',
        pageParam ? { limit: PAGE_SIZE, cursor: pageParam } : { limit: PAGE_SIZE },
        { token: token ?? undefined, signal },
      ),
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
  });

  const contacts: Contact[] = [];
  const seen = new Set<string>();
  for (const page of query.data?.pages ?? []) {
    for (const contact of page.items) {
      if (contact.relation !== 'active' || seen.has(contact.actor_id)) continue;
      seen.add(contact.actor_id);
      contacts.push(contact);
    }
  }

  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const failure = query.error as { message?: string } | null;

  return {
    contacts,
    loading: query.isPending && enabled,
    hasMore: Boolean(lastPage?.has_more && lastPage.next_cursor),
    loadingMore: query.isFetchingNextPage,
    error: failure?.message ?? null,
    loadMore: () => query.fetchNextPage(),
  };
}
