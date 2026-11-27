/**
 * 个人看板的 server state 与写操作。
 *
 * 读接口按 owner 缓存；写接口成功后统一失效 `['focus']`，UI 不等 SSE 回声。
 * token 只经 `callTool` 的 Authorization 发送，不进入组件状态或日志。
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { McpError } from '../../lib/mcp-client';
import { callTool } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { queryKeys } from '../../lib/query-keys';
import type {
  FocusDetailData,
  FocusItem,
  FocusListPage,
  FocusStatus,
} from './focus-types';

export function focusFailureText(error: unknown): string {
  const message = (error as McpError).message;
  return message || '看板读取失败，请重试';
}

export function useFocusStatus(
  actorId: string | null,
  token: string | null,
  options: { enabled?: boolean; poll?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.focusStatus(actorId),
    enabled: options.enabled !== false && Boolean(actorId && token),
    queryFn: ({ signal }) =>
      callTool<FocusStatus>('network_focus_status', {}, { token: token ?? undefined, signal }),
    staleTime: 8_000,
    // 只在本机等待开通时轮询；active/disabled 不制造后台流量。
    refetchInterval: options.poll
      ? (query) => (query.state.data?.status === 'provisioning' ? 5_000 : false)
      : false,
  });
}

export function useFocusItems({
  actorId,
  token,
  archived,
  query,
  enabled,
}: {
  actorId: string | null;
  token: string | null;
  archived: boolean;
  query: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.focusItems(actorId, archived, query),
    enabled: enabled && Boolean(actorId && token),
    queryFn: ({ signal }) =>
      callTool<FocusListPage>(
        'network_focus_list',
        {
          archived,
          limit: 50,
          ...(query.trim() ? { query: query.trim() } : {}),
        },
        { token: token ?? undefined, signal },
      ),
    staleTime: 5_000,
  });
}

export function useFocusDetail(
  actorId: string | null,
  token: string | null,
  itemId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.focusItem(actorId, itemId),
    enabled: enabled && Boolean(actorId && token && itemId),
    queryFn: ({ signal }) =>
      callTool<FocusDetailData>(
        'network_focus_get',
        { item_id: itemId ?? '' },
        { token: token ?? undefined, signal },
      ),
    staleTime: 5_000,
  });
}

export async function enableFocus(token: string): Promise<FocusStatus> {
  return callTool<FocusStatus & { idempotent: boolean }>(
    'network_focus_enable',
    { request_id: newRequestId('web_focus_enable') },
    { token },
  );
}

export async function archiveFocusItem(
  token: string,
  item: Pick<FocusItem, 'item_id' | 'version'>,
): Promise<void> {
  await callTool(
    'network_focus_archive',
    {
      item_id: item.item_id,
      request_id: newRequestId('web_focus_archive'),
      expected_version: item.version,
    },
    { token },
  );
}

export function useInvalidateFocus(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.focus() });
}
