import { useIsFetching, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { LIMITS } from '../../contracts/limits';
import { callTool } from '../lib/mcp-client';
import { queryKeys } from '../lib/query-keys';
import { useRooms } from './useRooms';
import { useWebSession } from './useWebSession';

/** `network_agents_get` 的管理摘要；页面只用归档相关字段。 */
export interface AgentSummary {
  actor_id: string;
  kind: 'agent';
  name: string;
  agent_session_id: string | null;
  share_url: string;
  archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
  disabled: boolean;
}

interface AgentsGetResult {
  items: AgentSummary[];
  missing_actor_ids: string[];
}

export interface ArchivedAgent {
  actor_id: string;
  name: string;
  archived_at: number;
}

export interface ArchivedAgentsState {
  items: ArchivedAgent[];
  /** 会话列表尚未加载完成时，归档集合也不完整。 */
  loading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
}

/**
 * 已归档 Agents 浮层的数据源。
 *
 * 服务端没有“枚举全部已归档 Agent”的接口：先从已加载的 direct 会话取出
 * 对端 actor_id，再批量 `network_agents_get` 以服务端归档状态为准。归档
 * 只影响默认列举，不删除房间、消息或凭据；恢复后会话重新出现在默认列表。
 */
export function useArchivedAgents(enabled: boolean): ArchivedAgentsState {
  const { session } = useWebSession();
  const token = session?.token ?? null;
  const actorId = session?.identity.actor_id ?? null;
  const rooms = useRooms(enabled);

  const ids = useMemo(() => {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const room of rooms.rooms) {
      if (room.kind !== 'direct' || room.peer_kind !== 'agent') continue;
      const id = room.peer_actor_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
      if (unique.length >= LIMITS.agentLookupMax) break;
    }
    return unique;
  }, [rooms.rooms]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const room of rooms.rooms) {
      if (room.peer_actor_id && !map.has(room.peer_actor_id)) {
        map.set(room.peer_actor_id, room.name);
      }
    }
    return map;
  }, [rooms.rooms]);

  const query = useQuery({
    queryKey: queryKeys.archivedAgents(actorId, ids),
    enabled: enabled && Boolean(token) && ids.length > 0,
    staleTime: 10_000,
    queryFn: ({ signal }) =>
      callTool<AgentsGetResult>(
        'network_agents_get',
        { actor_ids: ids },
        { token: token ?? undefined, signal },
      ),
  });

  const items = useMemo(() => {
    const archived: ArchivedAgent[] = [];
    for (const item of query.data?.items ?? []) {
      if (item.archived !== true) continue;
      archived.push({
        actor_id: item.actor_id,
        name: item.name || names.get(item.actor_id) || 'Agent',
        archived_at: Number(item.archived_at) || 0,
      });
    }
    return archived.sort((left, right) => {
      if (right.archived_at !== left.archived_at) return right.archived_at - left.archived_at;
      return left.name.localeCompare(right.name);
    });
  }, [names, query.data]);

  const roomsFetching = useIsFetching({
    queryKey: queryKeys.rooms(actorId),
  });

  return {
    items,
    loading:
      roomsFetching > 0 || (query.isPending && enabled && ids.length > 0),
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => query.refetch(),
  };
}
